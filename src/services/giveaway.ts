import { prisma } from '../database';
import { redis, acquireLock, releaseLock, trackGiveawayView } from './redis';
import { walletService } from './wallet';
import { generateSecureCode } from '../utils/validation';
import { logger } from '../utils/logger';
import type { AssetSymbol } from '../config';

class GiveawayService {
  async createGiveaway(data: {
    creatorId: string;
    asset: AssetSymbol;
    totalAmount: number;
    maxClaimers: number;
    expiresAt?: Date;
  }): Promise<{ giveawayId: string; secureCode: string; amountPerUser: number }> {
    const amountPerUser = data.totalAmount / data.maxClaimers;

    // Pre-check with a CLEAR error: shows exact asset, have vs need.
    // (lockFunds alone throws a generic "Insufficient balance".)
    const balance = await prisma.balance.findUnique({
      where: { userId_asset: { userId: data.creatorId, asset: data.asset } },
    });
    const available = Number(balance?.availableBalance ?? 0);
    if (available < data.totalAmount) {
      throw new Error(
        `Insufficient ${data.asset} balance — you have ${available.toFixed(6)} ${data.asset}, ` +
        `need ${data.totalAmount} ${data.asset}. Deposit more ${data.asset} first.`
      );
    }

    // Lock funds (available → locked)
    await walletService.lockFunds(data.creatorId, data.asset, data.totalAmount);

    const secureCode = generateSecureCode(20);

    const giveaway = await prisma.giveaway.create({
      data: {
        creatorId: data.creatorId,
        asset: data.asset,
        totalAmount: data.totalAmount,
        amountPerUser,
        maxClaimers: data.maxClaimers,
        secureCode,
        expiresAt: data.expiresAt,
        status: 'ACTIVE',
      },
    });

    // Record transaction
    const { hashIdempotencyKey } = await import('../utils/encryption');
    await prisma.transaction.create({
      data: {
        userId: data.creatorId,
        type: 'GIVEAWAY_CREATED',
        asset: data.asset,
        amount: data.totalAmount,
        fee: 0,
        netAmount: -data.totalAmount,
        status: 'CONFIRMED',
        idempotencyKey: hashIdempotencyKey('giveaway', giveaway.id),
        metadata: { giveawayId: giveaway.id },
      },
    });

    logger.info(`Giveaway created: ${giveaway.id} by ${data.creatorId} (${data.totalAmount} ${data.asset})`);
    return { giveawayId: giveaway.id, secureCode, amountPerUser };
  }

  async claimGiveaway(giveawayId: string, userId: string): Promise<{ success: boolean; reason?: string; claimOrder?: number }> {
    const lockKey = `giveaway:claim:${giveawayId}`;
    const lockToken = await acquireLock(lockKey, 5000);

    if (!lockToken) {
      return { success: false, reason: 'System busy, please try again' };
    }

    try {
      const existingClaim = await prisma.giveawayClaim.findUnique({
        where: { giveawayId_userId: { giveawayId, userId } },
      });

      if (existingClaim) {
        return { success: false, reason: 'You already claimed this giveaway' };
      }

      const giveaway = await prisma.giveaway.findUnique({
        where: { id: giveawayId },
        include: { claims: true },
      });

      if (!giveaway) return { success: false, reason: 'Giveaway not found' };
      if (giveaway.status !== 'ACTIVE') return { success: false, reason: 'Giveaway is not active' };
      if (giveaway.expiresAt && giveaway.expiresAt < new Date()) {
        return { success: false, reason: 'Giveaway has expired' };
      }
      if (giveaway.claimedCount >= giveaway.maxClaimers) {
        return { success: false, reason: 'Giveaway is full' };
      }

      // Atomic increment using raw query for true concurrency safety
      const result = await prisma.$queryRaw<{ claimed_count: number }[]>`
        UPDATE giveaways
        SET claimed_count = claimed_count + 1,
            status = CASE
              WHEN claimed_count + 1 >= max_claimers THEN 'FULL'::"GiveawayStatus"
              ELSE status
            END,
            updated_at = NOW()
        WHERE id = ${giveawayId}
          AND claimed_count < max_claimers
          AND status = 'ACTIVE'
        RETURNING claimed_count
      `;

      if (!result || result.length === 0) {
        return { success: false, reason: 'Giveaway just filled up' };
      }

      const claimOrder = result[0].claimed_count;

      await prisma.giveawayClaim.create({
        data: {
          giveawayId,
          userId,
          status: 'RESERVED',
          claimOrder,
        },
      });

      logger.info(`Giveaway ${giveawayId} claimed by ${userId}, order: ${claimOrder}`);
      return { success: true, claimOrder };
    } finally {
      await releaseLock(lockKey, lockToken);
    }
  }

  async submitAddress(claimId: string, address: string): Promise<void> {
    await prisma.giveawayClaim.update({
      where: { id: claimId },
      data: {
        walletAddress: address,
        status: 'ADDRESS_CONFIRMED',
      },
    });
  }

  async cancelGiveaway(giveawayId: string, userId: string): Promise<{ success: boolean; reason?: string }> {
    const giveaway = await prisma.giveaway.findUnique({
      where: { id: giveawayId },
      include: { claims: true },
    });

    if (!giveaway) return { success: false, reason: 'Giveaway not found' };
    if (giveaway.creatorId !== userId) return { success: false, reason: 'Not authorized' };
    if (giveaway.status === 'CANCELLED') return { success: false, reason: 'Already cancelled' };
    if (giveaway.claims.some((c) => c.status === 'PAID')) {
      return { success: false, reason: 'Cannot cancel: payouts already sent' };
    }

    const unclaimedAmount = Number(giveaway.totalAmount) -
      (giveaway.claims.filter((c) => c.status === 'PAID').length * Number(giveaway.amountPerUser));

    await prisma.$transaction(async (tx) => {
      await tx.giveaway.update({
        where: { id: giveawayId },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
        },
      });

      if (unclaimedAmount > 0) {
        await tx.balance.update({
          where: { userId_asset: { userId: giveaway.creatorId, asset: giveaway.asset } },
          data: {
            availableBalance: { increment: unclaimedAmount },
            lockedBalance: { decrement: unclaimedAmount },
          },
        });
      }
    });

    if (unclaimedAmount > 0) {
      const { hashIdempotencyKey } = await import('../utils/encryption');
      await prisma.transaction.create({
        data: {
          userId: giveaway.creatorId,
          type: 'REFUND',
          asset: giveaway.asset,
          amount: unclaimedAmount,
          fee: 0,
          netAmount: unclaimedAmount,
          status: 'CONFIRMED',
          idempotencyKey: hashIdempotencyKey('refund', giveawayId),
          metadata: { giveawayId },
        },
      });
    }

    return { success: true };
  }

  async getGiveawayStats(giveawayId: string): Promise<{
    totalReward: number;
    totalSlots: number;
    linkOpens: number;
    claimAttempts: number;
    spotsSecured: number;
    payoutsCompleted: number;
    remainingSlots: number;
  }> {
    const giveaway = await prisma.giveaway.findUnique({
      where: { id: giveawayId },
      include: { claims: true },
    });

    if (!giveaway) throw new Error('Giveaway not found');

    const linkOpens = await trackGiveawayView(giveawayId).then(() =>
      redis.get(`giveaway:views:${giveawayId}`).then((v) => parseInt(v || '0'))
    );

    return {
      totalReward: Number(giveaway.totalAmount),
      totalSlots: giveaway.maxClaimers,
      linkOpens,
      claimAttempts: giveaway.attemptCount,
      spotsSecured: giveaway.claimedCount,
      payoutsCompleted: giveaway.claims.filter((c) => c.status === 'PAID').length,
      remainingSlots: giveaway.maxClaimers - giveaway.claimedCount,
    };
  }

  async trackAttempt(giveawayId: string): Promise<void> {
    await prisma.giveaway.update({
      where: { id: giveawayId },
      data: { attemptCount: { increment: 1 } },
    });
  }
}

export const giveawayService = new GiveawayService();
                                                 
