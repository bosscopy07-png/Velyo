import { Context, Markup } from 'telegraf';
import { prisma } from '../../database';
import { config } from '../../config';
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
 * Phase-2 upgrade callbacks: rewards dashboard, deposit sessions,
 * creator claimant management (view / block / unblock).
 *
 * Security: every giveaway-scoped action re-verifies creator ownership
 * server-side — callback payload is never trusted (spec §36).
 */

const DIVIDER = `${e('sparkle')}━━━━━━━━━━━━━━━━━${e('sparkle')}`;

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

export function registerUpgradeCallbacks(bot: any): void {
  // ══════════════════════ REWARDS DASHBOARD ══════════════════════
  bot.action('account:rewards', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const user = await currentUser(ctx);
    if (!user) return;

    const summary = await rewardsService.getSummary(user.id);
    const unapplied = await rewardsService.getUnappliedCredit(user.id, 'USDT');

    const text = [
      `${e('star')} <b>MY REWARDS</b>`,
      DIVIDER,
      '',
      `🎁 Giveaway Cashback: <b>+${summary.cashback.toFixed(6)}</b>`,
      `🔗 Referral Rewards: <b>+${summary.referral.toFixed(6)}</b>`,
      `💰 Total Earned: <b>+${summary.total.toFixed(6)}</b>`,
      '',
      unapplied > 0
        ? `✨ <b>${unapplied.toFixed(6)} USDT</b> of reward credit will automatically discount your next giveaway's platform fee.`
        : `Create giveaways to earn 1% cashback, and refer new users via your giveaway links to earn referral rewards.`,
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
      `${e('deposit')} <b>MY DEPOSITS</b>`,
      DIVIDER,
      '',
      ...(sessions.length === 0
        ? ['No deposits yet.']
        : sessions.map((s) =>
            `${sessionStatusLabel(s)} — <b>${Number(s.requestedAmount)} ${s.asset}</b>` +
            (s.txHash ? `\n   Tx: <code>${s.txHash.slice(0, 18)}…</code>` : '')
          )),
    ].join('\n');

    const rows: any[] = [
      [
        Markup.button.callback(`🟡 New BNB Deposit`, 'deposit:session:BNB'),
        Markup.button.callback(`🟢 New USDT Deposit`, 'deposit:session:USDT'),
      ],
    ];
    // One-tap re-verification for the newest live session.
    const live = sessions.find((s) => s.status === 'AWAITING' || s.status === 'DETECTED');
    if (live) {
      rows.push([Markup.button.callback(`${eb('check')} I Have Deposited`, `deposit:paid:${live.id}`)]);
    }
    rows.push([Markup.button.callback(`${eb('back')} Back`, 'account')]);

    await editMainMessage(ctx, text, Markup.inlineKeyboard(rows));
  }));

  // Asset chosen → ask for amount (text handler 'deposit_amount' finishes).
  bot.action(/deposit:session:(BNB|USDT)/, guard(async (ctx: Context) => {
    await assertUserOperational(ctx.from!.id.toString()).catch(() => {
      throw new Error('maintenance');
    });
    await ctx.answerCbQuery();
    const asset = (ctx as any).match[1] as string;
    const { setUserSession } = await import('../../services/redis');
    await setUserSession(ctx.from!.id.toString(), { state: 'deposit_amount', asset });
    await editMainMessage(
      ctx,
      `${e('deposit')} <b>NEW ${asset} DEPOSIT</b>\n${DIVIDER}\n\n` +
      `Enter the amount you want to deposit (in ${asset}).\n\n${e('edit')} Example: <code>10</code>`,
      backKeyboard('account:deposits')
    );
  }));

  // "I HAVE DEPOSITED" — immediate active verification (spec §18).
  bot.action(/deposit:paid:(.+)/, guard(async (ctx: Context) => {
    const sessionId = (ctx as any).match[1];
    const user = await currentUser(ctx);
    if (!user) return;

    await ctx.answerCbQuery('Verifying on-chain… this takes a few seconds.');
    const result = await depositSessionService.verifySession(sessionId, user.id);

    let text: string;
    switch (result.status) {
      case 'credited':
        text = `${e('check')} <b>DEPOSIT CREDITED</b>\n\n` +
          `<b>${result.amount}</b> has been added to your VEYLO balance.\n\n${e('party')} You're ready to go!`;
        break;
      case 'already_credited':
        text = `${e('check')} This deposit was already credited to your balance.`;
        break;
      case 'pending_confirmations':
        text = `${e('clock')} <b>DEPOSIT DETECTED</b>\n\nYour transaction was found and is waiting for blockchain confirmations.\n` +
          `It will be credited automatically — no further action needed.\n\nTx: <code>${result.txHash}</code>`;
        break;
      case 'not_found':
        text = `${e('search')} <b>TRANSACTION NOT FOUND YET</b>\n\nNo matching payment arrived at your deposit address yet.\n\n` +
          `• Check that you sent the exact expected amount to the correct address\n` +
          `• Confirmations can take a few minutes — tap again shortly\n\n` +
          `Your session stays active for 30 minutes.`;
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

  // ══════════════════════ CREATOR CLAIMANT MANAGEMENT ══════════════════════
  bot.action(/giveaway:claimants:(.+)/, guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const giveawayId = (ctx as any).match[1];
    const user = await currentUser(ctx);
    if (!user) return;

    // Ownership verified SERVER-SIDE — never trust the callback payload.
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
    const flaggedClaimIds = new Set(flags.map((f) => f.claimId));

    const lines = [
      `${e('people')} <b>CLAIMANTS</b>`,
      DIVIDER,
      `🎁 ${giveaway.totalAmount} ${giveaway.asset} · ${giveaway.claimedCount}/${giveaway.maxClaimers} claimed`,
      '',
    ];

    const rows: any[] = [];
    if (giveaway.claims.length === 0) lines.push('No claimants yet.');

    for (const c of giveaway.claims) {
      const name = c.user.firstName || c.user.username || 'User';
      const handle = c.user.username ? `@${c.user.username}` : `ID ${c.user.telegramId}`;
      const statusIcon = c.status === 'PAID' ? '✅' : c.status === 'FAILED' ? '❌' : '⏳';
      const flagIcon = flaggedClaimIds.has(c.id) ? ' ⚠️<i>possible duplicate</i>' : '';
      lines.push(
        `${statusIcon} <b>${name}</b> (${handle})`,
        `   ${c.status} · ${c.claimedAt.toLocaleString()}${c.payoutTransactionHash ? ` · <code>${c.payoutTransactionHash.slice(0, 12)}…</code>` : ''}${flagIcon}`
      );

      // Block controls — giveaway-scoped and creator-scoped (spec §8).
      rows.push([
        Markup.button.callback(
          `🚫 Block from this giveaway`,
          `giveaway:blockg:${giveawayId}:${c.userId}`
        ),
        Markup.button.callback(
          `🚫 Block from all my giveaways`,
          `giveaway:blockc:${c.userId}`
        ),
      ]);
    }

    if (flags.length > 0) {
      lines.push('', `⚠️ <b>${flags.length}</b> claim(s) flagged as possible duplicates — review before payouts finalize.`);
    }

    rows.push([Markup.button.callback(`${eb('chart')} Stats`, `giveaway:stats:${giveawayId}`)]);
    rows.push([Markup.button.callback(`${eb('back')} My Giveaways`, 'giveaway:mine')]);

    await editMainMessage(ctx, lines.join('\n'), Markup.inlineKeyboard(rows));
  }));

  // Giveaway-scoped block / unblock
  bot.action(/giveaway:blockg:(.+):(.+)/, guard(async (ctx: Context) => {
    const [, giveawayId, blockedUserId] = (ctx as any).match;
    const user = await currentUser(ctx);
    if (!user) return;
    const giveaway = await prisma.giveaway.findUnique({ where: { id: giveawayId }, select: { creatorId: true } });
    if (!giveaway || giveaway.creatorId !== user.id) {
      await ctx.answerCbQuery('Not authorized.', { show_alert: true });
      return;
    }
    await attributionService.blockUser({ creatorId: user.id, blockedUserId, giveawayId });
    await ctx.answerCbQuery('User blocked from this giveaway.');
    await editMainMessage(ctx, `${e('check')} User blocked from this giveaway.\nThey can no longer claim it.`, backKeyboard(`giveaway:claimants:${giveawayId}`));
  }));

  bot.action(/giveaway:unblockg:(.+):(.+)/, guard(async (ctx: Context) => {
    const [, giveawayId, blockedUserId] = (ctx as any).match;
    const user = await currentUser(ctx);
    if (!user) return;
    await attributionService.unblockUser({ creatorId: user.id, blockedUserId, giveawayId });
    await ctx.answerCbQuery('User unblocked.');
    await editMainMessage(ctx, `${e('check')} User unblocked for this giveaway.`, backKeyboard(`giveaway:claimants:${giveawayId}`));
  }));

  // Creator-scoped block / unblock
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

  // Creator view of their blocked list (with unblock shortcuts)
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
          ? Markup.button.callback(`✅ Unblock`, `giveaway:unblockg:${b.giveawayId}:${b.blockedUserId}`)
          : Markup.button.callback(`✅ Unblock`, `giveaway:unblockc:${b.blockedUserId}`),
      ]);
    }
    rows.push([Markup.button.callback(`${eb('back')} My Giveaways`, 'giveaway:mine')]);

    await editMainMessage(ctx, lines.join('\n'), Markup.inlineKeyboard(rows));
  }));
}
