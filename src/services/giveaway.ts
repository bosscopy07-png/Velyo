import { prisma } from '../database';
import { redis, acquireLock, releaseLock } from './redis';
import { blockchain } from './blockchain';
import { walletService } from './wallet';
import { config } from '../config';
import { generateSecureCode } from '../utils/validation';
import { logger } from '../utils/logger';
import type { AssetSymbol } from '../config';

/**
 * Gas economics. One BEP20 transfer costs ≈ 0.00000174 BNB; we budget
 * 0.000002 BNB per unit = 2×10^12 wei.
 */
export const GAS_PER_CLAIM_BNB = 0.000002;
const GAS_SEED_PER_PAYOUT = 2000000000000n;
const BNB_USD_FALLBACK = 550;
/** Extra seeded units: 1 buffer for claim rounding + 1 for the fee-forward tx */
const GAS_BUFFER_UNITS = 2;

/** USDT value of `units × 0.000002` BNB (for charging gas to users) */
export async function estimateGasUSDT(units: number): Promise<number> {
  let usd = 0;
  try {
    const { pricing } = await import('./pricing');
    usd = await pricing.convertToUSD('BNB', units * GAS_PER_CLAIM_BNB);
  } catch {}
  if (!usd || usd <= 0) usd = units * GAS_PER_CLAIM_BNB * BNB_USD_FALLBACK;
  return Number(usd.toFixed(6));
}

export interface CreationCost {
  platformFee: number;
  gasFee: number;
  fee: number;
  total: number;
  gasUnits: number;
}

export async function estimateCreationCost(totalAmount: number, maxClaimers: number): Promise<CreationCost> {
  const platformFee = config.ENABLE_FEES
    ? Number((totalAmount * (config.PLATFORM_FEE_PERCENT / 100)).toFixed(6))
    : 0;
  // claimers payouts + 1 buffer + 1 fee-forward transaction
  const gasUnits = maxClaimers + GAS_BUFFER_UNITS;
  const gasFee = await estimateGasUSDT(gasUnits);
  const fee = Number((platformFee + gasFee).toFixed(6));
  return { platformFee, gasFee, fee, total: Number((totalAmount + fee).toFixed(6)), gasUnits };
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

    // Lazy wallet: creators need a real custodial wallet (funds + gas live there)
    await walletService.createWallet(data.creatorId);

    // ── REAL-BALANCE GATE ──
    // DB can hold phantom credits (old refunds, admin-era redeems). Only
    // on-chain truth may fund a giveaway.
    const creatorWallet = await prisma.wallet.findUnique({ where: { userId: data.creatorId } });
    if (creatorWallet) {
      const raw = await blockchain.getBalance(creatorWallet.address, data.asset);
      const onChain = Number(raw) / 1e18;
      const lockedRow = await prisma.balance.findUnique({
        where: { userId_asset: { userId: data.creatorId, asset: data.asset } },
      });
      const pendingFees = await prisma.platformFee.aggregate({
        where: { sweptAt: null, asset: data.asset, transaction: { userId: data.creatorId } },
        _sum: { amount: true },
      });
      const realAvailable = onChain - Number(lockedRow?.lockedBalance ?? 0) - Number(pendingFees._sum.amount ?? 0);
      if (realAvailable < totalCost) {
        throw new Error(
          `Insufficient ${data.asset} — your wallet holds ${realAvailable.toFixed(6)} ${data.asset} on-chain ` +
          `(need ${totalCost.toFixed(6)} including fees). Deposit more ${data.asset} first.`
        );
      }
    }

    const giveaway = await prisma.$transaction(async (tx) => {
      const balance = await tx.balance.findUnique({
        where: { userId_asset: { userId: data.creatorId, asset: data.asset } },
      });
      const available = Number(balance?.availableBalance ?? 0);
      if (available < totalCost) {
        throw new Error(
          `Insufficient ${data.asset} balance — you have ${available.toFixed(6)} ${data.asset}, ` +
          `need ${totalCost.toFixed(6)}. Deposit more ${data.asset} first.`
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
          metadata: { giveawayId: g.id, feeBreakdown: { platformFee: cost.platformFee, gasFee: cost.gasFee, gasUnits: cost.gasUnits } },
        },
      });

      // Fee row 1: 1% platform fee — forwarded on-chain right after creation
      if (cost.platformFee > 0) {
        const feeTx = await tx.transaction.create({
          data: {
            userId: data.creatorId,
            type: 'PLATFORM_FEE',
            asset: data.asset,
            amount: cost.platformFee,
            fee: 0,
            netAmount: cost.platformFee,
            status: 'CONFIRMED',
            metadata: { giveawayId: g.id, kind: 'creation_fee_1pct' },
            idempotencyKey: hashIdempotencyKey('creation-fee', g.id),
          },
        });
        await tx.platformFee.create({
          data: { transactionId: feeTx.id, asset: data.asset, amount: cost.platformFee, feeWallet: config.PLATFORM_FEE_WALLET },
        });
      }

      // Fee row 2: gas charge — forwarded on-chain right after creation
      if (cost.gasFee > 0) {
        const gasTx = await tx.transaction.create({
          data: {
            userId: data.creatorId,
            type: 'PLATFORM_FEE',
            asset: data.asset,
            amount: cost.gasFee,
            fee: 0,
            netAmount: cost.gasFee,
            status: 'CONFIRMED',
            metadata: { giveawayId: g.id, kind: 'creation_gas', gasUnits: cost.gasUnits },
            idempotencyKey: hashIdempotencyKey('creation-gas', g.id),
          },
        });
        await tx.platformFee.create({
          data: { transactionId: gasTx.id, asset: data.asset, amount: cost.gasFee, feeWallet: config.PLATFORM_FEE_WALLET },
        });
      }

      return g;
    });

    // 1) Seed BNB (payout gas + buffer + 1 unit for the fee-forward below).
    //    Enqueued FIRST so the serialized send queue runs it before the forward.
    await this.seedPayoutGas(data.creatorId, giveaway.id, data.maxClaimers + GAS_BUFFER_UNITS);

    // 2) Immediately forward the full creation fee on-chain to the platform
    //    wallet — same flow as deposits. On failure the rows stay pending and
    //    the admin Fee Sweep catches them later.
    await this.forwardCreationFee(giveaway.id, data.creatorId, data.asset, fee);

    logger.info(`Giveaway created: ${giveaway.id} by ${data.creatorId} (${data.totalAmount} ${data.asset}, fee ${fee})`);
    return { giveawayId: giveaway.id, secureCode, amountPerUser };
  }

  /**
   * Sends the creator's full creation fee (1% + gas charge) on-chain to the
   * platform fee wallet. Marks the giveaway's platformFee rows swept on
   * success; leaves them pending on failure (admin sweep is the fallback).
   *
   * No insufficient-funds retry here: the serialized send queue in
   * blockchain.ts waits for the gas-seed tx to MINE before broadcasting
   * this forward, so the seed-not-landed race this used to guard against
   * can no longer happen.
   */
  private async forwardCreationFee(giveawayId: string, creatorId: string, asset: AssetSymbol, amount: number): Promise<void> {
    if (amount <= 0) return;

    try {
      const wallet = await prisma.wallet.findUnique({ where: { userId: creatorId } });
      if (!wallet) return;

      const raw = BigInt(Math.floor(amount * 1e18));
      const { hash } = await blockchain.sendTransaction(
        wallet.encryptedPrivateKey,
        config.PLATFORM_FEE_WALLET,
        raw,
        asset,
        `creation-fwd-${giveawayId}`
      );

      await prisma.platformFee.updateMany({
        where: {
          sweptAt: null,
          transaction: { userId: creatorId, metadata: { path: ['giveawayId'], equals: giveawayId } },
        },
        data: { sweptAt: new Date() },
      });
      await walletService.adjustOperatorBalance(asset, amount);
      logger.info(`Creation fee forwarded: ${amount} ${asset} → platform wallet (tx ${hash})`);
    } catch (err) {
      logger.error(`Creation fee forward failed for giveaway ${giveawayId} (stays pending for admin sweep): ${(err as Error).message}`);
    }
  }

  private async seedPayoutGas(creatorId: string, giveawayId: string, units: number): Promise<void> {
    try {
      let wallet = await prisma.wallet.findUnique({ where: { userId: creatorId } });
      if (!wallet) {
        await walletService.createWallet(creatorId);
        wallet = await prisma.wallet.findUnique({ where: { userId: creatorId } });
        if (!wallet) return;
      }

      const baseline = await blockchain.getBalance(wallet.address, 'BNB');
      const needed = BigInt(units) * GAS_SEED_PER_PAYOUT;
      let seeded = 0n;

      if (baseline < needed) {
        if (!config.OPERATOR_WALLET_KEY) {
          logger.warn(`OPERATOR_WALLET_KEY not set — cannot seed gas for giveaway ${giveawayId}`);
        } else {
          const { hashIdempotencyKey } = await import('../utils/encryption');
          seeded = needed - baseline;
          const { hash } = await blockchain.sendTransaction(
            config.OPERATOR_WALLET_KEY,
            wallet.address,
            seeded,
            'BNB',
            hashIdempotencyKey('create-seed', giveawayId)
          );
          logger.info(`Gas seeded for giveaway ${giveawayId}: ${hash} (${Number(seeded) / 1e18} BNB for ${units} units)`);
          await walletService.adjustOperatorBalance('BNB', -Number(seeded) / 1e18);
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
   * After all claims are paid (or the giveaway is cancelled):
   * leftover seeded BNB → admin wallet, creator refunded the USDT value
   * of the leftover.
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

      const reclaimTxGas = 1800000000000n; // 0.0000018 BNB

      if (ours <= reclaimTxGas) {
        logger.info(`Gas reclaim for ${giveawayId}: leftover ${ours} wei below reclaim cost — kept as wallet float.`);
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
      logger.info(`Gas reclaimed for ${giveawayId}: ${Number(sendBack) / 1e18} BNB → admin (tx ${hash})`);
      await walletService.adjustOperatorBalance('BNB', Number(sendBack) / 1e18);

      const refundUSDT = await estimateGasUSDT(Number(sendBack) / 1e18 / GAS_PER_CLAIM_BNB);
      if (refundUSDT > 0) {
        await walletService.creditFunds(wallet.userId, 'USDT', refundUSDT);
        const { hashIdempotencyKey } = await import('../utils/encryption');
        await prisma.transaction.create({
          data: {
            userId: wallet.userId,
            type: 'REFUND',
            asset: 'USDT',
            amount: refundUSDT,
            fee: 0,
            netAmount: refundUSDT,
            status: 'CONFIRMED',
            idempotencyKey: hashIdempotencyKey('gas-refund', giveawayId),
            metadata: { kind: 'gas_refund', giveawayId, reclaimedBNB: Number(sendBack) / 1e18 },
          },
        });
        logger.info(`Gas refund for ${giveawayId}: ${refundUSDT} USDT credited to creator`);
      }

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
        data: { giveawayId, userId, status: 'RESERVED', claimOrder },
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
      data: { walletAddress: address, status: 'ADDRESS_CONFIRMED' },
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
