import { Context, Markup } from 'telegraf';
import { prisma } from '../../database';
import { e, eb } from '../../utils/emoji';
import { logger } from '../../utils/logger';
import { editMainMessage } from '../utils/editMainMessage';
import { backKeyboard } from '../keyboards/main';
import { rewardsService } from '../../services/rewards';
import { attributionService } from '../../services/attribution';
import { claimRiskService } from '../../services/claim-risk';
import { depositSessionService } from '../../services/deposit-session';
import { assertUserOperational } from '../../services/maintenance';

/**
 * Phase-2 upgrade callbacks: rewards dashboard, deposit sessions, creator
 * claimant management (view / block / unblock), creator-level AUDIENCE view
 * (everyone who ever claimed any of your giveaways, with per-user totals)
 * and FLAGGED USERS view (possible multi-account claimants).
 *
 * Security: every giveaway-scoped action re-verifies creator ownership
 * server-side — callback payload is never trusted (spec §36).
 *
 * NOTE on callback_data: Telegram caps it at 64 bytes. Giveaway-scoped
 * block/unblock therefore uses the CLAIM id / ClaimBlock row id (resolved
 * server-side), never giveawayId+userId pairs.
 *
 * NOTE on message length: these views are rendered as photo captions, which
 * Telegram caps at 1,024 chars (vs 4,096 for text). All list views are
 * paginated to stay well under that, and inline keyboards stay under the
 * 100-button cap.
 */

const DIVIDER = `${e('sparkle')}━━━━━━━━━━━━━━━━━${e('sparkle')}`;

/** Claimants per page — sized so a full page fits the 1,024-char caption. */
const CLAIMANTS_PER_PAGE = 5;

const guard = (fn: (ctx: Context) => Promise<void>) => async (ctx: Context) => {
  try {
    await fn(ctx);
  } catch (err) {
    logger.error(`Upgrade callback error: ${(err as Error).message}`, err);
    try {
      await ctx.answerCbQuery('Something went wrong. Try again.', { show_alert: true });
    } catch { /* ignore */ }
  }
};

async function currentUser(ctx: Context) {
  return prisma.user.findUnique({ where: { telegramId: ctx.from!.id.toString() } });
}

function sessionStatusLabel(s: { status: string }): string {
  switch (s.status) {
    case 'AWAITING': return '⏳ Awaiting payment';
    case 'DETECTED': return '🔎 Detected — confirming';
    case 'CREDITED': return '✅ Credited';
    case 'EXPIRED': return '⌛ Expired';
    case 'FAILED': return '❌ Failed';
    default: return s.status;
  }
}

/** All giveaway IDs owned by this user (helper for audience/flagged views). */
async function myGiveawayIds(creatorId: string): Promise<string[]> {
  const rows = await prisma.giveaway.findMany({ where: { creatorId }, select: { id: true } });
  return rows.map((r) => r.id);
}

export function registerUpgradeCallbacks(bot: any): void {
  // ══════════════════════ REWARDS DASHBOARD ══════════════════════
  bot.action('account:rewards', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const user = await currentUser(ctx);
    if (!user) return;
    const summary = await rewardsService.getSummary(user.id);
    const unapplied = await rewardsService.getUnappliedCredit(user.id, 'USDT');
    const text = [
      `${e('star')} <b>MY REWARDS</b>`, DIVIDER, '',
      `🎁 Giveaway Cashback: <b>+${summary.cashback.toFixed(6)}</b>`,
      `🔗 Referral Rewards: <b>+${summary.referral.toFixed(6)}</b>`,
      `💰 Total Earned: <b>+${summary.total.toFixed(6)}</b>`, '',
      unapplied > 0
        ? `✨ <b>${unapplied.toFixed(6)} USDT</b> of reward credit will discount your next giveaway's platform fee.`
        : `Cashback pays out when your giveaways complete; referral rewards when people you referred complete their giveaways.`,
      '',
      ...(summary.recent.length > 0
        ? [`<b>Recent</b>`, ...summary.recent.map((r) => {
            const icon = r.type === 'GIVEAWAY_CASHBACK' ? '🎁' : '🔗';
            const label = r.type === 'GIVEAWAY_CASHBACK' ? 'Cashback' : 'Referral';
            return `${icon} ${label} <b>+${r.amount.toFixed(6)} ${r.asset}</b> — ${r.createdAt.toLocaleDateString()}`;
          })]
        : []),
    ].join('\n');
    await editMainMessage(ctx, text, backKeyboard('account'));
  }));

  // ══════════════════════ DEPOSIT SESSIONS ══════════════════════
  bot.action('account:deposits', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const user = await currentUser(ctx);
    if (!user) return;
    const sessions = await depositSessionService.listRecent(user.id, 5);
    const text = [
      `${e('deposit')} <b>MY DEPOSITS</b>`, DIVIDER, '',
      ...(sessions.length === 0
        ? ['No deposits yet.']
        : sessions.map((s) =>
            `${sessionStatusLabel(s)} — <b>${Number(s.requestedAmount)} ${s.asset}</b>` +
            (s.txHash ? `\n   Tx: <code>${s.txHash.slice(0, 18)}…</code>` : ''))),
    ].join('\n');
    const rows: any[] = [
      [
        Markup.button.callback(`🟡 New BNB Deposit`, 'deposit:session:BNB'),
        Markup.button.callback(`🟢 New USDT Deposit`, 'deposit:session:USDT'),
      ],
    ];
    const live = sessions.find((s) => s.status === 'AWAITING' || s.status === 'DETECTED');
    if (live) rows.push([Markup.button.callback(`${eb('check')} I Have Deposited`, `deposit:paid:${live.id}`)]);
    rows.push([Markup.button.callback(`${eb('back')} Back`, 'account')]);
    await editMainMessage(ctx, text, Markup.inlineKeyboard(rows));
  }));

  bot.action(/deposit:session:(BNB|USDT)/, guard(async (ctx: Context) => {
    await assertUserOperational(ctx.from!.id.toString()).catch(() => { throw new Error('maintenance'); });
    await ctx.answerCbQuery();
    const asset = (ctx as any).match[1] as string;
    const { setUserSession } = await import('../../services/redis');
    await setUserSession(ctx.from!.id.toString(), { state: 'deposit_amount', asset });
    await editMainMessage(
      ctx,
      `${e('deposit')} <b>NEW ${asset} DEPOSIT</b>\n${DIVIDER}\n\nEnter the amount you want to deposit (in ${asset}).\n\n${e('edit')} Example: <code>10</code>`,
      backKeyboard('account:deposits')
    );
  }));

  bot.action(/deposit:paid:(.+)/, guard(async (ctx: Context) => {
    const sessionId = (ctx as any).match[1];
    const user = await currentUser(ctx);
    if (!user) return;
    await ctx.answerCbQuery('Verifying on-chain… this takes a few seconds.');
    const result = await depositSessionService.verifySession(sessionId, user.id);
    let text: string;
    switch (result.status) {
      case 'credited':
        text = `${e('check')} <b>DEPOSIT CREDITED</b>\n\n<b>${result.amount}</b> has been added to your VEYLO balance.\n\n${e('party')} You're ready to go!`;
        break;
      case 'already_credited':
        text = `${e('check')} This deposit was already credited to your balance.`;
        break;
      case 'pending_confirmations':
        text = `${e('clock')} <b>DEPOSIT DETECTED</b>\n\nYour transaction was found and is waiting for blockchain confirmations.\nIt will be credited automatically.\n\nTx: <code>${result.txHash}</code>`;
        break;
      case 'not_found':
        text = `${e('search')} <b>TRANSACTION NOT FOUND YET</b>\n\nNo matching payment arrived at your deposit address yet.\n\n• Check that you sent the exact expected amount to the correct address\n• Confirmations can take a few minutes — tap again shortly\n\nYour session stays active for 30 minutes.`;
        break;
      case 'expired':
        text = `${e('warning')} <b>DEPOSIT SESSION EXPIRED</b>\n\nThis session timed out after 30 minutes.\nStart a new deposit to get a fresh address.`;
        break;
      default:
        text = `${e('warning')} <b>VERIFICATION UNAVAILABLE</b>\n\n${result.status === 'error' ? result.reason : 'Please try again in a minute.'}`;
    }
    await editMainMessage(ctx, text, Markup.inlineKeyboard([
      ...(result.status === 'not_found' ? [[Markup.button.callback(`${eb('check')} Check Again`, `deposit:paid:${sessionId}`)]] : []),
      [Markup.button.callback(`${eb('wallet')} My Deposits`, 'account:deposits')],
      [Markup.button.callback(`${eb('back')} Back`, 'account')],
    ]));
  }));

  bot.action(/deposit:cancel:(.+)/, guard(async (ctx: Context) => {
    const sessionId = (ctx as any).match[1];
    const user = await currentUser(ctx);
    if (!user) return;
    await prisma.depositSession.updateMany({
      where: { id: sessionId, userId: user.id, status: { in: ['AWAITING', 'DETECTED'] } },
      data: { status: 'EXPIRED' },
    });
    await ctx.answerCbQuery('Deposit session cancelled.');
    await editMainMessage(ctx, `${e('check')} Deposit session cancelled.`, backKeyboard('account:deposits'));
  }));

  // No-op for non-navigable buttons (e.g. the "3/7" page indicator).
  bot.action('giveaway:noop', async (ctx: Context) => {
    await ctx.answerCbQuery();
  });

  // ══════════════════════ CREATOR: CLAIMANTS (per giveaway, PAGINATED) ══════════════════════
  // Paginated because photo captions cap at 1,024 chars — with ~250 chars
  // per claimant a full list of 18+ blows the limit (and approaches the
  // 100-button keyboard cap). Page size keeps a full page well under both.
  //
  // The optional :page segment is matched non-greedily so the giveaway id
  // (a UUID, never contains ':') is never swallowed into it.
  bot.action(/giveaway:claimants:(.+?)(?::(\d+))?$/, guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const giveawayId = (ctx as any).match[1] as string;
    const requestedPage = Math.max(1, parseInt((ctx as any).match[2] ?? '1', 10));
    const user = await currentUser(ctx);
    if (!user) return;

    const giveaway = await prisma.giveaway.findUnique({
      where: { id: giveawayId },
      include: {
        claims: {
          orderBy: { claimOrder: 'asc' },
          include: { user: { select: { telegramId: true, username: true, firstName: true, lastName: true } } },
        },
      },
    });
    if (!giveaway || giveaway.creatorId !== user.id) {
      await editMainMessage(ctx, `${e('warning')} Giveaway not found.`, backKeyboard('giveaway:mine'));
      return;
    }

    const flags = await claimRiskService.listOpenFlags(giveawayId);
    const flagMap = new Map<string, string[]>();
    for (const f of flags) flagMap.set(f.claimId, [...(flagMap.get(f.claimId) ?? []), f.signal]);

    const totalPages = Math.max(1, Math.ceil(giveaway.claims.length / CLAIMANTS_PER_PAGE));
    const page = Math.min(requestedPage, totalPages);
    const slice = giveaway.claims.slice((page - 1) * CLAIMANTS_PER_PAGE, page * CLAIMANTS_PER_PAGE);

    const lines = [
      `${e('people')} <b>CLAIMANTS</b> (${page}/${totalPages})`, DIVIDER,
      `🎁 ${giveaway.totalAmount} ${giveaway.asset} · ${giveaway.claimedCount}/${giveaway.maxClaimers} claimed`, '',
    ];
    const rows: any[] = [];

    if (slice.length === 0) {
      lines.push('No claimants yet.');
    }

    // Compact rows: one summary line (+ optional tx hash) per claimant.
    // Total-claims stats, referrer info and full history live in Details —
    // fetching them for every claimant on every page was what blew the cap.
    for (const c of slice) {
      const name = [c.user.firstName, c.user.lastName].filter(Boolean).join(' ') || c.user.username || 'User';
      const handle = c.user.username ? `@${c.user.username}` : `ID ${c.user.telegramId}`;
      const statusIcon = c.status === 'PAID' ? '✅' : c.status === 'FAILED' ? '❌' : '⏳';
      const flagIcon = flagMap.has(c.id) ? ` ⚠️ <i>${flagMap.get(c.id)!.join(', ')}</i>` : '';

      lines.push(
        `${statusIcon} <b>${name}</b> (${handle})`,
        `   ${c.status} · ${c.claimedAt.toLocaleString()}` +
          (c.payoutTransactionHash ? ` · Tx <code>${c.payoutTransactionHash.slice(0, 16)}…</code>` : '') +
          flagIcon
      );

      // Three buttons per claimant: one row, well under the 100-button cap.
      rows.push([
        Markup.button.callback(`🚫 Block (this giveaway)`, `giveaway:blockg:${c.id}`),
        Markup.button.callback(`🚫 Block (all mine)`, `giveaway:blockc:${c.userId}`),
        Markup.button.callback(`👤 Details`, `giveaway:audience:user:${c.userId}`),
      ]);
    }

    if (flags.length > 0) {
      lines.push('', `⚠️ <b>${flags.length}</b> claim(s) flagged — see ⚠️ lines above.`);
    }

    // Page navigation (only when there's more than one page)
    if (totalPages > 1) {
      const nav: any[] = [];
      if (page > 1) {
        nav.push(Markup.button.callback(`◀️ ${page - 1}`, `giveaway:claimants:${giveawayId}:${page - 1}`));
      }
      nav.push(Markup.button.callback(`${page}/${totalPages}`, 'giveaway:noop'));
      if (page < totalPages) {
        nav.push(Markup.button.callback(`${page + 1} ▶️`, `giveaway:claimants:${giveawayId}:${page + 1}`));
      }
      rows.push(nav);
    }

    rows.push([
      Markup.button.callback(`${eb('people')} My Audience`, 'giveaway:audience'),
      Markup.button.callback(`⚠️ Flagged Users`, 'giveaway:flagged'),
    ]);
    rows.push([Markup.button.callback(`${eb('back')} My Giveaways`, 'giveaway:mine')]);

    await editMainMessage(ctx, lines.join('\n'), Markup.inlineKeyboard(rows));
  }));

  // ══════════════════════ CREATOR: MY AUDIENCE (all giveaways) ══════════════════════
  bot.action('giveaway:audience', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const user = await currentUser(ctx);
    if (!user) return;

    const ids = await myGiveawayIds(user.id);
    if (ids.length === 0) {
      await editMainMessage(ctx, `${e('people')} <b>MY AUDIENCE</b>\n${DIVIDER}\n\nNo giveaways yet.`, backKeyboard('giveaway:mine'));
      return;
    }

    const claims = await prisma.giveawayClaim.findMany({
      where: { giveawayId: { in: ids } },
      include: { user: { select: { id: true, telegramId: true, username: true, firstName: true, lastName: true } } },
      orderBy: { claimedAt: 'desc' },
      take: 300,
    });

    // Amount per claim from the giveaway rows (single query, no N+1)
    const giveawayAmounts = new Map(
      (await prisma.giveaway.findMany({ where: { id: { in: ids } }, select: { id: true, amountPerUser: true } }))
        .map((g) => [g.id, Number(g.amountPerUser)])
    );

    // Aggregate per user: total claims, total amount claimed, last claim
    const agg = new Map<string, {
      user: { id: string; telegramId: string; username: string | null; firstName: string | null; lastName: string | null };
      totalClaims: number; totalAmount: number; lastClaim: Date;
    }>();
    for (const c of claims) {
      const existing = agg.get(c.userId);
      const amt = giveawayAmounts.get(c.giveawayId) ?? 0;
      if (existing) {
        existing.totalClaims += 1;
        existing.totalAmount += amt;
        if (c.claimedAt > existing.lastClaim) existing.lastClaim = c.claimedAt;
      } else {
        agg.set(c.userId, { user: c.user, totalClaims: 1, totalAmount: amt, lastClaim: c.claimedAt });
      }
    }

    const audience = [...agg.values()].sort((a, b) => b.totalAmount - a.totalAmount).slice(0, 20);

    const lines = [
      `${e('people')} <b>MY AUDIENCE</b>`, DIVIDER,
      `Everyone who claimed ANY of your giveaways: <b>${agg.size}</b> user(s)`, '',
    ];
    const rows: any[] = [];
    for (const a of audience) {
      const name = [a.user.firstName, a.user.lastName].filter(Boolean).join(' ') || a.user.username || 'User';
      lines.push(
        `👤 <b>${name}</b> (${a.user.username ? '@' + a.user.username : `ID ${a.user.telegramId}`})`,
        `   claimed <b>${a.totalClaims}</b>× · total <b>${a.totalAmount.toFixed(6)}</b> · last: ${a.lastClaim.toLocaleDateString()}`
      );
      rows.push([Markup.button.callback(`🔎 Details`, `giveaway:audience:user:${a.user.id}`)]);
    }
    rows.push([
      Markup.button.callback(`⚠️ Flagged Users`, 'giveaway:flagged'),
      Markup.button.callback(`${eb('back')} My Giveaways`, 'giveaway:mine'),
    ]);

    await editMainMessage(ctx, lines.join('\n'), Markup.inlineKeyboard(rows));
  }));

  // ══════════════════════ CREATOR: USER DETAIL ══════════════════════
  bot.action(/giveaway:audience:user:(.+)/, guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const targetUserId = (ctx as any).match[1];
    const user = await currentUser(ctx);
    if (!user) return;

    const ids = await myGiveawayIds(user.id);
    const [target, claims, flags, referrer, blockedNow] = await Promise.all([
      prisma.user.findUnique({ where: { id: targetUserId }, select: { telegramId: true, username: true, firstName: true, lastName: true } }),
      prisma.giveawayClaim.findMany({
        where: { userId: targetUserId, giveawayId: { in: ids } },
        include: { giveaway: { select: { totalAmount: true, asset: true, amountPerUser: true } } },
        orderBy: { claimedAt: 'desc' },
      }),
      prisma.claimFlag.findMany({
        where: { claim: { userId: targetUserId }, giveawayId: { in: ids }, status: 'OPEN' },
        select: { signal: true, claimId: true },
      }),
      attributionService.getReferrerOf(targetUserId),
      attributionService.isBlocked({ creatorId: user.id, giveawayId: ids[0] ?? '', userId: targetUserId }),
    ]);
    if (!target || claims.length === 0) {
      await editMainMessage(ctx, `${e('warning')} User not found in your audience.`, backKeyboard('giveaway:audience'));
      return;
    }

    const totalAmount = claims.reduce((s, c) => s + Number(c.giveaway.amountPerUser), 0);
    const flaggedSignals = [...new Set(flags.map((f) => f.signal))];
    const name = [target.firstName, target.lastName].filter(Boolean).join(' ') || target.username || 'User';

    const lines = [
      `👤 <b>${name}</b>`, DIVIDER,
      `TG ID: <code>${target.telegramId}</code>`,
      `Username: ${target.username ? '@' + target.username : '—'}`,
      referrer ? `Referred by: ${referrer.username ? '@' + referrer.username : `ID ${referrer.telegramId}`}` : '',
      `Claims from YOUR giveaways: <b>${claims.length}</b>`,
      `Total claimed from you: <b>${totalAmount.toFixed(6)}</b>`,
      flaggedSignals.length > 0 ? `⚠️ Flags: <i>${flaggedSignals.join(', ')}</i>` : '',
      '',
      '<b>Claim history</b>',
      ...claims.slice(0, 12).map((c) => {
        const icon = c.status === 'PAID' ? '✅' : c.status === 'FAILED' ? '❌' : '⏳';
        const flagged = flags.some((f) => f.claimId === c.id) ? ' ⚠️' : '';
        return `${icon} ${Number(c.giveaway.amountPerUser)} ${c.giveaway.asset} from a ${c.giveaway.totalAmount} ${c.giveaway.asset} giveaway · ${c.claimedAt.toLocaleDateString()} · ${c.status}${flagged}`;
      }),
    ].filter((l) => l !== '');

    const rows: any[] = [
      blockedNow
        ? [Markup.button.callback(`✅ Unblock (all my giveaways)`, `giveaway:unblockc:${targetUserId}`)]
        : [Markup.button.callback(`🚫 Block (all my giveaways)`, `giveaway:blockc:${targetUserId}`)],
      [Markup.button.callback(`${eb('back')} My Audience`, 'giveaway:audience')],
    ];
    await editMainMessage(ctx, lines.join('\n'), Markup.inlineKeyboard(rows));
  }));

  // ══════════════════════ CREATOR: FLAGGED USERS ══════════════════════
  bot.action('giveaway:flagged', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const user = await currentUser(ctx);
    if (!user) return;

    const ids = await myGiveawayIds(user.id);
    const flags = ids.length
      ? await prisma.claimFlag.findMany({
          where: { giveawayId: { in: ids }, status: 'OPEN' },
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: { claim: { include: { user: { select: { id: true, telegramId: true, username: true, firstName: true } } } } },
        })
      : [];

    const lines = [
      `⚠️ <b>FLAGGED USERS</b>`, DIVIDER,
      'Users with POSSIBLE_DUPLICATE signals across your giveaways.', '',
      flags.length === 0 ? 'No flagged users. 🎉' : '',
    ];
        const rows: any[] = [];
    for (const f of flags) {
      const u = f.claim.user;
      const name = u.firstName || u.username || 'Name';
      lines.push(
        `⚠️ <b>${name}</b> (${u.username ? '@' + u.username : `ID ${u.telegramId}`})`,
        `   signal: <b>${f.signal}</b> · ${f.createdAt.toLocaleString()}`
      );
      rows.push([
        Markup.button.callback(`👤 Details`, `giveaway:audience:user:${u.id}`),
        Markup.button.callback(`🚫 Block`, `giveaway:blockc:${u.id}`),
      ]);
    }
    rows.push([
      Markup.button.callback(`${eb('people')} My Audience`, 'giveaway:audience'),
      Markup.button.callback(`${eb('back')} My Giveaways`, 'giveaway:mine'),
    ]);

    await editMainMessage(ctx, lines.join('\n'), Markup.inlineKeyboard(rows));
  }));

  // ══════════════════════ BLOCK / UNBLOCK ══════════════════════
  // NOTE: takes the CLAIM id, not giveaway+user — Telegram callback_data
  // is capped at 64 bytes, and giveaway UUID (36) + user id (25) exceeds it.
  // The claim row carries both, verified server-side.
  bot.action(/giveaway:blockg:(.+)/, guard(async (ctx: Context) => {
    const claimId = (ctx as any).match[1];
    const user = await currentUser(ctx);
    if (!user) return;
    const claim = await prisma.giveawayClaim.findUnique({
      where: { id: claimId },
      include: { giveaway: { select: { creatorId: true } } },
    });
    if (!claim || claim.giveaway.creatorId !== user.id) {
      await ctx.answerCbQuery('Not authorized.', { show_alert: true });
      return;
    }
    await attributionService.blockUser({
      creatorId: user.id,
      blockedUserId: claim.userId,
      giveawayId: claim.giveawayId,
    });
    await ctx.answerCbQuery('User blocked from this giveaway.');
    await editMainMessage(
      ctx,
      `${e('check')} User blocked from this giveaway.`,
      backKeyboard(`giveaway:claimants:${claim.giveawayId}`)
    );
  }));

  // Takes the ClaimBlock ROW id — same 64-byte reason as blockg above.
  bot.action(/giveaway:unblockg:(.+)/, guard(async (ctx: Context) => {
    const blockId = (ctx as any).match[1];
    const user = await currentUser(ctx);
    if (!user) return;
    const block = await prisma.claimBlock.findUnique({ where: { id: blockId } });
    if (!block || block.creatorId !== user.id) {
      await ctx.answerCbQuery('Not authorized.', { show_alert: true });
      return;
    }
    await attributionService.unblockUser({
      creatorId: block.creatorId,
      blockedUserId: block.blockedUserId,
      giveawayId: block.giveawayId,
    });
    await ctx.answerCbQuery('User unblocked.');
    await editMainMessage(
      ctx,
      `${e('check')} User unblocked.`,
      block.giveawayId
        ? backKeyboard(`giveaway:claimants:${block.giveawayId}`)
        : backKeyboard('giveaway:blocklist')
    );
  }));

  bot.action(/giveaway:blockc:(.+)/, guard(async (ctx: Context) => {
    const blockedUserId = (ctx as any).match[1];
    const user = await currentUser(ctx);
    if (!user) return;
    await attributionService.blockUser({ creatorId: user.id, blockedUserId, giveawayId: null });
    await ctx.answerCbQuery('User blocked from all your giveaways.');
    await editMainMessage(
      ctx,
      `${e('check')} User blocked from <b>all your giveaways</b>.\n\nThis is your personal list only — it is not a platform ban. Only admins can ban users globally.`,
      backKeyboard('giveaway:mine')
    );
  }));

  bot.action(/giveaway:unblockc:(.+)/, guard(async (ctx: Context) => {
    const blockedUserId = (ctx as any).match[1];
    const user = await currentUser(ctx);
    if (!user) return;
    await attributionService.unblockUser({ creatorId: user.id, blockedUserId, giveawayId: null });
    await ctx.answerCbQuery('User unblocked.');
    await editMainMessage(ctx, `${e('check')} User removed from your block list.`, backKeyboard('giveaway:mine'));
  }));

  bot.action('giveaway:blocklist', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const user = await currentUser(ctx);
    if (!user) return;
    const blocks = await prisma.claimBlock.findMany({
      where: { creatorId: user.id },
      include: { blockedUser: { select: { telegramId: true, username: true, firstName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const lines = [`${e('shield')} <b>MY BLOCKED USERS</b>`, DIVIDER, ''];
    const rows: any[] = [];
    if (blocks.length === 0) lines.push('No blocked users.');
    for (const b of blocks) {
      const name = b.blockedUser.firstName || b.blockedUser.username || `ID ${b.blockedUser.telegramId}`;
      lines.push(`🚫 <b>${name}</b> — ${b.giveawayId ? 'one giveaway' : 'all my giveaways'}`);
      rows.push([
        b.giveawayId
          ? Markup.button.callback(`✅ Unblock`, `giveaway:unblockg:${b.id}`)
          : Markup.button.callback(`✅ Unblock`, `giveaway:unblockc:${b.blockedUserId}`),
      ]);
    }
    rows.push([Markup.button.callback(`${eb('back')} My Giveaways`, 'giveaway:mine')]);
    await editMainMessage(ctx, lines.join('\n'), Markup.inlineKeyboard(rows));
  }));
}
