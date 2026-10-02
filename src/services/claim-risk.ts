import { Prisma } from '@prisma/client';
import { prisma } from '../database';
import { logger } from '../utils/logger';

/**
 * Anti-looting / duplicate-claim SIGNALS. Deliberately conservative:
 *
 *  - NO IP-based logic of any kind (bots cannot see IPs; shared IPs are
 *    meaningless — spec §9).
 *  - NO automatic bans. Matches only ever create ClaimFlag rows with
 *    severity POSSIBLE_DUPLICATE for creator/admin review.
 */

export type RiskSignal = 'SHARED_WALLET' | 'CROSS_ACCOUNT_WALLET' | 'CLAIM_VELOCITY';

interface SignalCheck {
  signal: RiskSignal;
  detail: Prisma.InputJsonObject;
}

/** Pure classifier — exported for unit tests (no DB). */
export function matchSharedWallet(
  walletAddress: string | null | undefined,
  otherClaims: Array<{ userId: string; walletAddress: string | null }>,
  ownUserId: string
): SignalCheck | null {
  if (!walletAddress) return null;
  const norm = walletAddress.toLowerCase();
  const others = otherClaims.filter(
    (c) => c.userId !== ownUserId && c.walletAddress && c.walletAddress.toLowerCase() === norm
  );
  if (others.length === 0) return null;
  return {
    signal: 'SHARED_WALLET',
    detail: { walletAddress: norm, otherUserIds: others.map((o) => o.userId) },
  };
}

/** Pure classifier — exported for unit tests (no DB). */
export function matchClaimVelocity(claimsLast24h: number, threshold = 5): SignalCheck | null {
  if (claimsLast24h < threshold) return null;
  return { signal: 'CLAIM_VELOCITY', detail: { claimsLast24h, threshold } };
}

class ClaimRiskService {
  /**
   * Evaluate a single claim after its payout address is submitted (that is
   * when wallet-based signals exist). Best-effort: never throws into the
   * claim flow.
   */
  async evaluateClaim(claimId: string): Promise<void> {
    try {
      const claim = await prisma.giveawayClaim.findUnique({
        where: { id: claimId },
        include: { giveaway: { select: { id: true, creatorId: true } } },
      });
      if (!claim || !claim.walletAddress) return;

      const checks: SignalCheck[] = [];

      // Signal 1: same payout wallet claimed twice in THIS giveaway.
      const siblingClaims = await prisma.giveawayClaim.findMany({
        where: { giveawayId: claim.giveawayId, walletAddress: { not: null } },
        select: { userId: true, walletAddress: true },
      });
      const shared = matchSharedWallet(claim.walletAddress, siblingClaims, claim.userId);
      if (shared) checks.push(shared);

      // Signal 2: same wallet address seen under DIFFERENT telegram users
      // anywhere on the platform (only when the address is confirmed).
      const crossAccounts = await prisma.giveawayClaim.findMany({
        where: {
          walletAddress: { equals: claim.walletAddress, mode: 'insensitive' },
          userId: { not: claim.userId },
        },
        select: { userId: true },
        take: 5,
      });
      if (crossAccounts.length > 0 && !shared) {
        checks.push({
          signal: 'CROSS_ACCOUNT_WALLET',
          detail: { walletAddress: claim.walletAddress.toLowerCase(), otherUserIds: crossAccounts.map((c) => c.userId) },
        });
      }

      // Signal 3: claim velocity — one account sweeping many giveaways.
      const dayAgo = new Date(Date.now() - 24 * 3600_000);
      const recentCount = await prisma.giveawayClaim.count({
        where: { userId: claim.userId, claimedAt: { gte: dayAgo } },
      });
      const velocity = matchClaimVelocity(recentCount);
      if (velocity) checks.push(velocity);

      for (const check of checks) {
        const dup = await prisma.claimFlag.findFirst({
          where: { claimId, signal: check.signal, status: 'OPEN' },
        });
        if (dup) continue;
        await prisma.claimFlag.create({
          data: {
            claimId,
            giveawayId: claim.giveawayId,
            signal: check.signal,
            severity: 'POSSIBLE_DUPLICATE',
            detail: check.detail,
          },
        });
        logger.info(`Claim ${claimId} flagged POSSIBLE_DUPLICATE (${check.signal})`);
      }
    } catch (err) {
      // Flagging is advisory — never break the payout flow over it.
      logger.error(`evaluateClaim(${claimId}) failed: ${(err as Error).message}`);
    }
  }

  async listOpenFlags(giveawayId?: string) {
    return prisma.claimFlag.findMany({
      where: { status: 'OPEN', ...(giveawayId ? { giveawayId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        claim: { select: { user: { select: { telegramId: true, username: true, firstName: true } } } },
      },
    });
  }

  async reviewFlag(flagId: string, adminTelegramId: string, decision: 'DISMISSED' | 'CONFIRMED'): Promise<void> {
    await prisma.claimFlag.update({
      where: { id: flagId },
      data: { status: decision, reviewedAt: new Date(), reviewedBy: adminTelegramId },
    });
    await prisma.auditLog.create({
      data: {
        adminId: adminTelegramId,
        action: `CLAIM_FLAG_${decision}`,
        entityType: 'claim_flag',
        entityId: flagId,
      },
    });
  }
}

export const claimRiskService = new ClaimRiskService();
  
