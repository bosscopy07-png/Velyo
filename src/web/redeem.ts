import { prisma } from '../database';
import { redis } from '../services/redis';
import { giveawayService } from '../services/giveaway';
import { logger } from '../utils/logger';
import { webConfig } from './config';
import { hashCode, isWellFormedCode } from './lib/codes';

export type RedeemFailure =
  | 'INVALID' | 'EXPIRED' | 'USED' | 'GIVEAWAY_CLOSED' | 'FULL' | 'ALREADY_CLAIMED'
  | 'BLOCKED' | 'BUSY' | 'RATE_LIMITED' | 'MAINTENANCE' | 'ERROR';

export type RedeemResult =
  | { ok: true; claimId: string; giveawayId: string; asset: string; amountPerUser: string; resumed: boolean }
  | { ok: false; code: RedeemFailure; claimId?: string; asset?: string; resumable?: boolean };

const failKey = (tg: string) => `webcode:fail:${tg}`;

async function isLocked(tg: string): Promise<boolean> {
  const n = Number((await redis.get(failKey(tg))) ?? 0);
  return n >= webConfig().codeFailLimit;
}
async function noteFailure(tg: string): Promise<void> {
  const k = failKey(tg);
  const n = await redis.incr(k);
  if (n === 1) await redis.pexpire(k, webConfig().codeFailWindowMs);
}

function mapClaimReason(reason = ''): RedeemFailure {
  const r = reason.toLowerCase();
  if (r.includes('maintenance')) return 'MAINTENANCE';
  if (r.includes('already claimed')) return 'ALREADY_CLAIMED';
  if (r.includes('full') || r.includes('filled')) return 'FULL';
  if (r.includes('not eligible')) return 'BLOCKED';
  if (r.includes('busy')) return 'BUSY';
  if (r.includes('not active') || r.includes('expired') || r.includes('not found')) return 'GIVEAWAY_CLOSED';
  return 'ERROR';
}

async function release(codeId: string, reservationId: string, to: 'CANCELLED'): Promise<void> {
  const now = new Date();
  await prisma.giveawayWebCode.updateMany({ where: { id: codeId, status: { in: ['ACTIVE', 'REDEEMED'] }, claimId: null }, data: { status: to, codeCipher: null } });
  await prisma.giveawayReservation.updateMany({ where: { id: reservationId, status: 'ACTIVE' }, data: { status: 'RELEASED', releasedAt: now } });
}

/**
 * Redeem a website-generated giveaway code for a Telegram user.
 * Hands the actual claim to the EXISTING giveawayService.claimGiveaway (same
 * atomic slot UPDATE, blocks, maintenance gate) — no second claim engine.
 * Safe to call repeatedly with the same input (idempotent).
 */
export async function redeemWebCode(input: { rawCode: string; userId: string; telegramId: string }): Promise<RedeemResult> {
  const cfg = webConfig();
  const { userId, telegramId } = input;

  if (await isLocked(telegramId)) return { ok: false, code: 'RATE_LIMITED' };
  if (!isWellFormedCode(input.rawCode)) {
    await noteFailure(telegramId);
    return { ok: false, code: 'INVALID' };
  }

  const code = await prisma.giveawayWebCode.findUnique({
    where: { codeHash: hashCode(cfg.hashSecret, input.rawCode) },
    include: { reservation: true },
  });
  if (!code) {
    await noteFailure(telegramId);
    return { ok: false, code: 'INVALID' };
  }

  const now = new Date();
  const mine = code.status === 'REDEEMED' && code.telegramUserId === telegramId;

  if (code.status === 'REDEEMED' && !mine) return { ok: false, code: 'USED' };
  if (!mine && (code.status === 'EXPIRED' || code.status === 'CANCELLED' || code.expiresAt <= now)) {
    return { ok: false, code: 'EXPIRED' };
  }

  const giveaway = await prisma.giveaway.findUnique({ where: { id: code.giveawayId } });
  if (!giveaway) return { ok: false, code: 'INVALID' };

  // ── Existing claim by this user in this giveaway (resume / already done) ──
  const existing = await prisma.giveawayClaim.findUnique({
    where: { giveawayId_userId: { giveawayId: giveaway.id, userId } },
  });
  if (existing) {
    const expired = existing.status === 'FAILED' && String(existing.failedReason ?? '').startsWith('Expired');
    if (expired) {
      // Same cleanup the existing deep-link flow performs so the reopened slot can be re-claimed.
      await prisma.giveawayClaim.delete({ where: { id: existing.id } }).catch(() => {});
      await prisma.auditLog.create({
        data: { action: 'EXPIRED_CLAIM_REMOVED', entityType: 'giveaway_claim', entityId: existing.id,
          newValue: { giveawayId: giveaway.id, via: 'web_code' } },
      });
    } else if (existing.status === 'RESERVED' || existing.status === 'ADDRESS_PENDING') {
      return { ok: false, code: 'ALREADY_CLAIMED', resumable: true, claimId: existing.id, asset: giveaway.asset };
    } else {
      return { ok: false, code: 'ALREADY_CLAIMED' };
    }
  }

  if (!mine) {
    if (giveaway.status === 'FULL') return { ok: false, code: 'FULL' };
    if (giveaway.status !== 'ACTIVE' || (giveaway.expiresAt && giveaway.expiresAt <= now)) {
      await release(code.id, code.reservationId, 'CANCELLED');
      return { ok: false, code: 'GIVEAWAY_CLOSED' };
    }

    // Atomic single-use consume: exactly one concurrent caller wins.
    const won = await prisma.giveawayWebCode.updateMany({
      where: { id: code.id, status: 'ACTIVE', expiresAt: { gt: now } },
      data: { status: 'REDEEMED', redeemedAt: now, telegramUserId: telegramId },
    });
    if (won.count !== 1) return { ok: false, code: 'USED' };
  }

  // Reservation is excluded from the guard so this code can use ITS OWN held slot.
  const res = await giveawayService.claimGiveaway(giveaway.id, userId, { reservationId: code.reservationId });
  if (!res.success) {
    const failure = mapClaimReason(res.reason);
    if (failure === 'BUSY' || failure === 'MAINTENANCE' || failure === 'ERROR') {
      // Transient: give the code back so the user can retry before it expires.
      await prisma.giveawayWebCode.updateMany({
        where: { id: code.id, status: 'REDEEMED', claimId: null, telegramUserId: telegramId },
        data: { status: 'ACTIVE', redeemedAt: null, telegramUserId: null },
      });
    } else {
      await release(code.id, code.reservationId, 'CANCELLED'); // terminal: free the held slot now
    }
    return { ok: false, code: failure };
  }

  const claim = await prisma.giveawayClaim.findUnique({
    where: { giveawayId_userId: { giveawayId: giveaway.id, userId } },
  });
  if (!claim) {
    logger.error(`[web] claim row missing after successful claim (giveaway ${giveaway.id}, user ${userId})`);
    return { ok: false, code: 'ERROR' };
  }

  // Convert: reservation → CONVERTED, code ↔ claim linked, audit trail.
  await prisma.$transaction([
    prisma.giveawayWebCode.update({ where: { id: code.id }, data: { claimId: claim.id, codeCipher: null } }),
    prisma.giveawayReservation.updateMany({
      where: { id: code.reservationId, status: { in: ['ACTIVE', 'EXPIRED'] } },
      data: { status: 'CONVERTED', convertedAt: new Date(), claimId: claim.id },
    }),
    prisma.auditLog.create({
      data: { userId, action: 'WEB_CODE_REDEEMED', entityType: 'giveaway_web_code', entityId: code.id,
        newValue: { giveawayId: giveaway.id, claimId: claim.id, reservationId: code.reservationId } },
    }),
  ]);

  try {
    const { attributionService } = await import('../services/attribution');
    await attributionService.recordAttribution({ giveawayId: giveaway.id, claimantId: userId, source: 'MANUAL_CODE' });
  } catch (err) {
    logger.error(`[web] attribution failed (non-fatal): ${(err as Error).message}`);
  }

  return { ok: true, claimId: claim.id, giveawayId: giveaway.id, asset: giveaway.asset, amountPerUser: giveaway.amountPerUser.toString(), resumed: mine };
     }
     
