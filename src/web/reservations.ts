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

/**
 * Fast-path for "giveaway is full". Set ONLY after an authoritative in-transaction
 * check, for a few seconds. It can only ever REJECT sooner — it never authorises
 * anything — so when 1,000 people hit a full giveaway they don't queue on the lock.
 */
const fullFlag = new Map<string, { until: number; mayReopen: boolean }>();
const FULL_FLAG_MS = 3000;

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
 * cap per network/IP. Capacity is decided inside a DB transaction that holds a
 * row lock on the giveaway (plus the same Redis lock claimGiveaway uses), from
 * fresh rows only — never from the client, a cache, or a stale read.
 */
export async function reserveSlot(giveawayId: string, sig: RequestSignals, who: Claimer): Promise<ReserveResult> {
  const cfg = webConfig();
  if (!cfg.claimEnabled) return { ok: false, error: 'DISABLED' };
  const now = new Date();

  // 1. Idempotent: this wallet (any browser) or this browser already holds a live code.
  const live = await prisma.giveawayReservation.findFirst({
    where: {
      giveawayId, status: 'ACTIVE', expiresAt: { gt: now },
      OR: [{ addressHash: who.addressHash }, ...(sig.deviceHash ? [{ deviceHash: sig.deviceHash }] : [])],
    },
    include: { code: true },
  });
  if (live) {
    if (live.addressHash !== who.addressHash) {
      await recordBlock(giveawayId, 'WEAK_SIGNAL', 'SAME_DEVICE', sig, who, { note: 'same browser asked for a second code with a different wallet' });
      return { ok: false, error: 'DEVICE_LIMIT' };
    }
    const code = live.code?.status === 'ACTIVE' && live.code.codeCipher ? openCode(cfg.codeSecret, live.code.codeCipher) : null;
    if (code) return { ok: true, code, expiresAt: live.expiresAt, reused: true, maskedAddress: who.maskedAddress };
    return { ok: false, error: 'ADDRESS_USED' };
  }

  // 2. Already redeemed: this wallet, or this browser, or a bot-side claim with this wallet.
  const done = await prisma.giveawayReservation.findFirst({
    where: {
      giveawayId, status: 'CONVERTED',
      OR: [{ addressHash: who.addressHash }, ...(sig.deviceHash ? [{ deviceHash: sig.deviceHash }] : [])],
    },
    select: { addressHash: true },
  });
  if (done) {
    if (done.addressHash === who.addressHash) await recordBlock(giveawayId, 'CONFIRMED_DUPLICATE', 'SAME_WALLET_SAME_GIVEAWAY', sig, who, { via: 'website' });
    return { ok: false, error: 'ALREADY_CLAIMED' };
  }
  const walletUse = await prisma.giveawayWalletUse.findUnique({ where: { giveawayId_addressHash: { giveawayId, addressHash: who.addressHash } } });
  if (walletUse) {
    const c = await prisma.giveawayClaim.findUnique({ where: { id: walletUse.claimId }, select: { status: true } });
    if (c && !DEAD_CLAIM.includes(c.status)) {
      await recordBlock(giveawayId, 'CONFIRMED_DUPLICATE', 'SAME_WALLET_SAME_GIVEAWAY', sig, who, { via: 'bot-claim' });
      return { ok: false, error: 'ALREADY_CLAIMED' };
    }
  }

  // 3. Spam guard (rate-limit, not accusation): unused codes per browser per day.
  if (sig.deviceHash) {
    const unused = await prisma.giveawayReservation.count({
      where: { giveawayId, deviceHash: sig.deviceHash, status: { in: ['ACTIVE', 'EXPIRED', 'RELEASED'] }, createdAt: { gt: new Date(now.getTime() - 24 * 3600_000) } },
    });
    if (unused >= cfg.rl.maxReservationsPerDeviceDay) return { ok: false, error: 'DEVICE_LIMIT' };
  }

  // 4. Known-full fast path (rejects only).
  const ff = fullFlag.get(giveawayId);
  if (ff && ff.until > Date.now()) return { ok: false, error: 'FULL', mayReopen: ff.mayReopen };

  // 5. Authoritative section.
  const lockKey = `giveaway:claim:${giveawayId}`;
  let token: string | null = null;
  for (let i = 0; i < 24 && !token; i++) {
    token = await acquireLock(lockKey, 5000);
    if (!token) await sleep(60 + Math.floor(Math.random() * 90));
  }
  if (!token) return { ok: false, error: 'BUSY' };

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = generateClaimCode();
      try {
        const res = await prisma.$transaction(async (tx): Promise<ReserveResult> => {
          const rows = await tx.$queryRaw<{ status: string; claimedCount: number; maxClaimers: number; expiresAt: Date | null }[]>`
            SELECT status::text AS status, "claimedCount", "maxClaimers", "expiresAt"
              FROM giveaways WHERE id = ${giveawayId} FOR UPDATE`;
          const g = rows[0];
          if (!g) return { ok: false, error: 'NOT_FOUND' };
          if (g.status === 'FULL') return { ok: false, error: 'FULL', mayReopen: false };
          if (g.status !== 'ACTIVE') return { ok: false, error: g.status === 'EXPIRED' ? 'EXPIRED' : 'NOT_ACTIVE' };
          if (g.expiresAt && g.expiresAt <= now) return { ok: false, error: 'EXPIRED' };

          const held = await tx.giveawayReservation.count({ where: { giveawayId, status: 'ACTIVE', expiresAt: { gt: now } } });
          if (g.claimedCount + held >= g.maxClaimers) return { ok: false, error: 'FULL', mayReopen: held > 0 };

          const cap = cfg.rl.maxCodesPerIpPerGiveaway;
          if (cap > 0 && sig.ipHash) {
            const fromIp = await tx.giveawayReservation.count({
              where: { giveawayId, ipHash: sig.ipHash, OR: [{ status: 'CONVERTED' }, { status: 'ACTIVE', expiresAt: { gt: now } }] },
            });
            if (fromIp >= cap) return { ok: false, error: 'IP_LIMIT' };
          }

          const expiresAt = new Date(now.getTime() + cfg.reservationMinutes * 60_000);
          const reservation = await tx.giveawayReservation.create({
            data: { giveawayId, expiresAt, ipHash: sig.ipHash, deviceHash: sig.deviceHash, uaHash: sig.uaHash, addressHash: who.addressHash, maskedAddress: who.maskedAddress },
          });
          await tx.giveawayWebCode.create({
            data: {
              giveawayId, reservationId: reservation.id, codeHash: hashCode(cfg.hashSecret, code),
              codeCipher: sealCode(cfg.codeSecret, code), expiresAt, audit: { createdVia: 'website' },
            },
          });
          return { ok: true, code, expiresAt, reused: false, maskedAddress: who.maskedAddress };
        });
        if (!res.ok && res.error === 'FULL') fullFlag.set(giveawayId, { until: Date.now() + FULL_FLAG_MS, mayReopen: !!res.mayReopen });
        if (!res.ok && res.error === 'IP_LIMIT') await recordBlock(giveawayId, 'WEAK_SIGNAL', 'SAME_IP', sig, who, { policy: 'per-network cap', cap: cfg.rl.maxCodesPerIpPerGiveaway });
        return res;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }
    return { ok: false, error: 'BUSY' };
  } finally {
    await releaseLock(lockKey, token);
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
  if (codes.count || reservations.count) fullFlag.clear(); // freed slots become visible immediately
  if (codes.count || reservations.count) {
    logger.info(`[web] expiry sweep: ${codes.count} code(s), ${reservations.count} reservation(s) released`);
  }
  return { codes: codes.count, reservations: reservations.count };
            }
                        
