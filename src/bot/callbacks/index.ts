import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { prisma } from '../../database';
import { walletService } from '../../services/wallet';
import { giveawayService } from '../../services/giveaway';
import { redis, setUserSession } from '../../services/redis';
import { config } from '../../config';
import { e, eb } from '../../utils/emoji';
import { logger } from '../../utils/logger';
import { formatWalletMessage, formatDepositMessage, formatGiveawayCreatedMessage } from '../messages';
import {
  mainKeyboard,
  walletKeyboard,
  depositKeyboard,
  giveawayTypeKeyboard,
  backKeyboard,
  assetKeyboard,
} from '../keyboards/main';
import { formatAddress } from '../../utils/validation';
import { editMainMessage } from '../utils/editMainMessage';

// Telegram t.me links break if the username contains "@"
const BOT_USERNAME = config.BOT_USERNAME.replace(/^@/, '');

export function registerCallbacks(bot: any): void {
  const isAdmin = (ctx: Context): boolean =>
    !!ctx.from && config.ADMIN_TELEGRAM_IDS.includes(ctx.from.id.toString());

  /**
   * Platform money sitting in the user's wallet that is NOT spendable:
   *  - unswept USDT platform fees (owed to the platform until swept/forwarded)
   *  - seeded BNB gas floats (recorded in Redis gas:credit:*, reclaimed later)
   * These must be subtracted from what we display, or users see money they
   * can't actually use (the giveaway creation gate subtracts them too).
   */
  async function getPlatformReserve(userId: string, address: string): Promise<{ USDT: number; BNB: number }> {
    const reserve = { USDT: 0, BNB: 0 };

    // Unswept fees owed on this user's deposits/giveaways
    const feesAgg = await prisma.platformFee.aggregate({
      where: { sweptAt: null, asset: 'USDT', transaction: { userId } },
      _sum: { amount: true },
    });
    reserve.USDT = Number(feesAgg._sum.amount ?? 0);

    // Active seeded gas floats for this address (across all its giveaways).
    // Plain SCAN cursor loop — compatible with ioredis v4 AND v5.
    try {
      let cursor = '0';
      do {
        const [next, keys] = (await redis.scan(
          cursor,
          'MATCH', 'gas:credit:*',
          'COUNT', 200,
        )) as unknown as [string, string[]];

        for (const key of keys) {
          const raw = await redis.get(key);
          if (!raw) continue;
          const credit = JSON.parse(raw) as { address: string; seeded: string };
          if (credit.address === address && BigInt(credit.seeded) > 0n) {
            reserve.BNB += Number(BigInt(credit.seeded)) / 1e18;
          }
        }

        cursor = next;
      } while (cursor !== '0');
    } catch (err) {
      // Float lookup is best-effort — never block the wallet view on it
      logger.warn(`Gas float lookup failed for ${address}: ${(err as Error).message}`);
    }

    return reserve;
  }

  async function renderWallet(ctx: Context): Promise<void> {
    const from = ctx.from!;
    let user = await prisma.user.findUnique({
      where: { telegramId: from.id.toString() },
      include: { balances: true, wallet: true },
    });

    if (!user) return;

    if (!user.wallet) {
      await walletService.createWallet(user.id);
      user = await prisma.user.findUnique({
        where: { telegramId: from.id.toString() },
        include: { balances: true, wallet: true },
      });
    }

    if (!user?.wallet) return;

    // UPGRADE (spec §37): the DB ledger is the SINGLE source of truth —
    // deposits and rewards credit it, giveaways spend from it, every change
    // is ledger-recorded. No on-chain balance reads for user balances.
    const reserve = await getPlatformReserve(user.id, user.wallet.address);

    const balances = await Promise.all(
      (['BNB', 'USDT'] as const).map(async (asset) => {
        const db = user!.balances.find((b) => b.asset === asset);
        const locked = Number(db?.lockedBalance ?? 0);
        const platformReserve = reserve[asset] ?? 0;
        const available = Number(db?.availableBalance ?? 0);

        return {
          asset,
          available: Math.max(0, available - platformReserve),
          locked,
        };
      })
    );

    const caption = await formatWalletMessage(balances);
    await editMainMessage(ctx, caption, walletKeyboard);
  }

  async function renderHistory(ctx: Context): Promise<void> {
    const from = ctx.from!;
    const user = await prisma.user.findUnique({ where: { telegramId: from.id.toString() } });
    if (!user) return;

    const txs = await prisma.transaction.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    let text = `${e('document')} <b>RECENT ACTIVITY</b>\n\n`;
    if (txs.length === 0) text += 'No transactions yet.';

    for (const tx of txs) {
      const sign = ['DEPOSIT', 'GIVEAWAY_REWARD', 'CODE_REDEMPTION', 'REFUND'].includes(tx.type) ? '+' : '-';
      text += `${sign}${tx.amount} ${tx.asset} — ${tx.status}\n`;
    }

    await editMainMessage(ctx, text, backKeyboard('wallet'));
  }

  async function renderMyGiveaways(ctx: Context, userId: string): Promise<void> {
    const giveaways = await prisma.giveaway.findMany({
      where: { creatorId: userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { claims: true },
    });

    let text = `${e('chart')} <b>MY GIVEAWAYS</b>\n\n`;
    if (giveaways.length === 0) text += 'No giveaways created yet.';

    for (const g of giveaways) {
      const status = g.status === 'ACTIVE' ? '🟢' : g.status === 'FULL' ? '🔴' : '⚪';
      text += `${status} ${g.totalAmount} ${g.asset} | ${g.claimedCount}/${g.maxClaimers} claimed | ${g.status}\n`;
    }

    // Cancel only while nothing has been paid out
    const rows: any[] = giveaways
      .filter(
        (g) =>
          (g.status === 'ACTIVE' || g.status === 'FULL') &&
          g.claims.every((c) => c.status !== 'PAID')
      )
      .map((g) => [
        Markup.button.callback(`${eb('cancel')} Cancel ${g.totalAmount} ${g.asset}`, `giveaway:cancel:${g.id}`),
        Markup.button.callback(`${eb('chart')} Stats`, `giveaway:stats:${g.id}`),
      ]);
    for (const g of giveaways) {
      if (g.claims.some((c) => c.status === 'PAID') && !rows.some((r) => (r[1] as any)?.callback_data === `giveaway:stats:${g.id}`)) {
        rows.unshift([Markup.button.callback(`${eb('chart')} Stats — ${g.totalAmount} ${g.asset}`, `giveaway:stats:${g.id}`)]);
      }
    }
    // UPGRADE: claimant management (view / block / unblock) for any giveaway
    // that has at least one claim (spec §7/§8). Handled in callbacks/upgrade.ts.
    for (const g of giveaways) {
      if (g.claims.length > 0 && !rows.some((r) => (r[1] as any)?.callback_data === `giveaway:claimants:${g.id}`)) {
        rows.push([Markup.button.callback(`${eb('people')} Claimants — ${g.totalAmount} ${g.asset}`, `giveaway:claimants:${g.id}`)]);
      }
    }
    rows.push([Markup.button.callback(`${eb('back')} Back`, 'giveaway')]);

    await editMainMessage(ctx, text, Markup.inlineKeyboard(rows));
  }
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

  // === MAIN NAVIGATION ===
  bot.action('main', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    await editMainMessage(
      ctx,
      `${e('lightning')} <b>Welcome to VEYLO</b>\n\n` +
      `Your crypto wallet built for speed.\n\n` +
      `Manage your assets, receive payments, create giveaways, and earn with simple Telegram tools.\n\n` +
      `Fast. Simple. Secure.`,
      mainKeyboard(isAdmin(ctx))
    );
  }));

  // === WALLET ===
  bot.action('wallet', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    await renderWallet(ctx);
  }));

  bot.action('wallet:refresh', guard(async (ctx: Context) => {
    await ctx.answerCbQuery('Refreshing...');
    await renderWallet(ctx);
  }));

  // === DEPOSIT (UPGRADE §11–13: company pool sessions) ===
  // Personal wallets are NO LONGER deposit addresses and are NOT monitored
  // for deposits. Deposits use a company pool address assigned per-session
  // (30-minute window, unique amount, "I Have Deposited" verification).
  // The personal wallet address stays — it still holds giveaway funds/gas.
  bot.action('wallet:deposit', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    await editMainMessage(
      ctx,
      `${e('deposit')} <b>DEPOSIT</b>\n\n` +
      `You'll receive a dedicated company deposit address, valid for <b>30 minutes</b>, ` +
      `with a unique amount so your payment is matched instantly.\n\n` +
      `Choose an asset to start:`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`🟡 New BNB Deposit`, 'deposit:session:BNB')],
        [Markup.button.callback(`🟢 New USDT Deposit`, 'deposit:session:USDT')],
        [Markup.button.callback(`${eb('back')} Back`, 'wallet')],
      ])
    );
  }));

  bot.action(/deposit:(BNB|USDT)/, guard(async (ctx: Context) => {
    // UPGRADE: old personal-wallet deposit addresses are RETIRED. They are
    // no longer monitored, so deposits sent there would not be detected.
    // Redirect every tap to the session flow. (History is preserved in the
    // DB; the address still custodies funds — it is simply no longer a
    // deposit endpoint.)
    await ctx.answerCbQuery('Personal deposit addresses are retired — use a new deposit session.');
    const asset = (ctx as any).match[1] as string;
    const { setUserSession } = await import('../../services/redis');
    await setUserSession(ctx.from!.id.toString(), { state: 'deposit_amount', asset });
    await editMainMessage(
      ctx,
      `${e('deposit')} <b>NEW ${asset} DEPOSIT</b>\n\n` +
      `Personal deposit addresses are <b>no longer used</b>.\n\n` +
      `Enter the amount you want to deposit (in ${asset}):\n\n` +
      `${e('edit')} Example: <code>10</code>`,
      backKeyboard('account:deposits')
    );
  }));

  bot.action(/wallet:copy:(BNB|USDT)/, guard(async (ctx: Context) => {
    const from = ctx.from!;
    const user = await prisma.user.findUnique({
      where: { telegramId: from.id.toString() },
      include: { wallet: true },
    });
    if (user?.wallet) {
      await ctx.answerCbQuery('Address copied! Paste it in your wallet app.', { show_alert: true });
    } else {
      await ctx.answerCbQuery('No wallet found. Send /start first.', { show_alert: true });
    }
  }));

  bot.action(/wallet:check:(BNB|USDT)/, guard(async (ctx: Context) => {
    await ctx.answerCbQuery('Checking deposits... This may take a moment.');
    await renderWallet(ctx);
  }));

  bot.action('wallet:history', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    await renderHistory(ctx);
  }));

  // === GIVEAWAY ===
  bot.action('giveaway', guard(async (ctx: Context) => {
    if (!config.ENABLE_GIVEAWAYS) {
      await ctx.answerCbQuery('Giveaways are temporarily disabled.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    await editMainMessage(
      ctx,
      `${e('gift')} <b>CREATE GIVEAWAY</b>\n\nChoose your giveaway type.`,
      giveawayTypeKeyboard
    );
  }));

  bot.action('giveaway:single', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const from = ctx.from!;
    await setUserSession(from.id.toString(), { state: 'giveaway_single_asset' });
    await editMainMessage(
      ctx,
      `${e('gift')} <b>SINGLE CLAIM GIVEAWAY</b>\n\n` +
      `One lucky user will receive the full amount.\n\n` +
      `First, select the asset:`,
      assetKeyboard('gws', 'giveaway')
    );
  }));

  bot.action('giveaway:multiple', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const from = ctx.from!;
    await setUserSession(from.id.toString(), { state: 'giveaway_multi_asset' });
    await editMainMessage(
      ctx,
      `${e('gift')} <b>MULTIPLE CLAIM GIVEAWAY</b>\n\n` +
      `The total amount is split between all claimers.\n\n` +
      `First, select the asset:`,
      assetKeyboard('gwm', 'giveaway')
    );
  }));

  bot.action(/gws:(BNB|USDT)/, guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const asset = (ctx as any).match[1] as string;
    const from = ctx.from!;
    await setUserSession(from.id.toString(), { state: 'giveaway_single_amount', asset });
    await editMainMessage(
      ctx,
      `${e('gift')} <b>SINGLE CLAIM GIVEAWAY</b>\n\n` +
      `Asset: <b>${asset}</b>\n\n` +
      `Enter the total amount to give away.\n\n` +
      `Example: <code>10</code>`,
      backKeyboard('giveaway')
    );
  }));

  bot.action(/gwm:(BNB|USDT)/, guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const asset = (ctx as any).match[1] as string;
    const from = ctx.from!;
    await setUserSession(from.id.toString(), { state: 'giveaway_multi_amount', asset });
    await editMainMessage(
      ctx,
      `${e('gift')} <b>MULTIPLE CLAIM GIVEAWAY</b>\n\n` +
      `Asset: <b>${asset}</b>\n\n` +
      `Enter the total amount to distribute.\n\n` +
      `Example: <code>10</code>`,
      backKeyboard('giveaway')
    );
  }));

  // === MY GIVEAWAYS ===
  bot.action('giveaway:mine', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const from = ctx.from!;
    const user = await prisma.user.findUnique({ where: { telegramId: from.id.toString() } });
    if (!user) return;
    await renderMyGiveaways(ctx, user.id);
  }));

  bot.action(/giveaway:cancel:(.+)/, guard(async (ctx: Context) => {
    const giveawayId = (ctx as any).match[1];
    const from = ctx.from!;
    const user = await prisma.user.findUnique({ where: { telegramId: from.id.toString() } });
    if (!user) return;

    const result = await giveawayService.cancelGiveaway(giveawayId, user.id);
    await ctx.answerCbQuery(
      result.success ? 'Giveaway cancelled. Funds returned.' : result.reason!,
      { show_alert: !result.success }
    );
    if (result.success) {
      await renderMyGiveaways(ctx, user.id);
    }
  }));
    // === GIVEAWAY STATISTICS ===
  bot.action(/giveaway:stats:(.+)/, guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const giveawayId = (ctx as any).match[1];
    const stats = await giveawayService.getGiveawayStats(giveawayId);

    const text = [
      `${e('chart')} <b>GIVEAWAY STATISTICS</b>`,
      `${e('sparkle')}━━━━━━━━━━━━━━━━━${e('sparkle')}`,
      '',
      `${e('gift')} <b>Total Reward</b>          <code>${stats.totalReward}</code>`,
      `${e('target')} <b>Total Slots</b>            <code>${stats.totalSlots}</code>`,
      `${e('link')} <b>Link Opens</b>           <code>${stats.linkOpens}</code>`,
      `${e('people')} <b>Claim Attempts</b>       <code>${stats.claimAttempts}</code>`,
      `${e('party')} <b>Spots Secured</b>        <code>${stats.spotsSecured}</code>`,
      `${e('check')} <b>Payouts Completed</b>    <code>${stats.payoutsCompleted}</code>`,
      `${e('clock')} <b>Remaining Slots</b>      <code>${stats.remainingSlots}</code>`,
      '',
      stats.remainingSlots === 0
        ? `${e('fire')} <b>ALL SLOTS FILLED</b>`
        : stats.payoutsCompleted > 0
          ? `${e('rocket')} <b>Payouts in progress…</b>`
          : `${e('lightning')} <b>GIVEAWAY LIVE</b>`,
    ].join('\n');

    await editMainMessage(ctx, text, backKeyboard('giveaway:mine'));
  }));

  // === HISTORY ===
  bot.action('history', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    await renderHistory(ctx);
  }));

  // === ACCOUNT ===
  bot.action('account', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const from = ctx.from!;
    const user = await prisma.user.findUnique({
      where: { telegramId: from.id.toString() },
      include: { wallet: true },
    });

    if (!user) return;

    const stats = await prisma.transaction.groupBy({
      by: ['type'],
      where: { userId: user.id, status: 'CONFIRMED' },
      _sum: { amount: true },
      _count: { id: true },
    });

    const totalDeposited = Number(stats.find((s) => s.type === 'DEPOSIT')?._sum.amount || 0);
    const totalGiveaways = Number(stats.find((s) => s.type === 'GIVEAWAY_CREATED')?._sum.amount || 0);
    const totalRewards = Number(stats.find((s) => s.type === 'GIVEAWAY_REWARD')?._sum.amount || 0);

    const caption = [
      `${e('person')} <b>MY ACCOUNT</b>`,
      '',
      `<b>Name:</b> ${user.firstName || 'N/A'}`,
      `<b>Username:</b> ${user.username ? '@' + user.username : 'N/A'}`,
      `<b>Joined:</b> ${user.joinDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`,
      `<b>Wallet:</b> <code>${formatAddress(user.wallet?.address || 'N/A')}</code>`,
      `<b>Status:</b> 🟢 Active`,
      '',
      `${e('chart')} <b>Statistics</b>`,
      `Total Deposited: ${totalDeposited}`,
      `Total Giveaways: ${totalGiveaways}`,
      `Total Rewards: ${totalRewards}`,
    ].join('\n');

    // UPGRADE: Rewards + Deposits dashboard entries (spec §29/§30).
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(`${eb('star')} Rewards`, 'account:rewards')],
      [Markup.button.callback(`${eb('deposit')} Deposits`, 'account:deposits')],
      [Markup.button.callback(`${eb('document')} History`, 'wallet:history')],
      [Markup.button.callback(`${eb('back')} Back`, 'main')],
    ]);

    await editMainMessage(ctx, caption, keyboard);
  }));

  // === HELP ===
  bot.action('help', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    await editMainMessage(
      ctx,
      `${e('help')} <b>HELP CENTER</b>\n\n` +
      `<b>Getting Started</b>\n` +
      `• Your wallet is created automatically when you start the bot.\n` +
      `• Deposit BNB or USDT (BEP20) to your wallet address.\n` +
      `• Create giveaways to share crypto with your community.\n\n` +
      `<b>Deposits</b>\n` +
      `• Only send BEP20 tokens to your deposit address.\n` +
      `• Deposits require blockchain confirmations.\n\n` +
      `<b>Giveaways</b>\n` +
      `• Create single or multiple claim giveaways.\n` +
      `• A ${config.PLATFORM_FEE_PERCENT}% platform fee + network gas applies at creation.\n` +
      `• Funds are locked until claimed or cancelled.\n\n` +
      `<b>Support</b>\n` +
      `For assistance, join https`,
      backKeyboard('main')
    );
  }));

  // === CONFIRM/CREATE GIVEAWAY ===
  bot.action(/giveaway:confirm:(.+)/, guard(async (ctx: Context) => {
    const sessionData = (ctx as any).match[1];
    const [type, asset, amountStr, claimersStr, expiryHours] = sessionData.split('|');
    const from = ctx.from!;

    const user = await prisma.user.findUnique({ where: { telegramId: from.id.toString() } });
    if (!user) return;

    const amount = parseFloat(amountStr);
    const maxClaimers = parseInt(claimersStr, 10);

    if (!(amount > 0) || !(maxClaimers >= 1)) {
      await ctx.answerCbQuery('Invalid giveaway parameters.', { show_alert: true });
      return;
    }

    try {
      const { giveawayId, secureCode } = await giveawayService.createGiveaway({
        creatorId: user.id,
        asset: asset as any,
        totalAmount: amount,
        maxClaimers,
        expiresAt: expiryHours ? new Date(Date.now() + parseInt(expiryHours, 10) * 3600000) : undefined,
      });

      const amountPerUser = amount / maxClaimers;

      // Share URL opens Telegram's chat picker — the recipient gets the link
      // as a normal message, so tapping it opens the bot FRESH and the
      // ?start= payload is actually delivered.
      const claimUrl = `https://t.me/${BOT_USERNAME}?start=giveaway_${secureCode}`;
      const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(claimUrl)}&text=${encodeURIComponent(`🎁 Giveaway: ${amount} ${asset} on VEYLO — tap to claim!`)}`;

      await editMainMessage(
        ctx,
        formatGiveawayCreatedMessage(asset, amount, maxClaimers, amountPerUser, secureCode),
        Markup.inlineKeyboard([
          [Markup.button.url(`${eb('gift')} Share Giveaway`, shareUrl)],
          [Markup.button.callback(`${eb('copy')} Copy Link`, `giveaway:copy:${secureCode}`)],
          [Markup.button.callback(`${eb('chart')} View Stats`, `giveaway:stats:${giveawayId}`)],
          [Markup.button.callback(`${eb('cancel')} Cancel Giveaway`, `giveaway:cancel:${giveawayId}`)],
          [Markup.button.callback(`${eb('back')} My Giveaways`, 'giveaway:mine')],
        ])
      );
      await ctx.answerCbQuery('Giveaway created!');
    } catch (err) {
      logger.error('Giveaway creation error:', err);
      await ctx.answerCbQuery((err as Error).message.slice(0, 180), { show_alert: true });
    }
  }));

  bot.action(/giveaway:copy:(.+)/, guard(async (ctx: Context) => {
    const code = (ctx as any).match[1];
    const link = `https://t.me/${BOT_USERNAME}?start=giveaway_${code}`;
    await ctx.answerCbQuery(`Link: ${link}`, { show_alert: true });
  }));
                              }
        
