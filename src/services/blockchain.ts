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

/** Hard cap on any single RPC call — hung nodes must fail, not freeze */
const RPC_TIMEOUT_MS = 15000;

/**
 * Block-range adaptive chunking: 500 → 250 → … → 1 on range rejections.
 * QuickNode's "limited to a 5 range" therefore settles on a working size.
 */
const INITIAL_LOG_CHUNK = 500;
const MIN_LOG_CHUNK = 1;
const MAX_LOG_RETRIES = 6;

const ADDRESS_BATCH_SIZE = 50;

export interface TransferEvent {
  from: string;
  to: string;
  amount: bigint;
  txHash: string;
  blockNumber: number;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

class BlockchainService {
  private primaryProvider: ethers.JsonRpcProvider;
  private quicknodeProvider: ethers.JsonRpcProvider;
  /** getblock.io — SMALL safety scan only */
  private smallScanProvider: ethers.JsonRpcProvider;
  /** Chainstack — ALL transaction sends (payouts, seeds, forwards) */
  private txProvider: ethers.JsonRpcProvider;
  private fallbackProviders: ethers.JsonRpcProvider[];
  private currentProvider: ethers.JsonRpcProvider;
  private providerIndex = 0;

  /**
   * Per-address send queue. Txs from one wallet serialize, each waiting
   * for the previous to MINE — prevents gapped nonces and the
   * balance-validation race on paired sends.
   */
  private sendQueues = new Map<string, Promise<{ hash: string; nonce: number }>>();

  private readonly transferInterface = new ethers.Interface(ERC20_ABI);

  /** Per-provider learned topic-batch size (0 = range-only mode). */
  private learnedTopicSize = new Map<string, number>();

  /** ethers v6 hides the RPC URL on providers — track it for learning keys. */
  private providerUrls = new Map<ethers.JsonRpcProvider, string>();

  constructor() {
    const network = new ethers.Network('bnb', config.BSC_CHAIN_ID);

    const makeProvider = (url: string): ethers.JsonRpcProvider => {
      const request = new ethers.FetchRequest(url);
      request.timeout = RPC_TIMEOUT_MS;
      return new ethers.JsonRpcProvider(request, network, { staticNetwork: network });
    };

    this.primaryProvider = makeProvider(config.BSC_PRIMARY_RPC);
    this.quicknodeProvider = makeProvider(config.BSC_QUICKNODE_RPC);
    this.smallScanProvider = makeProvider(config.BSC_SMALL_SCAN_RPC);
    this.txProvider = makeProvider(config.BSC_TX_RPC);
    this.fallbackProviders = config.BSC_PUBLIC_RPCS.map(makeProvider);

    this.currentProvider = this.primaryProvider;

    this.providerUrls.set(this.primaryProvider, config.BSC_PRIMARY_RPC);
    this.providerUrls.set(this.quicknodeProvider, config.BSC_QUICKNODE_RPC);
    this.providerUrls.set(this.smallScanProvider, config.BSC_SMALL_SCAN_RPC);
    this.providerUrls.set(this.txProvider, config.BSC_TX_RPC);
    this.fallbackProviders.forEach((provider, i) => {
      this.providerUrls.set(provider, config.BSC_PUBLIC_RPCS[i]);
    });

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
        // Primary still down
      }
    }, 30000);
  }

  async getProvider(): Promise<ethers.JsonRpcProvider> {
    return this.resolveProvider();
  }

  /** getblock.io — used ONLY by the SMALL 5-block safety scan. */
  async getSmallScanProvider(): Promise<ethers.JsonRpcProvider> {
    await this.smallScanProvider.getBlockNumber();
    return this.smallScanProvider;
  }

  /**
   * Chainstack — ALL sends and tx confirmations. Isolated from read pools.
   * Falls back to the read pool only if Chainstack itself is unreachable.
   */
  private async getTxProvider(): Promise<ethers.JsonRpcProvider> {
    try {
      await this.txProvider.getBlockNumber();
      return this.txProvider;
    } catch {
      logger.warn('TX RPC (Chainstack) unreachable — falling back to read pool for this send');
      return this.resolveProvider();
    }
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
      const idx = (this.providerIndex + i) % this.fallbackProviders.length;
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

  private async switchToAnotherProvider(): Promise<boolean> {
    const providers = [this.primaryProvider, ...this.fallbackProviders];

    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i];
      if (provider === this.currentProvider) continue;

      try {
        await provider.getBlockNumber();
        this.currentProvider = provider;
        if (provider === this.primaryProvider) {
          this.providerIndex = 0;
        } else {
          const fallbackIndex = this.fallbackProviders.indexOf(provider);
          if (fallbackIndex >= 0) this.providerIndex = fallbackIndex;
        }
        logger.warn('Switched RPC provider for log scanning');
        return true;
      } catch {
        continue;
      }
    }

    return false;
  }

  async getBalance(address: string, asset: AssetSymbol): Promise<bigint> {
    const provider = await this.resolveProvider();

    if (asset === 'BNB') {
      return provider.getBalance(address);
    }

    const assetConfig = ASSETS[asset];
    if (!assetConfig.contractAddress) throw new Error(`No contract for ${asset}`);

    const contract = new ethers.Contract(assetConfig.contractAddress, ERC20_ABI, provider);
    return (await contract.balanceOf(address)) as bigint;
  }

  /**
   * Serialized send via the dedicated TX RPC. Waits for the previous tx
   * from this wallet to mine, then broadcasts.
   */
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

    const run = (async () => {
      try {
        const prev = await previous;
        if (prev.hash) await this.waitMined(prev.hash, 60000);
      } catch {
        // previous send failed — proceed anyway
      }
      return this.doSend(wallet, to, amount, asset);
    })();

    this.sendQueues.set(wallet.address, run);
    return run;
  }

  /** Poll until a tx has at least 1 confirmation. TX RPC. Proceeds on timeout. */
  async waitMined(hash: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const receipt = await this.getTxReceipt(hash);
        if (receipt) return;
      } catch {
        // hiccup — keep polling
      }
      await sleep(2000);
    }
    logger.warn(`waitMined: ${hash} not confirmed after ${timeoutMs}ms — proceeding anyway.`);
  }

  /** Receipt from the TX RPC — what our own sends care about. */
  private async getTxReceipt(hash: string): Promise<ethers.TransactionReceipt | null> {
    const provider = await this.getTxProvider();
    return provider.getTransactionReceipt(hash);
  }

  private async doSend(
    wallet: ethers.Wallet,
    to: string,
    amount: bigint,
    asset: AssetSymbol
  ): Promise<{ hash: string; nonce: number }> {
    const provider = await this.getTxProvider();
    const signer = wallet.connect(provider);
    const nonce = await this.getNextNonce(wallet.address, provider);

    try {
      const tx = await this.broadcast(signer, to, amount, asset, nonce);
      return { hash: tx.hash, nonce: tx.nonce };
    } catch (err) {
      const msg = ((err as Error).message ?? '').toLowerCase();
      const isNonceError =
        msg.includes('gapped') ||
        msg.includes('nonce') ||
        msg.includes('already known') ||
        msg.includes('replacement transaction');

      if (isNonceError) {
        logger.warn(`Nonce rejection from ${wallet.address} — refetching and retrying once.`);
        await sleep(4000);
        const fresh = await this.getNextNonce(wallet.address, provider);
        const tx = await this.broadcast(signer, to, amount, asset, fresh);
        return { hash: tx.hash, nonce: tx.nonce };
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
      return signer.sendTransaction({ to, value: amount, nonce });
    }

    const assetConfig = ASSETS[asset];
    if (!assetConfig.contractAddress) throw new Error(`No contract for ${asset}`);

    const contract = new ethers.Contract(assetConfig.contractAddress, ERC20_ABI, signer);
    return (await contract.transfer(to, amount, { nonce })) as ethers.TransactionResponse;
  }

  private async getNextNonce(address: string, provider: ethers.JsonRpcProvider): Promise<number> {
    return provider.getTransactionCount(address, 'pending');
  }

  /** Read-pool receipt — used by the deposit monitor for event verification. */
  async getTransactionReceipt(hash: string): Promise<ethers.TransactionReceipt | null> {
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
      const receipt = await this.getTxReceipt(hash);
      if (receipt && (await receipt.confirmations()) >= requiredConfirmations) {
        return receipt;
      }
      await sleep(5000);
    }
    throw new Error('Transaction confirmation timeout');
  }

  async validateAddress(address: string): Promise<boolean> {
    return ethers.isAddress(address);
  }

  async getGasPrice(): Promise<bigint> {
    const provider = await this.getTxProvider();
    const feeData = await provider.getFeeData();
    return feeData.gasPrice ?? 5000000000n;
  }

  async estimateGas(asset: AssetSymbol, from: string, to: string, amount: bigint): Promise<bigint> {
    const provider = await this.getTxProvider();
    if (asset === 'BNB') {
      return provider.estimateGas({ from, to, value: amount });
    }
    const assetConfig = ASSETS[asset];
    if (!assetConfig.contractAddress) throw new Error(`No contract for ${asset}`);
    const contract = new ethers.Contract(assetConfig.contractAddress, ERC20_ABI, provider);
    return (await contract.transfer.estimateGas(to, amount, { from })) as bigint;
  }

  generateWallet(): { address: string; privateKey: string; mnemonic: string } {
    const wallet = ethers.Wallet.createRandom();
    return {
      address: wallet.address,
      privateKey: wallet.privateKey,
      mnemonic: wallet.mnemonic?.phrase ?? '',
    };
  }

  /** Original single-wallet API retained for compatibility. */
  async getTokenTransferEvents(
    asset: AssetSymbol,
    toAddress: string,
    fromBlock: number,
    toBlock: number
  ): Promise<TransferEvent[]> {
    const grouped = await this.getTokenTransferEventsForAddresses(asset, [toAddress], fromBlock, toBlock);
    return grouped.get(toAddress.toLowerCase()) ?? [];
      }
      /**
   * Block-range-first USDT scanner.
   *
   * COST FIX: when the provider is in range-only mode (learned topic
   * size 0), address BATCHING is meaningless — one range-only query
   * returns ALL transfers and wallets are matched in memory. One pass
   * with all addresses then costs 1 query per block chunk instead of
   * (batches × chunks). This is what stops the credit burn.
   */
  async getTokenTransferEventsForAddresses(
    asset: AssetSymbol,
    addresses: string[],
    fromBlock: number,
    toBlock: number,
    pinnedProvider?: ethers.JsonRpcProvider
  ): Promise<Map<string, TransferEvent[]>> {
    const result = new Map<string, TransferEvent[]>();

    if (asset === 'BNB') return result;
    if (addresses.length === 0) return result;
    if (fromBlock > toBlock) return result;

    const assetConfig = ASSETS[asset];
    if (!assetConfig.contractAddress) throw new Error(`No contract for ${asset}`);

    const normalizedAddresses = [
      ...new Set(
        addresses
          .filter((address) => ethers.isAddress(address))
          .map((address) => address.toLowerCase())
      ),
    ];

    const providerForLearn = pinnedProvider ?? this.currentProvider;
    const learned = this.getLearnedTopicSize(providerForLearn);

    const collect = (events: TransferEvent[]): void => {
      for (const event of events) {
        const recipient = event.to.toLowerCase();
        const existing = result.get(recipient) ?? [];
        existing.push(event);
        result.set(recipient, existing);
      }
    };

    // RANGE-ONLY FAST PATH: batches irrelevant — one pass, in-memory match.
    if (learned <= 0) {
      const events = await this.queryTransferEventsAdaptive(
        assetConfig.contractAddress,
        normalizedAddresses,
        fromBlock,
        toBlock,
        pinnedProvider
      );
      collect(events);
      return result;
    }

    // TOPIC-FILTERED PATH: batch addresses for server-side filtering.
    for (let start = 0; start < normalizedAddresses.length; start += ADDRESS_BATCH_SIZE) {
      const batch = normalizedAddresses.slice(start, start + ADDRESS_BATCH_SIZE);
      const events = await this.queryTransferEventsAdaptive(
        assetConfig.contractAddress,
        batch,
        fromBlock,
        toBlock,
        pinnedProvider
      );
      collect(events);
    }

    return result;
  }

  /**
   * Scan one address batch across the block range with TWO adaptive knobs:
   *   chunkSize — blocks per request; halves on range rejection.
   *   topicSize — addresses per topic OR-array; halves on 413; 0 = range-only.
   *
   * Error order is ALWAYS: (B) provider failure → throw; (A2) 413 → shrink
   * topic; (A1) range rejection → shrink chunk. A rate limit is NEVER a
   * range error.
   */
  private async queryTransferEventsAdaptive(
    contractAddress: string,
    addresses: string[],
    fromBlock: number,
    toBlock: number,
    pinnedProvider?: ethers.JsonRpcProvider
  ): Promise<TransferEvent[]> {
    const addressSet = new Set(addresses);
    const allEvents: TransferEvent[] = [];

    let cursor = fromBlock;
    let chunkSize = INITIAL_LOG_CHUNK;
    let providerRef: ethers.JsonRpcProvider = pinnedProvider ?? this.currentProvider;
    let topicSize = this.getLearnedTopicSize(providerRef);

    while (cursor <= toBlock) {
      const end = Math.min(cursor + chunkSize - 1, toBlock);
      const units: Array<string[] | null> = topicSize <= 0 ? [null] : chunkArray(addresses, topicSize);

      try {
        for (const unit of units) {
          const events = await this.queryTransferChunk(contractAddress, unit, addressSet, cursor, end, pinnedProvider);
          for (const event of events) allEvents.push(event);
        }

        this.learnedTopicSize.set(this.providerKey(providerRef), topicSize);
        cursor = end + 1;
        if (chunkSize < INITIAL_LOG_CHUNK) chunkSize = Math.min(INITIAL_LOG_CHUNK, chunkSize * 2);
      } catch (err) {
        const msg = this.getErrorMessage(err);

        if (this.isProviderFailure(msg)) throw err;

        if (this.isTopicTooLargeError(msg) && topicSize > 0) {
          topicSize = topicSize <= 4 ? 0 : Math.floor(topicSize / 2);
          this.learnedTopicSize.set(this.providerKey(providerRef), topicSize);
          logger.warn(
            topicSize === 0
              ? `[RPC] topic filter rejected (413) → range-only mode for this provider`
              : `[RPC] topic filter too large → retrying with ${topicSize} addresses per filter`
          );
          continue;
        }

        if (this.isLogRangeError(msg)) {
          if (chunkSize > MIN_LOG_CHUNK) {
            const prevChunk = chunkSize;
            chunkSize = Math.max(MIN_LOG_CHUNK, Math.floor(chunkSize / 2));
            logger.warn(`[RPC] eth_getLogs range rejected: ${prevChunk} blocks → retrying with ${chunkSize}`);
            continue;
          }
          if (!pinnedProvider) {
            const switched = await this.switchToAnotherProvider();
            if (switched) {
              providerRef = this.currentProvider;
              topicSize = this.getLearnedTopicSize(providerRef);
              continue;
            }
          }
        }

        throw err;
      }
    }

    return allEvents;
  }

  /**
   * One eth_getLogs request for one (topic unit, block chunk) pair.
   * Retries with backoff ONLY for provider failures; (A1)/(A2) throw
   * immediately for the adaptive loop.
   */
  private async queryTransferChunk(
    contractAddress: string,
    topicBatch: string[] | null,
    addressSet: Set<string>,
    fromBlock: number,
    toBlock: number,
    pinnedProvider?: ethers.JsonRpcProvider
  ): Promise<TransferEvent[]> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_LOG_RETRIES; attempt++) {
      try {
        const provider = pinnedProvider ?? (await this.resolveProvider());
        const transferTopic = ethers.id('Transfer(address,address,uint256)');

        const logs = await provider.getLogs({
          address: contractAddress,
          topics: [
            transferTopic,
            null,
            topicBatch ? topicBatch.map((address) => ethers.zeroPadValue(address, 32)) : null,
          ],
          fromBlock,
          toBlock,
        });

        const events: TransferEvent[] = [];
        for (const log of logs) {
          try {
            const parsed = this.transferInterface.parseLog({ topics: log.topics, data: log.data });
            if (!parsed) continue;
            const to = String(parsed.args[1]).toLowerCase();
            if (!addressSet.has(to)) continue;
            events.push({
              from: String(parsed.args[0]),
              to,
              amount: BigInt(String(parsed.args[2])),
              txHash: log.transactionHash,
              blockNumber: log.blockNumber,
            });
          } catch {
            continue;
          }
        }
        return events;
      } catch (err) {
        lastError = err;
        const msg = this.getErrorMessage(err);

        if (this.isProviderFailure(msg)) {
          const backoffMs = Math.min(500 * (attempt + 1) * (attempt + 1), 5000);
          logger.warn(`[RPC] provider failure → backing off ${backoffMs}ms (attempt ${attempt + 1}/${MAX_LOG_RETRIES})`);
          await sleep(backoffMs);
          continue;
        }

        if (this.isTopicTooLargeError(msg)) throw err;
        if (this.isLogRangeError(msg)) throw err;
        throw err;
      }
    }

    throw lastError ?? new Error('eth_getLogs failed');
  }

  private getErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message.toLowerCase();
    return String(err ?? '').toLowerCase();
  }

  /** (B) TRUE provider failures — checked FIRST, everywhere. */
  private isProviderFailure(message: string): boolean {
    return (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('429') ||
      message.includes('rate limit') ||
      message.includes('rate_limit') ||
      message.includes('request limit') ||
      message.includes('-32007') ||
      message.includes('too many requests') ||
      message.includes('503') ||
      message.includes('502') ||
      message.includes('500') ||
      message.includes('temporarily unavailable') ||
      message.includes('server error') ||
      message.includes('network error') ||
      message.includes('socket')
    );
  }

  private isRateLimitError(message: string): boolean {
    return (
      message.includes('429') ||
      message.includes('rate limit') ||
      message.includes('rate_limit') ||
      message.includes('request limit') ||
      message.includes('-32007') ||
      message.includes('too many requests')
    );
  }

  /** (A2) Topic OR-array payload rejected (QuickNode Discover: 413). */
  private isTopicTooLargeError(message: string): boolean {
    return (
      message.includes('413') ||
      message.includes('request entity too large') ||
      message.includes('payload too large')
    );
  }

  /** (A1) TRUE block-range / result-size rejections — only after (B) and (A2). */
  private isLogRangeError(message: string): boolean {
    return (
      message.includes('eth_getlogs') ||
      message.includes('too many results') ||
      message.includes('range') ||
      message.includes('block range') ||
      message.includes('limit') ||
      message.includes('-32005') ||
      message.includes('-32615') ||
      message.includes('result limit') ||
      message.includes('exceeds')
    );
  }

  private providerKey(provider: ethers.JsonRpcProvider): string {
    return this.providerUrls.get(provider) ?? 'unknown-provider';
  }

  private getLearnedTopicSize(provider: ethers.JsonRpcProvider): number {
    return this.learnedTopicSize.get(this.providerKey(provider)) ?? ADDRESS_BATCH_SIZE;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const blockchain = new BlockchainService();
      
