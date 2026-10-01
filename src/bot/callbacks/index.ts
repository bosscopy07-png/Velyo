import { Context, Markup } from 'telegraf';
import { prisma } from '../../database';
import { config, GIVEAWAY_EXPIRY_OPTIONS, type AssetSymbol } from '../../config';
import { giveawayService } from '../../services/giveaway';
import { e, eb } from '../../utils/emoji';
import { logger } from '../../utils/logger';
import { BOT_USERNAME, editMainMessage, VEYLO_IMAGE } from '../utils/editMainMessage';
import { backKeyboard, mainKeyboard, assetKeyboard } from '../keyboards/main';
import { formatDashboardMessage, formatCreateGiveawayMessage, formatWalletMessage, formatMyGiveawaysMessage } from '../messages';
import { pricing } from '../../services/pricing';
import { walletService } from '../../services/wallet';
import { blockchain } from '../../services/blockchain';
import { assertUserOperational } from '../../services/maintenance';
import { isValidAmount } from '../../utils/validation';
import { setUserSession, redis } from '../../services/redis';

const guard = (fn: (ctx: Context) => Promise<void>) => async (ctx: Context) => {
  try {
    await fn(ctx);
  } catch (err) {
    logger.error(`Callback error: ${(err as Error).message}`, err);
    try {
      await ctx.answerCbQuery('Something went wrong. Try again.', { show_alert: true });
    } catch { /* ignore */ }
  }
};

// Track the user menu message (caption on the VEYLO image) per chat
const MENU_KEY_PREFIX = 'menu:msg:';

async function rememberMenuMessage(chatId: number, messageId: number): Promise<void> {
  try {
    await redis.set(`${MENU_KEY_PREFIX}${chatId}`, messageId.toString());
  } catch { /* non-critical */ }
}

async function findMenuMessageId(ctx: Context): Promise<number | null> {
  const chatId = ctx.chat?.id;
  if (!chatId) return null;
  const stored = await redis.get(`${MENU_KEY_PREFIX}${chatId}`);
  return stored ? parseInt(stored, 10) : null;
}

export function registerCallbacks(bot: any): void {
  // ═══════════════════════ MAIN MENU ═══════════════════════
  bot.action('main', guard(async (ctx: Context) => {
    await assertUserOperational(ctx.from!.id.toString());
    await ctx.answerCbQuery();

    const user = await prisma.user.findUnique({ where: { telegramId: ctx.from!.id.toString() } });
    if (!user) return;

    const caption = formatDashboardMessage(user, ctx.from!.first_name || 'there');

    // Try: edit existing menu → edit mainMessage → send new
    const existingMenuId = await findMenuMessageId(ctx);
    const mainMessageId = user.mainMessageId ? parseInt(user.mainMessageId) : null;

    let edited = false;

    if (existingMenuId) {
      try {
        await ctx.telegram.editMessageCaption(
          ctx.chat!.id,
          existingMenuId,
          undefined,
          caption,
          {
            parse_mode: 'HTML',
            reply_markup: mainKeyboard(config.ADMIN_TELEGRAM_IDS.includes(ctx.from!.id.toString())).reply_markup,
          }
        );
        edited = true;
      } catch {
        // deleted/migrated/etc — fall through
      }
    }

    if (!edited && mainMessageId) {
      try {
        await ctx.telegram.editMessageCaption(
          ctx.chat!.id,
          mainMessageId,
          undefined,
          caption,
          {
            parse_mode: 'HTML',
            reply_markup: mainKeyboard(config.ADMIN_TELEGRAM_IDS.includes(ctx.from!.id.toString())).reply_markup,
          }
        );
        await rememberMenuMessage(ctx.chat!.id, mainMessageId);
        edited = true;
      } catch { /* ignore */ }
    }

    if (!edited) {
      const msg = await ctx.replyWithPhoto(VEYLO_IMAGE, {
        caption,
        parse_mode: 'HTML',
        reply_markup: mainKeyboard(config.ADMIN_TELEGRAM_IDS.includes(ctx.from!.id.toString())).reply_markup,
      });
      await rememberMenuMessage(ctx.chat!.id, msg.message_id);
      await prisma.user.update({ where: { id: user.id }, data: { mainMessageId: msg.message_id.toString() } });
    }
  }));

  // ═══════════════════════ ACCOUNT ═══════════════════════
  bot.action('account', guard(async (ctx: Context) => {
    await assertUserOperational(ctx.from!.id.toString());
    await ctx.answerCbQuery();

    const user = await prisma.user.findUnique({ where: { telegramId: ctx.from!.id.toString() } });
    if (!user) return;

    const balances = await prisma.balance.findMany({ where: { userId: user.id } });

    // Prefer on-chain balances (same source of truth as payouts) over the DB mirror
    let onChain: Record<string, string> = {};
    try {
      const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } });
      if (wallet) {
        for (const asset of ['USDT', 'BNB'] as const) {
          try {
            const raw = await blockchain.getBalance(wallet.address, asset);
            onChain[asset] = (Number(raw) / 1e18).toFixed(4);
          } catch {
            onChain[asset] = '—';
          }
        }
      }
    } catch { /* fall through to DB balances */ }

    const text = formatWalletMessage(
      user,
      balances,
      pricing,
      onChain.USDT ?? null,
      onChain.BNB ?? null,
    );

    // UPGRADE: Rewards + Deposits sections added (spec §29/§30).
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(`${eb('star')} Rewards`, 'account:rewards')],
      [Markup.button.callback(`${eb('deposit')} Deposits`, 'account:deposits')],
      [Markup.button.callback(`${eb('document')} History`, 'wallet:history')],
      [Markup.button.callback(`${eb('back')} Back`, 'main')],
    ]);

    await editMainMessage(ctx, text, keyboard);
  }));

  // ═══════════════════════ WALLET ═══════════════════════
  bot.action('wallet', guard(async (ctx: Context) => {
    await assertUserOperational(ctx.from!.id.toString());
    await ctx.answerCbQuery();

    const user = await prisma.user.findUnique({ where: { telegramId: ctx.from!.id.toString() } });
    if (!user) return;

    // Lazy wallet: shown on demand only
    const wallet = await walletService.createWallet(user.id);
    const balances = await prisma.balance.findMany({ where: { userId: user.id } });

    let onChainUSDT: string | null = null;
    let onChainBNB: string | null = null;
    try {
      const rawUsdt = await blockchain.getBalance(wallet.address, 'USDT');
      const rawBnb = await blockchain.getBalance(wallet.address, 'BNB');
      onChainUSDT = (Number(rawUsdt) / 1e18).toFixed(4);
      onChainBNB = (Number(rawBnb) / 1e18).toFixed(6);
    } catch { /* on-chain read failed — DB mirror only */ }

    const text = formatWalletMessage(user, balances, pricing, onChainUSDT, onChainBNB);

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(`${eb('deposit')} Deposit`, 'wallet:deposit')],
      [Markup.button.callback(`${eb('document')} History`, 'wallet:history')],
      [Markup.button.callback(`${eb('back')} Back`, 'main')],
    ]);

    await editMainMessage(ctx, text, keyboard);
  }));

  // ═══════════════════════ WALLET HISTORY ═══════════════════════
  bot.action('wallet:history', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();

    const user = await prisma.user.findUnique({ where: { telegramId: ctx.from!.id.toString() } });
    if (!user) return;

    const history = await prisma.transaction.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 15,
    });

    const text =
      `${e('chart')} <b>RECENT ACTIVITY</b>\n━━━━━━━━━━━━━━━━━\n\n` +
      (history.length === 0
        ? 'No transactions yet.'
        : history
            .map((tx) => {
              const date = tx.createdAt.toLocaleDateString();
              const amount = Number(tx.amount);
              const statusIcon = tx.status === 'CONFIRMED' ? '✅' : tx.status === 'PENDING' ? '⏳' : '❌';
              const typeLabels: Record<string, string> = {
                DEPOSIT: '📥 Deposit',
                WITHDRAWAL: '📤 Withdrawal',
                GIVEAWAY_CREATED: '🎁 Giveaway Created',
                GIVEAWAY_REWARD: '🎉 Giveaway Reward',
                CODE_REDEMPTION: '🎟 Code Redemption',
                REFUND: '↩️ Refund',
                PLATFORM_FEE: '💳 Platform Fee',
                PAYOUT: '📤 Payout',
              };
              const label = typeLabels[tx.type] || tx.type;
              const sign = tx.type === 'DEPOSIT' || tx.type === 'GIVEAWAY_REWARD' || tx.type === 'CODE_REDEMPTION' ? '+' : '-';
              return `${statusIcon} ${label}\n  ${sign}${amount} ${tx.asset} · ${date}\n  <code>${tx.id.slice(0, 8)}…</code>`;
            })
            .join('\n\n'));

    const keyboard = backKeyboard('account');
    await editMainMessage(ctx, text, keyboard);
  }));

  // ═══════════════════════ DEPOSIT ═══════════════════════
  bot.action('wallet:deposit', guard(async (ctx: Context) => {
    await assertUserOperational(ctx.from!.id.toString());
    await ctx.answerCbQuery();

    const user = await prisma.user.findUnique({ where: { telegramId: ctx.from!.id.toString() } });
    if (!user) return;

    // Lazy wallet: generated on first deposit attempt
    const wallet = await walletService.createWallet(user.id);

    await editMainMessage(
      ctx,
      `${e('deposit')} <b>DEPOSIT</b>\n━━━━━━━━━━━━━━━━━\n\n` +
      `<b>Network:</b> BNB Smart Chain (BEP20)\n\n` +
      `<b>Your deposit address:</b>\n<code>${wallet.address}</code>\n\n` +
      `⚠️ Send only BNB or USDT (BEP20) to this address.\n` +
      `Funds are credited after 15 network confirmations.`,
      assetKeyboard('deposit')
    );
  }));

  bot.action(/deposit:(BNB|USDT)/, guard(async (ctx: Context) => {
    await assertUserOperational(ctx.from!.id.toString());
    await ctx.answerCbQuery();
    const asset = (ctx as any).match[1] as string;

    const user = await prisma.user.findUnique({ where: { telegramId: ctx.from!.id.toString() } });
    if (!user) return;

    const wallet = await walletService.createWallet(user.id);
    const { formatDepositMessage } = await import('../messages');
    const depositKeyboard = (await import('../keyboards/main')).depositKeyboard;
    const text = await formatDepositMessage(wallet.address, asset, pricing);
    await editMainMessage(ctx, text, depositKeyboard(asset));
  }));

  // Deposit action handler — asset + specific amount button
  bot.action(/deposit:(BNB|USDT):(\d+)/, guard(async (ctx: Context) => {
    await assertUserOperational(ctx.from!.id.toString());
    await ctx.answerCbQuery();
    const asset = (ctx as any).match[1] as string;
    const amount = (ctx as any).match[2] as string;

    const user = await prisma.user.findUnique({ where: { telegramId: ctx.from!.id.toString() } });
    if (!user) return;

    const wallet = await walletService.createWallet(user.id);
    const { formatDepositMessage } = await import('../messages');
    const depositKeyboard = (await import('../keyboards/main')).depositKeyboard;
    const text = await formatDepositMessage(wallet.address, asset, pricing);
    await editMainMessage(ctx, text, depositKeyboard(asset, amount));
  }));

  // ═══════════════════════ GIVEAWAY ═══════════════════════
  bot.action('giveaway', guard(async (ctx: Context) => {
    await assertUserOperational(ctx.from!.id.toString());
    await ctx.answerCbQuery();

    const text = formatCreateGiveawayMessage();

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(`${eb('gift')} Single Claim`, 'giveaway:single')],
      [Markup.button.callback(`${eb('people')} Multiple Claims`, 'giveaway:multiple')],
      [Markup.button.callback(`${eb('list')} My Giveaways`, 'giveaway:mine')],
      [Markup.button.callback(`${eb('back')} Back`, 'main')],
    ]);

    await editMainMessage(ctx, text, keyboard);
  }));

  bot.action('giveaway:single', guard(async (ctx: Context) => {
    await assertUserOperational(ctx.from!.id.toString());
    await ctx.answerCbQuery();

    const keyboard = assetKeyboard('giveaway:single');
    await editMainMessage(ctx, `${e('gift')} <b>SINGLE CLAIM GIVEAWAY</b>\n━━━━━━━━━━━━━━━━━\n\nSelect an asset:`, keyboard);
  }));

  bot.action(/giveaway:single:(BNB|USDT)/, guard(async (ctx: Context) => {
    await assertUserOperational(ctx.from!.id.toString());
    await ctx.answerCbQuery();
    const asset = (ctx as any).match[1] as string;

    await setUserSession(ctx.from!.id.toString(), { state: 'giveaway_single_amount', asset });

    await editMainMessage(
      ctx,
      `${e('gift')} <b>SINGLE CLAIM GIVEAWAY</b>\n━━━━━━━━━━━━━━━━━\n\nSelected: <b>${asset}</b>\n\nEnter the total amount:`,
      backKeyboard('giveaway')
    );
  }));

  bot.action('giveaway:multiple', guard(async (ctx: Context) => {
    await assertUserOperational(ctx.from!.id.toString());
    await ctx.answerCbQuery();

    const keyboard = assetKeyboard('giveaway:multiple');
    await editMainMessage(ctx, `${e('people')} <b>MULTIPLE CLAIM GIVEAWAY</b>\n━━━━━━━━━━━━━━━━━\n\nSelect an asset:`, keyboard);
  }));

  bot.action(/giveaway:multiple:(BNB|USDT)/, guard(async (ctx: Context) => {
    await assertUserOperational(ctx.from!.id.toString());
    await ctx.answerCbQuery();
    const asset = (ctx as any).match[1] as string;

    await setUserSession(ctx.from!.id.toString(), { state: 'giveaway_multi_amount', asset });

    await editMainMessage(
      ctx,
      `${e('people')} <b>MULTIPLE CLAIM GIVEAWAY</b>\n━━━━━━━━━━━━━━━━━\n\nSelected: <b>${asset}</b>\n\nEnter the total amount:`,
      backKeyboard('giveaway:multiple')
    );
  }));

  // ═══════════════════════ MY GIVEAWAYS ═══════════════════════
  bot.action('giveaway:mine', guard(async (ctx: Context) => {
    await assertUserOperational(ctx.from!.id.toString());
    await ctx.answerCbQuery();

    const user = await prisma.user.findUnique({ where: { telegramId: ctx.from!.id.toString() } });
    if (!user) return;

    await renderMyGiveaways(ctx, user.id);
  }));

  // UPGRADE: per-giveaway Claimants management (spec §7/§8).
  async function renderMyGiveaways(ctx: Context, userId: string, page = 0): Promise<void> {
    const PER_PAGE = 5;
    const total = await prisma.giveaway.count({ where: { creatorId: userId } });
    const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

    const giveaways = await prisma.giveaway.findMany({
      where: { creatorId: userId },
      orderBy: { createdAt: 'desc' },
      skip: page * PER_PAGE,
      take: PER_PAGE,
      include: { claims: { orderBy: { claimedAt: 'asc' } } },
    });

    const text = formatMyGiveawaysMessage(giveaways);

    const rows: any[] = [];
    giveaways.forEach((g, i) => {
      const idx = page * PER_PAGE + i + 1;
      const statusIcon = g.status === 'ACTIVE' ? '🟢' : g.status === 'FULL' ? '🟡' : g.status === 'COMPLETED' ? '✅' : g.status === 'CANCELLED' ? '❌' : '⚪';
      rows.push([
        Markup.button.callback(
          `${statusIcon} #${idx} — ${Number(g.totalAmount)} ${g.asset} (${g.claimedCount}/${g.maxClaimers})`,
          `giveaway:view:${g.id}`
        ),
      ]);
    });

    // Pagination
    if (totalPages > 1) {
      const nav: any[] = [];
      if (page > 0) nav.push(Markup.button.callback('◀️', `giveaway:mine:${page - 1}`));
      nav.push(Markup.button.callback(`${page + 1}/${totalPages}`, 'noop'));
      if (page < totalPages - 1) nav.push(Markup.button.callback('▶️', `giveaway:mine:${page + 1}`));
      rows.push(nav);
    }

    // Stats buttons for giveaways that have paid claims (2 per row)
    for (const g of giveaways) {
      if (g.claims.some((c) => c.status === 'PAID') && !rows.some((r) => (r[1] as any)?.callback_data === `giveaway:stats:${g.id}`)) {
        rows.unshift([Markup.button.callback(`${eb('chart')} Stats — ${g.totalAmount} ${g.asset}`, `giveaway:stats:${g.id}`)]);
      } else if (g.claims.length > 0) {
        // UPGRADE: claimants management for any giveaway with claims.
        rows.push([
          Markup.button.callback(`${eb('chart')} Stats`, `giveaway:stats:${g.id}`),
          Markup.button.callback(`${eb('people')} Claimants`, `giveaway:claimants:${g.id}`),
        ]);
      }
    }

    // UPGRADE: creator block list entry point.
    rows.push([Markup.button.callback(`${eb('shield')} Blocked Users`, 'giveaway:blocklist')]);
    rows.push([Markup.button.callback(`${eb('back')} Back`, 'giveaway')]);

    await editMainMessage(ctx, text, Markup.inlineKeyboard(rows));
  }

  bot.action(/giveaway:mine:(\d+)/, guard(async (ctx: Context) => {
    await assertUserOperational(ctx.from!.id.toString());
    await ctx.answerCbQuery();
    const page = parseInt((ctx as any).match[1], 10);
    const user = await prisma.user.findUnique({ where: { telegramId: ctx.from!.id.toString() } });
    if (!user) return;
    await renderMyGiveaways(ctx, user.id, page);
  }));

  // ─────────────────────────── GIVEAWAY STATS (Creator Analytics) ───────────────────────────

  bot.action(/giveaway:stats:(.+)/, guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const giveawayId = (ctx as any).match[1];

    const user = await prisma.user.findUnique({ where: { telegramId: ctx.from!.id.toString() } });
    if (!user) return;

    const stats = await giveawayService.getGiveawayStats(giveawayId);
    if (!stats || stats.creatorId !== user.id) {
      await editMainMessage(ctx, `${e('warning')} Giveaway not found.`, backKeyboard('giveaway:mine'));
      return;
    }

    const timeRangeText = (() => {
      if (!stats.claims.length) return 'No claims yet';
      const first = new Date(stats.claims[0].claimedAt);
      const last = new Date(stats.claims[stats.claims.length - 1].claimedAt);
      const diffMs = last.getTime() - first.getTime();
      const hours = Math.floor(diffMs / 3600000);
      const minutes = Math.floor((diffMs % 3600000) / 60000);
      return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    })();

    const text =
      `${e('chart')} <b>GIVEAWAY STATS</b>\n━━━━━━━━━━━━━━━━━\n\n` +
      `<b>Total Pool:</b> ${stats.totalAmount} ${stats.asset}\n` +
      `<b>Amount Per User:</b> ${stats.amountPerUser} ${stats.asset}\n` +
      `<b>Claimed:</b> ${stats.claimedCount}/${stats.maxClaimers}\n` +
      `<b>Time to Fill:</b> ${timeRangeText}\n\n` +
      `<b>Claims Breakdown:</b>\n` +
      `✅ Paid: ${stats.paidClaims.length}\n` +
      `⏳ Pending: ${stats.pendingClaims.length}\n` +
      `❌ Failed: ${stats.failedClaims.length}\n\n` +
      `${e('gift')} <b>Claims:</b>\n` +
      (stats.claims.length === 0
        ? 'No claims yet.'
        : stats.claims
            .slice(0, 15)
            .map((c) => {
              const icon = c.status === 'PAID' ? '✅' : c.status === 'FAILED' ? '❌' : '⏳';
              const name = c.user.username || c.user.firstName || 'Unknown';
              return `${icon} #${c.claimOrder} @${name} — ${c.status}`;
            })
            .join('\n'));

    await editMainMessage(ctx, text, backKeyboard('giveaway:mine'));
  }));

  // ─────────────────────────── GIVEAWAY VIEW ───────────────────────────

  bot.action(/giveaway:view:(.+)/, guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const giveawayId = (ctx as any).match[1];

    const user = await prisma.user.findUnique({ where: { telegramId: ctx.from!.id.toString() } });
    if (!user) return;

    const giveaway = await prisma.giveaway.findUnique({
      where: { id: giveawayId },
      include: { claims: { include: { user: true } } },
    });

    if (!giveaway || giveaway.creatorId !== user.id) {
      await editMainMessage(ctx, `${e('warning')} Giveaway not found.`, backKeyboard('giveaway:mine'));
      return;
    }

    const statusIcons: Record<string, string> = {
      ACTIVE: '🟢',
      FULL: '🟡',
      COMPLETED: '✅',
      CANCELLED: '❌',
      EXPIRED: '⚪',
      FAILED: '❌',
      PROCESSING: '⏳',
      DRAFT: '⚪',
    };

    const expiryText = giveaway.expiresAt
      ? giveaway.expiresAt.toLocaleString()
      : 'No expiry';

        const text =
      `${e('gift')} <b>GIVEAWAY DETAILS</b>\n━━━━━━━━━━━━━━━━━\n\n` +
      `<b>Status:</b> ${statusIcons[giveaway.status] || '⚪'} ${giveaway.status}\n` +
      `<b>Asset:</b> ${giveaway.asset}\n` +
      `<b>Total Pool:</b> ${giveaway.totalAmount} ${giveaway.asset}\n` +
      `<b>Per User:</b> ${giveaway.amountPerUser} ${giveaway.asset}\n` +
      `<b>Progress:</b> ${giveaway.claimedCount}/${giveaway.maxClaimers} claimed\n` +
      `<b>Expiry:</b> ${expiryText}\n` +
      `<b>Share Link:</b> <code>https://t.me/${BOT_USERNAME}?start=giveaway_${giveaway.secureCode}</code>\n` +
      (giveaway.claims.length > 0
        ? `\n<b>Claims:</b>\n${giveaway.claims
            .slice(0, 10)
            .map((c) => `${c.status === 'PAID' ? '✅' : c.status === 'FAILED' ? '❌' : '⏳'} @${c.user.username || 'Unknown'}`)
            .join('\n')}`
        : '');

    const rows: any[] = [
      [Markup.button.callback(`${eb('copy')} Copy Link`, `giveaway:copy:${giveaway.secureCode}`)],
    ];

    if (giveaway.status === 'ACTIVE') {
      rows.push([Markup.button.callback(`${eb('cancel')} Cancel Giveaway`, `giveaway:cancel:${giveaway.id}`)]);
    }

    rows.push([Markup.button.callback(`${eb('back')} Back`, 'giveaway:mine')]);

    await editMainMessage(ctx, text, Markup.inlineKeyboard(rows));
  }));

  // ─────────────────────────── CANCEL GIVEAWAY ───────────────────────────

  bot.action(/giveaway:cancel:(.+)/, guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const giveawayId = (ctx as any).match[1];

    const user = await prisma.user.findUnique({ where: { telegramId: ctx.from!.id.toString() } });
    if (!user) return;

    const giveaway = await prisma.giveaway.findUnique({ where: { id: giveawayId } });
    if (!giveaway || giveaway.creatorId !== user.id) {
      await editMainMessage(ctx, `${e('warning')} Giveaway not found.`, backKeyboard('giveaway:mine'));
      return;
    }

    if (giveaway.status !== 'ACTIVE') {
      await editMainMessage(ctx, `${e('warning')} This giveaway can no longer be cancelled.`, backKeyboard('giveaway:mine'));
      return;
    }

    // Show inline confirmation
    const text =
      `${e('warning')} <b>CANCEL GIVEAWAY?</b>\n━━━━━━━━━━━━━━━━━\n\n` +
      `Pool: ${giveaway.totalAmount} ${giveaway.asset}\n` +
      `Claimed: ${giveaway.claimedCount}/${giveaway.maxClaimers}\n\n` +
      `Unclaimed funds will be returned to your balance.`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(`${eb('confirm')} Yes, Cancel`, `giveaway:cancel:confirm:${giveawayId}`)],
      [Markup.button.callback(`${eb('back')} Keep Giveaway`, 'giveaway:mine')],
    ]);

    await editMainMessage(ctx, text, keyboard);
  }));

  bot.action(/giveaway:cancel:confirm:(.+)/, guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const giveawayId = (ctx as any).match[1];

    const user = await prisma.user.findUnique({ where: { telegramId: ctx.from!.id.toString() } });
    if (!user) return;

    try {
      const result = await giveawayService.cancelGiveaway(giveawayId, user.id);
      const text =
        `${e('check')} <b>GIVEAWAY CANCELLED</b>\n━━━━━━━━━━━━━━━━━\n\n` +
        `Refunded: ${result.refundAmount} ${result.asset}\n` +
        `Tx: <code>${result.transactionHash || 'Internal'}</code>`;
      await editMainMessage(ctx, text, backKeyboard('giveaway:mine'));
    } catch (err) {
      logger.error('Cancel giveaway error:', err);
      const reason = (err as Error).message;
      const friendly = reason.includes('already been cancelled')
        ? 'This giveaway has already been cancelled.'
        : reason.includes('no longer active')
          ? 'This giveaway is no longer active and cannot be cancelled.'
          : 'Could not cancel the giveaway. Please try again.';
      await editMainMessage(ctx, `${e('warning')} ${friendly}`, backKeyboard('giveaway:mine'));
    }
  }));

  bot.action(/giveaway:confirm:(single|multi)\|([A-Z]+)\|([\d.]+)\|(\d+)\|(\d+)/, guard(async (ctx: Context) => {
    await assertUserOperational(ctx.from!.id.toString());
    await ctx.answerCbQuery('Creating giveaway...');

    const [, mode, asset, amountStr, claimersStr, expiryHoursStr] = (ctx as any).match;
    const amount = parseFloat(amountStr);
    const maxClaimers = parseInt(claimersStr);
    const expiryHours = parseInt(expiryHoursStr);

    const user = await prisma.user.findUnique({ where: { telegramId: ctx.from!.id.toString() } });
    if (!user) return;

    try {
      const result = await giveawayService.createGiveaway({
        creatorId: user.id,
        asset: asset as AssetSymbol,
        totalAmount: amount,
        maxClaimers,
        expiresAt: expiryHours > 0 ? new Date(Date.now() + expiryHours * 3600000) : undefined,
      });

      const text =
        `${e('party')} <b>GIVEAWAY CREATED!</b>\n━━━━━━━━━━━━━━━━━\n\n` +
        `${e('gift')} Total: ${amount} ${asset}\n` +
        `${e('people')} Claimers: ${maxClaimers}\n` +
        `${e('star')} Each gets: ${result.amountPerUser} ${asset}\n\n` +
        `${e('link')} <b>Share Link:</b>\n` +
        `<code>https://t.me/${BOT_USERNAME}?start=giveaway_${result.secureCode}</code>\n\n` +
        `Share this link to let people claim!`;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(`${eb('copy')} Copy Link`, `giveaway:copy:${result.secureCode}`)],
        [Markup.button.callback(`${eb('list')} My Giveaways`, 'giveaway:mine')],
        [Markup.button.callback(`${eb('back')} Back`, 'giveaway')],
      ]);

      await editMainMessage(ctx, text, keyboard);
    } catch (err) {
      logger.error('Giveaway creation error:', err);
      const reason = (err as Error).message;

      let friendlyMessage = `${e('warning')} <b>COULD NOT CREATE GIVEAWAY</b>\n\n`;
      if (reason.includes('Insufficient')) {
        friendlyMessage += `You don't have enough ${asset} to cover the giveaway amount plus fees.\n\nDeposit more ${asset} and try again.`;
      } else if (reason.includes('gas budget')) {
        friendlyMessage += `Network gas is too expensive right now. Please try again later.`;
      } else if (reason.includes('maintenance')) {
        friendlyMessage += `VEYLO is currently under maintenance. Please try again later.`;
      } else {
        friendlyMessage += `Something went wrong. Please try again.`;
      }

      await editMainMessage(ctx, friendlyMessage, backKeyboard('giveaway'));
    }
  }));

  // ─────────────────────────── REWARDS / REDEEM ───────────────────────────

  bot.action('rewards', guard(async (ctx: Context) => {
    await assertUserOperational(ctx.from!.id.toString());
    await ctx.answerCbQuery();

    await editMainMessage(
      ctx,
      `${e('gift')} <b>REWARDS</b>\n━━━━━━━━━━━━━━━━━\n\n` +
      `Have a redeem code?\nEnter it below to claim your reward!`,
      backKeyboard('main')
    );

    await setUserSession(ctx.from!.id.toString(), { state: 'redeem_code' });
  }));

  // ─────────────────────────── SETTINGS ───────────────────────────

  bot.action('settings', guard(async (ctx: Context) => {
    await assertUserOperational(ctx.from!.id.toString());
    await ctx.answerCbQuery();

    const text = `${e('settings')} <b>SETTINGS</b>\n━━━━━━━━━━━━━━━━━\n\nComing soon!`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(`${eb('back')} Back`, 'main')],
    ]);

    await editMainMessage(ctx, text, keyboard);
  }));

  // ─────────────────────────── NOOP (pagination indicator) ───────────────────────────

  bot.action('noop', async (ctx: Context) => {
    await ctx.answerCbQuery();
  });

  // ─────────────────────────── COPY GIVEAWAY LINK ───────────────────────────

  bot.action(/giveaway:copy:(.+)/, guard(async (ctx: Context) => {
    const code = (ctx as any).match[1];
    const link = `https://t.me/${BOT_USERNAME}?start=giveaway_${code}`;
    await ctx.answerCbQuery(`Link: ${link}`, { show_alert: true });
  }));
  }
  
