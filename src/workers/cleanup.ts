import { prisma } from '../database';
import { computeOutstandingEscrow } from '../services/giveaway';
import { logger } from '../utils/logger';
import cron from 'node-cron';

/**
 * Periodic cleanup:
 *   1. Expired giveaways → EXPIRED (and release the creator's escrow).
 *
 * Escrow release uses computeOutstandingEscrow — the ONE canonical
 * calculation (see services/giveaway.ts). Giveaway-link expiry is the
 * ONLY moment unclaimed slot funds return to the creator's spendable
 * balance (claim-level expiry no longer refunds; it just reopens the slot).
 *
 * UPGRADE: FULL giveaways also expire (previously only ACTIVE — a
 * full-but-expired giveaway would have held its escrow locked forever),
 * and every release is CAPPED by the locked balance that actually exists,
 * so legacy giveaways whose escrow was silently released pre-fix (locked=0,
 * no REFUND row) can never be paid out a second time.
 */

const cronSchedules: string[] = [
  '0 2 * * *',   // 02:00
  '0 8 * * *',   // 08:00
  '0 14 * * *',  // 14:00
  '0 20 * * *',  // 20:00
];

class CleanupService {
  private isRunning = false;

  start(): void {
    cronSchedules.forEach((schedule) => {
      cron.schedule(schedule, () => {
        void this.expireGiveaways();
      });
    });

    logger.info(`Cleanup worker started (${cronSchedules.length}x/day: ${cronSchedules.join(', ')})`);
  }

  private async expireGiveaways(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      // UPGRADE: FULL giveaways also expire.
      const expired = await prisma.giveaway.findMany({
        where: { status: { in: ['ACTIVE', 'FULL'] }, expiresAt: { lt: new Date() } },
        select: { id: true },
      });

      if (expired.length === 0) return;

      logger.info(`Found ${expired.length} expired giveaway(s), processing...`);

      for (const g of expired) {
        await this.expireOneGiveaway(g.id);
      }
    } catch (err) {
      logger.error('Cleanup error:', err);
    } finally {
      this.isRunning = false;
    }
  }

  private async expireOneGiveaway(giveawayId: string): Promise<void> {
    try {
      // Atomic guarded transition — only one caller (this process, this
      // tick, or a racing cancel) can move out of ACTIVE/FULL. A second
      // attempt sees count 0 and stops, so no double refund.
      const transitioned = await prisma.giveaway.updateMany({
        where: { id: giveawayId, status: { in: ['ACTIVE', 'FULL'] } },
        data: { status: 'EXPIRED' },
      });

      if (transitioned.count === 0) {
        return;
      }

      const { giveaway, outstanding } = await computeOutstandingEscrow(giveawayId);

      if (outstanding > 0) {
        // CAP: never refund more than the balance actually holds locked.
        // Legacy giveaways whose escrow was released pre-fix (locked=0 with
        // no REFUND row — the historic "locked mismatch" warnings) would
        // otherwise be paid out TWICE: "outstanding" is only trustworthy
        // when the backing exists.
        const bal = await prisma.balance.findUnique({
          where: { userId_asset: { userId: giveaway.creatorId, asset: giveaway.asset } },
        });
        const refund = Math.min(outstanding, Math.max(0, Number(bal?.lockedBalance ?? 0)));

        if (refund > 0) {
          await prisma.$transaction(async (tx) => {
            await tx.balance.update({
              where: { userId_asset: { userId: giveaway.creatorId, asset: giveaway.asset } },
              data: {
                availableBalance: { increment: refund },
                lockedBalance: { decrement: refund },
              },
            });

            await tx.transaction.create({
              data: {
                userId: giveaway.creatorId,
                type: 'REFUND',
                asset: giveaway.asset,
                amount: refund,
                fee: 0,
                netAmount: refund,
                status: 'CONFIRMED',
                idempotencyKey: `refund|expired|${giveawayId}`,
                metadata: { giveawayId, kind: 'expired' },
              },
            });
          });

          if (refund < outstanding) {
            logger.warn(
              `Giveaway ${giveawayId}: capped refund ${refund} < outstanding ${outstanding} ` +
              `(escrow was already released — pre-fix legacy). Difference NOT credited.`
            );
          }

          logger.info(`Expired giveaway processed: ${giveawayId} (${refund} refunded)`);
        } else {
          logger.warn(
            `Giveaway ${giveawayId}: outstanding ${outstanding} but zero locked backing — ` +
            `escrow was already released pre-fix. No refund issued.`
          );
        }
      }

      // Reclaim any leftover seeded gas (no-op in platform payout mode)
      const { giveawayService } = await import('../services/giveaway');
      await giveawayService.reclaimGas(giveawayId).catch(() => {});
    } catch (err) {
      logger.error(`Failed to expire giveaway ${giveawayId}:`, err);
    }
  }
}

const cleanupService = new CleanupService();
cleanupService.start();
