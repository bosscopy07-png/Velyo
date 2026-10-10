import { prisma } from '../database';
import { logger } from '../utils/logger';
import { clearUserSession } from './redis';
import cron from 'node-cron';

/**
 * Claims that don't submit an address within this window are expired.
 *
 * UPGRADE (new model): expiring a claim releases the SLOT ONLY — the
 * share stays LOCKED. It is released to the creator's spendable balance
 * only when the GIVEAWAY itself ends (cancel → cancelGiveaway; link
 * expiry → cleanup worker), via the canonical computeOutstandingEscrow.
 *
 * Why: refunding the share to spendable at claim-expiry created a
 * refund → reopen → re-claim cycle that double-paid slots and drove
 * lockedBalance negative. Keeping the share locked means a reopened slot
 * needs NO balance movement when re-claimed, and the platform can never
 * pay one slot twice. The claimant's input session is also cleared so
 * the stale "send your address" prompt stops accepting input for the
 * dead claim (the screen fixes itself on their next tap).
 */
const CLAIM_EXPIRY_MINUTES = 10;

class ClaimExpiryService {
  private isRunning = false;

  start(): void {
    cron.schedule('* * * * *', () => void this.expireStaleClaims());
    logger.info(`Claim expiry started (> ${CLAIM_EXPIRY_MINUTES} min = expired, slot released, share stays locked)`);
  }

  private async expireStaleClaims(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const cutoff = new Date(Date.now() - CLAIM_EXPIRY_MINUTES * 60 * 1000);

      const stuck = await prisma.giveawayClaim.findMany({
        where: {
          status: { in: ['RESERVED', 'ADDRESS_PENDING'] },
          claimedAt: { lt: cutoff },
        },
        include: { giveaway: true },
      });

      for (const claim of stuck) {
        try {
          await this.expireOne(claim);
        } catch (err) {
          logger.error(`Claim expiry failed for ${claim.id}: ${(err as Error).message}`);
        }
      }
    } finally {
      this.isRunning = false;
    }
  }

  private async expireOne(claim: {
    id: string;
    userId: string;
    giveawayId: string;
    giveaway: { creatorId: string; asset: string; amountPerUser: unknown };
  }): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.giveawayClaim.update({
        where: { id: claim.id },
        data: { status: 'FAILED', failedReason: `Expired — no address within ${CLAIM_EXPIRY_MINUTES} minutes` },
      });

      // Release the slot (FULL → ACTIVE so someone else can claim).
      // NO balance movement — the share stays locked until the giveaway ends.
      await tx.$queryRaw`
        UPDATE giveaways
        SET "claimedCount" = "claimedCount" - 1,
            status = CASE WHEN status = 'FULL' THEN 'ACTIVE'::"GiveawayStatus" ELSE status END,
            "updatedAt" = NOW()
        WHERE id = ${claim.giveawayId} AND "claimedCount" > 0
      `;
    });

    // Kill the claimant's stale input session so the old "send your
    // address" prompt no longer accepts input for this dead claim.
    try {
      const u = await prisma.user.findUnique({ where: { id: claim.userId }, select: { telegramId: true } });
      if (u) await clearUserSession(u.telegramId);
    } catch (err) {
      logger.warn(`Could not clear session for expired claim ${claim.id}: ${(err as Error).message}`);
    }

    logger.info(`Claim ${claim.id} expired — slot released (share stays locked until giveaway ends)`);
  }
}

export const claimExpiry = new ClaimExpiryService();
        
