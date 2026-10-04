import { Prisma } from '@prisma/client';
import { prisma } from '../database';
import { hashIdempotencyKey } from '../utils/encryption';
import { logger } from '../utils/logger';
import { rewardsService } from './rewards';

/**
 * Giveaway-link referral attribution.
 *
 * Velyo deliberately has NO separate referral-link system: the giveaway
 * link IS the attribution mechanism. User B claims User A's giveaway → one
 * GiveawayAttribution row (unique per giveaway+claimant, stable internal
 * user IDs — never usernames).
 *
 * REWARD MODEL (UPGRADE): the referral reward does NOT pay on first claim.
 * Instead: when a referred user CREATES a giveaway and it is fully paid
 * out, the referrer earns the configured % (settled in
 * workers/payout.maybeCompleteGiveaway). getReferrerOf() resolves the
 * referrer as the creator of the user's EARLIEST attribution.
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

    try {
      const attribution = await prisma.giveawayAttribution.create({
        data: {
          giveawayId: input.giveawayId,
          claimantId: input.claimantId,
          creatorId: giveaway.creatorId,
          claimId: claim?.id ?? null,
          source: input.source,
        },
      });
      return { id: attribution.id, alreadyExisted: false };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await prisma.giveawayAttribution.findUnique({
          where: { giveawayId_claimantId: { giveawayId: input.giveawayId, claimantId: input.claimantId } },
        });
        if (winner) return { id: winner.id, alreadyExisted: true };
      }
      throw err;
    }
  }

  /**
   * The referrer of a user = the creator of the EARLIEST giveaway that user
   * claimed through a giveaway link. Drives the referral reward: when the
   * referred user CREATES and fully pays out a giveaway, this referrer earns
   * the configured % (settled in workers/payout.maybeCompleteGiveaway).
   */
  async getReferrerOf(userId: string): Promise<{ id: string; telegramId: string; username: string | null } | null> {
    const first = await prisma.giveawayAttribution.findFirst({
      where: { claimantId: userId },
      orderBy: { createdAt: 'asc' },
      include: { creator: { select: { id: true, telegramId: true, username: true } } },
    });
    return first?.creator ?? null;
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
      
