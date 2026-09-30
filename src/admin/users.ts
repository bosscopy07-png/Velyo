import { Context, Markup } from 'telegraf';
import { prisma } from '../database';
import { config } from '../config';
import { logger } from '../utils/logger';
import { e, eb } from '../utils/emoji';
import { setUserSession, clearUserSession } from '../services/redis';
import { editMainMessage } from '../bot/utils/editMainMessage';
import { backKeyboard } from '../bot/keyboards/main';

const DIVIDER = `${e('sparkle')}━━━━━━━━━━━━━━━━━${e('sparkle')}`;
const TX_PER_PAGE = 6;
const SEARCH_LIMIT = 8;
// Captions on the main (photo) message are capped at 1024 characters.
const CAPTION_SAFE = 1000;

const isAdminCtx = (ctx: Context): boolean =>
  !!ctx.from && config.ADMIN_TELEGRAM_IDS.includes(ctx.from.id.toString());

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 12.5000 → "12.5"; BNB gets more precision than stablecoins. */
function amt(n: number | string | { toString(): string } | null | undefined, asset: string): string {
  const v = Number(n ?? 0);
  return Number(v.toFixed(asset === 'BNB' ? 6 : 4)).toString();
}

function fmtUtc(d: Date | null | undefined): string {
  return d ? d.toISOString().replace('T', ' ').slice(0, 16) : '—';
}

function ago(d: Date | null | undefined): string {
  if (!d) return '—';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function displayName(u: { username: string | null; firstName: string | null; telegramId: string }): string {
  return u.username ? `@${u.username}` : u.firstName || u.telegramId;
}

const STATUS_ICON: Record<string, string> = { ACTIVE: '🟢', SUSPENDED: '🟠', FROZEN: '🧊', BANNED: '🚫' };

const TX_ICON: Record<string, string> = {
  DEPOSIT: '📥',
  WITHDRAWAL: '📤',
  PAYOUT: '📤',
  TRANSFER: '↔️',
  GIVEAWAY_CREATED: '🎁',
  GIVEAWAY_CANCELLED: '↩️',
  GIVEAWAY_REWARD: '🏆',
  CODE_REDEMPTION: '🎟',
  PLATFORM_FEE: '💳',
  REFUND: '↩️',
};

const TX_STATUS_ICON: Record<string, string> = {
  CONFIRMED: '✅',
  PENDING: '⏳',
  PROCESSING: '⏳',
  FAILED: '❌',
  CANCELLED: '❌',
};

function fit(text: string): string {
  return text.length <= CAPTION_SAFE ? text : `${text.slice(0, CAPTION_SAFE - 1)}…`;
}

// ─────────────────────────── PROFILE ───────────────────────────

export async function renderUserProfile(ctx: Context, userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { wallet: true, balances: true },
  });
  if (!user) {
    await editMainMessage(ctx, `${e('warning')} User not found.`, backKeyboard('admin:users'));
    return;
  }

  const [txGroups, claimGroups, giveawayGroups, redemptions, fees, giveawayCount] = await Promise.all([
    prisma.transaction.groupBy({
      by: ['type', 'asset'],
      where: { userId, status: 'CONFIRMED', type: { in: ['DEPOSIT', 'GIVEAWAY_REWARD'] } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.giveawayClaim.groupBy({ by: ['status'], where: { userId }, _count: { _all: true } }),
    prisma.giveaway.groupBy({ by: ['asset'], where: { creatorId: userId }, _sum: { totalAmount: true }, _count: { _all: true } }),
    prisma.codeRedemption.aggregate({ where: { userId }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.platformFee.aggregate({ where: { transaction: { userId } }, _sum: { amount: true } }),
    prisma.giveaway.count({ where: { creatorId: userId } }),
  ]);

  const sumLine = (type: string): { count: number; text: string } => {
    const rows = txGroups.filter((g) => g.type === type);
    const count = rows.reduce((s, g) => s + g._count._all, 0);
    const text = rows.map((g) => `${amt(g._sum.amount, g.asset)} ${g.asset}`).join(' + ') || '0';
    return { count, text };
  };
  const deposits = sumLine('DEPOSIT');
  const rewards = sumLine('GIVEAWAY_REWARD');

  const claimsTotal = claimGroups.reduce((s, g) => s + g._count._all, 0);
  const claimsPaid = claimGroups.find((g) => g.status === 'PAID')?._count._all ?? 0;

  const bal = (asset: string, field: 'availableBalance' | 'lockedBalance') =>
    amt(user.balances.find((b) => b.asset === asset)?.[field], asset);

  const creatorText =
    giveawayGroups.map((g) => `${amt(g._sum.totalAmount, g.asset)} ${g.asset}`).join(' + ') || '0';

  const text = fit(
    `${e('person')} <b>USER PROFILE</b>\n${DIVIDER}\n\n` +
    `<b>${esc(displayName(user))}</b>${user.firstName && user.username ? ` · ${esc(user.firstName)}` : ''}\n` +
    `🆔 <code>${user.telegramId}</code> · ${STATUS_ICON[user.status] ?? ''} ${user.status}${user.isAdmin ? ' · admin' : ''}\n` +
    `📅 Joined ${fmtUtc(user.joinDate).slice(0, 10)} · active ${ago(user.lastActive)}\n\n` +
    (user.wallet
      ? `${e('wallet')} <code>${user.wallet.address}</code>\n` +
        `Available: <b>${bal('USDT', 'availableBalance')}</b> USDT · <b>${bal('BNB', 'availableBalance')}</b> BNB\n` +
        `Locked: ${bal('USDT', 'lockedBalance')} USDT · ${bal('BNB', 'lockedBalance')} BNB\n\n`
      : `${e('wallet')} <i>No wallet yet</i>\n\n`) +
    `📥 Deposits: <b>${deposits.count}</b> · ${deposits.text}\n` +
    `🎁 Giveaways created: <b>${giveawayCount}</b> · ${creatorText}\n` +
    `🏆 Claims: <b>${claimsTotal}</b> (${claimsPaid} paid · ${rewards.text})\n` +
    `🎟 Codes redeemed: <b>${redemptions._count._all}</b> · ${amt(redemptions._sum.amount, 'USDT')}\n` +
    `💳 Fees paid: ${amt(fees._sum.amount, 'USDT')} USDT`
  );

  const rows = [
    [
      Markup.button.callback(`${eb('document')} Transactions`, `admin:user:${userId}:tx:0`),
      Markup.button.callback(`${eb('gift')} Giveaways & Claims`, `admin:user:${userId}:act`),
    ],
    [
      Markup.button.callback(`${eb('refresh')} Refresh`, `admin:user:${userId}`),
      user.status === 'BANNED'
        ? Markup.button.callback('✅ Unban', `admin:user:${userId}:ban`)
        : Markup.button.callback('🚫 Ban', `admin:user:${userId}:ban`),
    ],
  ];
  if (user.wallet) {
    rows.push([Markup.button.callback(`${eb('lock')} Recover Key`, `admin:revealkey:${user.wallet.id}:pk`)]);
  }
  rows.push([
    Markup.button.callback(`${eb('search')} Find User`, 'admin:search'),
    Markup.button.callback(`${eb('back')} Users`, 'admin:users'),
  ]);

  await editMainMessage(ctx, text, Markup.inlineKeyboard(rows));
}

async function renderUserTransactions(ctx: Context, userId: string, page: number): Promise<void> {
  const [user, total] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { username: true, firstName: true, telegramId: true } }),
    prisma.transaction.count({ where: { userId } }),
  ]);
  if (!user) {
    await editMainMessage(ctx, `${e('warning')} User not found.`, backKeyboard('admin:users'));
    return;
  }
  const totalPages = Math.max(1, Math.ceil(total / TX_PER_PAGE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);

  const txs = await prisma.transaction.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    skip: safePage * TX_PER_PAGE,
    take: TX_PER_PAGE,
  });

  let text = `${e('document')} <b>TRANSACTIONS</b> · ${esc(displayName(user))}\n${DIVIDER}\n\n`;
  if (txs.length === 0) text += 'No transactions yet.';
  for (const t of txs) {
    text +=
      `${TX_ICON[t.type] ?? '•'} ${TX_STATUS_ICON[t.status] ?? ''} <b>${t.type.replace(/_/g, ' ')}</b> · ` +
      `${amt(t.amount, t.asset)} ${t.asset}\n` +
      `└ ${fmtUtc(t.createdAt)}${t.transactionHash ? ` · <code>${t.transactionHash.slice(0, 10)}…</code>` : ''}\n`;
  }
  text += `\nPage ${safePage + 1}/${totalPages} · ${total} total`;

  const nav = [];
  if (safePage > 0) nav.push(Markup.button.callback('◀️ Prev', `admin:user:${userId}:tx:${safePage - 1}`));
  if (safePage < totalPages - 1) nav.push(Markup.button.callback('Next ▶️', `admin:user:${userId}:tx:${safePage + 1}`));

  const rows = [];
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback(`${eb('back')} Profile`, `admin:user:${userId}`)]);

  await editMainMessage(ctx, fit(text), Markup.inlineKeyboard(rows));
}

async function renderUserActivity(ctx: Context, userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true, firstName: true, telegramId: true },
  });
  if (!user) {
    await editMainMessage(ctx, `${e('warning')} User not found.`, backKeyboard('admin:users'));
    return;
  }

  const [created, claims] = await Promise.all([
    prisma.giveaway.findMany({ where: { creatorId: userId }, orderBy: { createdAt: 'desc' }, take: 5 }),
    prisma.giveawayClaim.findMany({
      where: { userId },
      orderBy: { claimedAt: 'desc' },
      take: 5,
      include: { giveaway: { select: { asset: true, amountPerUser: true } } },
    }),
  ]);

  let text = `${e('gift')} <b>GIVEAWAYS & CLAIMS</b> · ${esc(displayName(user))}\n${DIVIDER}\n\n`;
  text += `<b>Created</b> (latest 5)\n`;
  text += created.length === 0 ? '—\n' : '';
  for (const g of created) {
    text += `• ${g.status} · ${amt(g.totalAmount, g.asset)} ${g.asset} · ${g.claimedCount}/${g.maxClaimers} · ${fmtUtc(g.createdAt).slice(5, 10)}\n`;
  }
  text += `\n<b>Claimed</b> (latest 5)\n`;
  text += claims.length === 0 ? '—\n' : '';
  for (const c of claims) {
    text += `• ${c.status} · ${amt(c.giveaway.amountPerUser, c.giveaway.asset)} ${c.giveaway.asset} · ${fmtUtc(c.claimedAt).slice(5, 10)}\n`;
  }

  await editMainMessage(
    ctx,
    fit(text),
    Markup.inlineKeyboard([[Markup.button.callback(`${eb('back')} Profile`, `admin:user:${userId}`)]])
  );
}

// ─────────────────────────── SEARCH ───────────────────────────

export async function handleUserSearch(ctx: Context): Promise<void> {
  if (!isAdminCtx(ctx)) return;
  const adminId = ctx.from!.id.toString();
  const raw = (ctx.message as { text?: string } | undefined)?.text ?? '';
  const q = raw.trim().replace(/^@/, '');
  if (!q) return;

  const matches = await prisma.user.findMany({
    where: {
      OR: [
        { telegramId: q },
        { id: q },
        { username: { contains: q, mode: 'insensitive' } },
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        ...(q.length >= 6 ? [{ wallet: { address: { contains: q, mode: 'insensitive' as const } } }] : []),
      ],
    },
    orderBy: { lastActive: 'desc' },
    take: SEARCH_LIMIT,
  });

  if (matches.length === 0) {
    // Keep the session so the admin can simply type another query.
    await setUserSession(adminId, { state: 'admin_search_user' }, 300);
    await editMainMessage(
      ctx,
      `${e('warning')} <b>NO MATCH</b>\n\nNothing found for "<code>${esc(q)}</code>".\n\n` +
      `Try a Telegram ID, @username, name, or part of a wallet address.`,
      backKeyboard('admin')
    );
    return;
  }

  await clearUserSession(adminId);

  if (matches.length === 1) {
    await renderUserProfile(ctx, matches[0].id);
    return;
  }

  const rows = matches.map((u) => [
    Markup.button.callback(
      `${STATUS_ICON[u.status] ?? ''} ${displayName(u)} · ${u.telegramId}`.slice(0, 60),
      `admin:user:${u.id}`
    ),
  ]);
  rows.push([Markup.button.callback(`${eb('back')} Admin Panel`, 'admin')]);

  await editMainMessage(
    ctx,
    `${e('search')} <b>${matches.length} MATCHES</b>${matches.length === SEARCH_LIMIT ? ' (showing first ' + SEARCH_LIMIT + ')' : ''}\n${DIVIDER}\n\nTap a user to open their profile.`,
    Markup.inlineKeyboard(rows)
  );
}

// ─────────────────────────── REGISTRATION ───────────────────────────

export function registerUserAdmin(bot: any): void {
  const adminOnly =
    (fn: (ctx: Context) => Promise<void>) =>
    async (ctx: Context) => {
      if (!isAdminCtx(ctx)) {
        await ctx.answerCbQuery('Not authorized.', { show_alert: true }).catch(() => undefined);
        return;
      }
      try {
        await fn(ctx);
      } catch (err) {
        logger.error(`User admin error: ${(err as Error).message}`);
        await ctx.answerCbQuery('Something went wrong. Check logs.', { show_alert: true }).catch(() => undefined);
      }
    };

  bot.action('admin:search', adminOnly(async (ctx) => {
    await ctx.answerCbQuery();
    await setUserSession(ctx.from!.id.toString(), { state: 'admin_search_user' }, 300);
    await editMainMessage(
      ctx,
      `${e('search')} <b>FIND USER</b>\n${DIVIDER}\n\n` +
      `Send any of:\n• Telegram ID\n• @username or name\n• Wallet address (full or partial)`,
      backKeyboard('admin')
    );
  }));

  bot.action(/^admin:user:([^:]+)$/, adminOnly(async (ctx) => {
    await ctx.answerCbQuery();
    await renderUserProfile(ctx, (ctx as any).match[1]);
  }));

  bot.action(/^admin:user:([^:]+):tx:(\d+)$/, adminOnly(async (ctx) => {
    await ctx.answerCbQuery();
    const m = (ctx as any).match;
    await renderUserTransactions(ctx, m[1], parseInt(m[2], 10));
  }));

  bot.action(/^admin:user:([^:]+):act$/, adminOnly(async (ctx) => {
    await ctx.answerCbQuery();
    await renderUserActivity(ctx, (ctx as any).match[1]);
  }));

  // Ban / unban — step 1: confirm
  bot.action(/^admin:user:([^:]+):ban$/, adminOnly(async (ctx) => {
    const userId = (ctx as any).match[1];
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      await ctx.answerCbQuery();
      await editMainMessage(ctx, `${e('warning')} User not found.`, backKeyboard('admin:users'));
      return;
    }
    if (config.ADMIN_TELEGRAM_IDS.includes(user.telegramId)) {
      await ctx.answerCbQuery('Admins cannot be banned.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    const banning = user.status !== 'BANNED';
    await editMainMessage(
      ctx,
      `${e('warning')} <b>${banning ? 'BAN' : 'UNBAN'} USER?</b>\n${DIVIDER}\n\n` +
      `${esc(displayName(user))} · <code>${user.telegramId}</code>\n\n` +
      (banning
        ? `They will be locked out of the bot immediately and skipped by future broadcasts. Their balance is untouched. Logged to the audit trail.`
        : `They will regain full access. Logged to the audit trail.`),
      Markup.inlineKeyboard([
        [Markup.button.callback(banning ? '🚫 Yes, ban' : '✅ Yes, unban', `admin:user:${userId}:banok`)],
        [Markup.button.callback(`${eb('back')} Cancel`, `admin:user:${userId}`)],
      ])
    );
  }));

  // Step 2: apply
  bot.action(/^admin:user:([^:]+):banok$/, adminOnly(async (ctx) => {
    const userId = (ctx as any).match[1];
    const adminId = ctx.from!.id.toString();
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || config.ADMIN_TELEGRAM_IDS.includes(user.telegramId)) {
      await ctx.answerCbQuery('Not allowed.', { show_alert: true });
      return;
    }
    const next = user.status === 'BANNED' ? 'ACTIVE' : 'BANNED';

    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { status: next } }),
      prisma.auditLog.create({
        data: {
          adminId,
          userId,
          action: next === 'BANNED' ? 'USER_BAN' : 'USER_UNBAN',
          entityType: 'user',
          entityId: userId,
          oldValue: { status: user.status },
          newValue: { status: next },
        },
      }),
    ]);
    logger.warn(`Admin ${adminId} set user ${user.telegramId} to ${next}`);
    await ctx.answerCbQuery(next === 'BANNED' ? '🚫 User banned' : '✅ User unbanned', { show_alert: true });
    await renderUserProfile(ctx, userId);
  }));
}
