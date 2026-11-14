import { Prisma } from '@prisma/client';
import { prisma } from '../database';
import { logger } from '../utils/logger';
import { webConfig } from './config';
import { hashAddress, maskAddress, shortRef } from './lib/codes';
import { classifySignals, VELOCITY_THRESHOLD, type Signal } from './lib/risk';

/**
 * Giveaway-scoped duplicate protection.
 *
 *  - The wallet registry (giveaway_wallet_uses, unique on giveaway+addressHash)
 *    is the ONLY thing that can reject a claim. It is per giveaway: the same
 *    address in another giveaway is never affected, and no user/platform-wide
 *    status is ever touched here.
 *  - IP / device signals are stored as keyed hashes, are supporting evidence
 *    only, and can never reject on their own.
 */

const DEAD_CLAIM_STATUSES = ['FAILED', 'REJECTED'];

export type AddressDecision =
  | { outcome: 'ALLOWED'; level: string; evidenceId?: string }
  | { outcome: 'DUPLICATE'; evidenceId: string; previousClaimId: string };

export async function registerPayoutAddress(args: { claimId: string; address: string }): Promise<AddressDecision> {
  const cfg = webConfig();
  const claim = await prisma.giveawayClaim.findUnique({
    where: { id: args.claimId },
    include: { user: { select: { telegramId: true } } },
  });
  if (!claim) return { outcome: 'ALLOWED', level: 'NONE' };

  const addressHash = hashAddress(cfg.hashSecret, args.address);
  const masked = maskAddress(args.address);
  const reservation = await prisma.giveawayReservation.findFirst({ where: { claimId: claim.id } });

  const signals: Signal[] = [];
  let previousClaim: { id: string; claimedAt: Date; telegramId: string } | null = null;

  if (cfg.duplicateWalletEnforcement) {
    const dup = await claimAddress(claim.giveawayId, claim.id, claim.user.telegramId, addressHash, masked);
    if (dup) {
      const evidence = await prisma.duplicateEvidence.create({
        data: {
          giveawayId: claim.giveawayId,
          level: 'CONFIRMED_DUPLICATE',
          signals: [{ type: 'SAME_WALLET_SAME_GIVEAWAY', detail: { scope: 'giveaway' } }],
          currentClaimId: claim.id,
          currentReservationId: reservation?.id ?? null,
          previousClaimId: dup.id,
          previousClaimAt: dup.claimedAt,
          walletHash: addressHash,
          maskedWallet: masked,
          relatedTelegramIds: [dup.telegramId, claim.user.telegramId],
          signalRefs: { ip: shortRef(reservation?.ipHash), device: shortRef(reservation?.deviceHash) },
          decision: 'REJECTED',
          reviewStatus: 'OPEN',
        },
      });
      await rejectClaim(claim.id, claim.giveawayId, 'DUPLICATE_WALLET');
      await prisma.auditLog.create({
        data: {
          userId: claim.userId, action: 'DUPLICATE_WALLET_REJECTED', entityType: 'giveaway_claim', entityId: claim.id,
          newValue: { giveawayId: claim.giveawayId, previousClaimId: dup.id, evidenceId: evidence.id },
        },
      });
      logger.info(`[antiabuse] claim ${claim.id} rejected: same wallet as claim ${dup.id} in giveaway ${claim.giveawayId}`);
      return { outcome: 'DUPLICATE', evidenceId: evidence.id, previousClaimId: dup.id };
    }
  }

  // ── Supporting signals (never reject) ──
  try {
    if (reservation) {
      const others = await prisma.giveawayReservation.findMany({
        where: { giveawayId: claim.giveawayId, id: { not: reservation.id } },
        select: { id: true, ipHash: true, deviceHash: true, claimId: true, status: true, createdAt: true },
      });
      const sinceDay = Date.now() - 24 * 3600_000;
      const sameIp = reservation.ipHash ? others.filter((o) => o.ipHash === reservation.ipHash && o.claimId) : [];
      const sameDev = reservation.deviceHash ? others.filter((o) => o.deviceHash === reservation.deviceHash && o.claimId) : [];
      const burst = others.filter(
        (o) => o.createdAt.getTime() > sinceDay &&
          ((reservation.ipHash && o.ipHash === reservation.ipHash) || (reservation.deviceHash && o.deviceHash === reservation.deviceHash))
      );
      if (sameIp.length) signals.push({ type: 'SAME_IP', detail: { otherClaims: sameIp.length, note: 'shared networks are common; supporting evidence only' } });
      if (sameDev.length) signals.push({ type: 'SAME_DEVICE', detail: { otherClaims: sameDev.length, note: 'browser token; not proof of identity' } });
      if (burst.length + 1 >= VELOCITY_THRESHOLD) signals.push({ type: 'RESERVATION_VELOCITY', detail: { reservations24h: burst.length + 1 } });
      const first = [...sameDev, ...sameIp][0];
      if (first?.claimId) {
        const pc = await prisma.giveawayClaim.findUnique({ where: { id: first.claimId }, include: { user: { select: { telegramId: true } } } });
        if (pc) previousClaim = { id: pc.id, claimedAt: pc.claimedAt, telegramId: pc.user.telegramId };
      }
    }
    // Same wallet used by a DIFFERENT Telegram account in ANOTHER giveaway: a signal, not a ban.
    const cross = await prisma.giveawayWalletUse.findMany({
      where: { addressHash, giveawayId: { not: claim.giveawayId }, telegramId: { not: claim.user.telegramId } },
      take: 5,
    });
    if (cross.length) signals.push({ type: 'CROSS_ACCOUNT_WALLET_OTHER_GIVEAWAY', detail: { otherGiveaways: cross.length } });
  } catch (err) {
    logger.error(`[antiabuse] signal gathering failed (non-fatal): ${(err as Error).message}`);
  }

  const cls = classifySignals(signals);
  if (cls.level === 'NONE' || cls.level === 'CONFIRMED_DUPLICATE') return { outcome: 'ALLOWED', level: 'NONE' };

  const already = await prisma.duplicateEvidence.findFirst({
    where: { currentClaimId: claim.id, level: cls.level, decision: cls.decision },
  });
  if (already) return { outcome: 'ALLOWED', level: cls.level, evidenceId: already.id };

  const ev = await prisma.duplicateEvidence.create({
    data: {
      giveawayId: claim.giveawayId,
      level: cls.level,
      signals: signals as unknown as Prisma.InputJsonValue,
      currentClaimId: claim.id,
      currentReservationId: reservation?.id ?? null,
      previousClaimId: previousClaim?.id ?? null,
      previousClaimAt: previousClaim?.claimedAt ?? null,
      walletHash: addressHash,
      maskedWallet: masked,
      relatedTelegramIds: previousClaim ? [previousClaim.telegramId, claim.user.telegramId] : [claim.user.telegramId],
      signalRefs: { ip: shortRef(reservation?.ipHash), device: shortRef(reservation?.deviceHash) },
      decision: cls.decision,
      reviewStatus: cls.reviewRequired ? 'OPEN' : 'NOT_REQUIRED',
    },
  });
  logger.info(`[antiabuse] claim ${claim.id}: ${cls.level} (${cls.decision}) — payout NOT blocked`);
  return { outcome: 'ALLOWED', level: cls.level, evidenceId: ev.id };
}

/**
 * Atomically register `addressHash` for this giveaway. Returns null when the
 * address is ours (or was free / held by a dead claim), or the PREVIOUS live
 * claim when it is a genuine duplicate.
 */
async function claimAddress(
  giveawayId: string, claimId: string, telegramId: string, addressHash: string, masked: string
): Promise<{ id: string; claimedAt: Date; telegramId: string } | null> {
  // The same claim re-confirming with a different address replaces its own row.
  await prisma.giveawayWalletUse.deleteMany({ where: { claimId, addressHash: { not: addressHash } } });

  for (let i = 0; i < 3; i++) {
    try {
      await prisma.giveawayWalletUse.create({ data: { giveawayId, addressHash, maskedAddress: masked, claimId, telegramId } });
      return null;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
    const prior = await prisma.giveawayWalletUse.findUnique({ where: { giveawayId_addressHash: { giveawayId, addressHash } } });
    if (!prior) continue;
    if (prior.claimId === claimId) return null; // idempotent re-confirm
    const prev = await prisma.giveawayClaim.findUnique({ where: { id: prior.claimId } });
    const live = !!prev && !DEAD_CLAIM_STATUSES.includes(prev.status);
    if (live && prev) return { id: prev.id, claimedAt: prev.claimedAt, telegramId: prior.telegramId };
    // Previous holder is dead (failed/rejected/gone): take over — compare-and-swap so two racers can't both win.
    const swapped = await prisma.giveawayWalletUse.updateMany({
      where: { id: prior.id, claimId: prior.claimId },
      data: { claimId, telegramId, maskedAddress: masked },
    });
    if (swapped.count === 1) return null;
  }
  // Could not settle after retries: fail SAFE (treat as duplicate-in-progress is wrong; surface as error upstream).
  throw new Error('wallet registry contention');
}

/** Reject a not-yet-paid claim and release its slot (idempotent: only the first call decrements). */
async function rejectClaim(claimId: string, giveawayId: string, reason: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const u = await tx.giveawayClaim.updateMany({
      where: { id: claimId, status: { in: ['RESERVED', 'ADDRESS_PENDING'] } },
      data: { status: 'REJECTED', failedReason: reason },
    });
    if (u.count === 1) {
      await tx.$executeRaw`
        UPDATE giveaways
           SET "claimedCount" = "claimedCount" - 1,
               status = CASE WHEN status = 'FULL' THEN 'ACTIVE'::"GiveawayStatus" ELSE status END,
               "updatedAt" = NOW()
         WHERE id = ${giveawayId} AND "claimedCount" > 0`;
    }
  });
}

// ── Admin review ────────────────────────────────────────────────────────────
export function listOpenEvidence(limit = 8) {
  return prisma.duplicateEvidence.findMany({
    where: { reviewStatus: 'OPEN' }, orderBy: { createdAt: 'desc' }, take: limit,
  });
}

export async function reviewEvidence(id: string, adminTelegramId: string, decision: 'DISMISSED' | 'CONFIRMED'): Promise<boolean> {
  const r = await prisma.duplicateEvidence.updateMany({
    where: { id, reviewStatus: 'OPEN' },
    data: { reviewStatus: decision, reviewedBy: adminTelegramId, reviewedAt: new Date() },
  });
  if (r.count === 1) {
    await prisma.auditLog.create({
      data: { adminId: adminTelegramId, action: `DUPLICATE_EVIDENCE_${decision}`, entityType: 'duplicate_evidence', entityId: id },
    });
  }
  return r.count === 1;
}
