import { Prisma } from '@prisma/client';
import { prisma } from '../database';
import { acquireLock, releaseLock } from '../services/redis';
import { logger } from '../utils/logger';
import { webConfig } from './config';
import { generateClaimCode, hashCode, openCode, sealCode } from './lib/codes';

export interface RequestSignals {
  ipHash: string | null;
  deviceHash: string | null;
  uaHash: string | null;
}

export type ReserveError =
  | 'NOT_FOUND' | 'FULL' | 'EXPIRED' | 'NOT_ACTIVE' | 'BUSY' | 'DEVICE_LIMIT' | 'DISABLED';

export type ReserveResult =
  | { ok: true; code: string; expiresAt: Date; reused: boolean }
  | { ok: false; error: ReserveError };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Atomically reserve ONE slot and mint a claim code.
 *
 * Concurrency model (defence in depth):
 *  1. Redis lock `giveaway:claim:<id>` — the SAME lock giveawayService
 *     .claimGiveaway holds, so a reservation and a direct Telegram claim are
 *     mutually exclusive for a giveaway.
 *  2. `SELECT ... FOR UPDATE` on the giveaway row inside a DB transaction —
 *     serialises concurrent reservations even across processes/lock expiry.
 *  3. Capacity = maxClaimers - claimedCount - live reservations, evaluated
 *     INSIDE the transaction from fresh rows (never from a cache or the client).
 *  4. Unique constraints (codeHash, reservationId) make double-minting impossible.
 */
export async function reserveSlot(giveawayId: string, sig: RequestSignals): Promise<ReserveResult> {
  const cfg = webConfig();
  if (!cfg.claimEnabled) return { ok: false, error: 'DISABLED' };
  const now = new Date();

  // Idempotent re-click: same device, still-live reservation → show the SAME code.
  if (sig.deviceHash) {
    const existing = await prisma.giveawayReservation.findFirst({
      where: { giveawayId, deviceHash: sig.deviceHash, status: 'ACTIVE', expiresAt: { gt: now } },
      include: { code: true },
    });
    if (existing?.code?.status === 'ACTIVE' && existing.code.codeCipher) {
      const code = openCode(cfg.codeSecret, existing.code.codeCipher);
      if (code) return { ok: true, code, expiresAt: existing.expiresAt, reused: true };
    }
    // Rate-limit (not accuse): unused reservations per device per giveaway per day.
    const unused = await prisma.giveawayReservation.count({
      where: {
        giveawayId, deviceHash: sig.deviceHash,
        status: { in: ['ACTIVE', 'EXPIRED', 'RELEASED'] },
        createdAt: { gt: new Date(now.getTime() - 24 * 3600_000) },
      },
    });
    if (unused >= cfg.rl.maxReservationsPerDeviceDay) return { ok: false, error: 'DEVICE_LIMIT' };
  }

  const lockKey = `giveaway:claim:${giveawayId}`;
  let token: string | null = null;
  for (let i = 0; i < 8 && !token; i++) {
    token = await acquireLock(lockKey, 5000);
    if (!token) await sleep(100 + Math.floor(Math.random() * 60));
  }
  if (!token) return { ok: false, error: 'BUSY' };

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = generateClaimCode();
      try {
        return await prisma.$transaction(async (tx): Promise<ReserveResult> => {
          const rows = await tx.$queryRaw<
            { status: string; claimedCount: number; maxClaimers: number; expiresAt: Date | null }[]
          >`SELECT status::text AS status, "claimedCount", "maxClaimers", "expiresAt"
              FROM giveaways WHERE id = ${giveawayId} FOR UPDATE`;
          const g = rows[0];
          if (!g) return { ok: false, error: 'NOT_FOUND' };
          if (g.status === 'FULL') return { ok: false, error: 'FULL' };
          if (g.status !== 'ACTIVE') return { ok: false, error: g.status === 'EXPIRED' ? 'EXPIRED' : 'NOT_ACTIVE' };
          if (g.expiresAt && g.expiresAt <= now) return { ok: false, error: 'EXPIRED' };

          const held = await tx.giveawayReservation.count({
            where: { giveawayId, status: 'ACTIVE', expiresAt: { gt: now } },
          });
          if (g.claimedCount + held >= g.maxClaimers) return { ok: false, error: 'FULL' };

          const expiresAt = new Date(now.getTime() + cfg.reservationMinutes * 60_000);
          const reservation = await tx.giveawayReservation.create({
            data: { giveawayId, expiresAt, ipHash: sig.ipHash, deviceHash: sig.deviceHash, uaHash: sig.uaHash },
          });
          await tx.giveawayWebCode.create({
            data: {
              giveawayId,
              reservationId: reservation.id,
              codeHash: hashCode(cfg.hashSecret, code),
              codeCipher: sealCode(cfg.codeSecret, code),
              expiresAt,
              audit: { createdVia: 'website' },
            },
          });
          return { ok: true, code, expiresAt, reused: false };
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue; // code collision → new code
        throw err;
      }
    }
    return { ok: false, error: 'BUSY' };
  } finally {
    await releaseLock(lockKey, token);
  }
}

/**
 * Idempotent expiry cleanup. Safe to run from any number of processes, any
 * number of times. Correctness NEVER depends on it (all capacity checks
 * ignore reservations past expiresAt); it just keeps tables tidy and wipes
 * the encrypted re-display copy of dead codes.
 */
export async function sweepExpired(): Promise<{ codes: number; reservations: number }> {
  const now = new Date();
  const codes = await prisma.giveawayWebCode.updateMany({
    where: { status: 'ACTIVE', expiresAt: { lte: now } },
    data: { status: 'EXPIRED', codeCipher: null },
  });
  const reservations = await prisma.giveawayReservation.updateMany({
    where: { status: 'ACTIVE', expiresAt: { lte: now } },
    data: { status: 'EXPIRED', releasedAt: now },
  });
  if (codes.count || reservations.count) {
    logger.info(`[web] expiry sweep: ${codes.count} code(s), ${reservations.count} reservation(s) released`);
  }
  return { codes: codes.count, reservations: reservations.count };
  }
      
