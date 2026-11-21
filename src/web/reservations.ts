import { Prisma } from '@prisma/client';
import { prisma } from '../database';
import { acquireLock, releaseLock } from '../services/redis';
import { logger } from '../utils/logger';
import { webConfig } from './config';
import { generateClaimCode, hashCode, openCode, sealCode } from './lib/codes';
import { ClaimGate } from './lib/gate';

export interface RequestSignals {
  ipHash: string | null;
  deviceHash: string | null;
  uaHash: string | null;
}
/** The wallet the visitor typed BEFORE a code is issued (hash + masked display form). */
export interface Claimer {
  addressHash: string;
  maskedAddress: string;
}

export type ReserveError =
  | 'NOT_FOUND' | 'FULL' | 'EXPIRED' | 'NOT_ACTIVE' | 'BUSY' | 'DEVICE_LIMIT' | 'DISABLED'
  | 'ADDRESS_USED' | 'ALREADY_CLAIMED' | 'IP_LIMIT';

export type ReserveResult =
  | { ok: true; code: string; expiresAt: Date; reused: boolean; maskedAddress: string }
  | { ok: false; error: ReserveError; mayReopen?: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEAD_CLAIM = ['FAILED', 'REJECTED'];
const NOW_UTC = Prisma.sql`(NOW() AT TIME ZONE 'UTC')`;

/** One admission gate per giveaway (see lib/gate.ts). */
const gates = new Map<string, ClaimGate>();
function gateFor(giveawayId: string): ClaimGate {
  let g = gates.get(giveawayId);
  if (!g) {
    if (gates.size > 500) gates.clear();
    g = new ClaimGate(async () => {
      const rows = await prisma.$queryRaw<{ remaining: number; held: number; active: boolean }[]>`
        SELECT GREATEST(0, g."maxClaimers" - g."claimedCount" - h.held)::int AS remaining, h.held::int AS held,
               (g.status = 'ACTIVE' AND (g."expiresAt" IS NULL OR g."expiresAt" > ${NOW_UTC})) AS active
          FROM giveaways g,
               LATERAL (SELECT count(*) AS held FROM giveaway_reservations r
                         WHERE r."giveawayId" = g.id AND r.status = 'ACTIVE' AND r."expiresAt" > ${NOW_UTC}) h
         WHERE g.id = ${giveawayId}`;
      const r = rows[0];
      // Ended / missing giveaways: admit everyone so the authoritative step answers with the exact reason.
      return !r || !r.active ? { remaining: 1_000_000, held: 0 } : { remaining: r.remaining, held: r.held };
    });
    gates.set(giveawayId, g);
  }
  return g;
}

async function recordBlock(
  giveawayId: string, level: 'CONFIRMED_DUPLICATE' | 'WEAK_SIGNAL', type: string, sig: RequestSignals, who: Claimer, detail: Record<string, unknown>
): Promise<void> {
  try {
    const recent = await prisma.duplicateEvidence.findFirst({
      where: { giveawayId, level, walletHash: who.addressHash, decision: 'REJECTED', createdAt: { gt: new Date(Date.now() - 3600_000) } },
    });
    if (recent) return; // one row per wallet per hour — repeated taps must not flood the evidence table
    await prisma.duplicateEvidence.create({
      data: {
        giveawayId, level, signals: [{ type, detail }] as unknown as Prisma.InputJsonValue,
        walletHash: who.addressHash, maskedWallet: who.maskedAddress,
        signalRefs: { ip: sig.ipHash?.slice(0, 10) ?? null, device: sig.deviceHash?.slice(0, 10) ?? null, stage: 'website-code' },
        decision: 'REJECTED', reviewStatus: 'NOT_REQUIRED',
      },
    });
  } catch (err) {
    logger.warn(`[web] evidence write skipped: ${(err as Error).message}`);
  }
}

/**
 * Atomically reserve ONE slot for ONE wallet address and mint a claim code.
 *
 * One slot per wallet address per giveaway; one code per browser; a configurable
 * cap per network/IP. Layers:
 *  A. ONE indexed query for anything this wallet/browser already holds here (idempotent re-show, duplicates);
 *  B. an in-memory admission gate: only as many requests as there are free slots go further, the
 *     rest get an instant "full" (so 1,000 visitors never queue on a 20-slot giveaway);
 *  C. admitted requests run one at a time (FIFO) through the authoritative section: Redis lock shared with
 *     claimGiveaway + a DB transaction holding a row lock, deciding capacity from FRESH rows only.
 * Only C can approve a slot, so nothing above it can cause over-issuing.
 */
export async function reserveSlot(giveawayId: string, sig: RequestSignals, who: Claimer): Promise<ReserveResult> {
  const cfg = webConfig();
  if (!cfg.claimEnabled) return { ok: false, error: 'DISABLED' };
  const now = new Date();

  // A. everything this wallet or browser already has in this giveaway (single query)
  const mine = await prisma.giveawayReservation.findMany({
    where: { giveawayId, OR: [{ addressHash: who.addressHash }, ...(sig.deviceHash ? [{ deviceHash: sig.deviceHash }] : [])] },
    include: { code: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  const live = mine.find((r) => r.status === 'ACTIVE' && r.expiresAt > now);
  if (live) {
    if (live.addressHash !== who.addressHash) {
      await recordBlock(giveawayId, 'WEAK_SIGNAL', 'SAME_DEVICE', sig, who, { note: 'same browser asked for a second code with a different wallet' });
      return { ok: false, error: 'DEVICE_LIMIT' };
    }
    const code = live.code?.status === 'ACTIVE' && live.code.codeCipher ? openCode(cfg.codeSecret, live.code.codeCipher) : null;
    if (code) return { ok: true, code, expiresAt: live.expiresAt, reused: true, maskedAddress: who.maskedAddress };
    return { ok: false, error: 'ADDRESS_USED' };
  }

  const done = mine.find((r) => r.status === 'CONVERTED');
  if (done) {
    if (done.addressHash === who.addressHash) await recordBlock(giveawayId, 'CONFIRMED_DUPLICATE', 'SAME_WALLET_SAME_GIVEAWAY', sig, who, { via: 'website' });
    return { ok: false, error: 'ALREADY_CLAIMED' };
  }

  if (sig.deviceHash) {
    const since = now.getTime() - 24 * 3600_000;
    const unused = mine.filter((r) => r.deviceHash === sig.deviceHash && ['ACTIVE', 'EXPIRED', 'RELEASED'].includes(r.status) && r.createdAt.getTime() > since).length;
    if (unused >= cfg.rl.maxReservationsPerDeviceDay) return { ok: false, error: 'DEVICE_LIMIT' };
  }

  // B. admission control (instant "full" for everyone who cannot possibly get a slot)
  const gate = gateFor(giveawayId);
  if (!(await gate.admit())) return { ok: false, error: 'FULL', mayReopen: gate.held > 0 || gate.inflight > 0 };

  let success = false;
  try {
    // bot-side claim already using this wallet in this giveaway
    const walletUse = await prisma.giveawayWalletUse.findUnique({ where: { giveawayId_addressHash: { giveawayId, addressHash: who.addressHash } } });
    if (walletUse) {
      const c = await prisma.giveawayClaim.findUnique({ where: { id: walletUse.claimId }, select: { status: true } });
      if (c && !DEAD_CLAIM.includes(c.status)) {
        await recordBlock(giveawayId, 'CONFIRMED_DUPLICATE', 'SAME_WALLET_SAME_GIVEAWAY', sig, who, { via: 'bot-claim' });
        return { ok: false, error: 'ALREADY_CLAIMED' };
      }
    }

    // C. one at a time, in arrival order
    const res = await gate.exclusive(() => authoritative(giveawayId, sig, who));
    success = res.ok;
    if (!res.ok && res.error === 'FULL') gate.markFull(res.mayReopen ? 1 : 0);
    if (!res.ok && res.error === 'IP_LIMIT') await recordBlock(giveawayId, 'WEAK_SIGNAL', 'SAME_IP', sig, who, { policy: 'per-network cap', cap: cfg.rl.maxCodesPerIpPerGiveaway });
    return res;
  } finally {
    gate.release(success);
  }
}

/** The ONLY place a slot can be approved. */
async function authoritative(giveawayId: string, sig: RequestSignals, who: Claimer): Promise<ReserveResult> {
  const cfg = webConfig();
  const lockKey = `giveaway:claim:${giveawayId}`;
  // The Redis lock only coordinates with the bot's own claim flow. The DB row lock (FOR UPDATE) below is what
  // guarantees correctness, so a visitor is NEVER turned away with "busy" just because the Redis lock is taken.
  let token: string | null = null;
  for (let i = 0; i < 5 && !token; i++) {
    token = await acquireLock(lockKey, 5000);
    if (!token) await sleep(20 + Math.floor(Math.random() * 30));
  }

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = generateClaimCode();
      try {
        return await prisma.$transaction(async (tx): Promise<ReserveResult> => {
          // Statement 1: take the row lock. (Only the lock + the giveaway's own columns here.)
          const rows = await tx.$queryRaw<{ status: string; claimedCount: number; maxClaimers: number; expired: boolean }[]>`
            SELECT g.status::text AS status, g."claimedCount", g."maxClaimers",
                   (g."expiresAt" IS NOT NULL AND g."expiresAt" <= ${NOW_UTC}) AS expired
              FROM giveaways g WHERE g.id = ${giveawayId} FOR UPDATE`;
          const g = rows[0];
          if (!g) return { ok: false, error: 'NOT_FOUND' };
          if (g.status === 'FULL') return { ok: false, error: 'FULL', mayReopen: false };
          if (g.status !== 'ACTIVE') return { ok: false, error: g.status === 'EXPIRED' ? 'EXPIRED' : 'NOT_ACTIVE' };
          if (g.expired) return { ok: false, error: 'EXPIRED' };

          // Statement 2: counts + duplicate lookup. This MUST be a separate statement AFTER the lock: in READ COMMITTED
          // a statement keeps the snapshot it started with, so counting inside the locking statement could miss a
          // reservation another transaction committed while we waited for the lock.
          const st = (await tx.$queryRaw<{ held: number; fromIp: number; dupeId: string | null }[]>`
            SELECT
              (SELECT count(*) FROM giveaway_reservations r WHERE r."giveawayId" = ${giveawayId} AND r.status = 'ACTIVE' AND r."expiresAt" > ${NOW_UTC})::int AS held,
              (SELECT count(*) FROM giveaway_reservations r WHERE r."giveawayId" = ${giveawayId} AND r."ipHash" = ${sig.ipHash ?? ''}
                  AND (r.status = 'CONVERTED' OR (r.status = 'ACTIVE' AND r."expiresAt" > ${NOW_UTC})))::int AS "fromIp",
              (SELECT r.id FROM giveaway_reservations r WHERE r."giveawayId" = ${giveawayId} AND r."addressHash" = ${who.addressHash}
                  AND (r.status = 'CONVERTED' OR (r.status = 'ACTIVE' AND r."expiresAt" > ${NOW_UTC})) LIMIT 1) AS "dupeId"`)[0];

          // Authoritative uniqueness (two simultaneous requests for the same wallet can both pass the early check).
          if (st.dupeId) {
            const dupe = await tx.giveawayReservation.findUnique({ where: { id: st.dupeId }, include: { code: true } });
            if (dupe && dupe.status === 'ACTIVE' && dupe.code?.status === 'ACTIVE' && dupe.code.codeCipher) {
              const again = openCode(cfg.codeSecret, dupe.code.codeCipher);
              if (again) return { ok: true, code: again, expiresAt: dupe.expiresAt, reused: true, maskedAddress: who.maskedAddress };
            }
            return { ok: false, error: 'ALREADY_CLAIMED' };
          }

          if (g.claimedCount + st.held >= g.maxClaimers) return { ok: false, error: 'FULL', mayReopen: st.held > 0 };

          const cap = cfg.rl.maxCodesPerIpPerGiveaway;
          if (cap > 0 && sig.ipHash && st.fromIp >= cap) return { ok: false, error: 'IP_LIMIT' };

          const expiresAt = new Date(Date.now() + cfg.reservationMinutes * 60_000);
          await tx.giveawayReservation.create({
            data: {
              giveawayId, expiresAt, ipHash: sig.ipHash, deviceHash: sig.deviceHash, uaHash: sig.uaHash,
              addressHash: who.addressHash, maskedAddress: who.maskedAddress,
              code: { create: { giveawayId, codeHash: hashCode(cfg.hashSecret, code), codeCipher: sealCode(cfg.codeSecret, code), expiresAt, audit: { createdVia: 'website' } } },
            },
          });
          return { ok: true, code, expiresAt, reused: false, maskedAddress: who.maskedAddress };
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }
    return { ok: false, error: 'BUSY' };
  } finally {
    if (token) await releaseLock(lockKey, token);
  }
}

/**
 * Idempotent expiry cleanup. Correctness NEVER depends on it (capacity checks
 * ignore reservations past expiresAt); it tidies tables and wipes the
 * encrypted re-display copy of dead codes.
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
  if (codes.count || reservations.count) gates.forEach((g) => g.reset()); // freed slots become visible immediately
  if (codes.count || reservations.count) {
    logger.info(`[web] expiry sweep: ${codes.count} code(s), ${reservations.count} reservation(s) released`);
  }
  return { codes: codes.count, reservations: reservations.count };
}
