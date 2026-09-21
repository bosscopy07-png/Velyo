import { prisma } from '../database';
import { blockchain } from './blockchain';
import { config } from '../config';
import { logger } from '../utils/logger';
import { hashIdempotencyKey } from '../utils/encryption';
import cron from 'node-cron';

/** Ignore differences smaller than this (chain dust / rounding) */
const SYNC_TOLERANCE: Record<string, number> = {
  USDT: 0.001,
  BNB: 0.00001,
};

const SYNC_ASSETS = ['USDT', 'BNB'] as const;
type SyncAsset = (typeof SYNC_ASSETS)[number];

// Every 5 minutes at second 30 — deliberately offset from the deposit monitor
// (second 0 of every minute) so the two never burst the RPC simultaneously
const CRON_SCHEDULE = '30 */5 * * * *';
const SYNC_KEY_WINDOW_MS = 300000; // matches the 5-min cycle

interface SyncContext {
  userId: string;
  address: string;
  asset: SyncAsset;
  onChain: number;
  available: number;
  locked: number;
  unsweptFees: number;
  redeemCredits: number;
  gasRefunds: number;
}

class BalanceSyncService {
  private isRunning = false;

  start(): void {
    cron.schedule(CRON_SCHEDULE, () => void this.syncAll());
    logger.info('Balance sync started (on-chain → DB, every 5 min, offset from deposit monitor)');
  }

  private async syncAll(): Promise<void> {
    if (this.isRunning) return; // prevent overlapping runs
    this.isRunning = true;

    try {
      const wallets = await prisma.wallet.findMany({
        where: {
          status: 'ACTIVE',
          // Operator wallet is synced explicitly via adjustOperatorBalance —
          // its on-chain balance legitimately differs from any user ledger
          address: { not: config.PLATFORM_FEE_WALLET },
        },
      });

      let rateLimited = false;
      for (const wallet of wallets) {
        for (const asset of SYNC_ASSETS) {
          try {
            await this.syncOne(wallet.userId, wallet.address, asset);
          } catch (err) {
            const msg = (err as Error).message ?? '';
            if (msg.includes('rate limit') || msg.includes('-32005') || msg.includes('limit exceeded')) {
              rateLimited = true;
              logger.warn('Balance sync: rate limited — aborting this cycle, next window retries.');
              break;
            }
            logger.error(`Balance sync failed for ${wallet.address} ${asset}: ${msg}`);
          }
          // Pace calls so wallets don't burst the RPC in one batch
          await sleep(400);
        }
        if (rateLimited) break;
        await sleep(500);
      }
    } catch (err) {
      logger.error('Balance sync run failed:', err);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * expectedOnChain = available + locked + unsweptFees − redeemCredits − gasRefunds
   *
   *   available     → user's spendable balance (what they could withdraw)
   *   locked        → giveaway escrow held for the creator
   *   unsweptFees   → USDT fees owed to platform, still sitting in the wallet
   *   redeemCredits → USDT credited via redeem codes, NOT funded on-chain
   *   gasRefunds    → USDT refunded for unused seeded BNB (reclaimGas) —
   *                   app credit, no on-chain movement
   *
   * Anything beyond tolerance = a movement the deposit monitor missed → self-heal.
   */
  private async syncOne(userId: string, address: string, asset: SyncAsset): Promise<void> {
    const ctx = await this.gatherState(userId, address, asset);

    // NEVER heal a debtor: a negative available balance means the user owes
    // the platform (phantom-era over-credit). Matching on-chain by crediting
    // them would mint money from nothing. Their balance stays negative until
    // real deposits cover it.
    const tol = SYNC_TOLERANCE[asset] ?? 0.000001;
    if (ctx.available < -tol) {
      logger.warn(
        `Balance sync (${asset}) ${address}: debtor (available ${ctx.available.toFixed(6)}) — skipped, no auto-credit`
      );
      return;
    }

    const expected =
      ctx.available + ctx.locked + ctx.unsweptFees - ctx.redeemCredits - ctx.gasRefunds;
    const diff = ctx.onChain - expected;

    if (Math.abs(diff) < tol) return;

    await this.applyAdjustment(ctx, expected, diff);

    logger.warn(
      `Balance sync (${asset}) ${address}: adjusted ${diff > 0 ? '+' : ''}${diff} ` +
      `(on-chain ${ctx.onChain} vs expected ${expected.toFixed(6)})`
    );
  }

  /** Reads on-chain balance + every app-side component of the expectation. */
  private async gatherState(userId: string, address: string, asset: SyncAsset): Promise<SyncContext> {
    const raw = await blockchain.getBalance(address, asset);
    const onChain = Number(raw) / 1e18;

    const balance = await prisma.balance.findUnique({
      where: { userId_asset: { userId, asset } },
    });

    const [feesAgg, redeemAgg, gasRefundAgg] = await Promise.all([
      prisma.platformFee.aggregate({
        where: { sweptAt: null, asset, transaction: { userId } },
        _sum: { amount: true },
      }),
      prisma.codeRedemption.aggregate({
        where: { userId, code: { asset } },
        _sum: { amount: true },
      }),
      // Gas refunds (kind: 'gas_refund') are app-credit USDT — subtract them
      // from the expectation just like redeem credits.
      prisma.transaction.aggregate({
        where: {
          userId,
          asset,
          type: 'REFUND',
          metadata: { path: ['kind'], equals: 'gas_refund' },
        },
        _sum: { amount: true },
      }),
    ]);

    return {
      userId,
      address,
      asset,
      onChain,
      available: Number(balance?.availableBalance ?? 0),
      locked: Number(balance?.lockedBalance ?? 0),
      unsweptFees: Number(feesAgg._sum.amount ?? 0),
      redeemCredits: Number(redeemAgg._sum.amount ?? 0),
      gasRefunds: Number(gasRefundAgg._sum.amount ?? 0),
    };
  }

  /**
   * Applies the drift correction: nudge `availableBalance` by `diff` and
   * record an audit trail row.
   *
   * Idempotency: adjustments for the same user+asset inside the same 5-minute
   * window share a bucket key. On unique-constraint collision (rare), we log
   * and rethrow so the next tick retries cleanly.
   */
  private async applyAdjustment(ctx: SyncContext, expected: number, diff: number): Promise<void> {
    const bucket = String(Math.floor(Date.now() / SYNC_KEY_WINDOW_MS));

    try {
      await prisma.$transaction(async (tx) => {
        await tx.balance.upsert({
          where: { userId_asset: { userId: ctx.userId, asset: ctx.asset } },
          create: {
            userId: ctx.userId,
            asset: ctx.asset,
            availableBalance: diff,
            lockedBalance: 0,
            pendingBalance: 0,
          },
          update: { availableBalance: { increment: diff } },
        });

        await tx.transaction.create({
          data: {
            userId: ctx.userId,
            type: 'DEPOSIT',
            asset: ctx.asset,
            amount: Math.abs(diff),
            fee: 0,
            netAmount: diff,
            status: 'CONFIRMED',
            idempotencyKey: hashIdempotencyKey('chain-sync', ctx.userId, ctx.asset, bucket),
            metadata: {
              kind: 'chain-sync',
              address: ctx.address,
              onChain: ctx.onChain,
              expected,
              diff,
            },
          },
        });
      });
    } catch (err) {
      logger.warn(
        `Balance sync adjustment for ${ctx.address} ${ctx.asset} deferred: ${(err as Error).message}`
      );
      throw err;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const balanceSync = new BalanceSyncService();
