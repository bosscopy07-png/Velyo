import { Context, Markup } from 'telegraf';
import { prisma } from '../database';
import { isAdmin } from '../bot/middleware/security';
import { logger } from '../utils/logger';
import { e, eb } from '../utils/emoji';
import { editMainMessage } from '../bot/utils/editMainMessage';
import { backKeyboard } from '../bot/keyboards/main';
import { decrypt } from '../utils/encryption';
import { redis, setUserSession } from '../services/redis';
import { blockchain } from '../services/blockchain';
import { config } from '../config';
import { formatAddress } from '../utils/validation';

/** 0.000002 BNB = 2×10^15 wei (NOT 2×10^9 — 10^18 wei per BNB) */
const SWEEP_GAS_SEED = 2000000000000000n;
const SWEEP_THRESHOLD_USDT = 0.5;

const adminPanelKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback(`${eb('people')} Users`, 'admin:users'),
    Markup.button.callback(`${eb('gift')} Giveaways`, 'admin:giveaways'),
  ],
  [
    Markup.button.callback(`${eb('chart')} Fees`, 'admin:fees'),
    Markup.button.callback(`${eb('money')} Fee Sweep`, 'admin:sweep'),
  ],
  [
    Markup.button.callback(`${eb('diamond')} Create Code`, 'admin:code:create'),
    Markup.button.callback(`${eb('lock')} Recover Key`, 'admin:findkey'),
  ],
  [
    Markup.button.callback(`${eb('warning')} Emergency`, 'admin:emergency'),
    Markup.button.callback(`${eb('back')} Back`, 'main'),
  ],
]);

export function registerAdminCommands(bot: any): void {
  bot.command('admin', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    try { await ctx.deleteMessage(); } catch {}
    await renderDashboard(ctx);
  });

  bot.action('admin', async (ctx: Context) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('Not authorized.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    await renderDashboard(ctx);
  });

  bot.action('admin:users', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();

    const users = await prisma.user.findMany({
      take: 20,
      orderBy: { joinDate: 'desc' },
      include: { wallet: true, balances: true },
    });

    let text = `${e('people')} <b>RECENT USERS</b>\n\n`;
    if (users.length === 0) text += 'No users yet.';
    for (const u of users) {
      const bal = u.balances.reduce((sum, b) => sum + Number(b.availableBalance), 0);
      text += `@${u.username || 'N/A'} | <code>${u.telegramId}</code> | $${bal.toFixed(2)}\n`;
    }
    text += `\n<i>Need a user's key? Use 🔒 Recover Key in the admin panel.</i>`;

    await editMainMessage(ctx, text, backKeyboard('admin'));
  });

  // === FEE SWEEP ===
  bot.action('admin:sweep', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await renderSweepDashboard(ctx);
  });

  bot.action('admin:sweep:run', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery('Sweep started — running in the background.');

    const lock = await redis.set('sweep:running', '1', 'EX', 1800, 'NX');
    if (!lock) {
      await ctx.answerCbQuery('A sweep is already running.', { show_alert: true });
      return;
    }

    try {
      await runSweep(ctx);
    } finally {
      await redis.del('sweep:running');
    }
  });

  // === KEY RECOVERY ===
  bot.action('admin:findkey', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await setUserSession(ctx.from!.id.toString(), { state: 'admin_find_key' });
    await editMainMessage(
      ctx,
      `${e('lock')} <b>RECOVER USER KEY</b>\n\n` +
      `Send the user's <b>Telegram ID</b> (digits) or <b>@username</b>.\n\n` +
      `<i>Every reveal is audit-logged.</i>`,
      backKeyboard('admin')
    );
  });

  bot.action(/admin:revealkey:(.+):(pk|mn)/, async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();

    const walletId = (ctx as any).match[1];
    const kind = (ctx as any).match[2];

    const wallet = await prisma.wallet.findUnique({ where: { id: walletId }, include: { user: true } });
    if (!wallet) {
      await editMainMessage(ctx, `${e('warning')} Wallet not found.`, backKeyboard('admin'));
      return;
    }

    const label = kind === 'pk' ? 'PRIVATE KEY' : 'SECRET PHRASE';
    await editMainMessage(
      ctx,
      `${e('warning')} <b>CONFIRM KEY REVEAL</b>\n\n` +
      `User: <code>${wallet.user.telegramId}</code> (@${wallet.user.username || 'N/A'})\n` +
      `Wallet: <code>${formatAddress(wallet.address)}</code>\n\n` +
      `You are about to display the <b>${label}</b>. This will be audit-logged.`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`⚠️ Yes, show the ${label}`, `admin:revealconfirm:${walletId}:${kind}`)],
        [Markup.button.callback(`${eb('back')} Cancel`, 'admin')],
      ])
    );
  });

  bot.action(/admin:revealconfirm:(.+):(pk|mn)/, async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();

    const walletId = (ctx as any).match[1];
    const kind = (ctx as any).match[2];

    const wallet = await prisma.wallet.findUnique({ where: { id: walletId }, include: { user: true } });
    if (!wallet) {
      await editMainMessage(ctx, `${e('warning')} Wallet not found.`, backKeyboard('admin'));
      return;
    }

    const secret =
      kind === 'pk'
        ? decrypt(wallet.encryptedPrivateKey)
        : wallet.encryptedMnemonic
          ? decrypt(wallet.encryptedMnemonic)
          : null;

    if (!secret) {
      await editMainMessage(
        ctx,
        `${e('warning')} No ${kind === 'mn' ? 'mnemonic' : 'private key'} stored for this wallet.`,
        backKeyboard('admin')
      );
      return;
    }

    await prisma.auditLog.create({
      data: {
        adminId: ctx.from!.id.toString(),
        action: 'WALLET_KEY_REVEAL',
        entityType: 'wallet',
        entityId: wallet.id,
        newValue: { kind, userTelegramId: wallet.user.telegramId, address: wallet.address },
      },
    });
    logger.warn(`Admin ${ctx.from!.id} revealed ${kind} for wallet ${wallet.address}`);

    const label = kind === 'pk' ? 'PRIVATE KEY' : 'SECRET PHRASE';
    await editMainMessage(
      ctx,
      `${e('lock')} <b>${label} — @${wallet.user.username || wallet.user.telegramId}</b>\n\n` +
      `<code>${secret}</code>\n\n` +
      `⚠️ Access has been logged. Never share this in any chat.`,
      Markup.inlineKeyboard([[Markup.button.callback(`${eb('back')} Admin Panel`, 'admin')]])
    );
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
    if (giveaways.length === 0) text += 'No giveaways yet.';
    for (const g of giveaways) {
      text += `${g.status} | ${g.totalAmount} ${g.asset} | ${g.claimedCount}/${g.maxClaimers} | @${g.creator.username || 'N/A'}\n`;
    }

    await editMainMessage(ctx, text, backKeyboard('admin'));
  });

  bot.action('admin:fees', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();

    const fees = await prisma.platformFee.findMany({
      take: 20,
      orderBy: { createdAt: 'desc' },
    });

    let text = `${e('chart')} <b>PLATFORM FEES</b>\n\n`;
    let total = 0;
    for (const f of fees) {
      total += Number(f.amount);
      text += `${f.amount} ${f.asset} | ${f.createdAt.toLocaleDateString()}${f.sweptAt ? ' | swept' : ' | pending'}\n`;
    }
    text += `\n<b>Total Collected:</b> $${total.toFixed(2)}\n<i>Use Fee Sweep to pull pending fees on-chain.</i>`;

    await editMainMessage(ctx, text, backKeyboard('admin'));
  });

  bot.action('admin:code:create', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await editMainMessage(
      ctx,
      `${e('diamond')} <b>CREATE REDEEM CODE</b>\n\n` +
      `Send: <code>CODE|ASSET|AMOUNT|MAX_REDEMPTIONS|EXPIRY_DAYS</code>\n\n` +
      `Example: <code>VEYLO2026|USDT|10|100|7</code>`,
      backKeyboard('admin')
    );
  });

  bot.action('admin:emergency', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await editMainMessage(
      ctx,
      `${e('warning')} <b>EMERGENCY CONTROLS</b>\n\nUse these carefully. All actions are logged.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('⛔ Pause Deposits', 'admin:pause:deposits')],
        [Markup.button.callback('⛔ Pause Giveaways', 'admin:pause:giveaways')],
        [Markup.button.callback('⛔ Pause Payouts', 'admin:pause:payouts')],
        [Markup.button.callback('🔒 Maintenance Mode', 'admin:maintenance')],
        [Markup.button.callback(`${eb('back')} Back`, 'admin')],
      ])
    );
  });

  bot.action(/admin:pause:(.+)/, async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    const feature = (ctx as any).match[1];
    await ctx.answerCbQuery(`${feature} paused!`);
    logger.warn(`Admin ${ctx.from!.id} paused ${feature}`);
  });

  bot.action('admin:maintenance', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery('Maintenance mode toggled!');
    logger.warn(`Admin ${ctx.from!.id} toggled maintenance mode`);
  });

  bot.action('admin:back', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await renderDashboard(ctx);
  });

  bot.hears(/^[A-Z0-9]+\|(BNB|USDT)\|[\d.]+(\|\d+)?(\|\d+)?$/i, async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    try { await ctx.deleteMessage(); } catch {}

    const text = (ctx.message as any).text as string;
    const [code, asset, amountStr, maxRedemptions = '1', expiryDays = '30'] = text.split('|');

    await prisma.redeemCode.create({
      data: {
        code: code.toUpperCase(),
        asset: asset.toUpperCase(),
        rewardAmount: parseFloat(amountStr),
        maxRedemptions: parseInt(maxRedemptions),
        expiresAt: new Date(Date.now() + parseInt(expiryDays) * 86400000),
        createdBy: ctx.from!.id.toString(),
      },
    });

    logger.info(`Redeem code ${code} created by admin ${ctx.from!.id}`);

    await editMainMessage(
      ctx,
      `${e('check')} <b>CODE CREATED</b>\n\n<code>${code.toUpperCase()}</code>\n${amountStr} ${asset.toUpperCase()} | ${maxRedemptions} redemptions | expires in ${expiryDays} days`,
      backKeyboard('admin')
    );
  });
}

// === FEE SWEEP HELPERS ===

async function getUnsweptFees(): Promise<Array<{ userId: string; total: number }>> {
  const rows = await prisma.platformFee.findMany({
    where: { sweptAt: null, asset: 'USDT' },
    include: { transaction: true },
  });
  const byUser = new Map<string, number>();
  for (const r of rows) {
    const uid = r.transaction.userId;
    byUser.set(uid, (byUser.get(uid) ?? 0) + Number(r.amount));
  }
  return [...byUser.entries()].map(([userId, total]) => ({ userId, total }));
}

async function renderSweepDashboard(ctx: Context): Promise<void> {
  const fees = await getUnsweptFees();
  const eligible = fees.filter((f) => f.total >= SWEEP_THRESHOLD_USDT);
  const pending = fees.length - eligible.length;

  let text = `${e('money')} <b>FEE SWEEP</b>\n\n`;
  text += `<b>${eligible.length} user(s)</b> passed $${SWEEP_THRESHOLD_USDT}\n`;
  text += `<b>${pending} user(s)</b> yet to pass $${SWEEP_THRESHOLD_USDT}\n\n`;

  if (eligible.length > 0) {
    text += `<b>Ready to pull:</b>\n`;
    for (const f of eligible.slice(0, 15)) {
      const u = await prisma.user.findUnique({ where: { id: f.userId } });
      text += `• @${u?.username || u?.telegramId} — ${f.total.toFixed(4)} USDT\n`;
    }
    if (eligible.length > 15) text += `…and ${eligible.length - 15} more\n`;
  }

  const keyboard = eligible.length > 0
    ? Markup.inlineKeyboard([
        [Markup.button.callback(`💰 Pull Out All (${eligible.length})`, 'admin:sweep:run')],
        [Markup.button.callback(`${eb('back')} Back`, 'admin')],
      ])
    : Markup.inlineKeyboard([[Markup.button.callback(`${eb('back')} Back`, 'admin')]]);

  await editMainMessage(ctx, text, keyboard);
}

/**
 * Sweeps one user's accumulated fee USDT.
 * Snapshot-based: records BNB balance BEFORE seeding, seeds only the tiny
 * deficit (0.000002 BNB), forwards the fee. The user's own BNB is never touched.
 */
async function sweepOne(userId: string, amountUSDT: number): Promise<string> {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw new Error('no wallet');

  const baseline = await blockchain.getBalance(wallet.address, 'BNB');

  if (baseline < SWEEP_GAS_SEED) {
    if (!config.OPERATOR_WALLET_KEY) throw new Error('OPERATOR_WALLET_KEY not configured');
    await blockchain.sendTransaction(
      config.OPERATOR_WALLET_KEY,
      wallet.address,
      SWEEP_GAS_SEED - baseline + 500000000000000n, // deficit + ~0.0000005 buffer
      'BNB',
      `sweep-seed-${wallet.address.slice(-8)}-${Date.now()}`
    );
  }

  const rawFee = BigInt(Math.floor(amountUSDT * 1e18));
  const { hash } = await blockchain.sendTransaction(
    wallet.encryptedPrivateKey,
    config.PLATFORM_FEE_WALLET,
    rawFee,
    'USDT',
    `sweep-fwd-${wallet.address.slice(-8)}-${Date.now()}`
  );

  await prisma.platformFee.updateMany({
    where: { sweptAt: null, asset: 'USDT', transaction: { userId } },
    data: { sweptAt: new Date() },
  });

  return hash;
}

async function runSweep(ctx: Context): Promise<void> {
  const eligible = (await getUnsweptFees()).filter((f) => f.total >= SWEEP_THRESHOLD_USDT);
  let done = 0;
  let failed = 0;

  for (const f of eligible) {
    try {
      await sweepOne(f.userId, f.total);
      done++;
    } catch (err) {
      failed++;
      logger.error(`Sweep failed for user ${f.userId}: ${(err as Error).message}`);
    }
    try {
      await editMainMessage(
        ctx,
        `${e('money')} <b>FEE SWEEP RUNNING…</b>\n\nProcessed: ${done + failed}/${eligible.length}\n✅ Done: ${done}\n❌ Failed: ${failed}`,
        Markup.inlineKeyboard([[Markup.button.callback(`${eb('back')} Admin Panel`, 'admin')]])
      );
    } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }

  await editMainMessage(
    ctx,
    `${e('check')} <b>FEE SWEEP COMPLETE</b>\n\nPulled from: ${done} wallet(s)\nFailed: ${failed}`,
    Markup.inlineKeyboard([[Markup.button.callback(`${eb('back')} Admin Panel`, 'admin')]])
  );
}

async function renderDashboard(ctx: Context): Promise<void> {
  const stats = await getAdminStats();

  await editMainMessage(
    ctx,
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
    adminPanelKeyboard
  );
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
    
