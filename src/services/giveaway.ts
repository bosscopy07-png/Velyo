import { prisma } from '../database';
import { redis, acquireLock, releaseLock } from './redis';
import { blockchain } from './blockchain';
import { config } from '../config';
import { generateSecureCode } from '../utils/validation';
import { logger } from '../utils/logger';
import type { AssetSymbol } from '../config';

/**
 * Seeded per expected claim. Actual payout cost ≈ 0.00000174 BNB; we send
 * 0.000002 BNB. UNITS: 0.000002 BNB = 2×10^12 wei (2,000,000,000,000).
 * Verified against on-chain logs: one USDT transfer costs 1,743,100,000,000 wei.
 */
export const GAS_PER_CLAIM_BNB = 0.000002;
const GAS_SEED_PER_PAYOUT = 2000000000000n; // 0.000002 BNB
const BNB_USD_FALLBACK = 550; // used only if the price API is down

export interface CreationCost {
  platformFee: number;
  gasFee: number;      // BNB gas for all claims, priced in USDT
  fee: number;         // total fee
  total: number;       // amount + fee
}

/** Total creation cost: 1% platform fee + gas for every expected claim (priced in USDT). */
export async function estimateCreationCost(totalAmount: number, maxClaimers: number): Promise<CreationCost> {
  const platformFee = config.ENABLE_FEES
    ? Number((totalAmount * (config.PLATFORM_FEE_PERCENT / 100)).toFixed(6))
    : 0;

  let gasFee = 0;
  try {
    const { pricing } = await import('./pricing');
    gasFee = await pricing.convertToUSD('BNB', maxClaimers * GAS_PER_CLAIM_BNB);
  } catch {
    // price API down — use fallback rate
  }
  if (!gasFee || gasFee <= 0) {
    gasFee = maxClaimers * GAS_PER_CLAIM_BNB * BNB_USD_FALLBACK;
  }
  gasFee = Number(gasFee.toFixed(6));

  const fee = Number((platformFee + gasFee).toFixed(6));
  return { platformFee, gasFee, fee, total: Number((totalAmount + fee).toFixed(6)) };
}

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

    const cost = await estimateCreationCost(data.totalAmount, data.maxClaimers);
    const fee = cost.fee;
    const totalCost = data.totalAmount + fee;

    const giveaway = await prisma.$transaction(async (tx) => {
      const balance = await tx.balance.findUnique({
        where: { userId_asset: { userId: data.creatorId, asset: data.asset } },
      });
      const available = Number(balance?.availableBalance ?? 0);
      if (available < totalCost) {
        throw new Error(
          `Insufficient ${data.asset} balance — you have ${available.toFixed(6)} ${data.asset}, ` +
          `need ${totalCost.toFixed(6)} ${data.asset} (amount ${data.totalAmount} + fee ${fee.toFixed(6)}: ` +
          `1% platform + gas for ${data.maxClaimers} claim(s)). Deposit more ${data.asset} first.`
        );
      }

      await tx.balance.update({
        where: { userId_asset: { userId: data.creatorId, asset: data.asset } },
        data: {
          availableBalance: { decrement: totalCost },
          lockedBalance: { increment: data.totalAmount },
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
          metadata: { giveawayId: g.id, feeBreakdown: { platformFee: cost.platformFee, gasFee: cost.gasFee } },
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
            metadata: { giveawayId: g.id, kind: 'creation_fee', feeBreakdown: { platformFee: cost.platformFee, gasFee: cost.gasFee } },
            idempotencyKey: hashIdempotencyKey('creation-fee', g.id),
          },
        });
        await tx.platformFee.create({
          data: {
            transactionId: feeTx.id,
            asset: data.asset,
            amount: fee,
            feeWallet: config.PLATFORM_FEE_WALLET,
          },
        });
      }

      return g;
    });

    await this.seedPayoutGas(data.creatorId, giveaway.id, data.maxClaimers);

    logger.info(`Giveaway created: ${giveaway.id} by ${data.creatorId} (${data.totalAmount} ${data.asset}, fee ${fee})`);
    return { giveawayId: giveaway.id, secureCode, amountPerUser };
  }

  /**
   * Sends the creator's wallet exactly enough BNB for every expected claim's
   * payout gas (0.000002 BNB × claimers) from the admin wallet, and records
   * { baseline } in Redis so reclaimGas later returns ONLY what we added.
   */
  private async seedPayoutGas(creatorId: string, giveawayId: string, claimers: number): Promise<void> {
    try {
      const wallet = await prisma.wallet.findUnique({ where: { userId: creatorId } });
      if (!wallet) return;

      const baseline = await blockchain.getBalance(wallet.address, 'BNB');
      const needed = BigInt(claimers) * GAS_SEED_PER_PAYOUT;
      let seeded = 0n;

      if (baseline < needed) {
        if (!config.OPERATOR_WALLET_KEY) {
          logger.warn(`OPERATOR_WALLET_KEY not set — cannot seed gas for giveaway ${giveawayId}`);
        } else {
          const { hashIdempotencyKey } = await import('../utils/encryption');
          seeded = needed - baseline + GAS_SEED_PER_PAYOUT; // deficit + one-claim buffer
          const { hash } = await blockchain.sendTransaction(
            config.OPERATOR_WALLET_KEY,
            wallet.address,
            seeded,
            'BNB',
            hashIdempotencyKey('create-seed', giveawayId)
          );
          logger.info(`Gas seeded for giveaway ${giveawayId}: ${hash} (${seeded} wei = ${Number(seeded) / 1e18} BNB)`);
        }
      }

      await redis.set(
        `gas:credit:${giveawayId}`,
        JSON.stringify({ address: wallet.address, baseline: baseline.toString(), seeded: seeded.toString() }),
        'EX', 60 * 60 * 24 * 30
      );
    } catch (err) {
      logger.error(`Gas seed failed for giveaway ${giveawayId}: ${(err as Error).message}`);
    }
  }

  /**
   * Returns unused seeded BNB to the admin fee wallet.
   * ours = currentBalance − baseline (snapshot BEFORE seeding), so the
   * creator's own BNB is mathematically excluded. Keeps a small reserve
   * (reclaim tx gas + dust float) in the wallet.
   */
  async reclaimGas(giveawayId: string): Promise<void> {
    try {
      const raw = await redis.get(`gas:credit:${giveawayId}`);
      if (!raw) return;
      const credit = JSON.parse(raw) as { address: string; baseline: string; seeded: string };

      if (BigInt(credit.seeded) === 0n) {
        await redis.del(`gas:credit:${giveawayId}`);
        return;
      }

      const wallet = await prisma.wallet.findUnique({ where: { address: credit.address } });
      if (!wallet) {
        await redis.del(`gas:credit:${giveawayId}`);
        return;
      }

      const current = await blockchain.getBalance(credit.address, 'BNB');
      const ours = current - BigInt(credit.baseline);

      const reserve = 2500000000000n;      // 0.0000025 BNB kept as future float
      const reclaimTxGas = 1800000000000n; // 0.0000018 BNB cost of the reclaim tx

      if (ours <= reserve + reclaimTxGas) {
        logger.info(`Gas reclaim for ${giveawayId}: leftover ${ours} wei below threshold — kept as wallet float.`);
        await redis.del(`gas:credit:${giveawayId}`);
        return;
      }

      const sendBack = ours - reclaimTxGas;
      const { hash } = await blockchain.sendTransaction(
        wallet.encryptedPrivateKey,
        config.PLATFORM_FEE_WALLET,
        sendBack,
        'BNB',
        `gas-reclaim-${giveawayId}`
      );
      logger.info(`Gas reclaimed for ${giveawayId}: ${sendBack} wei → admin wallet (tx ${hash})`);
      await redis.del(`gas:credit:${giveawayId}`);
    } catch (err) {
      logger.error(`Gas reclaim failed for ${giveawayId}: ${(err as Error).message}`);
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

    const unclaimedAmount = Number(giveaway.totalAmount) -
      (giveaway.claims.filter((c) => c.status === 'PAID').length * Number(giveaway.amountPerUser));

    await prisma.$transaction(async (tx) => {
      await tx.giveaway.update({
        where: { id: giveawayId },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
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

    await this.reclaimGas(giveawayId);
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
    const giveaway =
      (await prisma.giveaway.findUnique({ where: { id: giveawayId }, include: { claims: true } })) ??
      (await prisma.giveaway.findUnique({ where: { secureCode: giveawayId }, include: { claims: true } }));

    if (!giveaway) throw new Error('Giveaway not found');

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
                              
