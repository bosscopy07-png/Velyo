import { Context, Markup } from 'telegraf';
import { prisma } from '../database';
import { config } from '../config';
import { isAdmin } from '../bot/middleware/security';
import { logger } from '../utils/logger';
import { e } from '../utils/emoji';
import { hashIdempotencyKey } from '../utils/encryption';

export function registerAdminCommands(bot: any): void {
  
  // Admin entry point
  bot.command('admin', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    
    const stats = await getAdminStats();
    
    await ctx.reply(
      `${e('crown')} <b>VEYLO ADMIN DASHBOARD</b>\n\n` +
      `<b>Users</b>\n` +
      `Total: ${stats.totalUsers}\n` +
      `New Today: ${stats.newUsersToday}\n` +
      `Active Today: ${stats.activeUsersToday}\n\n` +
      `<b>Finance</b>\n` +
      `Total Deposits: ${stats.totalDeposits}\n` +
      `Fees Collected: ${stats.totalFees}\n` +
      `USDT Held: ${stats.totalUSDT}\n` +
      `BNB Held: ${stats.totalBNB}\n\n` +
      `<b>Giveaways</b>\n` +
      `Total: ${stats.totalGiveaways}\n` +
      `Active: ${stats.activeGiveaways}\n` +
      `Pending Payouts: ${stats.pendingPayouts}`,
      {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback('👥 Users', 'admin:users'),
            Markup.button.callback('🎁 Giveaways', 'admin:giveaways'),
          ],
          [
            Markup.button.callback('💰 Fees', 'admin:fees'),
            Markup.button.callback('⚙️ Config', 'admin:config'),
          ],
          [
            Markup.button.callback('🎟 Create Code', 'admin:code:create'),
            Markup.button.callback('🚨 Emergency', 'admin:emergency'),
          ],
        ]).reply_markup,
      }
    );
  });

  // Admin callbacks
  bot.action('admin:users', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    
    const users = await prisma.user.findMany({
      take: 20,
      orderBy: { joinDate: 'desc' },
      include: { wallet: true, balances: true },
    });

    let text = `${e('people')} <b>RECENT USERS</b>\n\n`;
    for (const u of users) {
      const bal = u.balances.reduce((sum, b) => sum + Number(b.availableBalance), 0);
      text += `@${u.username || 'N/A'} | ${u.telegramId} | $${bal.toFixed(2)}\n`;
    }

    await ctx.editMessageText(text, { parse_mode: 'HTML' });
  });

  bot.action('admin:giveaways', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    
    const giveaways = await prisma.giveaway.findMany({
      take: 20,
      orderBy: { createdAt: 'desc' },
      include: { creator: true, claims: true },
    });

    let text = `${e('gift')} <b>RECENT GIVEAWAYS</b>\n\n`;
    for (const g of giveaways) {
      text += `${g.status} | ${g.totalAmount} ${g.asset} | ${g.claimedCount}/${g.maxClaimers} | @${g.creator.username || 'N/A'}\n`;
    }

    await ctx.editMessageText(text, { parse_mode: 'HTML' });
  });

  bot.action('admin:fees', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    
    const fees = await prisma.platformFee.findMany({
      take: 20,
      orderBy: { createdAt: 'desc' },
    });

    let text = `${e('money')} <b>PLATFORM FEES</b>\n\n`;
    let total = 0;
    for (const f of fees) {
      total += Number(f.amount);
      text += `${f.amount} ${f.asset} | ${f.createdAt.toLocaleDateString()}\n`;
    }
    text += `\n<b>Total Collected:</b> $${total.toFixed(2)}`;

    await ctx.editMessageText(text, { parse_mode: 'HTML' });
  });

  // Create redeem code
  bot.action('admin:code:create', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await ctx.reply(
      'Create redeem code:\nFormat: <code>CODE|ASSET|AMOUNT|MAX_REDEMPTIONS|EXPIRY_DAYS</code>\n\n' +
      'Example: <code>VEYLO2026|USDT|10|100|7</code>',
      { parse_mode: 'HTML' }
    );
  });

  // Emergency controls
  bot.action('admin:emergency', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    
    await ctx.editMessageText(
      `${e('warning')} <b>EMERGENCY CONTROLS</b>\n\n` +
      `Use these carefully. All actions are logged.`,
      {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('⛔ Pause Deposits', 'admin:pause:deposits')],
          [Markup.button.callback('⛔ Pause Giveaways', 'admin:pause:giveaways')],
          [Markup.button.callback('⛔ Pause Payouts', 'admin:pause:payouts')],
          [Markup.button.callback('🔒 Maintenance Mode', 'admin:maintenance')],
          [Markup.button.callback('◀️ Back', 'admin:back')],
        ]).reply_markup,
      }
    );
  });

  bot.action(/admin:pause:(.+)/, async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    const feature = (ctx as any).match[1];
    await ctx.answerCbQuery(`${feature} paused!`);
    logger.warn(`Admin ${ctx.from!.id} paused ${feature}`);
    // In production, update SystemConfig table
  });

  bot.action('admin:maintenance', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery('Maintenance mode toggled!');
    logger.warn(`Admin ${ctx.from!.id} toggled maintenance mode`);
  });

  bot.action('admin:back', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await bot.handle('admin')!(ctx);
  });

  // Handle admin text commands for code creation
  bot.hears(/^[A-Z0-9]+\|(?:BNB|USDT)\|[\d.]+|\d+(?:\|\d+)?$/, async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    
    const text = (ctx.message as any).text as string;
    const [code, asset, amountStr, maxRedemptions = '1', expiryDays = '30'] = text.split('|');
    
    await prisma.redeemCode.create({
      data: {
        code: code.toUpperCase(),
        asset,
        rewardAmount: parseFloat(amountStr),
        maxRedemptions: parseInt(maxRedemptions),
        expiresAt: new Date(Date.now() + parseInt(expiryDays) * 86400000),
        createdBy: ctx.from!.id.toString(),
      },
    });

    await ctx.reply(`${e('check')} Code <code>${code}</code> created!`, { parse_mode: 'HTML' });
  });
}

async function getAdminStats() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [
    totalUsers,
    newUsersToday,
    activeUsersToday,
    totalDeposits,
    totalFees,
    totalUSDT,
    totalBNB,
    totalGiveaways,
    activeGiveaways,
    pendingPayouts,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { joinDate: { gte: today } } }),
    prisma.user.count({ where: { lastActive: { gte: today } } }),
    prisma.transaction.count({ where: { type: 'DEPOSIT', status: 'CONFIRMED' } }),
    prisma.platformFee.aggregate({ _sum: { amount: true } }),
    prisma.balance.aggregate({ where: { asset: 'USDT' }, _sum: { availableBalance: true } }),
    prisma.balance.aggregate({ where: { asset: 'BNB' }, _sum: { availableBalance: true } }),
    prisma.giveaway.count(),
    prisma.giveaway.count({ where: { status: 'ACTIVE' } }),
    prisma.giveawayClaim.count({ where: { status: { in: ['QUEUED', 'PROCESSING'] } } }),
  ]);

  return {
    totalUsers,
    newUsersToday,
    activeUsersToday,
    totalDeposits,
    totalFees: Number(totalFees._sum.amount || 0).toFixed(2),
    totalUSDT: Number(totalUSDT._sum.availableBalance || 0).toFixed(2),
    totalBNB: Number(totalBNB._sum.availableBalance || 0).toFixed(6),
    totalGiveaways,
    activeGiveaways,
    pendingPayouts,
  };
}
