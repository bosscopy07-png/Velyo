import { ethers } from 'ethers';
import {
  config,
  ASSETS,
  type AssetSymbol,
} from '../config';
import {
  redis,
  isPrimaryRPCFailed,
  markPrimaryRPCFailed,
} from './redis';
import { logger } from '../utils/logger';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
];

/**
 * Maximum time allowed for one RPC request.
 */
const RPC_TIMEOUT_MS = 15000;

/**
 * Initial eth_getLogs chunk size.
 *
 * 500 works with many providers.
 * If the provider rejects it, the code automatically
 * reduces the chunk size.
 */
const INITIAL_LOG_CHUNK = 500;

/**
 * Never go below this automatically.
 *
 * QuickNode Discover currently allows only 5 blocks,
 * so the fallback logic can eventually reach 5.
 */
const MIN_LOG_CHUNK = 1;

/**
 * Number of attempts for a single RPC log range.
 */
const MAX_LOG_RETRIES = 6;

class BlockchainService {
  private primaryProvider: ethers.JsonRpcProvider;

  private fallbackProviders: ethers.JsonRpcProvider[];

  private currentProvider: ethers.JsonRpcProvider;

  private providerIndex = 0;

  /**
   * Per-wallet outgoing transaction queue.
   *
   * Prevents nonce races when gas-seeding and forwarding
   * happen almost simultaneously.
   */
  private sendQueues = new Map<
    string,
    Promise<{
      hash: string;
      nonce: number;
    }>
  >();

  constructor() {
    const network = new ethers.Network(
      'bnb',
      config.BSC_CHAIN_ID
    );

    const makeProvider = (
      url: string
    ): ethers.JsonRpcProvider => {
      const request =
        new ethers.FetchRequest(url);

      request.timeout =
        RPC_TIMEOUT_MS;

      return new ethers.JsonRpcProvider(
        request,
        network,
        {
          staticNetwork: network,
        }
      );
    };

    this.primaryProvider =
      makeProvider(
        config.BSC_PRIMARY_RPC
      );

    this.fallbackProviders =
      config.BSC_PUBLIC_RPCS.map(
        makeProvider
      );

    this.currentProvider =
      this.primaryProvider;

    this.startHealthCheck();
  }

  private startHealthCheck(): void {
    setInterval(async () => {
      try {
        await this.primaryProvider.getBlockNumber();

        const failed =
          await isPrimaryRPCFailed();

        if (failed) {
          logger.info(
            'Primary RPC recovered, switching back'
          );

          this.currentProvider =
            this.primaryProvider;

          await redis.del(
            'rpc:primary:failed'
          );
        }
      } catch {
        // Primary still unavailable.
      }
    }, 30000);
  }

  async getProvider(): Promise<ethers.JsonRpcProvider> {
    return this.resolveProvider();
  }

  /**
   * Resolve a healthy provider.
   *
   * Primary first, then fallbacks.
   */
  private async resolveProvider(): Promise<ethers.JsonRpcProvider> {
    const primaryFailed =
      await isPrimaryRPCFailed();

    if (!primaryFailed) {
      try {
        await this.primaryProvider.getBlockNumber();

        this.currentProvider =
          this.primaryProvider;

        return this.primaryProvider;
      } catch (err) {
        logger.warn(
          `Primary RPC failed: ${this.errorMessage(
            err
          )}`
        );

        await markPrimaryRPCFailed();
      }
    }

    for (
      let i = 0;
      i < this.fallbackProviders.length;
      i++
    ) {
      const index =
        (this.providerIndex + i) %
        this.fallbackProviders.length;

      try {
        await this.fallbackProviders[
          index
        ].getBlockNumber();

        this.providerIndex = index;

        this.currentProvider =
          this.fallbackProviders[index];

        return this.currentProvider;
      } catch {
        continue;
      }
    }

    throw new Error(
      'All RPC providers unavailable'
    );
  }

  async getBalance(
    address: string,
    asset: AssetSymbol
  ): Promise<bigint> {
    const provider =
      await this.resolveProvider();

    if (asset === 'BNB') {
      return provider.getBalance(
        address
      );
    }

    const assetConfig =
      ASSETS[asset];

    if (!assetConfig.contractAddress) {
      throw new Error(
        `No contract for ${asset}`
      );
    }

    const contract =
      new ethers.Contract(
        assetConfig.contractAddress,
        ERC20_ABI,
        provider
      );

    return (await contract.balanceOf(
      address
    )) as bigint;
  }

  /**
   * Serialize all outgoing transactions from
   * the same wallet.
   */
  async sendTransaction(
    encryptedPrivateKey: string,
    to: string,
    amount: bigint,
    asset: AssetSymbol,
    idempotencyKey: string
  ): Promise<{
    hash: string;
    nonce: number;
  }> {
    /**
     * idempotencyKey is intentionally accepted here
     * because callers already generate deterministic
     * identifiers for their transaction operations.
     *
     * Actual DB-level idempotency remains outside this
     * RPC layer.
     */
    void idempotencyKey;

    const { decrypt } =
      await import(
        '../utils/encryption'
      );

    const privateKey =
      decrypt(encryptedPrivateKey);

    const wallet =
      new ethers.Wallet(
        privateKey
      );

    const previous =
      this.sendQueues.get(
        wallet.address
      ) ??
      Promise.resolve({
        hash: '',
        nonce: 0,
      });

    const run =
      previous
        .catch(() => {})
        .then(() =>
          this.doSend(
            wallet,
            to,
            amount,
            asset
          )
        );

    this.sendQueues.set(
      wallet.address,
      run
    );

    return run;
  }

  private async doSend(
    wallet: ethers.Wallet,
    to: string,
    amount: bigint,
    asset: AssetSymbol
  ): Promise<{
    hash: string;
    nonce: number;
  }> {
    const provider =
      await this.resolveProvider();

    const signer =
      wallet.connect(provider);

    const nonce =
      await this.getNextNonce(
        wallet.address,
        provider
      );

    try {
      const tx =
        await this.broadcast(
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
      const msg =
        this.errorMessage(
          err
        ).toLowerCase();

      const isNonceError =
        msg.includes('gapped') ||
        msg.includes('nonce') ||
        msg.includes('already known') ||
        msg.includes(
          'replacement transaction'
        );

      if (!isNonceError) {
        throw err;
      }

      logger.warn(
        `Nonce rejection from ${wallet.address} — ` +
          `refetching and retrying once.`
      );

      await sleep(4000);

      const freshNonce =
        await this.getNextNonce(
          wallet.address,
          provider
        );

      const tx =
        await this.broadcast(
          signer,
          to,
          amount,
          asset,
          freshNonce
        );

      return {
        hash: tx.hash,
        nonce: tx.nonce,
      };
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

    const assetConfig =
      ASSETS[asset];

    if (!assetConfig.contractAddress) {
      throw new Error(
        `No contract for ${asset}`
      );
    }

    const contract =
      new ethers.Contract(
        assetConfig.contractAddress,
        ERC20_ABI,
        signer
      );

    return (await contract.transfer(
      to,
      amount,
      {
        nonce,
      }
    )) as ethers.TransactionResponse;
  }

  private async getNextNonce(
    address: string,
    provider: ethers.JsonRpcProvider
  ): Promise<number> {
    return provider.getTransactionCount(
      address,
      'pending'
    );
  }

  async getTransactionReceipt(
    hash: string
  ): Promise<ethers.TransactionReceipt | null> {
    const provider =
      await this.resolveProvider();

    return provider.getTransactionReceipt(
      hash
    );
  }

  async waitForConfirmations(
    hash: string,
    requiredConfirmations = 15,
    timeoutMs = 300000
  ): Promise<ethers.TransactionReceipt> {
    const startTime =
      Date.now();

    while (
      Date.now() - startTime <
      timeoutMs
    ) {
      const provider =
        await this.resolveProvider();

      const receipt =
        await provider.getTransactionReceipt(
          hash
        );

      if (
        receipt &&
        (await receipt.confirmations()) >=
          requiredConfirmations
      ) {
        return receipt;
      }

      await sleep(5000);
    }

    throw new Error(
      'Transaction confirmation timeout'
    );
  }

  async validateAddress(
    address: string
  ): Promise<boolean> {
    return ethers.isAddress(
      address
    );
  }

  async getGasPrice(): Promise<bigint> {
    const provider =
      await this.resolveProvider();

    const feeData =
      await provider.getFeeData();

    return (
      feeData.gasPrice ??
      BigInt(5000000000)
    );
  }

  async estimateGas(
    asset: AssetSymbol,
    from: string,
    to: string,
    amount: bigint
  ): Promise<bigint> {
    const provider =
      await this.resolveProvider();

    if (asset === 'BNB') {
      return provider.estimateGas({
        from,
        to,
        value: amount,
      });
    }

    const assetConfig =
      ASSETS[asset];

    if (!assetConfig.contractAddress) {
      throw new Error(
        `No contract for ${asset}`
      );
    }

    const contract =
      new ethers.Contract(
        assetConfig.contractAddress,
        ERC20_ABI,
        provider
      );

    return (await contract.transfer.estimateGas(
      to,
      amount,
      {
        from,
      }
    )) as bigint;
  }

  generateWallet(): {
    address: string;
    privateKey: string;
    mnemonic: string;
  } {
    const wallet =
      ethers.Wallet.createRandom();

    return {
      address: wallet.address,
      privateKey: wallet.privateKey,
      mnemonic:
        wallet.mnemonic?.phrase ?? '',
    };
  }

  /**
   * Get USDT Transfer events for one wallet.
   *
   * IMPORTANT:
   *
   * We DO NOT send one giant eth_getLogs request.
   *
   * The range is automatically split into chunks.
   *
   * Example:
   *
   * 500 requested
   * ↓
   * provider rejects 500
   * ↓
   * 250
   * ↓
   * provider rejects 250
   * ↓
   * 125
   * ...
   *
   * This makes the scanner compatible with providers
   * that impose different eth_getLogs range limits.
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
    if (asset === 'BNB') {
      return [];
    }

    const assetConfig =
      ASSETS[asset];

    if (!assetConfig.contractAddress) {
      throw new Error(
        `No contract for ${asset}`
      );
    }

    if (fromBlock > toBlock) {
      return [];
    }

    let provider =
      await this.resolveProvider();

    /**
     * Start with a sensible chunk.
     */
    let chunkSize =
      Math.min(
        INITIAL_LOG_CHUNK,
        toBlock - fromBlock + 1
      );

    const allEvents: Array<{
      from: string;
      to: string;
      amount: bigint;
      txHash: string;
      blockNumber: number;
    }> = [];

    let cursor = fromBlock;

    while (cursor <= toBlock) {
      const chunkEnd =
        Math.min(
          cursor + chunkSize - 1,
          toBlock
        );

      try {
        const events =
          await this.queryTransferChunk(
            provider,
            assetConfig.contractAddress,
            toAddress,
            cursor,
            chunkEnd
          );

        allEvents.push(
          ...events
        );

        /**
         * Successful request.
         *
         * If we previously had to reduce the
         * chunk size, slowly increase it again.
         */
        if (
          chunkSize <
          INITIAL_LOG_CHUNK
        ) {
          chunkSize =
            Math.min(
              INITIAL_LOG_CHUNK,
              chunkSize * 2
            );
        }

        cursor =
          chunkEnd + 1;
      } catch (err) {
        const msg =
          this.errorMessage(
            err
          );

        if (
          this.isLogRangeError(msg)
        ) {
          /**
           * Provider rejected the range.
           *
           * Reduce the range instead of killing
           * the whole deposit scanner.
           */
          if (
            chunkSize <=
            MIN_LOG_CHUNK
          ) {
            /**
             * At one block we cannot reduce further.
             * Try another provider before failing.
             */
            logger.warn(
              `RPC rejected even a 1-block eth_getLogs request ` +
                `for ${cursor}-${chunkEnd}: ${msg}`
            );

            provider =
              await this.switchToAnotherProvider(
                provider
              );

            /**
             * If provider changed, retry the same
             * block without advancing the cursor.
             */
            continue;
          }

          const previous =
            chunkSize;

          chunkSize =
            Math.max(
              MIN_LOG_CHUNK,
              Math.floor(
                chunkSize / 2
              )
            );

          logger.warn(
            `Reducing eth_getLogs chunk ` +
              `${previous} → ${chunkSize} ` +
              `for ${toAddress}`
          );

          continue;
        }

        /**
         * A timeout, rate-limit or provider failure
         * should try another provider.
         */
        if (
          this.isProviderFailure(
            msg
          )
        ) {
          logger.warn(
            `RPC failure while scanning ${toAddress}: ` +
              `${msg}. Switching provider.`
          );

          provider =
            await this.switchToAnotherProvider(
              provider
            );

          continue;
        }

        throw err;
      }
    }

    /**
     * Remove accidental duplicate logs.
     *
     * This is extra protection when a provider retries
     * or when adjacent ranges overlap in future changes.
     */
    const unique =
      new Map<
        string,
        {
          from: string;
          to: string;
          amount: bigint;
          txHash: string;
          blockNumber: number;
        }
      >();

    for (const event of allEvents) {
      const key =
        `${event.txHash}:${event.blockNumber}:${event.from}:${event.to}`;

      unique.set(
        key,
        event
      );
    }

    return Array.from(
      unique.values()
    );
  }

  private async queryTransferChunk(
    provider: ethers.JsonRpcProvider,
    contractAddress: string,
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
    const contract =
      new ethers.Contract(
        contractAddress,
        ERC20_ABI,
        provider
      );

    const filter =
      contract.filters.Transfer(
        null,
        toAddress
      );

    let lastError: unknown;

    for (
      let attempt = 1;
      attempt <= MAX_LOG_RETRIES;
      attempt++
    ) {
      try {
        const events =
          await contract.queryFilter(
            filter,
            fromBlock,
            toBlock
          );

        return events
          .filter(
            (
              event
            ): event is ethers.EventLog =>
              'args' in event &&
              event.args !== undefined
          )
          .map((event) => ({
            from: String(
              event.args!.from ?? ''
            ),
            to: String(
              event.args!.to ?? ''
            ),
            amount:
              (event.args!
                .amount as bigint) ??
              BigInt(0),
            txHash:
              event.transactionHash,
            blockNumber:
              event.blockNumber,
          }));
      } catch (err) {
        lastError = err;

        const msg =
          this.errorMessage(
            err
          );

        /**
         * Range errors should bubble immediately
         * to the chunk-size reducer.
         */
        if (
          this.isLogRangeError(msg)
        ) {
          throw err;
        }

        /**
         * Temporary provider errors get a short retry.
         */
        if (
          this.isProviderFailure(
            msg
          )
        ) {
          if (
            attempt <
            MAX_LOG_RETRIES
          ) {
            await sleep(
              500 * attempt
            );

            continue;
          }
        }

        throw err;
      }
    }

    throw (
      lastError ??
      new Error(
        'eth_getLogs failed'
      )
    );
  }

  /**
   * Switch to another known provider.
   *
   * We deliberately don't assume that the next provider
   * has the same eth_getLogs limits.
   */
  private async switchToAnotherProvider(
    failedProvider: ethers.JsonRpcProvider
  ): Promise<ethers.JsonRpcProvider> {
    const candidates = [
      this.primaryProvider,
      ...this.fallbackProviders,
    ];

    /**
     * Remove the currently failed provider.
     */
    const unique =
      candidates.filter(
        (provider, index) =>
          provider !==
            failedProvider &&
          candidates.indexOf(
            provider
          ) === index
      );

    for (const provider of unique) {
      try {
        await provider.getBlockNumber();

        this.currentProvider =
          provider;

        if (
          provider ===
          this.primaryProvider
        ) {
          await redis.del(
            'rpc:primary:failed'
          );
        }

        const index =
          this.fallbackProviders.indexOf(
            provider
          );

        if (index >= 0) {
          this.providerIndex =
            index;
        }

        return provider;
      } catch {
        continue;
      }
    }

    /**
     * If nothing else is healthy, return the original
     * provider. The caller will retry and eventually
     * surface the actual error.
     */
    return failedProvider;
  }

  private isLogRangeError(
    message: string
  ): boolean {
    const msg =
      message.toLowerCase();

    return (
      msg.includes(
        'eth_getlogs'
      ) ||
      msg.includes(
        'eth_getlogs is limited'
      ) ||
      msg.includes(
        'range'
      ) ||
      msg.includes(
        'request entity too large'
      ) ||
      msg.includes(
        '-32615'
      ) ||
      msg.includes(
        'too many results'
      ) ||
      msg.includes(
        'block range'
      )
    );
  }

  private isProviderFailure(
    message: string
  ): boolean {
    const msg =
      message.toLowerCase();

    return (
      msg.includes(
        'timeout'
      ) ||
      msg.includes(
        'timed out'
      ) ||
      msg.includes(
        'rate limit'
      ) ||
      msg.includes(
        'rate-limit'
      ) ||
      msg.includes(
        'limit exceeded'
      ) ||
      msg.includes(
        'too many requests'
      ) ||
      msg.includes(
        '-32005'
      ) ||
      msg.includes(
        '503'
      ) ||
      msg.includes(
        '502'
      ) ||
      msg.includes(
        '504'
      ) ||
      msg.includes(
        '429'
      )
    );
  }

  private errorMessage(
    err: unknown
  ): string {
    if (err instanceof Error) {
      return err.message;
    }

    return String(err);
  }
}

function sleep(
  ms: number
): Promise<void> {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms
      )
  );
}

export const blockchain =
  new BlockchainService();
