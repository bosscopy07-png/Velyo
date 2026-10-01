import { Prisma } from '@prisma/client';
import { prisma } from '../database';
import { hashIdempotencyKey } from '../utils/encryption';
import { logger } from '../utils/logger';
import { feeConfig } from './fee-config';
import { rewardsService } from './rewards';

/**
 * Giveaway-link referral attribution.
 *
 * Velyo deliberately has NO separate referral-link system: the giveaway
 * link IS the attribution mechanism. User B claims User A's giveaway →
 * one GiveawayAttribution row (unique per giveaway+claimant, stable
 * internal user IDs — never usernames).
 *
 * Referral reward rule: when a claimant is attributed for the FIRST time
 * platform-wide, the creator of that giveaway (the referrer) earns the
 * configured referral % of the giveaway's per-user amount. Idempotency:
 * hash('referral-reward', attribution.id) — one attribution, one reward.
 */

export interface AttributionInput {
  giveawayId: string;
  claimantId: string;
  source: 'GIVEAWAY_LINK' | 'MANUAL_CODE';
}

class AttributionService {
  async recordAttribution(input: AttributionInput): Promise<{ id: string; alreadyExisted: boolean } | null> {
    const giveaway = await prisma.giveaway.findUnique({
      where: { id: input.giveawayId },
      select: { id: true, creatorId: true, asset: true, amountPerUser: true },
    });
    if (!giveaway) return null;
    // Self-claim is not a referral.
    if (giveaway.creatorId === input.claimantId) return null;

    const existing = await prisma.giveawayAttribution.findUnique({
      where: { giveawayId_claimantId: { giveawayId: input.giveawayId, claimantId: input.claimantId } },
    });
    if (existing) return { id: existing.id, alreadyExisted: true };

    // Link the claim row when it already exists (deep-link flow creates the
    // claim first; a retry where the claim arrives later just leaves claimId null).
    const claim = await prisma.giveawayClaim.findUnique({
      where: { giveawayId_userId: { giveawayId: input.giveawayId, userId: input.claimantId } },
      select: { id: true },
    });

    let attribution;
    try {
      attribution = await prisma.giveawayAttribution.create({
        data: {
          giveawayId: input.giveawayId,
          claimantId: input.claimantId,
          creatorId: giveaway.creatorId,
          claimId: claim?.id ?? null,
          source: input.source,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await prisma.giveawayAttribution.findUnique({
          where: { giveawayId_claimantId: { giveawayId: input.giveawayId, claimantId: input.claimantId } },
        });
        if (winner) return { id: winner.id, alreadyExisted: true };
      }
      throw err;
    }

    // ── First-time referral reward ──
    try {
      const priorCount = await prisma.giveawayAttribution.count({
        where: { claimantId: input.claimantId, id: { not: attribution.id } },
      });
      if (priorCount === 0) {
        const fees = await feeConfig.getFees();
        const amount = feeConfig.percentOf(Number(giveaway.amountPerUser), fees.referralRewardPercent);
        if (amount > 0) {
          await rewardsService.creditReward({
            userId: giveaway.creatorId,
            type: 'REFERRAL_REWARD',
            sourceType: 'giveaway_attribution',
            sourceId: attribution.id,
            asset: giveaway.asset,
            amount,
            idempotencyKey: hashIdempotencyKey('referral-reward', attribution.id),
            metadata: { claimantId: input.claimantId, giveawayId: input.giveawayId },
          });
          await prisma.auditLog.create({
            data: {
              action: 'REFERRAL_REWARD_CREDIT',
              entityType: 'reward',
              entityId: attribution.id,
              newValue: { claimantId: input.claimantId, amount, asset: giveaway.asset },
            },
          });
        }
      }
    } catch (err) {
      // Reward failure must never break attribution recording — the retry
      // path (reward idempotency) cannot re-trigger because priorCount is
      // now > 0. Log loudly for manual reconciliation instead.
      logger.error(`Referral reward FAILED for attribution ${attribution.id} — reconcile manually: ${(err as Error).message}`);
    }

    return { id: attribution.id, alreadyExisted: false };
  }

  /**
   * Scoped block check. A block matches when:
   *  - creator-scoped: creatorId + blockedUserId (giveawayId IS NULL), or
   *  - giveaway-scoped: creatorId + blockedUserId + this giveawayId.
   * Never a global ban — User.status stays admin-only.
   */
  async isBlocked(args: { creatorId: string; giveawayId: string; userId: string }): Promise<boolean> {
    const block = await prisma.claimBlock.findFirst({
      where: {
        creatorId: args.creatorId,
        blockedUserId: args.userId,
        OR: [{ giveawayId: null }, { giveawayId: args.giveawayId }],
      },
      select: { id: true },
    });
    return !!block;
  }

  async blockUser(args: {
    creatorId: string;
    blockedUserId: string;
    giveawayId?: string | null; // undefined/null → creator-scoped
    reason?: string;
  }): Promise<void> {
    const giveawayId = args.giveawayId ?? null;
    // Dedup first (Postgres NULLs don't collide in unique indexes; a benign
    // duplicate row is impossible to create here because we check first and
    // the UI only exposes one block action per user).
    const existing = await prisma.claimBlock.findFirst({
      where: { creatorId: args.creatorId, blockedUserId: args.blockedUserId, giveawayId },
    });
    if (existing) return;

    await prisma.claimBlock.create({
      data: {
        creatorId: args.creatorId,
        blockedUserId: args.blockedUserId,
        giveawayId,
        reason: args.reason ?? null,
      },
    });
    await prisma.auditLog.create({
      data: {
        action: 'CLAIM_BLOCK',
        entityType: 'claim_block',
        newValue: { creatorId: args.creatorId, blockedUserId: args.blockedUserId, giveawayId, reason: args.reason ?? null },
      },
    });
  }

  async unblockUser(args: { creatorId: string; blockedUserId: string; giveawayId?: string | null }): Promise<void> {
    const giveawayId = args.giveawayId ?? null;
    await prisma.claimBlock.deleteMany({
      where: { creatorId: args.creatorId, blockedUserId: args.blockedUserId, giveawayId },
    });
    await prisma.auditLog.create({
      data: {
        action: 'CLAIM_UNBLOCK',
        entityType: 'claim_block',
        newValue: { creatorId: args.creatorId, blockedUserId: args.blockedUserId, giveawayId },
      },
    });
  }
}

export const attributionService = new AttributionService();
