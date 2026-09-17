import { prisma } from '../database';
import { redis, acquireLock, releaseLock } from './redis';
import { blockchain } from './blockchain';
import { config } from '../config';
import { generateSecureCode } from '../utils/validation';
import { logger } from '../utils/logger';
import type { AssetSymbol } from '../config';

/** Exact gas for one BEP20 payout (~0.0000017 BNB) + safety rounding = 0.000002 */
const GAS_SEED_PER_PAYOUT = 2000000000n; // wei

class GiveawayService {
  async createGiveaway(data: {
    creatorId: string;
    asset: AssetSymbol;
    totalAmount: number;
    maxClaimers: number;
    expiresAt?: Date;
  }): Promise<{ giveawayId: string; secureCode: string; amountPerUser: number }> {
    const amountPerUser = data.totalAmount / data.maxClaimers;
    const secureCode = generateSecureCode(20);
    const { hashIdempotencyKey } = await import('../utils/encryption');

    // Platform fee: 1% of the total, charged at creation (accumulates in the
    // creator's custodial wallet for the admin fee sweep — never forwarded here).
    const fee = config.ENABLE_FEES
      ? Number((data.totalAmount * (config.PLATFORM_FEE_PERCENT / 100)).toFixed(6))
      : 0;
    const totalCost = data.totalAmount + fee;

    // Everything in ONE transaction: lock funds + charge fee + create giveaway.
    const giveaway = await prisma.$transaction(async (tx) => {
      const balance = await tx.balance.findUnique({
        where: { userId_asset: { userId: data.creatorId, asset: data.asset } },
      });
      const available = Number(balance?.availableBalance ?? 0);
      if (available < totalCost) {
        throw new Error(
          `Insufficient ${data.asset} balance — you have ${available.toFixed(6)} ${data.asset}, ` +
          `need ${totalCost.toFixed(6)} ${data.asset} (amount ${data.totalAmount} + fee ${fee.toFixed(6)}). ` +
          `Deposit more ${data.asset} first.`
        );
      }

      await tx.balance.update({
        where: { userId_asset: { userId: data.creatorId, asset: data.asset } },
        data: {
          availableBalance: { decrement: totalCost },
          lockedBalance: { increment: data.totalAmount }, // only the reward is locked
        },
      });

      const g = await tx.giveaway.create({
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

      await tx.transaction.create({
        data: {
          userId: data.creatorId,
          type: 'GIVEAWAY_CREATED',
          asset: data.asset,
          amount: data.totalAmount,
          fee,
          netAmount: -data.totalAmount,
          status: 'CONFIRMED',
          idempotencyKey: hashIdempotencyKey('giveaway', g.id),
          metadata: { giveawayId: g.id },
        },
      });

      if (fee > 0) {
        const feeTx = await tx.transaction.create({
          data: {
            userId: data.creatorId,
            type: 'PLATFORM_FEE',
            asset: data.asset,
            amount: fee,
            fee: 0,
            netAmount: fee,
            status: 'CONFIRMED',
            metadata: { giveawayId: g.id, kind: 'creation_fee' },
            idempotencyKey: hashIdempotencyKey('creation-fee', g.id),
          },
        });
        await tx.platformFee.create({
          data: {
            transactionId: feeTx.id,
            asset: data.asset,
            amount: fee,
            feeWallet: config.PLATFORM_FEE_WALLET,
            // sweptAt stays null → appears in the admin Fee Sweep
          },
        });
      }

      return g;
    });

    // Seed exactly enough BNB for each expected claim's payout gas.
    await this.seedPayoutGas(data.creatorId, giveaway.id, data.maxClaimers);

    logger.info(`Giveaway created: ${giveaway.id} by ${data.creatorId} (${data.totalAmount} ${data.asset}, fee ${fee})`);
    return { giveawayId: giveaway.id, secureCode, amountPerUser };
  }

  /**
   * Sends the creator's wallet just enough BNB to cover payout gas
   * (0.000002 BNB per expected claimer). Snapshot-style: only tops up the deficit.
   */
  private async seedPayoutGas(creatorId: string, giveawayId: string, claimers: number): Promise<void> {
    try {
      const wallet = await prisma.wallet.findUnique({ where: { userId: creatorId } });
      if (!wallet) return;

      const needed = BigInt(claimers) * GAS_SEED_PER_PAYOUT;
      const current = await blockchain.getBalance(wallet.address, 'BNB');
      if (current >= needed) return;

      if (!config.OPERATOR_WALLET_KEY) {
        logger.warn(`OPERATOR_WALLET_KEY not set — cannot seed gas for giveaway ${giveawayId}`);
        return;
      }

      const { hashIdempotencyKey } = await import('../utils/encryption');
      const { hash } = await blockchain.sendTransaction(
        config.OPERATOR_WALLET_KEY,
        wallet.address,
        needed - current + GAS_SEED_PER_PAYOUT,
        'BNB',
        hashIdempotencyKey('create-seed', giveawayId)
      );
      logger.info(`Gas seeded for giveaway ${giveawayId}: ${hash}`);
    } catch (err) {
      logger.error(`Gas seed failed for giveaway ${giveawayId}: ${(err as Error).message}`);
    }
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

      // Atomic increment — Prisma made camelCase columns, quote them in raw SQL
      const result = await prisma.$queryRaw<{ claimedCount: number }[]>`
        UPDATE giveaways
        SET "claimedCount" = "claimedCount" + 1,
            status = CASE
              WHEN "claimedCount" + 1 >= "maxClaimers" THEN 'FULL'::"GiveawayStatus"
              ELSE status
            END,
            "updatedAt" = NOW()
        WHERE id = ${giveawayId}
          AND "claimedCount" < "maxClaimers"
          AND status = 'ACTIVE'
        RETURNING "claimedCount"
      `;

      if (!result || result.length === 0) {
        return { success: false, reason: 'Giveaway just filled up' };
      }

      const claimOrder = result[0].claimedCount;

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

    // Fee is non-refundable (platform earned it at creation); refund unclaimed reward only
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

    // READ-ONLY: viewing stats must never increment the counter
    // (the real increments happen in handleGiveawayDeepLink via trackAttempt)
    const linkOpens = await redis
      .get(`giveaway:views:${giveawayId}`)
      .then((v) => parseInt(v || '0'));

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