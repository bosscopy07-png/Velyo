import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { prisma } from '../../database';
import { walletService } from '../../services/wallet';
import { giveawayService } from '../../services/giveaway';
import { pricing } from '../../services/pricing';
import { setUserSession, getUserSession, clearUserSession } from '../../services/redis';
import { blockchain } from '../../services/blockchain';
import { config, ASSETS, GIVEAWAY_EXPIRY_OPTIONS } from '../../config';
import { e } from '../../utils/emoji';
import { logger } from '../../utils/logger';
import { formatWalletMessage, formatDepositMessage, formatGiveawayCreatedMessage, formatAccountMessage } from '../messages';
import { mainKeyboard, walletKeyboard, depositKeyboard, giveawayTypeKeyboard, backKeyboard, confirmCancelKeyboard, assetKeyboard } from '../keyboards/main';
import { isValidEVMAddress, normalizeAddress, formatAddress, isValidAmount } from '../../utils/validation';
import { queuePayout } from '../../queues';
import { hashIdempotencyKey } from '../../utils/encryption';

const VEYLO_IMAGE = 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1788789976/file_00000000d1ec81f4adfb8b48d09eb39d_k1fwyl.png';

// Helper to update main message
async function updateMainMessage(ctx: Context, caption: string, keyboard?: any): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const user = await prisma.user.findUnique({ where: { telegramId: from.id.toString() } });
  if (!user?.chatId || !user?.mainMessageId) {
    await ctx.answerCbQuery();
    return;
  }

  try {
    await ctx.telegram.editMessageCaption(
      parseInt(user.chatId),
      parseInt(user.mainMessageId),
      undefined,
      caption,
      { parse_mode: 'HTML', reply_markup: keyboard?.reply_markup }
    );
  } catch (err) {
    // If edit fails, try editMessageMedia for image+text updates
    try {
      await ctx.telegram.editMessageMedia(
        parseInt(user.chatId),
        parseInt(user.mainMessageId),
        undefined,
        { type: 'photo', media: VEYLO_IMAGE, caption, parse_mode: 'HTML' },
        { reply_markup: keyboard?.reply_markup }
      );
    } catch {
      logger.error('Failed to update main message');
    }
  }
  await ctx.answerCbQuery();
}

export function registerCallbacks(bot: any): void {
  
  // === MAIN NAVIGATION ===
  bot.action('main', async (ctx: Context) => {
    const from = ctx.from!;
    const user = await prisma.user.findUnique({ where: { telegramId: from.id.toString() } });
    await updateMainMessage(
      ctx,
      `${e('lightning')} <b>Welcome to VEYLO</b>\n\n` +
      `Your crypto wallet built for speed.\n\n` +
      `Manage your assets, receive payments, create giveaways, and earn with simple Telegram tools.\n\n` +
      `Fast. Simple. Secure.`,
      mainKeyboard
    );
  });

  // === WALLET ===
  bot.action('wallet', async (ctx: Context) => {
    const from = ctx.from!;
    const user = await prisma.user.findUnique({
      where: { telegramId: from.id.toString() },
      include: { balances: true, wallet: true },
    });

    if (!user) return;

    const balances = user.balances.map(b => ({
      asset: b.asset,
      available: Number(b.availableBalance),
      locked: Number(b.lockedBalance),
    }));

    const caption = await formatWalletMessage(balances);
    await updateMainMessage(ctx, caption, walletKeyboard);
  });

  bot.action('wallet:refresh', async (ctx: Context) => {
    await ctx.answerCbQuery('Refreshing...');
    await bot.handle('wallet')!(ctx);
  });

  // === DEPOSIT ===
  bot.action('wallet:deposit', async (ctx: Context) => {
    await updateMainMessage(
      ctx,
      `${e('deposit')} <b>SELECT ASSET TO DEPOSIT</b>\n\nChoose which asset you want to deposit.`,
      assetKeyboard('deposit')
    );
  });

  bot.action(/deposit:(BNB|USDT)/, async (ctx: Context) => {
    const asset = (ctx as any).match[1] as string;
    const from = ctx.from!;
    const user = await prisma.user.findUnique({
      where: { telegramId: from.id.toString() },
      include: { wallet: true },
    });

    if (!user?.wallet) return;

    await updateMainMessage(
      ctx,
      formatDepositMessage(asset, user.wallet.address),
      depositKeyboard(asset)
    );
  });

  bot.action(/wallet:copy:(BNB|USDT)/, async (ctx: Context) => {
    const from = ctx.from!;
    const user = await prisma.user.findUnique({
      where: { telegramId: from.id.toString() },
      include: { wallet: true },
    });
    if (user?.wallet) {
      await ctx.answerCbQuery('Address copied! Paste it in your wallet app.', { show_alert: true });
    }
  });

  bot.action(/wallet:check:(BNB|USDT)/, async (ctx: Context) => {
    await ctx.answerCbQuery('Checking deposits... This may take a moment.');
    // Deposit monitor runs automatically; just refresh balance
    await bot.handle('wallet')!(ctx);
  });

  // === SEND (Basic placeholder for future expansion) ===
  bot.action('wallet:send', async (ctx: Context) => {
    await ctx.answerCbQuery('Send feature coming soon! Use giveaways for now.', { show_alert: true });
  });

  bot.action('wallet:history', async (ctx: Context) => {
    const from = ctx.from!;
    const txs = await prisma.transaction.findMany({
      where: { userId: (await prisma.user.findUnique({ where: { telegramId: from.id.toString() } }))!.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    let text = `${e('document')} <b>RECENT ACTIVITY</b>\n\n`;
    if (txs.length === 0) text += 'No transactions yet.';
    
    for (const tx of txs) {
      const sign = ['DEPOSIT', 'GIVEAWAY_REWARD', 'CODE_REDEMPTION', 'REFUND'].includes(tx.type) ? '+' : '-';
      text += `${sign}${tx.amount} ${tx.asset} — ${tx.status}\n`;
    }

    await updateMainMessage(ctx, text, backKeyboard('wallet'));
  });

  // === GIVEAWAY ===
  bot.action('giveaway', async (ctx: Context) => {
    if (!config.ENABLE_GIVEAWAYS) {
      await ctx.answerCbQuery('Giveaways are temporarily disabled.', { show_alert: true });
      return;
    }
    await updateMainMessage(
      ctx,
      `${e('gift')} <b>CREATE GIVEAWAY</b>\n\nChoose your giveaway type.`,
      giveawayTypeKeyboard
    );
  });

  // Single Claim
  bot.action('giveaway:single', async (ctx: Context) => {
    const from = ctx.from!;
    await setUserSession(from.id.toString(), { state: 'giveaway_single_amount' });
    await updateMainMessage(
      ctx,
      `${e('gift')} <b>SINGLE CLAIM GIVEAWAY</b>\n\n` +
      `Enter the total amount to give away.\n\n` +
      `Example: <code>10 USDT</code>\n\n` +
      `One lucky user will receive the full amount.`,
      backKeyboard('giveaway')
    );
  });

  // Multiple Claim
  bot.action('giveaway:multiple', async (ctx: Context) => {
    const from = ctx.from!;
    await setUserSession(from.id.toString(), { state: 'giveaway_multi_amount' });
    await updateMainMessage(
      ctx,
      `${e('gift')} <b>MULTIPLE CLAIM GIVEAWAY</b>\n\n` +
      `Enter the total amount to distribute.\n\n` +
      `Example: <code>10 USDT</code>`,
      backKeyboard('giveaway')
    );
  });

  // My Giveaways
  bot.action('giveaway:mine', async (ctx: Context) => {
    const from = ctx.from!;
    const user = await prisma.user.findUnique({ where: { telegramId: from.id.toString() } });
    if (!user) return;

    const giveaways = await prisma.giveaway.findMany({
      where: { creatorId: user.id },
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

    await updateMainMessage(ctx, text, backKeyboard('giveaway'));
  });

  // Cancel Giveaway
  bot.action(/giveaway:cancel:(.+)/, async (ctx: Context) => {
    const giveawayId = (ctx as any).match[1];
    const from = ctx.from!;
    const user = await prisma.user.findUnique({ where: { telegramId: from.id.toString() } });
    if (!user) return;

    const result = await giveawayService.cancelGiveaway(giveawayId, user.id);
    await ctx.answerCbQuery(result.success ? 'Giveaway cancelled. Funds returned.' : result.reason, { show_alert: !result.success });
    if (result.success) await bot.handle('giveaway:mine')!(ctx);
  });

  // Giveaway Stats
  bot.action(/giveaway:stats:(.+)/, async (ctx: Context) => {
    const giveawayId = (ctx as any).match[1];
    const stats = await giveawayService.getGiveawayStats(giveawayId);
    
    const text = [
      `${e('chart')} <b>GIVEAWAY STATISTICS</b>`,
      '',
      `<b>Total Reward:</b> ${stats.totalReward}`,
      `<b>Total Slots:</b> ${stats.totalSlots}`,
      `<b>Link Opens:</b> ${stats.linkOpens}`,
      `<b>Claim Attempts:</b> ${stats.claimAttempts}`,
      `<b>Spots Secured:</b> ${stats.spotsSecured}`,
      `<b>Payouts Completed:</b> ${stats.payoutsCompleted}`,
      `<b>Remaining Slots:</b> ${stats.remainingSlots}`,
    ].join('\n');

    await updateMainMessage(ctx, text, backKeyboard('giveaway:mine'));
  });

  // === REDEEM CODE ===
  bot.action('redeem', async (ctx: Context) => {
    const from = ctx.from!;
    await setUserSession(from.id.toString(), { state: 'redeem_code' });
    await updateMainMessage(
      ctx,
      `${e('diamond')} <b>REDEEM CODE</b>\n\nEnter your redeem code.\n\nExample: <code>VEYLO2026</code>`,
      backKeyboard('main')
    );
  });

  // === HISTORY ===
  bot.action('history', async (ctx: Context) => {
    await bot.handle('wallet:history')!(ctx);
  });

  // === ACCOUNT ===
  bot.action('account', async (ctx: Context) => {
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

    const totalDeposited = stats.find(s => s.type === 'DEPOSIT')?._sum.amount || 0;
    const totalGiveaways = stats.find(s => s.type === 'GIVEAWAY_CREATED')?._sum.amount || 0;
    const totalRewards = stats.find(s => s.type === 'GIVEAWAY_REWARD')?._sum.amount || 0;

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

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(`${e('shield')} Security`, 'account:security'),
        Markup.button.callback(`${e('document')} History`, 'wallet:history'),
      ],
      [Markup.button.callback(`${e('back')} Back`, 'main')],
    ]);

    await updateMainMessage(ctx, caption, keyboard);
  });

  bot.action('account:security', async (ctx: Context) => {
    await updateMainMessage(
      ctx,
      `${e('shield')} <b>SECURITY</b>\n\n` +
      `🔒 Your private keys are encrypted at rest.\n` +
      `🛡 Two-factor authentication coming soon.\n` +
      `🔑 PIN protection coming soon.\n\n` +
      `Your funds are secured with industry-standard encryption.`,
      backKeyboard('account')
    );
  });

  // === HELP ===
  bot.action('help', async (ctx: Context) => {
    await updateMainMessage(
      ctx,
      `${e('help')} <b>HELP CENTER</b>\n\n` +
      `<b>Getting Started</b>\n` +
      `• Your wallet is created automatically when you start the bot.\n` +
      `• Deposit BNB or USDT (BEP20) to your wallet address.\n` +
      `• Create giveaways to share crypto with your community.\n\n` +
      `<b>Deposits</b>\n` +
      `• Only send BEP20 tokens to your deposit address.\n` +
      `• Deposits require blockchain confirmations.\n` +
      `• A 1% platform fee applies to deposits.\n\n` +
      `<b>Giveaways</b>\n` +
      `• Create single or multiple claim giveaways.\n` +
      `• Funds are locked until claimed or cancelled.\n` +
      `• Claim links are unique and secure.\n\n` +
      `<b>Support</b>\n` +
      `For assistance, contact @VeyloSupport`,
      backKeyboard('main')
    );
  });

  // === CONFIRM/CREATE GIVEAWAY CALLBACKS ===
  bot.action(/giveaway:confirm:(.+)/, async (ctx: Context) => {
    const sessionData = (ctx as any).match[1];
    const [type, asset, amountStr, claimersStr, expiryHours] = sessionData.split('|');
    const from = ctx.from!;
    
    const user = await prisma.user.findUnique({ where: { telegramId: from.id.toString() } });
    if (!user) return;

    const amount = parseFloat(amountStr);
    const maxClaimers = parseInt(claimersStr);

    try {
      const { secureCode } = await giveawayService.createGiveaway({
        creatorId: user.id,
        asset: asset as any,
        totalAmount: amount,
        maxClaimers,
        expiresAt: expiryHours ? new Date(Date.now() + parseInt(expiryHours) * 3600000) : undefined,
      });

      const amountPerUser = amount / maxClaimers;

      await updateMainMessage(
        ctx,
        formatGiveawayCreatedMessage(asset, amount, maxClaimers, amountPerUser, secureCode),
        Markup.inlineKeyboard([
          [Markup.button.callback(`${e('copy')} Copy Link`, `giveaway:copy:${secureCode}`)],
          [Markup.button.callback(`${e('chart')} View Stats`, `giveaway:stats:${secureCode}`)],
          [Markup.button.callback(`${e('cancel')} Cancel Giveaway`, `giveaway:cancel:${secureCode}`)],
          [Markup.button.callback(`${e('back')} My Giveaways`, 'giveaway:mine')],
        ])
      );
    } catch (err) {
      logger.error('Giveaway creation error:', err);
      await ctx.answerCbQuery((err as Error).message, { show_alert: true });
    }
  });

  bot.action(/giveaway:copy:(.+)/, async (ctx: Context) => {
    const code = (ctx as any).match[1];
    const link = `https://t.me/${config.BOT_USERNAME}?start=giveaway_${code}`;
    await ctx.answerCbQuery(`Link: ${link}`, { show_alert: true });
  });
  }
      
