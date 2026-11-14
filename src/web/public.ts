import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../database';
import { webConfig } from './config';
import { derivePublicStatus, LISTABLE_DB_STATUSES, type PublicStatus } from './lib/public-status';

export interface PublicGiveaway {
  slug: string;
  title: string;
  description: string | null;
  asset: string;
  amountPerUser: string;
  totalAmount: string;
  maxClaimers: number;
  claimedCount: number;
  availableSlots: number;
  status: PublicStatus;
  claimable: boolean;
  expiresAt: string | null;
  createdAt: string;
}

const SLUG_ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789';
const newSlug = () => Array.from(randomBytes(10), (b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join('');

export function trimDecimal(d: Prisma.Decimal | string | number): string {
  const s = new Prisma.Decimal(d).toFixed();
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** Stable, non-guessable public slug (created on first exposure). */
export async function slugFor(giveawayId: string): Promise<string> {
  const found = await prisma.giveawayPublicLink.findUnique({ where: { giveawayId } });
  if (found) return found.slug;
  for (let i = 0; i < 4; i++) {
    try {
      return (await prisma.giveawayPublicLink.create({ data: { giveawayId, slug: newSlug() } })).slug;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const again = await prisma.giveawayPublicLink.findUnique({ where: { giveawayId } });
        if (again) return again.slug; // lost a race for the same giveaway
        continue; // slug collision
      }
      throw err;
    }
  }
  throw new Error('slug allocation failed');
}

export async function resolveSlug(slug: string): Promise<string | null> {
  if (!/^[a-z0-9]{6,32}$/.test(slug)) return null;
  const row = await prisma.giveawayPublicLink.findUnique({ where: { slug } });
  return row?.giveawayId ?? null;
}

type Row = {
  id: string; asset: string; totalAmount: Prisma.Decimal; amountPerUser: Prisma.Decimal; maxClaimers: number;
  claimedCount: number; status: string; expiresAt: Date | null; createdAt: Date;
};

async function heldByGiveaway(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const grouped = await prisma.giveawayReservation.groupBy({
    by: ['giveawayId'],
    where: { giveawayId: { in: ids }, status: 'ACTIVE', expiresAt: { gt: new Date() } },
    _count: { _all: true },
  });
  return new Map(grouped.map((g) => [g.giveawayId, g._count._all]));
}

async function toPublic(rows: Row[]): Promise<PublicGiveaway[]> {
  const held = await heldByGiveaway(rows.map((r) => r.id));
  return Promise.all(
    rows.map(async (r) => {
      const st = derivePublicStatus({
        status: r.status, expiresAt: r.expiresAt, maxClaimers: r.maxClaimers,
        claimedCount: r.claimedCount, activeReservations: held.get(r.id) ?? 0,
      });
      const amount = trimDecimal(r.amountPerUser);
      return {
        slug: await slugFor(r.id),
        // The data model has no title/description — derive, never invent.
        title: `${amount} ${r.asset} Giveaway`,
        description: null,
        asset: r.asset,
        amountPerUser: amount,
        totalAmount: trimDecimal(r.totalAmount),
        maxClaimers: r.maxClaimers,
        claimedCount: r.claimedCount,
        availableSlots: st.availableSlots,
        status: st.status,
        claimable: st.claimable,
        expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      };
    })
  );
}

function scopeWhere(): Prisma.GiveawayWhereInput {
  const cfg = webConfig();
  return cfg.listingScope === 'admins' ? { creator: { telegramId: { in: cfg.adminTelegramIds } } } : {};
}

const PRIORITY: Record<PublicStatus, number> = { ACTIVE: 0, ALMOST_FULL: 0, FULL: 1, EXPIRED: 2, CANCELLED: 3 };

export async function listPublicGiveaways(opts: { onlyOpen: boolean; limit: number }): Promise<PublicGiveaway[]> {
  const recent = new Date(Date.now() - 7 * 24 * 3600_000);
  const rows = (await prisma.giveaway.findMany({
    where: {
      ...scopeWhere(),
      status: { in: opts.onlyOpen ? ['ACTIVE'] : [...LISTABLE_DB_STATUSES] },
      ...(opts.onlyOpen ? {} : { OR: [{ status: 'ACTIVE' }, { updatedAt: { gt: recent } }] }),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(60, opts.limit * 2),
    select: {
      id: true, asset: true, totalAmount: true, amountPerUser: true, maxClaimers: true,
      claimedCount: true, status: true, expiresAt: true, createdAt: true,
    },
  })) as Row[];
  let list = await toPublic(rows);
  if (opts.onlyOpen) list = list.filter((g) => g.claimable);
  list.sort((a, b) => PRIORITY[a.status] - PRIORITY[b.status] || b.createdAt.localeCompare(a.createdAt));
  return list.slice(0, opts.limit);
}

export async function getPublicGiveaway(slug: string): Promise<{ id: string; view: PublicGiveaway } | null> {
  const id = await resolveSlug(slug);
  if (!id) return null;
  const row = (await prisma.giveaway.findFirst({
    where: { id, ...scopeWhere(), status: { in: [...LISTABLE_DB_STATUSES] } },
    select: {
      id: true, asset: true, totalAmount: true, amountPerUser: true, maxClaimers: true,
      claimedCount: true, status: true, expiresAt: true, createdAt: true,
    },
  })) as Row | null;
  if (!row) return null;
  return { id: row.id, view: (await toPublic([row]))[0] };
}

export interface PlatformStats {
  activeGiveaways: number;
  rewardsDelivered: number;
  distributed: { asset: string; total: string; count: number }[];
}

let statsCache: { at: number; value: PlatformStats } | null = null;

/** Real aggregates only. 30s micro-cache (display data — never used to authorise a claim). */
export async function platformStats(): Promise<PlatformStats> {
  if (statsCache && Date.now() - statsCache.at < 30_000) return statsCache.value;
  const [active, paid] = await Promise.all([
    prisma.giveaway.count({
      where: { ...scopeWhere(), status: 'ACTIVE', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    }),
    prisma.$queryRaw<{ asset: string; count: number; total: string }[]>`
      SELECT g.asset, COUNT(*)::int AS count, SUM(g."amountPerUser")::text AS total
        FROM giveaway_claims c JOIN giveaways g ON g.id = c."giveawayId"
       WHERE c.status = 'PAID' GROUP BY g.asset ORDER BY g.asset`,
  ]);
  const value: PlatformStats = {
    activeGiveaways: active,
    rewardsDelivered: paid.reduce((n, r) => n + r.count, 0),
    distributed: paid.map((r) => ({ asset: r.asset, count: r.count, total: trimDecimal(r.total) })),
  };
  statsCache = { at: Date.now(), value };
  return value;
}
