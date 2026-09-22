import { prisma } from '../database';
import { blockchain } from './blockchain';
import { redis } from './redis';
import { walletService } from './wallet';
import { estimateGasUSDT } from './giveaway';
import { ensureGas, estimateBnbTransferCost, pendingGasSeedKey } from './gas';
import { config } from '../config';
import { logger } from '../utils/logger';
import { hashIdempotencyKey } from '../utils/encryption';
import cron from 'node-cron';

const ASSET_DECIMALS: Record<string, number> = {
  BNB: 18,
  USDT: 18,
};

/**
 * BIG scan (read pool) — every 60s at second 0.
 * Authoritative pass: 150-block window, advances the persistent cursor
 * `monitor:lastBlock`, owns the BNB balance sweep.
 *
 * COST FIX: ACTIVE WALLETS ONLY (14d of bot activity). Dormant wallets
 * are still covered by the SMALL scan every 30s later, so the expensive
 * pass scales with real usage, not total signups.
 */
const BIG_SCAN_BLOCK_WINDOW = 150;
const BIG_SCAN_ACTIVITY_DAYS = 14;

/**
 * SMALL scan (getblock.io) — every 60s at second 30, exactly half a
 * cycle after BIG so they never fire simultaneously. 5-block window,
 * ALL wallets (including dormant — a brand-new external deposit into a
 * dormant wallet is caught here), does NOT advance the cursor and does
 * NOT touch BNB balances. Fresh deposits land within ~60–90s even when
 * the BIG scan's pool is degraded.
 */
const SMALL_SCAN_BLOCK_WINDOW = 5;

/**
 * Shared Redis lock. Both scans compete for it; only one holder at a
 * time, so even if one scan overruns its slot the other waits/skips
 * instead of running concurrently.
 */
const SCAN_LOCK_KEY = 'monitor:scan:lock';
const SCAN_LOCK_TTL_SEC = 240;

/**
 * BNB balance sweep pacing — bounded concurrency with a small delay,
 * comfortably under a 15 req/s provider ceiling, with an extra
 * backoff pause whenever a batch hits a rate-limit error.
 */
const BNB_CHECK_CONCURRENCY = 4;
const BNB_CHECK_BATCH_DELAY_MS = 300;
const BNB_RATE_LIMIT_BACKOFF_MS = 2000;

/**
 * Pending gas-seed ledger TTL. When VEYLO seeds BNB gas into a user
 * wallet before forwarding USDT fees, the seed amount is recorded in
 * Redis and consumed by the next balance sweep so the seed is never
 * misread as a user BNB deposit. 600s comfortably covers
 * seed-then-forward latency.
 *
 * Owned by services/gas.ts (same Redis key, `monitor:seed:pending:<address>`)
 * since the ensureGas() refactor — this module only SUBTRACTS the ledger
 * in checkNativeBalance; all seeding goes through ensureGas().
 */
const SEED_LEDGER_TTL_SEC = 600;

/**
 * Required confirmation depth before a Transfer-log-based (USDT) deposit
 * is credited. Matches the schema default (`DepositMonitor.requiredConfirmations`)
 * and the confirmation depth outgoing payouts already wait for
 * (`payout.ts::CONFIRMATIONS`). Deposits are NOT credited on first sight —
 * they're recorded as CONFIRMING and only credited once `checkPendingConfirmations`
 * (or an immediate check, if already mature) proves this depth on a receipt
 * that is STILL valid at credit time. This is what actually protects against
 * a reorg reverting a deposit after it's already been credited.
 */
const REQUIRED_CONFIRMATIONS_USDT = 15;

/**
 * Minimum deposit worth crediting, per asset. Anything smaller is dust
 * and is ignored (see processDeposit's minAmount check).
 */
const MIN_DEPOSIT: Record<string, number> = {
  BNB: 0.0001,
  USDT: config.MINIMUM_AMOUNT_USD,
};

/**
 * Tiered flat fee: small deposits (< tier) pay the reduced flat fee so
 * they're still worth collecting; everything else pays the standard flat.
 */
function flatFeeFor(amountUSD: number): number {
  if (!config.ENABLE_FEES) return 0;
  return amountUSD < config.DEPOSIT_FLAT_FEE_TIER_USD
    ? config.DEPOSIT_FLAT_FEE_SMALL_USD
    : config.DEPOSIT_FLAT_FEE_USD;
}

type MonitoredWallet = {
  address: string;
  userId: string;
  encryptedPrivateKey: string;
  user: {
    chatId: string | null;
    telegramId: string;
  };
};

interface RawDepositEvent {
  from: string;
  amount: bigint;
  txHash: string;
  /** Present for real on-chain Transfer events (USDT); absent for the BNB balance-delta method. */
  blockNumber?: number;
}

class DepositMonitorService {
  private isRunning = false;

  start(): void {
    /**
     * t=0s, 60s, 120s ...  → BIG scan (read pool, active wallets, cursor)
     * t=30s, 90s, 150s ... → SMALL scan (getblock, ALL wallets, no cursor)
     * t=15s, 45s ...       → confirmation checker (matures CONFIRMING rows)
     */
    cron.schedule('0 * * * * *', () => {
      void this.runBigScan();
    });

    cron.schedule('30 * * * * *', () => {
      void this.runSmallScan();
    });

    cron.schedule('15,45 * * * * *', () => {
      void this.checkPendingConfirmations();
    });

    logger.info(
      'Deposit monitor started: BIG read-pool scan @0s (150 blk, active wallets), SMALL getblock scan @30s (5 blk, all wallets), confirmation checker @15s/45s; mutually exclusive; TX via Chainstack'
    );
  }

  // ------------------------------------------------------------------
  // Shared scan lock — always released in finally.
  // ------------------------------------------------------------------

  private async acquireScanLock(): Promise<boolean> {
    if (this.isRunning) return false;

    try {
      const res = await redis.set(
        SCAN_LOCK_KEY,
        '1',
        'EX',
        SCAN_LOCK_TTL_SEC,
        'NX'
      );

      if (res !== 'OK') return false;
    } catch {
      // Redis unavailable — fall back to the in-memory flag only.
    }

    this.isRunning = true;

    return true;
  }

  private async releaseScanLock(): Promise<void> {
    this.isRunning = false;

    try {
      await redis.del(SCAN_LOCK_KEY);
    } catch {
      // ignore
    }
  }

  /**
   * @param activityDays When set (BIG scan), only wallets whose owner
   * touched the bot within this window. Omit (SMALL scan) for ALL
   * wallets — the cheap 5-block pass covers dormant wallets too.
   */
  private async getActiveWallets(activityDays?: number): Promise<MonitoredWallet[]> {
    const cutoff = activityDays
      ? new Date(Date.now() - activityDays * 86400000)
      : undefined;

    const wallets = await prisma.wallet.findMany({
      where: {
        status: 'ACTIVE',
        address: {
          not: config.PLATFORM_FEE_WALLET,
        },
        ...(cutoff ? { user: { lastActive: { gte: cutoff } } } : {}),
      },
      include: {
        user: true,
      },
    });

    return wallets as MonitoredWallet[];
  }

  /** Looks up a single active wallet by address, for the deferred confirmation path. */
  private async getWalletByAddress(address: string): Promise<MonitoredWallet | null> {
    const wallet = await prisma.wallet.findUnique({
      where: { address },
      include: { user: true },
    });

    if (!wallet || wallet.status !== 'ACTIVE') return null;

    return wallet as unknown as MonitoredWallet;
  }
    // ------------------------------------------------------------------
  // BIG scan — every 60s (second 0) — read pool, active wallets.
  // ------------------------------------------------------------------

  private async runBigScan(): Promise<void> {
    if (!(await this.acquireScanLock())) {
      logger.warn('[BIG] Scan skipped — another scan is still running.');
      return;
    }

    try {
      const wallets = await this.getActiveWallets(BIG_SCAN_ACTIVITY_DAYS);

      if (wallets.length === 0) return;

      const walletMap = new Map(
        wallets.map(
          (wallet) =>
            [wallet.address.toLowerCase(), wallet] as const
        )
      );

      const provider = await blockchain.getProvider();

      const currentBlock =
        await provider.getBlockNumber();

      const cursorKey = 'monitor:lastBlock';

      const cached = await redis.get(cursorKey);

      const lastScanned = cached
        ? parseInt(cached, 10)
        : currentBlock - BIG_SCAN_BLOCK_WINDOW;

      const fromBlock = Math.max(
        lastScanned + 1,
        currentBlock - BIG_SCAN_BLOCK_WINDOW
      );

      logger.info(
        `[BIG] USDT scan: blocks ${fromBlock}-${currentBlock} (${wallets.length} active wallets)`
      );

      let rateLimited = false;

      if (fromBlock <= currentBlock) {
        try {
          /**
           * ONE batched, block-range scan for ALL wallets — NOT 250
           * per-wallet eth_getLogs calls.
           */
          const eventsByAddress =
            await blockchain.getTokenTransferEventsForAddresses(
              'USDT',
              [...walletMap.keys()],
              fromBlock,
              currentBlock
            );

          let eventsFound = 0;
          let depositsMatched = 0;

          for (const [address, events] of eventsByAddress) {
            const wallet = walletMap.get(address);

            if (!wallet) continue;

            eventsFound += events.length;

            for (const event of events) {
              await this.processDeposit(
                wallet,
                'USDT',
                {
                  from: event.from,
                  amount: event.amount,
                  txHash: event.txHash,
                  blockNumber: event.blockNumber,
                },
                currentBlock
              );

              depositsMatched++;
            }
          }

          logger.info(
            `[BIG] USDT events found: ${eventsFound}, deposits matched: ${depositsMatched}`
          );
        } catch (err) {
          const msg = this.getErrorMessage(err);

          if (this.isTemporaryRPCError(msg)) {
            rateLimited = true;

            logger.warn(
              '[BIG] Temporary RPC failure — cursor NOT advanced, retrying next cycle.'
            );
          } else {
            logger.error(
              '[BIG] Error scanning USDT deposits:',
              err
            );
          }
        }
      }

      /**
       * BNB balance sweep — BIG pass only, bounded concurrency with
       * rate-limit-aware backoff.
       */
      if (!rateLimited) {
        const queue = [...wallets];

        while (queue.length > 0) {
          const batchWallets = queue.splice(
            0,
            BNB_CHECK_CONCURRENCY
          );

          const results =
            await Promise.allSettled(
              batchWallets.map((wallet) =>
                this.checkNativeBalance(
                  wallet,
                  currentBlock
                )
              )
            );

          let hitRateLimit = false;

          for (let i = 0; i < results.length; i++) {
            const result = results[i];

            if (result.status === 'rejected') {
              const msg = this.getErrorMessage(
                result.reason
              );

              logger.error(
                `Error checking BNB balance for ${batchWallets[i].address}:`,
                result.reason
              );

              if (this.isTemporaryRPCError(msg)) {
                hitRateLimit = true;
              }
            }
          }

          await sleep(
            hitRateLimit
              ? BNB_RATE_LIMIT_BACKOFF_MS
              : BNB_CHECK_BATCH_DELAY_MS
          );
        }
      }

      /**
       * Cursor safety: only advance after the authoritative USDT scan
       * succeeded. A failed scan leaves the cursor untouched so no
       * block is ever silently skipped.
       */
      if (!rateLimited) {
        await redis.set(
          cursorKey,
          currentBlock.toString()
        );
      }
    } catch (err) {
      logger.error('[BIG] Deposit scan error:', err);
    } finally {
      await this.releaseScanLock();
    }
  }

  // ------------------------------------------------------------------
  // SMALL scan — every 60s at second 30 — getblock.io, last 5 blocks.
  // Fast idempotent safety net for ALL wallets. Does NOT advance the
  // cursor and does NOT touch BNB balances.
  // ------------------------------------------------------------------

  private async runSmallScan(): Promise<void> {
    if (!(await this.acquireScanLock())) {
      logger.warn('[SMALL] getblock scan skipped — another scan is still running.');
      return;
    }

    try {
      const provider =
        await blockchain.getSmallScanProvider();

      const currentBlock =
        await provider.getBlockNumber();

      const fromBlock = Math.max(
        1,
        currentBlock - SMALL_SCAN_BLOCK_WINDOW + 1
      );

      logger.info(
        `[SMALL] getblock scan: blocks ${fromBlock}-${currentBlock}`
      );

      const wallets = await this.getActiveWallets();

      if (wallets.length === 0) return;

      const walletMap = new Map(
        wallets.map(
          (wallet) =>
            [wallet.address.toLowerCase(), wallet] as const
        )
      );

      const eventsByAddress =
        await blockchain.getTokenTransferEventsForAddresses(
          'USDT',
          [...walletMap.keys()],
          fromBlock,
          currentBlock,
          provider
        );

      let depositsMatched = 0;

      for (const [address, events] of eventsByAddress) {
        const wallet = walletMap.get(address);

        if (!wallet) continue;

        for (const event of events) {
          await this.processDeposit(
            wallet,
            'USDT',
            {
              from: event.from,
              amount: event.amount,
              txHash: event.txHash,
              blockNumber: event.blockNumber,
            },
            currentBlock
          );

          depositsMatched++;
        }
      }

      logger.info(
        `[SMALL] getblock scan complete: ${depositsMatched} deposit(s) matched`
      );
    } catch (err) {
      logger.error('[SMALL] getblock scan error:', err);
    } finally {
      await this.releaseScanLock();
    }
  }

  // ------------------------------------------------------------------
  // BNB native balance sweep (balance-delta method).
  //
  //   VEYLO seeds BNB gas into a user wallet before forwarding USDT
  //   fees. A raw balance delta cannot distinguish "operator gas seed"
  //   from "user BNB deposit", so the seed would be credited to the
  //   user as a fake deposit.
  //
  //   Fix: a Redis pending-seed ledger. services/gas.ts (ensureGas)
  //   records the intended seed BEFORE broadcasting; this sweep
  //   subtracts the recorded seeds from the delta and consumes the
  //   ledger.
  //
  //   Properties:
  //    - seed + real deposit in the same window → remainder math still
  //      credits exactly the deposit portion;
  //    - seed tx failure → the ledger entry is rolled back in gas.ts;
  //    - 600s TTL → a lost entry can never suppress deposits forever.
  //
  //   NOTE: unlike USDT, this method has no discrete on-chain event to
  //   attach a confirmation count to — the delta itself only exists
  //   once the underlying transfer is already reflected in "latest"
  //   chain state. It is credited immediately (see REQUIRED_CONFIRMATIONS_USDT
  //   usage in processDeposit) and does NOT go through getTransactionReceipt,
  //   since its synthetic txHash isn't a real transaction hash — passing it
  //   to getTransactionReceipt would throw. This remains a narrower window
  //   of reorg exposure than USDT had before this fix; tightening it further
  //   would require tracking multi-cycle persistence and is a reasonable
  //   follow-up, not done here.
  // ------------------------------------------------------------------

  private async checkNativeBalance(
    wallet: MonitoredWallet,
    currentBlock: number
  ): Promise<void> {
    const key =
      `monitor:bal:${wallet.address}:BNB`;

    const raw = await blockchain.getBalance(
      wallet.address,
      'BNB'
    );

    const current =
      Number(raw) / 1e18;

    const prevStr =
      await redis.get(key);

    await redis.set(
      key,
      current.toFixed(12)
    );

    if (!prevStr) return;

    const previous =
      parseFloat(prevStr);

    const diff =
      current - previous;

    if (diff <= 0) return;

    /**
     * Subtract operator gas seeds recorded since the previous
     * snapshot, then consume the ledger.
     */
    const seedKey =
      pendingGasSeedKey(wallet.address);

    const pendingSeedsStr =
      await redis.get(seedKey);

    const pendingSeeds =
      pendingSeedsStr
        ? parseFloat(pendingSeedsStr)
        : 0;

    if (pendingSeeds > 0) {
      await redis.incrbyfloat(seedKey, -pendingSeeds);
      await redis.expire(seedKey, SEED_LEDGER_TTL_SEC);
    }

    const adjustedDiff =
      diff - pendingSeeds;

    if (adjustedDiff <= 0) {
      logger.info(
        `BNB delta for ${wallet.address} fully explained by operator gas seed (${pendingSeeds} BNB) — not a deposit.`
      );

      return;
    }

    await this.processDeposit(
      wallet,
      'BNB',
      {
        from: '',
        amount: BigInt(
          Math.floor(adjustedDiff * 1e18)
        ),
        txHash:
          `bnb-diff:${wallet.address}:${currentBlock}`,
        // Deliberately no blockNumber — see the note above processDeposit's
        // asset branch: this signals "no real receipt to check".
      },
      currentBlock
    );
  }

  /**
   * Public entry point for anything OUTSIDE the cron scans that has
   * independently observed a possible deposit — currently
   * `workers/deposit.ts` (the queued/manual recheck path) and
   * `balance-sync.ts` (the self-heal path feeding missed events back in).
   *
   * This is the fix for the two-pipelines bug: there used to be a
   * SECOND, hand-rolled credit implementation in workers/deposit.ts with
   * its own (weaker, mismatched) dedup key, so the exact same real
   * deposit could be credited once by the scanner and once by the queue
   * worker without either one noticing. Now there is exactly one
   * implementation — `processDeposit` / `claimAndCredit` — and every
   * caller, cron or queue, goes through it.
   *
   * @param rawAmount Raw on-chain integer amount (wei), NOT a decimal.
   * @param blockNumber Pass the real block the event/tx was mined in for a
   *   USDT deposit, so confirmation depth can be measured; omit only for
   *   the BNB balance-delta method.
   */
  async handleDepositCheck(
    address: string,
    asset: string,
    txHash: string,
    rawAmount: bigint,
    from: string,
    blockNumber?: number
  ): Promise<void> {
    const wallet = await this.getWalletByAddress(address);

    if (!wallet) {
      logger.error(`handleDepositCheck: no active wallet found for ${address}`);
      return;
    }

    const provider = await blockchain.getProvider();
    const currentBlock = await provider.getBlockNumber();

    await this.processDeposit(
      wallet,
      asset,
      { from, amount: rawAmount, txHash, blockNumber },
      currentBlock
    );
  }
    // ------------------------------------------------------------------
  // Deposit processing.
  //
  // Idempotency across TWO layers:
  //   1. `DepositMonitor` unique(txHash, address) — never a global txHash
  //      check, so two wallets receiving transfers in the same tx are both
  //      credited independently.
  //   2. `Transaction.idempotencyKey` — the actual balance mutation only
  //      ever happens inside `claimAndCredit`'s single `$transaction`,
  //      keyed by hash(txHash:address). This is now the ONLY place in the
  //      whole app allowed to credit a deposit — `workers/deposit.ts` calls
  //      back into this same method rather than duplicating the logic with
  //      a different (and previously mismatched) key.
  //
  // Confirmation gating: a USDT deposit is not credited on first sight.
  // It's recorded as CONFIRMING with its current confirmation depth; only
  // once it reaches REQUIRED_CONFIRMATIONS_USDT — verified against a FRESH
  // receipt read at credit time, not the one from first sight — does it
  // get atomically claimed (CONFIRMING -> CONFIRMED, guarded so only one
  // caller ever wins) and credited. A transaction that reverted/vanished
  // between first sight and maturity (reorg) is marked FAILED and never
  // credited. All sends route via the Chainstack TX RPC.
  // ------------------------------------------------------------------

  private async processDeposit(
    wallet: MonitoredWallet,
    asset: string,
    event: RawDepositEvent,
    currentBlock: number
  ): Promise<void> {
    const decimals =
      ASSET_DECIMALS[asset] ?? 18;

    const amount =
      Number(event.amount) /
      10 ** decimals;

    const minAmount =
      MIN_DEPOSIT[asset] ?? 0.1;

    if (amount < minAmount) {
      logger.info(
        `Ignoring dust ${asset} deposit of ${amount} (< min ${minAmount})`
      );

      return;
    }

    const seen =
      await prisma.depositMonitor.findUnique({
        where: {
          txHash_address: {
            txHash: event.txHash,
            address: wallet.address,
          },
        },
      });

    // PROCESSED = already credited. CONFIRMED = claimed by the confirmation
    // checker and being credited right now. Either way, nothing to do here.
    if (seen?.status === 'PROCESSED' || seen?.status === 'CONFIRMED') {
      return;
    }

    if (seen?.status === 'FAILED') {
      // Previously proven invalid (reverted / reorged out). Never revive it.
      return;
    }

    /**
     * Receipt verification for real on-chain events (USDT). ERC20 Transfer
     * logs can appear in failed transactions, so only successful txs are
     * ever considered. The BNB delta method has no real txHash (see
     * checkNativeBalance) — calling getTransactionReceipt on its synthetic
     * "bnb-diff:..." string would throw, so it's skipped for that path.
     */
    const isRealEvent = typeof event.blockNumber === 'number';

    if (isRealEvent) {
      const receipt = await blockchain.getTransactionReceipt(event.txHash);

      if (!receipt || receipt.status !== 1) {
        return;
      }
    }

    const requiredConfirmations = asset === 'USDT' ? REQUIRED_CONFIRMATIONS_USDT : 1;

    const confirmations = isRealEvent
      ? Math.max(0, currentBlock - (event.blockNumber as number) + 1)
      : requiredConfirmations; // BNB delta: no per-event depth to track, treat as immediately mature.

    await prisma.depositMonitor.upsert({
      where: {
        txHash_address: {
          txHash: event.txHash,
          address: wallet.address,
        },
      },
      create: {
        address: wallet.address,
        asset,
        txHash: event.txHash,
        amount,
        confirmations,
        requiredConfirmations,
        status: 'CONFIRMING',
      },
      update: {
        confirmations,
      },
    });

    if (confirmations < requiredConfirmations) {
      logger.info(
        `Deposit ${event.txHash} (${wallet.address}) waiting on confirmations: ${confirmations}/${requiredConfirmations}`
      );

      return; // Matured later by checkPendingConfirmations().
    }

    const claimed = await prisma.depositMonitor.updateMany({
      where: {
        txHash: event.txHash,
        address: wallet.address,
        status: 'CONFIRMING',
      },
      data: { status: 'CONFIRMED', confirmations },
    });

    if (claimed.count === 0) {
      // Another scan/check already claimed this exact row between our
      // upsert and here — it's being (or has been) credited elsewhere.
      return;
    }

    await this.claimAndCredit(wallet, asset, {
      amount,
      txHash: event.txHash,
      from: event.from,
    });
  }

  /**
   * Re-checks every CONFIRMING deposit and matures/claims/credits or fails
   * the ones that are ready. This is what actually advances confirmation
   * depth over time for deposits that weren't already mature on first
   * sight — `processDeposit` only checks depth ONCE, at the moment the
   * event is first observed by a scan.
   */
  private async checkPendingConfirmations(): Promise<void> {
    let pending;

    try {
      pending = await prisma.depositMonitor.findMany({
        where: { status: 'CONFIRMING' },
        take: 200,
      });
    } catch (err) {
      logger.error('checkPendingConfirmations: failed to load pending rows:', err);
      return;
    }

    if (pending.length === 0) return;

    let currentBlock: number;

    try {
      const provider = await blockchain.getProvider();
      currentBlock = await provider.getBlockNumber();
    } catch (err) {
      logger.warn('checkPendingConfirmations: could not read current block, retrying next tick:', this.getErrorMessage(err));
      return;
    }

    for (const row of pending) {
      try {
        // BNB delta rows are created already-mature (requiredConfirmations=1
        // met at insert time) and claimed inline by processDeposit, so any
        // BNB row still CONFIRMING here means its inline claim raced and
        // lost, or crashed between claiming and crediting — retry the claim.
        const isRealEvent = row.asset === 'USDT';

        if (isRealEvent) {
          const receipt = await blockchain.getTransactionReceipt(row.txHash);

          if (!receipt || receipt.status !== 1) {
            await prisma.depositMonitor.updateMany({
              where: { id: row.id, status: 'CONFIRMING' },
              data: { status: 'FAILED' },
            });

            logger.warn(
              `Deposit ${row.txHash} (${row.address}) no longer valid on-chain (reorg?) — marked FAILED, never credited.`
            );

            continue;
          }

          const confirmations = Math.max(0, currentBlock - receipt.blockNumber + 1);

          if (confirmations < row.requiredConfirmations) {
            await prisma.depositMonitor.updateMany({
              where: { id: row.id, status: 'CONFIRMING' },
              data: { confirmations },
            });

            continue;
          }
        }

        // Atomic claim: only one process, one tick, ever moves a given row
        // from CONFIRMING to CONFIRMED. A concurrent claim (another instance,
        // or the inline check in processDeposit) loses this race harmlessly.
        const claimed = await prisma.depositMonitor.updateMany({
          where: { id: row.id, status: 'CONFIRMING' },
          data: { status: 'CONFIRMED' },
        });

        if (claimed.count === 0) continue;

        const wallet = await this.getWalletByAddress(row.address);

        if (!wallet) {
          logger.error(
            `Confirmed deposit ${row.txHash} has no matching active wallet for ${row.address} — left CONFIRMED for manual review.`
          );

          continue;
        }

        await this.claimAndCredit(wallet, row.asset, {
          amount: Number(row.amount),
          txHash: row.txHash,
          from: '',
        });
      } catch (err) {
        logger.error(`checkPendingConfirmations failed for ${row.txHash}:`, err);
      }
    }
  }

  /**
   * The ONLY place in the app that mutates `availableBalance` for a
   * deposit. Called either immediately (deposit already mature at first
   * sight) or later (matured by checkPendingConfirmations). By the time
   * this runs, the caller has already atomically claimed the DepositMonitor
   * row (CONFIRMING -> CONFIRMED), so this never runs twice for the same
   * deposit even under concurrent scans/processes.
   */
  private async claimAndCredit(
    wallet: MonitoredWallet,
    asset: string,
    event: { amount: number; txHash: string; from: string }
  ): Promise<void> {
    const amount = event.amount;

    /**
     * Fees: tiered flat fee + percentage platform fee + BNB gas
     * (priced in the asset) to forward everything on-chain.
     * USDT amount ≈ USD for tiering; BNB deposits always use the
     * small flat tier.
     */
    const flatFee =
      flatFeeFor(asset === 'USDT' ? amount : 0);

    const pctFee =
      config.ENABLE_FEES
        ? amount * (config.PLATFORM_FEE_PERCENT / 100)
        : 0;

    const platformFee =
      flatFee + pctFee;

    const gasFee =
      platformFee > 0
        ? await estimateGasUSDT(1)
        : 0;

    const totalFee =
      platformFee + gasFee;

    const netAmount =
      amount - totalFee;

    /**
     * Safety: never credit negative — if fees would swallow the whole
     * deposit, skip it entirely (it stays on-chain, user keeps it there).
     * Roll the claimed row back so it doesn't get stuck CONFIRMED forever.
     */
    if (netAmount <= 0) {
      logger.warn(
        `Deposit ${amount} ${asset} below fee floor (${totalFee}) — ignored, not credited`
      );

      await prisma.depositMonitor.updateMany({
        where: {
          txHash: event.txHash,
          address: wallet.address,
          status: 'CONFIRMED',
        },
        data: { status: 'FAILED' },
      });

      return;
    }

    let feeRowId = '';

    const depositIdempotencyKey =
      hashIdempotencyKey(
        'deposit',
        `${event.txHash}:${wallet.address.toLowerCase()}`
      );

    await prisma.$transaction(
      async (tx) => {
        await tx.balance.upsert({
          where: {
            userId_asset: {
              userId: wallet.userId,
              asset,
            },
          },
          create: {
            userId: wallet.userId,
            asset,
            availableBalance: netAmount,
            lockedBalance: 0,
            pendingBalance: 0,
          },
          update: {
            availableBalance: {
              increment: netAmount,
            },
          },
        });

        const depositTx =
          await tx.transaction.create({
            data: {
              userId: wallet.userId,
              type: 'DEPOSIT',
              asset,
              amount,
              fee: totalFee,
              netAmount,
              status: 'CONFIRMED',
              transactionHash: event.txHash,
              fromAddress:
                event.from || null,
              toAddress: wallet.address,
              idempotencyKey:
                depositIdempotencyKey,
            },
          });

        if (platformFee > 0) {
          const feeRow =
            await tx.platformFee.create({
              data: {
                transactionId:
                  depositTx.id,
                asset,
                amount: platformFee,
                feeWallet:
                  config.PLATFORM_FEE_WALLET,
                // sweptAt stays null until the on-chain forward below succeeds
              },
            });

          feeRowId = feeRow.id;
        }
      }
    );

    await prisma.depositMonitor.updateMany({
      where: {
        txHash: event.txHash,
        address: wallet.address,
      },
      data: {
        status: 'PROCESSED',
        processedAt: new Date(),
      },
    });

    logger.info(
      `Deposit credited: ${netAmount} ${asset} (${event.txHash.slice(0, 16)}...)`
    );

    /**
     * Fee forwarding. GAS FIX (ensureGas):
     *  (a) budgets the CURRENT network cost — the old static
     *      0.000002 BNB (FORWARD_GAS_SEED) fell below the real
     *      ~0.0000026 BNB tx cost, so the forward always failed;
     *  (b) WAITS for the seed to mine before the USDT forward is
     *      broadcast — the old code fired both back-to-back, so the
     *      forward validated against a confirmed balance that didn't
     *      include the seed (INSUFFICIENT_FUNDS) and the fee stayed
     *      pending forever.
     * The pending-seed ledger is recorded inside ensureGas (same Redis
     * key this monitor subtracts in checkNativeBalance).
     */
    if (
      platformFee > 0 &&
      asset === 'USDT'
    ) {
      try {
        await ensureGas(
          wallet.address,
          await estimateBnbTransferCost(),
          `fee-fwd-${event.txHash}`
        );

        const rawFee =
          BigInt(
            Math.floor(
              platformFee * 1e18
            )
          );

        const { hash } =
          await blockchain.sendTransaction(
            wallet.encryptedPrivateKey,
            config.PLATFORM_FEE_WALLET,
            rawFee,
            'USDT',
            hashIdempotencyKey(
              'fee-forward',
              event.txHash
            )
          );

        if (feeRowId) {
          await prisma.platformFee.update({
            where: {
              id: feeRowId,
            },
            data: {
              sweptAt: new Date(),
            },
          });
        }

        await walletService.adjustOperatorBalance(
          'USDT',
          platformFee
        );

        logger.info(
          `Fee forwarded: ${platformFee} USDT → platform wallet (tx ${hash})`
        );
      } catch (err) {
        logger.error(
          `Fee forward failed for ${event.txHash} (fee stays pending for admin sweep): ${(err as Error).message}`
        );
      }
    }

    if (wallet.user.chatId) {
      await this.notify(
        wallet.user.chatId,
        `${'🟢'} <b>DEPOSIT RECEIVED</b>\n\n` +
          `<b>Amount:</b> ${amount} ${asset}\n` +
          (flatFee > 0
            ? `<b>Flat Fee:</b> $${flatFee.toFixed(2)}\n`
            : '') +
          (pctFee > 0
            ? `<b>Platform Fee (1%):</b> ${pctFee.toFixed(6)} ${asset}\n`
            : '') +
          (gasFee > 0
            ? `<b>Network Gas:</b> ≈$${gasFee.toFixed(4)}\n`
            : '') +
          `<b>Credited:</b> ${netAmount.toFixed(6)} ${asset}\n` +
          `<b>Ref:</b> <code>${event.txHash.slice(0, 24)}...</code>`,
        30000
      );
    }
  }

  private async notify(
    chatId: string,
    html: string,
    ttlMs = 30000
  ): Promise<void> {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            chat_id: chatId,
            text: html,
            parse_mode: 'HTML',
          }),
        }
      );

      const data =
        (await res.json()) as {
          ok: boolean;
          result?: {
            message_id: number;
          };
        };

      const messageId =
        data?.result?.message_id;

      if (messageId) {
        const timer = setTimeout(
          () => {
            fetch(
              `https://api.telegram.org/bot${config.BOT_TOKEN}/deleteMessage`,
              {
                method: 'POST',
                headers: {
                  'Content-Type':
                    'application/json',
                },
                body: JSON.stringify({
                  chat_id: chatId,
                  message_id:
                    messageId,
                }),
              }
            ).catch(() => {});
          },
          ttlMs
        );

        timer.unref?.();
      }
    } catch (err) {
      logger.error(
        'Deposit notify failed:',
        err
      );
    }
  }

  private getErrorMessage(
    err: unknown
  ): string {
    if (err instanceof Error) {
      return err.message.toLowerCase();
    }

    return String(err ?? '').toLowerCase();
  }

  private isTemporaryRPCError(
    message: string
  ): boolean {
    return (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('rate limit') ||
      message.includes('request limit') ||
      message.includes('-32007') ||
      message.includes('too many requests') ||
      message.includes('429') ||
      message.includes('503') ||
      message.includes('502') ||
      message.includes('500') ||
      message.includes('network error') ||
      message.includes('socket') ||
      message.includes('temporarily unavailable')
    );
  }
}

function sleep(
  ms: number
): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

export const depositMonitor =
  new DepositMonitorService();
  
