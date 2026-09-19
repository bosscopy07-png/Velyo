import { ethers } from 'ethers';
import { config, ASSETS, type AssetSymbol } from '../config';
import { redis, isPrimaryRPCFailed, markPrimaryRPCFailed } from './redis';
import { logger } from '../utils/logger';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
];

const RPC_TIMEOUT_MS = 15000;

/**
 * Start reasonably large, but automatically shrink when an RPC provider
 * rejects eth_getLogs because of its block-range/result limit.
 */
const INITIAL_LOG_CHUNK = 500;
const MIN_LOG_CHUNK = 1;
const MAX_LOG_RETRIES = 6;

/**
 * Query recipient addresses in batches.
 *
 * 50 is deliberately conservative. This keeps the JSON-RPC request size
 * reasonable while allowing hundreds/thousands of wallets.
 */
const ADDRESS_BATCH_SIZE = 50;

class BlockchainService {
  private primaryProvider: ethers.JsonRpcProvider;
  private quicknodeProvider: ethers.JsonRpcProvider;
  private fallbackProviders: ethers.JsonRpcProvider[];
  private currentProvider: ethers.JsonRpcProvider;
  private providerIndex = 0;

  private sendQueues = new Map<string, Promise<{ hash: string; nonce: number }>>();

  private readonly transferInterface = new ethers.Interface(ERC20_ABI);

  constructor() {
    const network = new ethers.Network('bnb', config.BSC_CHAIN_ID);

    const makeProvider = (url: string): ethers.JsonRpcProvider => {
      const request = new ethers.FetchRequest(url);
      request.timeout = RPC_TIMEOUT_MS;

      return new ethers.JsonRpcProvider(
        request,
        network,
        { staticNetwork: network }
      );
    };

    this.primaryProvider = makeProvider(config.BSC_PRIMARY_RPC);
    this.quicknodeProvider = makeProvider(config.BSC_QUICKNODE_RPC);
    this.fallbackProviders = config.BSC_PUBLIC_RPCS.map(makeProvider);

    this.currentProvider = this.primaryProvider;

    this.startHealthCheck();
  }

  private startHealthCheck(): void {
    setInterval(async () => {
      try {
        await this.primaryProvider.getBlockNumber();

        const failed = await isPrimaryRPCFailed();

        if (failed) {
          logger.info('Primary RPC recovered, switching back');
          this.currentProvider = this.primaryProvider;
          await redis.del('rpc:primary:failed');
        }
      } catch {
        // Health check intentionally silent.
      }
    }, 30000);
  }

  async getProvider(): Promise<ethers.JsonRpcProvider> {
    return this.resolveProvider();
  }

  /**
   * Dedicated QuickNode provider used by the 30-second-offset small scan.
   */
  async getQuickNodeProvider(): Promise<ethers.JsonRpcProvider> {
    await this.quicknodeProvider.getBlockNumber();
    return this.quicknodeProvider;
  }

  private async resolveProvider(): Promise<ethers.JsonRpcProvider> {
    const primaryFailed = await isPrimaryRPCFailed();

    if (!primaryFailed) {
      try {
        await this.primaryProvider.getBlockNumber();

        this.currentProvider = this.primaryProvider;

        return this.primaryProvider;
      } catch {
        logger.warn('Primary RPC failed, switching to fallback');
        await markPrimaryRPCFailed();
      }
    }

    for (let i = 0; i < this.fallbackProviders.length; i++) {
      const idx =
        (this.providerIndex + i) % this.fallbackProviders.length;

      try {
        await this.fallbackProviders[idx].getBlockNumber();

        this.providerIndex = idx;
        this.currentProvider = this.fallbackProviders[idx];

        return this.fallbackProviders[idx];
      } catch {
        continue;
      }
    }

    throw new Error('All RPC providers unavailable');
  }

  /**
   * Switch to another configured provider.
   *
   * Used when the current provider rejects a logs request because of
   * provider-specific limitations.
   */
  private async switchToAnotherProvider(): Promise<boolean> {
    const providers = [
      this.primaryProvider,
      ...this.fallbackProviders,
    ];

    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i];

      if (provider === this.currentProvider) continue;

      try {
        await provider.getBlockNumber();

        this.currentProvider = provider;

        if (provider === this.primaryProvider) {
          this.providerIndex = 0;
        } else {
          const fallbackIndex =
            this.fallbackProviders.indexOf(provider);

          if (fallbackIndex >= 0) {
            this.providerIndex = fallbackIndex;
          }
        }

        logger.warn('Switched RPC provider for log scanning');

        return true;
      } catch {
        continue;
      }
    }

    return false;
  }

  async getBalance(
    address: string,
    asset: AssetSymbol
  ): Promise<bigint> {
    const provider = await this.resolveProvider();

    if (asset === 'BNB') {
      return provider.getBalance(address);
    }

    const assetConfig = ASSETS[asset];

    if (!assetConfig.contractAddress) {
      throw new Error(`No contract for ${asset}`);
    }

    const contract = new ethers.Contract(
      assetConfig.contractAddress,
      ERC20_ABI,
      provider
    );

    return (await contract.balanceOf(address)) as bigint;
  }

  async sendTransaction(
    encryptedPrivateKey: string,
    to: string,
    amount: bigint,
    asset: AssetSymbol,
    _idempotencyKey: string
  ): Promise<{ hash: string; nonce: number }> {
    const { decrypt } = await import('../utils/encryption');

    const privateKey = decrypt(encryptedPrivateKey);
    const wallet = new ethers.Wallet(privateKey);

    const previous =
      this.sendQueues.get(wallet.address) ??
      Promise.resolve({ hash: '', nonce: 0 });

    const run = previous
      .catch(() => {})
      .then(() => this.doSend(wallet, to, amount, asset));

    this.sendQueues.set(wallet.address, run);

    return run;
  }

  private async doSend(
    wallet: ethers.Wallet,
    to: string,
    amount: bigint,
    asset: AssetSymbol
  ): Promise<{ hash: string; nonce: number }> {
    const provider = await this.resolveProvider();
    const signer = wallet.connect(provider);

    const nonce = await this.getNextNonce(wallet.address, provider);

    try {
      const tx = await this.broadcast(
        signer,
        to,
        amount,
        asset,
        nonce
      );

      return {
        hash: tx.hash,
        nonce: tx.nonce,
      };
    } catch (err) {
      const msg = ((err as Error).message ?? '').toLowerCase();

      const isNonceError =
        msg.includes('gapped') ||
        msg.includes('nonce') ||
        msg.includes('already known') ||
        msg.includes('replacement transaction');

      if (isNonceError) {
        logger.warn(
          `Nonce rejection from ${wallet.address} — refetching and retrying once.`
        );

        await new Promise((resolve) => setTimeout(resolve, 4000));

        const fresh = await this.getNextNonce(
          wallet.address,
          provider
        );

        const tx = await this.broadcast(
          signer,
          to,
          amount,
          asset,
          fresh
        );

        return {
          hash: tx.hash,
          nonce: tx.nonce,
        };
      }

      throw err;
    }
  }

  private async broadcast(
    signer: ethers.Wallet,
    to: string,
    amount: bigint,
    asset: AssetSymbol,
    nonce: number
  ): Promise<ethers.TransactionResponse> {
    if (asset === 'BNB') {
      return signer.sendTransaction({
        to,
        value: amount,
        nonce,
      });
    }

    const assetConfig = ASSETS[asset];

    if (!assetConfig.contractAddress) {
      throw new Error(`No contract for ${asset}`);
    }

    const contract = new ethers.Contract(
      assetConfig.contractAddress,
      ERC20_ABI,
      signer
    );

    return (await contract.transfer(
      to,
      amount,
      { nonce }
    )) as ethers.TransactionResponse;
  }

  private async getNextNonce(
    address: string,
    provider: ethers.JsonRpcProvider
  ): Promise<number> {
    return provider.getTransactionCount(address, 'pending');
  }

  async getTransactionReceipt(
    hash: string
  ): Promise<ethers.TransactionReceipt | null> {
    const provider = await this.resolveProvider();

    return provider.getTransactionReceipt(hash);
  }

  async waitForConfirmations(
    hash: string,
    requiredConfirmations = 15,
    timeoutMs = 300000
  ): Promise<ethers.TransactionReceipt> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const provider = await this.resolveProvider();

      const receipt =
        await provider.getTransactionReceipt(hash);

      if (
        receipt &&
        (await receipt.confirmations()) >= requiredConfirmations
      ) {
        return receipt;
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    throw new Error('Transaction confirmation timeout');
  }

  async validateAddress(address: string): Promise<boolean> {
    return ethers.isAddress(address);
  }

  async getGasPrice(): Promise<bigint> {
    const provider = await this.resolveProvider();

    const feeData = await provider.getFeeData();

    return feeData.gasPrice ?? 5000000000n;
  }

  async estimateGas(
    asset: AssetSymbol,
    from: string,
    to: string,
    amount: bigint
  ): Promise<bigint> {
    const provider = await this.resolveProvider();

    if (asset === 'BNB') {
      return provider.estimateGas({
        from,
        to,
        value: amount,
      });
    }

    const assetConfig = ASSETS[asset];

    if (!assetConfig.contractAddress) {
      throw new Error(`No contract for ${asset}`);
    }

    const contract = new ethers.Contract(
      assetConfig.contractAddress,
      ERC20_ABI,
      provider
    );

    return (await contract.transfer.estimateGas(
      to,
      amount,
      { from }
    )) as bigint;
  }

  generateWallet(): {
    address: string;
    privateKey: string;
    mnemonic: string;
  } {
    const wallet = ethers.Wallet.createRandom();

    return {
      address: wallet.address,
      privateKey: wallet.privateKey,
      mnemonic: wallet.mnemonic?.phrase ?? '',
    };
  }

  /**
   * Original single-wallet API retained for compatibility.
   */
  async getTokenTransferEvents(
    asset: AssetSymbol,
    toAddress: string,
    fromBlock: number,
    toBlock: number
  ): Promise<
    Array<{
      from: string;
      to: string;
      amount: bigint;
      txHash: string;
      blockNumber: number;
    }>
  > {
    const grouped =
      await this.getTokenTransferEventsForAddresses(
        asset,
        [toAddress],
        fromBlock,
        toBlock
      );

    return grouped.get(toAddress.toLowerCase()) ?? [];
  }

  /**
   * Efficient multi-wallet USDT scanner.
   *
   * Pass `pinnedProvider` to force a specific RPC (e.g. QuickNode for the
   * 30-second small scan). When pinned, provider switching on range errors
   * is disabled — the adaptive chunk shrink is relied on instead.
   */
  async getTokenTransferEventsForAddresses(
    asset: AssetSymbol,
    addresses: string[],
    fromBlock: number,
    toBlock: number,
    pinnedProvider?: ethers.JsonRpcProvider
  ): Promise<
    Map<
      string,
      Array<{
        from: string;
        to: string;
        amount: bigint;
        txHash: string;
        blockNumber: number;
      }>
    >
  > {
    const result = new Map<
      string,
      Array<{
        from: string;
        to: string;
        amount: bigint;
        txHash: string;
        blockNumber: number;
      }>
    >();

    if (asset === 'BNB') return result;
    if (addresses.length === 0) return result;
    if (fromBlock > toBlock) return result;

    const assetConfig = ASSETS[asset];

    if (!assetConfig.contractAddress) {
      throw new Error(`No contract for ${asset}`);
    }

    const normalizedAddresses = [
      ...new Set(
        addresses
          .filter((address) => ethers.isAddress(address))
          .map((address) => address.toLowerCase())
      ),
    ];

    for (
      let start = 0;
      start < normalizedAddresses.length;
      start += ADDRESS_BATCH_SIZE
    ) {
      const batch = normalizedAddresses.slice(
        start,
        start + ADDRESS_BATCH_SIZE
      );

      const events = await this.queryTransferEventsAdaptive(
        assetConfig.contractAddress,
        batch,
        fromBlock,
        toBlock,
        pinnedProvider
      );

      for (const event of events) {
        const recipient = event.to.toLowerCase();

        if (!result.has(recipient)) {
          result.set(recipient, []);
        }

        result.get(recipient)!.push(event);
      }
    }

    return result;
  }

  /**
   * Query one recipient batch with automatic block-range reduction.
   */
  private async queryTransferEventsAdaptive(
    contractAddress: string,
    recipientAddresses: string[],
    fromBlock: number,
    toBlock: number,
    pinnedProvider?: ethers.JsonRpcProvider
  ): Promise<
    Array<{
      from: string;
      to: string;
      amount: bigint;
      txHash: string;
      blockNumber: number;
    }>
  > {
    const allEvents: Array<{
      from: string;
      to: string;
      amount: bigint;
      txHash: string;
      blockNumber: number;
    }> = [];

    let cursor = fromBlock;
    let chunkSize = INITIAL_LOG_CHUNK;

    while (cursor <= toBlock) {
      const end = Math.min(
        cursor + chunkSize - 1,
        toBlock
      );

      try {
        const events =
          await this.queryTransferChunk(
            contractAddress,
            recipientAddresses,
            cursor,
            end,
            pinnedProvider
          );

        allEvents.push(...events);

        cursor = end + 1;

        if (chunkSize < INITIAL_LOG_CHUNK) {
          chunkSize = Math.min(
            INITIAL_LOG_CHUNK,
            chunkSize * 2
          );
        }
      } catch (err) {
        const msg = this.getErrorMessage(err);

        if (this.isLogRangeError(msg)) {
          if (chunkSize > MIN_LOG_CHUNK) {
            const oldChunk = chunkSize;

            chunkSize = Math.max(
              MIN_LOG_CHUNK,
              Math.floor(chunkSize / 2)
            );

            logger.warn(
              `RPC eth_getLogs range rejected (${oldChunk} blocks). Retrying with ${chunkSize} blocks.`
            );

            continue;
          }

          /**
           * Even one block was rejected.
           *
           * Only switch providers when NOT pinned to a specific RPC.
           */
          if (!pinnedProvider) {
            const switched =
              await this.switchToAnotherProvider();

            if (switched) {
              continue;
            }
          }
        }

        throw err;
      }
    }

    return allEvents;
  }

  private async queryTransferChunk(
    contractAddress: string,
    recipientAddresses: string[],
    fromBlock: number,
    toBlock: number,
    pinnedProvider?: ethers.JsonRpcProvider
  ): Promise<
    Array<{
      from: string;
      to: string;
      amount: bigint;
      txHash: string;
      blockNumber: number;
    }>
  > {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_LOG_RETRIES; attempt++) {
      try {
        const provider =
          pinnedProvider ?? (await this.resolveProvider());

        const transferTopic =
          ethers.id(
            'Transfer(address,address,uint256)'
          );

        const recipientTopics =
          recipientAddresses.map((address) =>
            ethers.zeroPadValue(address, 32)
          );

        const logs = await provider.getLogs({
          address: contractAddress,
          topics: [
            transferTopic,
            null,
            recipientTopics,
          ],
          fromBlock,
          toBlock,
        });

        return logs
          .map((log) => {
            try {
              const parsed =
                this.transferInterface.parseLog({
                  topics: log.topics,
                  data: log.data,
                });

              if (!parsed) return null;

              return {
                from: String(parsed.args[0]),
                to: String(parsed.args[1]),
                amount: BigInt(parsed.args[2]),
                txHash: log.transactionHash,
                blockNumber: log.blockNumber,
              };
            } catch {
              return null;
            }
          })
          .filter(
            (
              event
            ): event is {
              from: string;
              to: string;
              amount: bigint;
              txHash: string;
              blockNumber: number;
            } => event !== null
          );
      } catch (err) {
        lastError = err;

        const msg = this.getErrorMessage(err);

        if (this.isLogRangeError(msg)) {
          throw err;
        }

        if (this.isProviderFailure(msg)) {
          await new Promise((resolve) =>
            setTimeout(resolve, 500 * (attempt + 1))
          );

          continue;
        }

        throw err;
      }
    }

    throw lastError ?? new Error('eth_getLogs failed');
  }

  private getErrorMessage(err: unknown): string {
    if (err instanceof Error) {
      return err.message.toLowerCase();
    }

    return String(err ?? '').toLowerCase();
  }

  private isLogRangeError(message: string): boolean {
    return (
      message.includes('eth_getlogs') ||
      message.includes('too many results') ||
      message.includes('range') ||
      message.includes('block range') ||
      message.includes('413') ||
      message.includes('request entity too large') ||
      message.includes('limit') ||
      message.includes('-32005') ||
      message.includes('-32615') ||
      message.includes('result limit') ||
      message.includes('exceeds')
    );
  }

  private isProviderFailure(message: string): boolean {
    return (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('429') ||
      message.includes('rate limit') ||
      message.includes('rate_limit') ||
      message.includes('503') ||
      message.includes('502') ||
      message.includes('500') ||
      message.includes('temporarily unavailable') ||
      message.includes('server error') ||
      message.includes('network error') ||
      message.includes('socket')
    );
  }
}

export const blockchain = new BlockchainService();
        
