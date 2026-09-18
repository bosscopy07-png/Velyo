import { prisma } from '../database';
import { logger } from '../utils/logger';
import cron from 'node-cron';

/** Claims that don't submit an address within this window are expired */
const CLAIM_EXPIRY_MINUTES = 10;

class ClaimExpiryService {
  private isRunning = false;

  start(): void {
    cron.schedule('* * * * *', () => void this.expireStaleClaims());
    logger.info(`Claim expiry started (> ${CLAIM_EXPIRY_MINUTES} min = expired, refunded to creator)`);
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
    giveawayId: string;
    giveaway: { creatorId: string; asset: string; amountPerUser: unknown };
  }): Promise<void> {
    const share = Number(claim.giveaway.amountPerUser);

    await prisma.$transaction(async (tx) => {
      await tx.giveawayClaim.update({
        where: { id: claim.id },
        data: { status: 'FAILED', failedReason: `Expired — no address within ${CLAIM_EXPIRY_MINUTES} minutes` },
      });

      // Release the slot (FULL → ACTIVE so someone else can claim)
      await tx.$queryRaw`
        UPDATE giveaways
        SET "claimedCount" = "claimedCount" - 1,
            status = CASE WHEN status = 'FULL' THEN 'ACTIVE'::"GiveawayStatus" ELSE status END,
            "updatedAt" = NOW()
        WHERE id = ${claim.giveawayId} AND "claimedCount" > 0
      `;

      if (share > 0) {
        await tx.balance.update({
          where: { userId_asset: { userId: claim.giveaway.creatorId, asset: claim.giveaway.asset } },
          data: {
            availableBalance: { increment: share },
            lockedBalance: { decrement: share },
          },
        });
        await tx.transaction.create({
          data: {
            userId: claim.giveaway.creatorId,
            type: 'REFUND',
            asset: claim.giveaway.asset,
            amount: share,
            fee: 0,
            netAmount: share,
            status: 'CONFIRMED',
            idempotencyKey: `claim-expiry-${claim.id}`,
            metadata: { claimId: claim.id, giveawayId: claim.giveawayId },
          },
        });
      }
    });

    logger.info(`Claim ${claim.id} expired — slot released, ${share} refunded to creator`);
  }
}

export const claimExpiry = new ClaimExpiryService();
        
