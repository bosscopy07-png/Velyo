import { Prisma } from '@prisma/client';
import { prisma } from '../database';
import { hashIdempotencyKey } from '../utils/encryption';
import { logger } from '../utils/logger';
import type { AssetSymbol } from '../config';

/**
 * Reward ledger — the ONLY place reward-type credits are written.
 *
 * Every reward is: one `Reward` row (idempotencyKey @unique) + one
 * `Transaction` row (type REWARD, idempotencyKey derived) + one atomic
 * availableBalance increment — all inside a single $transaction.
 *
 * A retry (same idempotencyKey, e.g. a crashed creator-cashback step or a
 * double callback) either:
 *   - hits the pre-check and returns the existing row, or
 *   - loses the P2002 unique race and returns the winner's row.
 * Either way: exactly one reward, ever.
 *
 * IMPORTANT (anti-phantom architecture): user spendable funds are
 * on-chain-authoritative in this codebase (see giveaway.ts real-balance
 * gate). Rewards therefore live in the internal ledger and are consumed as
 * a CREDIT against the platform fee on the user's NEXT giveaway creation
 * (consumeCredit below) — never as phantom on-chain spendable balance.
 */

export interface CreditRewardInput {
  userId: string;
  type: 'GIVEAWAY_CASHBACK' | 'REFERRAL_REWARD';
  sourceType: string; // 'giveaway' today; extensible
  sourceId: string; // giveaway id (cashback) or attribution id (referral)
  asset: AssetSymbol | string;
  amount: number;
  /** Stable, deterministic per business event — e.g. hashIdempotencyKey('cashback', giveawayId) */
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

class RewardsService {
  async creditReward(input: CreditRewardInput): Promise<{ id: string; alreadyExisted: boolean } | null> {
    if (!(input.amount > 0)) return null;

    const existing = await prisma.reward.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return { id: existing.id, alreadyExisted: true };

    try {
      const reward = await prisma.$transaction(async (tx) => {
        const r = await tx.reward.create({
          data: {
            userId: input.userId,
            type: input.type,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            asset: input.asset,
            amount: input.amount,
            status: 'CREDITED',
            idempotencyKey: input.idempotencyKey,
          },
        });

        await tx.balance.upsert({
          where: { userId_asset: { userId: input.userId, asset: input.asset } },
          create: { userId: input.userId, asset: input.asset, availableBalance: input.amount },
          update: { availableBalance: { increment: input.amount } },
        });

        await tx.transaction.create({
          data: {
            userId: input.userId,
            type: 'REWARD',
            asset: input.asset,
            amount: input.amount,
            fee: 0,
            netAmount: input.amount,
            status: 'CONFIRMED',
            idempotencyKey: hashIdempotencyKey('reward-tx', input.idempotencyKey),
            metadata: { rewardType: input.type, sourceType: input.sourceType, sourceId: input.sourceId, ...(input.metadata ?? {}) },
          },
        });

        return r;
      });

      logger.info(`Reward credited: ${input.type} ${input.amount} ${input.asset} → ${input.userId} (source ${input.sourceType}:${input.sourceId})`);
      return { id: reward.id, alreadyExisted: false };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Concurrent duplicate — the winner's row is the single source of truth.
        const winner = await prisma.reward.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
        if (winner) return { id: winner.id, alreadyExisted: true };
      }
      throw err;
    }
  }

  /**
   * Applies earned reward credit against an upcoming charge (used by
   * giveaway creation to discount the platform fee). Marks the consumed
   * Reward rows APPLIED inside the caller's interactive transaction.
   *
   * @param maxAmount maximum credit to consume (e.g. the platform fee due)
   * @returns total credit applied (0..maxAmount)
   */
  async consumeCredit(
    tx: Prisma.TransactionClient,
    userId: string,
    asset: string,
    maxAmount: number
  ): Promise<number> {
    if (!(maxAmount > 0)) return 0;

    const rows = await tx.reward.findMany({
      where: { userId, asset, status: 'CREDITED' },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });

    let remaining = maxAmount;
    let applied = 0;
    const toApply: string[] = [];
    for (const row of rows) {
      if (remaining <= 1e-12) break;
      const amt = Number(row.amount);
      const use = Math.min(amt, remaining);
      applied += use;
      remaining -= use;
      toApply.push(row.id);
    }

    if (toApply.length > 0) {
      await tx.reward.updateMany({ where: { id: { in: toApply } }, data: { status: 'APPLIED' } });
    }
    return Number(applied.toFixed(8));
  }

  async getUnappliedCredit(userId: string, asset: string): Promise<number> {
    const agg = await prisma.reward.aggregate({
      where: { userId, asset, status: 'CREDITED' },
      _sum: { amount: true },
    });
    return Number(agg._sum.amount ?? 0);
  }

  async getSummary(userId: string): Promise<{
    cashback: number;
    referral: number;
    total: number;
    recent: Array<{ type: string; amount: number; asset: string; createdAt: Date }>;
  }> {
    const [byType, recent] = await Promise.all([
      prisma.reward.groupBy({
        by: ['type'],
        where: { userId, status: { in: ['CREDITED', 'APPLIED'] } },
        _sum: { amount: true },
      }),
      prisma.reward.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { type: true, amount: true, asset: true, createdAt: true },
      }),
    ]);

    const cashback = Number(byType.find((t) => t.type === 'GIVEAWAY_CASHBACK')?._sum.amount ?? 0);
    const referral = Number(byType.find((t) => t.type === 'REFERRAL_REWARD')?._sum.amount ?? 0);

    return {
      cashback,
      referral,
      total: Number((cashback + referral).toFixed(8)),
      recent: recent.map((r) => ({ type: r.type, amount: Number(r.amount), asset: r.asset, createdAt: r.createdAt })),
    };
  }
}

export const rewardsService = new RewardsService();
