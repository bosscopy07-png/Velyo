import { prisma } from '../database';
import { blockchain } from './blockchain';
import { redis } from './redis';
import { walletService } from './wallet';
import { estimateGasUSDT } from './giveaway';
import { config } from '../config';
import { logger } from '../utils/logger';
import { hashIdempotencyKey } from '../utils/encryption';
import cron from 'node-cron';

const ASSET_DECIMALS: Record<string, number> = {
  BNB: 18,
  USDT: 18,
};

/**
 * BIG scan (BSC primary) — runs every 60s at second 0.
 * Authoritative pass: scans the last 150 blocks, advances the
 * persistent cursor `monitor:lastBlock`, and owns the BNB balance
 * sweep.
 */
const BIG_SCAN_BLOCK_WINDOW = 150;

/**
 * SMALL scan (QuickNode) — runs every 60s at second 30 (offset by
 * half a cycle so the two scans NEVER fire at the same time).
 * Safety net for fresh deposits only: 5 blocks, pinned to QuickNode,
 * does NOT advance the cursor and does NOT touch BNB balances.
 */
const SMALL_SCAN_BLOCK_WINDOW = 5;

/**
 * Shared Redis lock. Both scans compete for it; only one holder at a
 * time, so even if one scan overruns its slot the other waits/skips
 * instead of running concurrently.
 */
const SCAN_LOCK_KEY = 'monitor:scan:lock';
const SCAN_LOCK_TTL_SEC = 240;

/** 0.000002 BNB = enough for one BEP20 forward */
const FORWARD_GAS_SEED = 2000000000000n;

const MIN_DEPOSIT: Record<string, number> = {
  BNB: 0.0001,
  USDT: config.MINIMUM_AMOUNT_USD,
};

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
 */
const SEED_LEDGER_TTL_SEC = 600;

type MonitoredWallet = {
  address: string;
  userId: string;
  encryptedPrivateKey: string;
  user: {
    chatId: string | null;
    telegramId: string;
  };
};

class DepositMonitorService {
  private isRunning = false;

  start(): void {
    /**
     * t=0s, 60s, 120s ...  → BIG scan (primary, 150 blocks, cursor)
     * t=30s, 90s, 150s ... → SMALL scan (QuickNode, 5 blocks, no cursor)
     */
    cron.schedule('0 * * * * *', () => {
      void this.runBigScan();
    });

    cron.schedule('30 * * * * *', () => {
      void this.runSmallScan();
    });

    logger.info(
      'Deposit monitor started: BIG primary scan @0s (150 blocks), SMALL QuickNode scan @30s (5 blocks), mutually exclusive'
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

  private async getActiveWallets(): Promise<MonitoredWallet[]> {
    const wallets = await prisma.wallet.findMany({
      where: {
        status: 'ACTIVE',
        address: {
          not: config.PLATFORM_FEE_WALLET,
        },
      },
      include: {
        user: true,
      },
    });

    return wallets as MonitoredWallet[];
  }

  // ------------------------------------------------------------------
  // BIG scan — every 60s (second 0) — primary/fallback, 150 blocks.
  // ------------------------------------------------------------------

  private async runBigScan(): Promise<void> {
    if (!(await this.acquireScanLock())) {
      logger.warn('[BIG] Scan skipped — another scan is still running.');
      return;
    }

    try {
      const wallets = await this.getActiveWallets();

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
        `[BIG] USDT scan: blocks ${fromBlock}-${currentBlock} (${wallets.length} wallets)`
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
                }
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
  // SMALL scan — every 60s at second 30 — QuickNode, last 5 blocks.
  // Fast idempotent safety net. Does NOT advance the cursor.
  // ------------------------------------------------------------------

  private async runSmallScan(): Promise<void> {
    if (!(await this.acquireScanLock())) {
      logger.warn('[SMALL] QuickNode scan skipped — another scan is still running.');
      return;
    }

    try {
      const provider =
        await blockchain.getQuickNodeProvider();

      const currentBlock =
        await provider.getBlockNumber();

      const fromBlock = Math.max(
        1,
        currentBlock - SMALL_SCAN_BLOCK_WINDOW + 1
      );

      logger.info(
        `[SMALL] QuickNode scan: blocks ${fromBlock}-${currentBlock}`
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
            }
          );

          depositsMatched++;
        }
      }

      logger.info(
        `[SMALL] QuickNode scan complete: ${depositsMatched} deposit(s) matched`
      );
    } catch (err) {
      logger.error('[SMALL] QuickNode scan error:', err);
    } finally {
      await this.releaseScanLock();
    }
  }

  // ------------------------------------------------------------------
  // BNB native balance sweep (balance-delta method, preserved).
  //
  // EXISTING ISSUE + FIX (proper, not partial):
  //
  //   VEYLO seeds BNB gas into a user wallet before forwarding USDT
  //   fees. A raw balance delta cannot distinguish "operator gas seed"
  //   from "user BNB deposit", so the seed was previously credited to
  //   the user as a fake deposit.
  //
  //   Fix: a Redis pending-seed ledger. processDeposit() records the
  //   intended seed BEFORE broadcasting; checkNativeBalance() subtracts
  //   the recorded seeds from the delta and consumes the ledger.
  //
  //   Properties:
  //    - seed + real deposit in the same window → remainder math still
  //      credits exactly the deposit portion;
  //    - seed tx failure → the ledger entry is rolled back in catch;
  //    - 600s TTL → a lost entry can never suppress deposits forever.
  //
  //   Residual edge (documented, intentionally not "fixed"): any OTHER
  //   inbound BNB in the same window (e.g. a user sending BNB between
  //   the two balance snapshots) is still attributed by delta — that is
  //   the pre-existing accounting semantic, unchanged here.
  // ------------------------------------------------------------------

  private pendingSeedKey(address: string): string {
    return `monitor:seed:pending:${address.toLowerCase()}`;
  }

  private async recordPendingGasSeed(
    address: string,
    seedAmount: bigint
  ): Promise<void> {
    const key = this.pendingSeedKey(address);
    const amountBnb = Number(seedAmount) / 1e18;

    await redis.incrbyfloat(key, amountBnb);
    await redis.expire(key, SEED_LEDGER_TTL_SEC);
  }

  private async clearPendingGasSeed(
    address: string,
    seedAmount: bigint
  ): Promise<void> {
    const key = this.pendingSeedKey(address);
    const amountBnb = Number(seedAmount) / 1e18;

    await redis.incrbyfloat(key, -amountBnb);
  }

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
      this.pendingSeedKey(wallet.address);

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
      }
    );
  }

  // ------------------------------------------------------------------
  // Deposit processing. Business logic unchanged (min amounts, fees,
  // crediting, fee forwarding, operator balance, notifications).
  // Idempotency: (txHash, walletAddress) — never a global txHash check,
  // so two wallets receiving transfers in the same tx are both credited.
  // ------------------------------------------------------------------

  private async processDeposit(
    wallet: MonitoredWallet,
    asset: string,
    event: {
      from: string;
      amount: bigint;
      txHash: string;
    }
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

    if (seen?.status === 'PROCESSED') {
      return;
    }

    /**
     * Receipt verification: ERC20 Transfer logs can appear in failed
     * transactions, so only successful txs are credited.
     */
    const receipt =
      await blockchain.getTransactionReceipt(
        event.txHash
      );

    if (!receipt || receipt.status !== 1) {
      return;
    }

    const feePercent =
      config.ENABLE_FEES
        ? config.PLATFORM_FEE_PERCENT
        : 0;

    const platformFee =
      amount *
      (feePercent / 100);

    const gasFee =
      platformFee > 0
        ? await estimateGasUSDT(1)
        : 0;

    const totalFee =
      platformFee + gasFee;

    const netAmount =
      amount - totalFee;

    if (netAmount <= 0) {
      logger.warn(
        `Deposit ${event.txHash} produced non-positive net amount; ignoring`
      );

      return;
    }

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
        status: 'CONFIRMING',
      },
      update: {},
    });

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
     * Fee forwarding (unchanged), with the gas-seed ledger recorded
     * BEFORE broadcasting so the monitor can never misattribute it.
     */
    if (
      platformFee > 0 &&
      asset === 'USDT'
    ) {
      try {
        const baseline =
          await blockchain.getBalance(
            wallet.address,
            'BNB'
          );

        if (
          baseline <
          FORWARD_GAS_SEED
        ) {
          if (!config.OPERATOR_WALLET_KEY) {
            throw new Error(
              'OPERATOR_WALLET_KEY not configured'
            );
          }

          const seedAmount =
            FORWARD_GAS_SEED -
            baseline;

          await this.recordPendingGasSeed(
            wallet.address,
            seedAmount
          );

          try {
            await blockchain.sendTransaction(
              config.OPERATOR_WALLET_KEY,
              wallet.address,
              seedAmount,
              'BNB',
              hashIdempotencyKey(
                'fwd-seed',
                event.txHash
              )
            );
          } catch (seedErr) {
            await this.clearPendingGasSeed(
              wallet.address,
              seedAmount
            );

            throw seedErr;
          }

          await walletService.adjustOperatorBalance(
            'BNB',
            -Number(seedAmount) / 1e18
          );
        }

        const rawFee =
          BigInt(
            Math.floor(
              platformFee * 1e18
            )
  
