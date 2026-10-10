import { prisma } from '../database';
import { logger } from '../utils/logger';
import cron from 'node-cron';

/**
 * Periodic cleanup:
 *   1. Expired giveaways → EXPIRED (and release the creator's escrow).
 *
 * Escrow release uses computeOutstandingEscrow — the ONE canonical
 * calculation (see services/giveaway.ts). Giveaway-link expiry is now the
 * ONLY moment unclaimed slot funds return to the creator's spendable
 * balance (claim-level expiry no longer refunds; it just reopens the slot).
 */

const cronSchedules: string[] = [
  '0 2 * * *',   // 02:00
  '0 8 * * *',   // 08:00
  '0 14 * * *',  // 14:00
  '0 20 * * *',  // 20:00
];

function startCleanupWorker(): void {
  cronSchedules.forEach((schedule) => {
    cron.schedule(schedule, () => {
      void expireGiveaways();
    });
  });

  logger.info(`Cleanup worker started (${cronSchedules.length}×/day: ${cronSchedules.join(', ')})`);
}

async function expireGiveaways(): Promise<void> {
  try {
    // UPGRADE: FULL giveaways also expire — otherwise a full-but-expired
    // giveaway would hold its escrow locked forever.
    const expired = await prisma.giveaway.findMany({
      where: { status: { in: ['ACTIVE', 'FULL'] }, expiresAt: { lt: new Date() } },
      select: { id: true },
    });

    if (expired.length === 0) return;

    logger.info(`Found ${expired.length} expired giveaway(s), processing...`);

    for (const g of expired) {
      await expireOneGiveaway(g.id);
    }
  } catch (err) {
    logger.error('Cleanup error:', err);
  }
}

async function expireOneGiveaway(giveawayId: string): Promise<void> {
  try {
    const { computeOutstandingEscrow } = await import('../services/giveaway');

    // Atomic guarded transition — only one caller (this process, this tick,
    // or a racing cancel) can move out of ACTIVE/FULL. A second attempt sees
    // count 0 and stops, so no double refund.
    const transitioned = await prisma.giveaway.updateMany({
      where: { id: giveawayId, status: { in: ['ACTIVE', 'FULL'] } },
      data: { status: 'EXPIRED' },
    });

    if (transitioned.count === 0) {
      return;
    }

    const { giveaway, outstanding } = await computeOutstandingEscrow(giveawayId);

    if (outstanding > 0) {
      const { hashIdempotencyKey } = await import('../utils/encryption');

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
            idempotencyKey: hashIdempotencyKey('refund', giveawayId),
            metadata: { giveawayId, kind: 'giveaway_expiry' },
          },
        });
      });

      logger.info(
        `Giveaway ${giveawayId} expired: refunded ${outstanding} ${giveaway.asset} to creator ${giveaway.creatorId}`
      );
    }

    // Reclaim any leftover seeded gas (no-op in platform payout mode)
    const { giveawayService } = await import('../services/giveaway');
    await giveawayService.reclaimGas(giveawayId).catch(() => {});
  } catch (err) {
    logger.error(`Failed to expire giveaway ${giveawayId}:`, err);
  }
}

startCleanupWorker();
        
