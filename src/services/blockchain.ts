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

/** Hard cap on any single RPC call — hung public nodes must fail, not freeze */
const RPC_TIMEOUT_MS = 15000;

/**
 * Block-range adaptive chunking. Starts large and halves on every
 * block-range rejection, e.g. 500 → 250 → … → 5. QuickNode Discover
 * ("eth_getLogs is limited to a 5 range") settles on a working size
 * and keeps scanning the remaining blocks with it.
 */
const INITIAL_LOG_CHUNK = 500;
const MIN_LOG_CHUNK = 1;
const MAX_LOG_RETRIES = 6;

/**
 * Addresses per eth_getLogs topic OR-array when the provider supports
 * server-side address filtering. If the provider rejects the topic
 * payload (QuickNode: 413 Request Entity Too Large), the scanner
 * automatically falls back to range-only queries and matches wallet
 * addresses in memory instead.
 */
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
  private fallbackProviders: ethers.JsonRpcProvider[];
  private currentProvider: ethers.JsonRpcProvider;
  private providerIndex: number = 0;

  /**
   * Per-address send queue. ALL outgoing transactions from one wallet are
   * serialized through this queue, and each waits for the previous one to
   * MINE before broadcasting — that prevents both "gapped nonce" rejections
   * and balance-validation failures on paired sends (gas seed → fee forward).
   */
  private sendQueues = new Map<string, Promise<{ hash: string; nonce: number }>>();

  private readonly transferInterface = new ethers.Interface(ERC20_ABI);

  /**
   * Per-provider learned topic-batch size. Providers that reject address
   * topic OR-arrays (413) are remembered as "range-only" for the lifetime
   * of the process so we never re-learn it on every scan cycle.
   */
  private learnedTopicSize = new Map<string, number>();

  /**
   * ethers v6 does not expose the RPC URL on JsonRpcProvider, so we
   * track it ourselves — needed to remember per-provider scanning
   * behaviour (topic-filter vs range-only) across scan cycles.
   */
  private providerUrls = new Map<ethers.JsonRpcProvider, string>();

  constructor() {
    const network = new ethers.Network('bnb', config.BSC_CHAIN_ID);

    // Every provider gets a hard timeout. Public nodes under rate-limit
    // pressure HANG instead of erroring — without this, awaits block forever.
    const makeProvider = (url: string): ethers.JsonRpcProvider => {
      const request = new ethers.FetchRequest(url);
      request.timeout = RPC_TIMEOUT_MS;
      return new ethers.JsonRpcProvider(request, network, { staticNetwork: network });
    };

    this.primaryProvider = makeProvider(config.BSC_PRIMARY_RPC);
    this.quicknodeProvider = makeProvider(config.BSC_QUICKNODE_RPC);
    this.fallbackProviders = config.BSC_PUBLIC_RPCS.map(makeProvider);

    this.currentProvider = this.primaryProvider;

    this.providerUrls.set(this.primaryProvider, config.BSC_PRIMARY_RPC);
    this.providerUrls.set(this.quicknodeProvider, config.BSC_QUICKNODE_RPC);
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

  /**
   * Dedicated QuickNode provider, used ONLY by the pinned 5-block small
   * scan. Balance checks, receipts and sends never route through it.
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
      } catch (err) {
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

  /**
   * Switch to another configured provider (primary + public fallbacks;
   * QuickNode is deliberately excluded — it is reserved for the pinned
   * small scan).
   */
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
      return await provider.getBalance(address);
    }

    const assetConfig = ASSETS[asset];
    if (!assetConfig.contractAddress) throw new Error(`No contract for ${asset}`);

    const contract = new ethers.Contract(assetConfig.contractAddress, ERC20_ABI, provider);
    return (await contract.balanceOf(address)) as bigint;
  }

  /**
   * Serialized send: waits for the previous tx from this wallet to mine,
   * then broadcasts. Returns once the tx is accepted by the node.
   */
  async sendTransaction(
    encryptedPrivateKey: string,
    to: string,
    amount: bigint,
    asset: AssetSymbol,
    idempotencyKey: string
  ): Promise<{ hash: string; nonce: number }> {
    const { decrypt } = await import('../utils/encryption');
    const privateKey = decrypt(encryptedPrivateKey);
    const wallet = new ethers.Wallet(privateKey);

    const prev = this.sendQueues.get(wallet.address) ?? Promise.resolve({ hash: '', nonce: 0 });
    const run = (async () => {
      try {
        const p = await prev;
        // CRITICAL: wait for the previous tx to actually mine. Nodes validate
        // balance/nonce against confirmed state — broadcasting a follow-up
        // (fee forward) before the seed lands causes INSUFFICIENT_FUNDS.
        if (p.hash) await this.waitMined(p.hash, 60000);
      } catch {
        // previous send failed — proceed anyway
      }
      return this.doSend(wallet, to, amount, asset);
    })();

    this.sendQueues.set(wallet.address, run);
    return run;
  }

  /** Poll until a tx has at least 1 confirmation. Proceeds on timeout. */
  private async waitMined(hash: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const receipt = await this.getTransactionReceipt(hash);
        if (receipt) return; // mined (status 0 or 1 — either way it's settled)
      } catch {
        // provider hiccup — keep polling
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    logger.warn(`waitMined: ${hash} not confirmed after ${timeoutMs}ms — proceeding anyway.`);
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
        await new Promise((r) => setTimeout(r, 4000));
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
      return await signer.sendTransaction({ to, value: amount, nonce });
    }

    const assetConfig = ASSETS[asset];
    if (!assetConfig.contractAddress) throw new Error(`No contract for ${asset}`);

    const contract = new ethers.Contract(assetConfig.contractAddress, ERC20_ABI, signer);
    return (await contract.transfer(to, amount, { nonce })) as ethers.TransactionResponse;
  }

  /**
   * Live pending nonce — no in-memory cache. Combined with the send queue
   * this is race-free: our previous tx is visible in the mempool before the
   * next one asks for a nonce.
   */
  private async getNextNonce(address: string, provider: ethers.JsonRpcProvider): Promise<number> {
    return await provider.getTransactionCount(address, 'pending');
  }

  async getTransactionReceipt(hash: string): Promise<ethers.TransactionReceipt | null> {
    const provider = await this.resolveProvider();
    return await provider.getTransactionReceipt(hash);
  }

  async waitForConfirmations(
    hash: string,
    requiredConfirmations: number = 15,
    timeoutMs: number = 300000
  ): Promise<ethers.TransactionReceipt> {
    const provider = await this.resolveProvider();
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt && (await receipt.confirmations()) >= requiredConfirmations) {
        return receipt;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }

    throw new Error('Transaction confirmation timeout');
  }

  async validateAddress(address: string): Promise<boolean> {
    return ethers.isAddress(address);
  }

  async getGasPrice(): Promise<bigint> {
    const provider = await this.resolveProvider();
    const feeData = await provider.getFeeData();
    return feeData.gasPrice ?? BigInt(5000000000);
  }

  async estimateGas(asset: AssetSymbol, from: string, to: string, amount: bigint): Promise<bigint> {
    const provider = await this.resolveProvider();

    if (asset === 'BNB') {
      return await provider.estimateGas({ from, to, value: amount });
    }

    const assetConfig = ASSETS[asset];
    const contract = new ethers.Contract(assetConfig.contractAddress!, ERC20_ABI, provider);
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

  /**
   * Original single-wallet API retained for compatibility. Delegates to
   * the block-range-first scanner below.
   */
  async getTokenTransferEvents(
    asset: AssetSymbol,
    toAddress: string,
    fromBlock: number,
    toBlock: number
  ): Promise<TransferEvent[]> {
    const grouped = await this.getTokenTransferEventsForAddresses(
      asset,
      [toAddress],
      fromBlock,
      toBlock
    );

    return grouped.get(toAddress.toLowerCase()) ?? [];
  }

  /**
   * =========================================================================
   * BLOCK-RANGE-FIRST USDT SCANNER
   * =========================================================================
   *
   * Scanning dimension is the BLOCK RANGE, never the wallet count:
   *
   *   BSC blocks → USDT Transfer logs → extract `to` → match against the
   *   in-memory Set of VEYLO wallet addresses → return only matches,
   *   grouped by lowercase recipient.
   *
   * Two query shapes, chosen adaptively per provider:
   *
   *  1. TOPIC-FILTERED (preferred where supported):
   *     topics[2] = OR-array of up to ADDRESS_BATCH_SIZE wallet
   *     addresses, so the provider filters server-side. 250 wallets =
   *     5 address batches, NOT 250 requests.
   *
   *  2. RANGE-ONLY (fallback when the provider rejects the topic
   *     payload — QuickNode Discover returns
   *     "413 Request Entity Too Large" for wide OR-arrays):
   *     no address topics at all; one query per block chunk returns
   *     ALL USDT transfers in the range, matched against the wallet
   *     Set in memory. Wallet count then has ZERO effect on the
   *     request count: 250 wallets still cost 1 query per chunk.
   *
   * Both shapes share the same adaptive block-chunk logic, so
   * QuickNode's "eth_getLogs is limited to a 5 range" is satisfied by
   * shrinking chunks (500 → 250 → … → 5), never by per-wallet scans.
   * =========================================================================
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

    for (
      let start = 0;
      start < normalizedAddresses.length;
      start += ADDRESS_BATCH_SIZE
    ) {
      const batch = normalizedAddresses.slice(start, start + ADDRESS_BATCH_SIZE);

      const events = await this.queryTransferEventsAdaptive(
        assetConfig.contractAddress,
        batch,
        fromBlock,
        toBlock,
        pinnedProvider
      );

      for (const event of events) {
        const recipient = event.to.toLowerCase();

        const existing = result.get(recipient) ?? [];
        existing.push(event);
        result.set(recipient, existing);
      }
    }

    return result;
  }

  /**
   * Scan one 50-address batch across the block range with TWO adaptive
   * knobs:
   *
   *   chunkSize  — blocks per request; halves on range rejection,
   *                doubles back after successes.
   *   topicSize  — addresses per topic OR-array; halves on 413,
   *                0 = range-only mode (in-memory matching).
   *
   * Error classes are ALWAYS distinguished in this order:
   *
   *   B. provider failure / rate limit  → throw (backoff in chunk loop)
   *   A2. topic payload too large (413) → shrink topicSize, same range
   *   A1. block-range / result limit    → shrink chunkSize
   *   C. anything else                  → throw
   *
   * A rate limit is NEVER treated as a range error and never shrinks
   * the block chunk.
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

    let providerRef: ethers.JsonRpcProvider =
      pinnedProvider ?? this.currentProvider;
    let topicSize = this.getLearnedTopicSize(providerRef);

    while (cursor <= toBlock) {
      const end = Math.min(cursor + chunkSize - 1, toBlock);

      /**
       * Query units for this block window. topicSize === 0 means one
       * range-only query; otherwise the batch is split into
       * topicSize-sized OR-arrays so EVERY address is still covered.
       */
      const units: Array<string[] | null> =
        topicSize <= 0
          ? [null]
          : chunkArray(addresses, topicSize);

      try {
        for (const unit of units) {
          const events = await this.queryTransferChunk(
            contractAddress,
            unit,
            addressSet,
            cursor,
            end,
            pinnedProvider
          );

          for (const event of events) {
            allEvents.push(event);
          }
        }

        this.learnedTopicSize.set(this.providerKey(providerRef), topicSize);

        cursor = end + 1;

        /**
         * Grow the block window back after successes so capable
         * providers are not penalised by QuickNode-sized chunks.
         */
        if (chunkSize < INITIAL_LOG_CHUNK) {
          chunkSize = Math.min(INITIAL_LOG_CHUNK, chunkSize * 2);
        }
      } catch (err) {
        const msg = this.getErrorMessage(err);

        // (B) rate-limit / provider failure — never a range problem.
        if (this.isProviderFailure(msg)) {
          throw err;
        }

        // (A2) topic OR-array too large — shrink it, retry same range.
        if (this.isTopicTooLargeError(msg) && topicSize > 0) {
          topicSize = topicSize <= 4 ? 0 : Math.floor(topicSize / 2);

          this.learnedTopicSize.set(this.providerKey(providerRef), topicSize);

          logger.warn(
            topicSize === 0
              ? `[RPC] topic filter rejected (413) → using range-only scan for this provider (wallets matched in memory, 1 query per block chunk)`
              : `[RPC] topic filter too large → retrying with ${topicSize} addresses per filter`
          );

          continue;
        }

                // (A1) block-range / result-size rejection — shrink the chunk.
        if (this.isLogRangeError(msg)) {
          if (chunkSize > MIN_LOG_CHUNK) {
            const prevChunk = chunkSize;

            chunkSize = Math.max(MIN_LOG_CHUNK, Math.floor(chunkSize / 2));

            logger.warn(
              `[RPC] eth_getLogs range rejected: ${prevChunk} blocks → retrying with ${chunkSize}`
            );

            continue;
          }

          /**
           * Even a 1-block range was rejected. Only un-pinned scans
           * may switch provider; a pinned QuickNode scan rethrows.
           */
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
   *
   * Retries with exponential backoff ONLY for provider failures
   * (class B). Range errors (A1) and topic-payload errors (A2) are
   * thrown immediately — the adaptive outer loop adjusts the right
   * knob; retrying them unchanged here would just waste quota.
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
        const provider =
          pinnedProvider ?? (await this.resolveProvider());

        const transferTopic = ethers.id(
          'Transfer(address,address,uint256)'
        );

        const logs = await provider.getLogs({
          address: contractAddress,
          topics: [
            transferTopic,
            null,
            topicBatch
              ? topicBatch.map((address) =>
                  ethers.zeroPadValue(address, 32)
                )
              : null,
          ],
          fromBlock,
          toBlock,
        });

        const events: TransferEvent[] = [];

        for (const log of logs) {
          try {
            const parsed = this.transferInterface.parseLog({
              topics: log.topics,
              data: log.data,
            });

            if (!parsed) continue;

            const to = String(parsed.args[1]).toLowerCase();

            /**
             * In-memory wallet match. With a topic filter this is a
             * cheap safety verification; in range-only mode this IS
             * the filter.
             */
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

        // (B) provider failure / rate limit → backoff and retry.
        if (this.isProviderFailure(msg)) {
          const backoffMs = Math.min(
            500 * (attempt + 1) * (attempt + 1),
            5000
          );

          if (this.isRateLimitError(msg)) {
            logger.warn(
              `[RPC] rate limited → backing off ${backoffMs}ms (attempt ${attempt + 1}/${MAX_LOG_RETRIES})`
            );
          } else {
            logger.warn(
              `[RPC] provider failure → backing off ${backoffMs}ms (attempt ${attempt + 1}/${MAX_LOG_RETRIES})`
            );
          }

          await new Promise((r) => setTimeout(r, backoffMs));

          continue;
        }

        // (A2) / (A1) — thrown for the adaptive loop to handle.
        if (this.isTopicTooLargeError(msg)) throw err;
        if (this.isLogRangeError(msg)) throw err;

        throw err;
      }
    }

    throw lastError ?? new Error('eth_getLogs failed');
  }

  // ------------------------------------------------------------------
  // Error classification
  // ------------------------------------------------------------------

  private getErrorMessage(err: unknown): string {
    if (err instanceof Error) {
      return err.message.toLowerCase();
    }

    return String(err ?? '').toLowerCase();
  }

  /**
   * (B) TRUE provider failures: timeouts, HTTP 5xx, and rate limits
   * (429, "rate limit", QuickNode -32007 "request limit").
   *
   * Checked FIRST, everywhere, because QuickNode's rate-limit text
   * contains the word "limit" and must never be mistaken for a
   * block-range rejection.
   */
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

  /**
   * (B+) Rate-limit flavour of provider failure (for logging; backoff
   * is applied to all provider failures).
   */
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

  /**
   * (A2) Topic OR-array payload rejected by the provider.
   * QuickNode Discover: "413 Request Entity Too Large".
   */
  private isTopicTooLargeError(message: string): boolean {
    return (
      message.includes('413') ||
      message.includes('request entity too large') ||
      message.includes('payload too large')
    );
  }

  /**
   * (A1) TRUE block-range / result-size rejections, e.g. QuickNode
   * "eth_getLogs is limited to a 5 range", Infura -32005 "exceeds
   * max results". Only ever consulted AFTER (B) and (A2).
   */
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

  // ------------------------------------------------------------------
  // Per-provider topic-size learning
  // ------------------------------------------------------------------

  private providerKey(provider: ethers.JsonRpcProvider): string {
    return this.providerUrls.get(provider) ?? 'unknown-provider';
  }

  private getLearnedTopicSize(
    provider: ethers.JsonRpcProvider
  ): number {
    return (
      this.learnedTopicSize.get(
        this.providerKey(provider)
      ) ?? ADDRESS_BATCH_SIZE
    );
  }
}

export const blockchain = new BlockchainService();
              
