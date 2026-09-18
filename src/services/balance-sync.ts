import { prisma } from '../database';
import { blockchain } from './blockchain';
import { config } from '../config';
import { logger } from '../utils/logger';
import { hashIdempotencyKey } from '../utils/encryption';
import cron from 'node-cron';

/** Ignore differences smaller than this (chain dust / rounding) */
const SYNC_TOLERANCE: Record<string, number> = {
  USDT: 0.000001,
  BNB: 0.0000001,
};

const SYNC_ASSETS = ['USDT', 'BNB'] as const;
type SyncAsset = (typeof SYNC_ASSETS)[number];

const CRON_SCHEDULE = '*/2 * * * *'; // every 2 minutes
const SYNC_KEY_WINDOW_MS = 120000;

interface SyncContext {
  userId: string;
  address: string;
  asset: SyncAsset;
  onChain: number;
  available: number;
  locked: number;
  unsweptFees: number;
  redeemCredits: number;
}

class BalanceSyncService {
  private isRunning = false;

  start(): void {
    cron.schedule(CRON_SCHEDULE, () => void this.syncAll());
    logger.info('Balance sync started (on-chain → DB, every 2 min)');
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

      for (const wallet of wallets) {
        for (const asset of SYNC_ASSETS) {
          try {
            await this.syncOne(wallet.userId, wallet.address, asset);
          } catch (err) {
            logger.error(
              `Balance sync failed for ${wallet.address} ${asset}: ${(err as Error).message}`
            );
          }
        }
      }
    } catch (err) {
      logger.error('Balance sync run failed:', err);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * expectedOnChain = available + locked + unsweptFees − redeemCredits
   *
   *   available     → user's spendable balance (what they could withdraw)
   *   locked        → giveaway escrow held for the creator
   *   unsweptFees   → USDT fees owed to platform, still sitting in the wallet
   *   redeemCredits → USDT credited to the user's app balance via redeem codes,
   *                   NOT yet funded on-chain (code redemptions are app-side)
   *
   * Anything beyond tolerance = a movement the deposit monitor missed → self-heal.
   */
  private async syncOne(userId: string, address: string, asset: SyncAsset): Promise<void> {
    const ctx = await this.gatherState(userId, address, asset);

    const expected = ctx.available + ctx.locked + ctx.unsweptFees - ctx.redeemCredits;
    const diff = ctx.onChain - expected;

    if (Math.abs(diff) < (SYNC_TOLERANCE[asset] ?? 0.000001)) return;

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

    const [feesAgg, redeemAgg] = await Promise.all([
      prisma.platformFee.aggregate({
        where: { sweptAt: null, asset, transaction: { userId } },
        _sum: { amount: true },
      }),
      prisma.codeRedemption.aggregate({
        where: { userId, code: { asset } },
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
    };
  }

  /**
   * Applies the drift correction: nudge `availableBalance` by `diff` and
   * record an audit trail row.
   *
   * Idempotency: two adjustments for the same user+asset inside the same
   * 2-minute window share a bucket key. If a collision occurs (rare — drift
   * is normally one-shot per missed event), the insert fails on the unique
   * constraint; we swallow that specific error and retry next run, since the
   * balance row itself is already correct (upsert-based increment).
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
      // Unique-constraint collision on idempotencyKey — the balance row was
      // already adjusted above (transaction rolled back together though, so
      // retry cleanly on the next sync tick instead).
      logger.warn(
        `Balance sync adjustment for ${ctx.address} ${ctx.asset} deferred: ${(err as Error).message}`
      );
      throw err;
    }
  }
}

export const balanceSync = new BalanceSyncService();
