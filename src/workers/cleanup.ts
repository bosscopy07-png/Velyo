import { prisma } from '../database';
import { logger } from '../utils/logger';
import { computeOutstandingEscrow } from '../services/giveaway';
import cron from 'node-cron';

/**
 * ============================================================================
 * WHY THIS FILE CHANGED
 * ============================================================================
 * Two independent bugs, both fixed here:
 *
 * 1. NO MUTEX. Every other cron in this codebase (claim-expiry.ts,
 *    deposit-monitor.ts, balance-sync.ts) guards against overlapping runs.
 *    This one didn't — an hourly job that runs long (slow DB, many expired
 *    giveaways) could still be running when the next hour's tick fires,
 *    and both instances would happily refund the same giveaway.
 *
 * 2. WRONG REFUND MATH. The old formula was:
 *
 *      refundAmount = totalAmount - claimedCount * amountPerUser
 *
 *    `claimedCount` is a live "currently occupied slots" counter — it's
 *    decremented the moment a claim expires (claim-expiry.ts) or its
 *    payout is permanently unwound (payout.ts), at which point THAT
 *    claim's share is ALSO independently refunded right then. By the
 *    time this hourly job ran, `claimedCount` no longer reflected those
 *    already-refunded slots, so this formula refunded the ENTIRE
 *    remaining pot again — a real double-refund with zero on-chain
 *    footprint (pure DB bookkeeping), showing up as `lockedBalance`
 *    going negative and `availableBalance` inflated by the same amount.
 *    This is exactly the shape phantom balances take here — invisible
 *    to `balance-sync.ts` because `available + locked` never changes,
 *    only the split between them does.
 *
 *    Fixed by using `computeOutstandingEscrow` — the same canonical
 *    calculation `cancelGiveaway` now uses — which derives "how much is
 *    still locked" from actual PAID claims and actual REFUND
 *    transactions already recorded, not from a counter that can drift.
 * ============================================================================
 */

const CRON_SCHEDULE = '0 * * * *'; // every hour, on the hour

class CleanupService {
  private isRunning = false;

  start(): void {
    cron.schedule(CRON_SCHEDULE, () => void this.run());
    logger.info('Cleanup worker started (expired-giveaway sweep, hourly, mutex-guarded)');
  }

  private async run(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Cleanup: previous run still in progress, skipping this tick.');
      return;
    }
    this.isRunning = true;

    try {
      logger.info('Running expired giveaway cleanup...');

      const expired = await prisma.giveaway.findMany({
        where: { status: 'ACTIVE', expiresAt: { lt: new Date() } },
        select: { id: true },
      });

      for (const { id } of expired) {
        try {
          await this.expireOne(id);
        } catch (err) {
          logger.error(`Failed to expire giveaway ${id}:`, err);
        }
      }
    } finally {
      this.isRunning = false;
    }
  }

  private async expireOne(giveawayId: string): Promise<void> {
    // Atomic guarded transition — only one caller (this process, this tick,
    // or any other instance running the same cron) ever moves a given
    // giveaway out of ACTIVE. A second attempt sees count 0 and stops,
    // instead of computing and applying a refund a second time.
    const transitioned = await prisma.giveaway.updateMany({
      where: { id: giveawayId, status: 'ACTIVE' },
      data: { status: 'EXPIRED' },
    });

    if (transitioned.count === 0) {
      return; // already handled (expired, or cancelled, by another caller)
    }

    const { giveaway, outstanding } = await computeOutstandingEscrow(giveawayId);

    if (outstanding > 0) {
      await prisma.$transaction(async (tx) => {
        await tx.balance.update({
          where: { userId_asset: { userId: giveaway.creatorId, asset: giveaway.asset } },
          data: {
            availableBalance: { increment: outstanding },
            lockedBalance: { decrement: outstanding },
          },
        });

        await tx.transaction.create({
          data: {
            userId: giveaway.creatorId,
            type: 'REFUND',
            asset: giveaway.asset,
            amount: outstanding,
            fee: 0,
            netAmount: outstanding,
            status: 'CONFIRMED',
            idempotencyKey: `refund|expired|${giveawayId}`,
            metadata: { giveawayId, kind: 'expired' },
          },
        });
      });
    }

    logger.info(`Expired giveaway processed: ${giveawayId} (${outstanding} refunded)`);
  }
}

export const cleanupService = new CleanupService();
cleanupService.start();
