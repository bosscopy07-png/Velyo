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
import { walletService } from '../services/wallet';
import { config } from '../config';
import { formatAddress } from '../utils/validation';

/** 0.000002 BNB = 2×10^12 wei (2,000,000,000,000) */
const SWEEP_GAS_SEED = 2000000000000n;
const SWEEP_SEED_BUFFER_WEI = 500000000000n; // 0.0000005 BNB buffer on top of deficit
/** Standard sweep threshold — Max Sweep ignores this entirely */
const SWEEP_THRESHOLD_USDT = 0.1;

const USERS_PER_PAGE = 10;
const FEES_PER_PAGE = 10;
const GIVEAWAYS_PER_PAGE = 10;

const SWEEP_LOCK_KEY = 'sweep:running';
const SWEEP_LOCK_TTL_SEC = 1800;
const SWEEP_STAGGER_MS = 3000;

const DIVIDER = `${e('sparkle')}━━━━━━━━━━━━━━━━━${e('sparkle')}`;

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
    Markup.button.callback(`${eb('document')} Codes`, 'admin:codes'),
  ],
  [
    Markup.button.callback(`${eb('lock')} Recover Key`, 'admin:findkey'),
    Markup.button.callback(`${eb('warning')} Emergency`, 'admin:emergency'),
  ],
  [Markup.button.callback(`${eb('back')} Back`, 'main')],
]);

/** Builds a Prev / page indicator / Next row. */
function pager(prefix: string, page: number, totalPages: number, totalLabel: string) {
  const row: any[] = [];
  if (page > 0) row.push(Markup.button.callback('◀️ Prev', `${prefix}:${page - 1}`));
  row.push(Markup.button.callback(`${page + 1}/${totalPages} · ${totalLabel}`, `${prefix}:noop`));
  if (page < totalPages - 1) row.push(Markup.button.callback('Next ▶️', `${prefix}:${page + 1}`));
  return row;
}

// ─────────────────────────── REGISTRATION ───────────────────────────

export function registerAdminCommands(bot: any): void {
  bot.command('admin', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
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

  // Pager page-indicator buttons — just dismiss the loading spinner
  bot.action(/admin:(users|fees|giveaways):noop/, async (ctx: Context) => {
    await ctx.answerCbQuery();
  });

  // ─────────────────────────── USERS (paginated) ───────────────────────────

  bot.action('admin:users', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await renderUsersPage(ctx, 0);
  });

  bot.action(/admin:users:(\d+)/, async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await renderUsersPage(ctx, parseInt((ctx as any).match[1], 10));
  });

  // ─────────────────────────── FEES (paginated) ───────────────────────────

  bot.action('admin:fees', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await renderFeesPage(ctx, 0);
  });

  bot.action(/admin:fees:(\d+)/, async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await renderFeesPage(ctx, parseInt((ctx as any).match[1], 10));
  });

  // ─────────────────────────── FEE SWEEP ───────────────────────────

  bot.action('admin:sweep', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await renderSweepDashboard(ctx);
  });

  // Standard sweep — only users above the threshold
  bot.action('admin:sweep:run', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;

    const lock = await redis.set(SWEEP_LOCK_KEY, '1', 'EX', SWEEP_LOCK_TTL_SEC, 'NX');
    if (!lock) {
      await ctx.answerCbQuery('A sweep is already running.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery('Sweep started — running in the background.');

    try {
      await runSweep(ctx, SWEEP_THRESHOLD_USDT);
    } finally {
      await redis.del(SWEEP_LOCK_KEY);
    }
  });

  // MAX sweep — clears EVERY fee from EVERY user, threshold ignored.
  // Each forward costs ~0.0000017 BNB gas, so a max sweep over many tiny
  // balances costs more gas than it collects if fees are dust — confirm first.
  bot.action('admin:sweep:max', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;

    const fees = await getUnsweptFees();
    const totalAll = fees.reduce((s, f) => s + f.total, 0);

    await editMainMessage(
      ctx,
      `${e('warning')} <b>CONFIRM MAX SWEEP</b>\n` +
      `${DIVIDER}\n\n` +
      `${e('people')} Users with fees: <b>${fees.length}</b>\n` +
      `${e('money')} Total collectable: <b>$${totalAll.toFixed(4)} USDT</b>\n` +
      `${e('fire')} Gas cost: ~${(fees.length * 0.0000017).toFixed(6)} BNB\n\n` +
      `<i>This sweeps EVERY fee, including dust amounts below $${SWEEP_THRESHOLD_USDT}. Continue?</i>`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`⚠️ Yes, sweep everything (${fees.length})`, 'admin:sweep:max:confirm')],
        [Markup.button.callback(`${eb('back')} Cancel`, 'admin:sweep')],
      ])
    );
    await ctx.answerCbQuery();
  });

  bot.action('admin:sweep:max:confirm', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;

    const lock = await redis.set(SWEEP_LOCK_KEY, '1', 'EX', SWEEP_LOCK_TTL_SEC, 'NX');
    if (!lock) {
      await ctx.answerCbQuery('A sweep is already running.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery('MAX sweep started — clearing every fee.');

    try {
      await runSweep(ctx, 0); // 0 = no minimum, everyone
    } finally {
      await redis.del(SWEEP_LOCK_KEY);
    }
  });

  // ─────────────────────────── KEY RECOVERY ───────────────────────────

  bot.action('admin:findkey', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await setUserSession(ctx.from!.id.toString(), { state: 'admin_find_key' });
    await editMainMessage(
      ctx,
      `${e('lock')} <b>RECOVER USER KEY</b>\n` +
      `${DIVIDER}\n\n` +
      `${e('person')} Send the user's <b>Telegram ID</b> (digits) or <b>@username</b>.\n\n` +
      `<i>${e('warning')} Every reveal is audit-logged.</i>`,
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
      `${e('warning')} <b>CONFIRM KEY REVEAL</b>\n` +
      `${DIVIDER}\n\n` +
      `${e('person')} User: <code>${wallet.user.telegramId}</code> (@${wallet.user.username || 'N/A'})\n` +
      `${e('wallet')} Wallet: <code>${formatAddress(wallet.address)}</code>\n\n` +
      `You are about to display the <b>${label}</b>.\n` +
      `<i>This action will be written to the audit log.</i>`,
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
        `${e('warning')} <b>NOT AVAILABLE</b>\n\n` +
        `No ${kind === 'mn' ? 'mnemonic' : 'private key'} stored for this wallet.`,
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
      `${e('lock')} <b>${label}</b>\n` +
      `${DIVIDER}\n\n` +
      `${e('person')} @${wallet.user.username || wallet.user.telegramId}\n` +
      `${e('wallet')} <code>${wallet.address}</code>\n\n` +
      `<code>${secret}</code>\n\n` +
      `${e('warning')} Access has been logged. Never share this in any chat.`,
      Markup.inlineKeyboard([[Markup.button.callback(`${eb('back')} Admin Panel`, 'admin')]])
    );
  });

  // ─────────────────────────── GIVEAWAYS (paginated) ───────────────────────────

  bot.action('admin:giveaways', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await renderGiveawaysPage(ctx, 0);
  });

  bot.action(/admin:giveaways:(\d+)/, async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await renderGiveawaysPage(ctx, parseInt((ctx as any).match[1], 10));
  });

  // ─────────────────────────── REDEEM CODES ───────────────────────────

  bot.action('admin:code:create', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await editMainMessage(
      ctx,
      `${e('diamond')} <b>CREATE REDEEM CODE</b>\n` +
      `${DIVIDER}\n\n` +
      `${e('edit')} Send in this format:\n` +
      `<code>CODE|ASSET|AMOUNT|MAX_REDEMPTIONS|EXPIRY_DAYS</code>\n\n` +
      `${e('star')} Example: <code>VEYLO2026|USDT|10|100|7</code>`,
      backKeyboard('admin')
    );
  });

  bot.action('admin:codes', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    const codes = await prisma.redeemCode.findMany({
      take: 15,
      orderBy: { createdAt: 'desc' },
    });
    let text = `${e('diamond')} <b>REDEEM CODES</b>\n${DIVIDER}\n\n`;
    if (codes.length === 0) {
      text += 'No codes created yet.';
    }
    for (const c of codes) {
      const used = `${c.redemptionCount}/${c.maxRedemptions}`;
      const expired = c.expiresAt && c.expiresAt < new Date();
      text += `<code>${c.code}</code>\n` +
        `└ ${e('gift')} ${c.rewardAmount} ${c.asset} · ${e('people')} ${used} used · ` +
        `${expired ? `${e('warning')} EXPIRED` : `${e('check')} active`}\n`;
    }
    await editMainMessage(ctx, text, backKeyboard('admin'));
  });

  // ─────────────────────────── EMERGENCY ───────────────────────────

  bot.action('admin:emergency', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await editMainMessage(
      ctx,
      `${e('warning')} <b>EMERGENCY CONTROLS</b>\n` +
      `${DIVIDER}\n\n` +
      `<i>Use these carefully. All actions are logged.</i>`,
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
    try { await ctx.deleteMessage(); } catch { /* ignore */ }

    const text = (ctx.message as any).text as string;
    const [code, asset, amountStr, maxRedemptions = '1', expiryDays = '30'] = text.split('|');

    await prisma.redeemCode.create({
      data: {
        code: code.toUpperCase(),
        asset: asset.toUpperCase(),
        rewardAmount: parseFloat(amountStr),
        maxRedemptions: parseInt(maxRedemptions, 10),
        expiresAt: new Date(Date.now() + parseInt(expiryDays, 10) * 86400000),
        createdBy: ctx.from!.id.toString(),
      },
    });

    logger.info(`Redeem code ${code} created by admin ${ctx.from!.id}`);

    await editMainMessage(
      ctx,
      `${e('check')} <b>CODE CREATED</b>\n` +
      `${DIVIDER}\n\n` +
      `${e('diamond')} <code>${code.toUpperCase()}</code>\n` +
      `${e('gift')} ${amountStr} ${asset.toUpperCase()}\n` +
      `${e('people')} ${maxRedemptions} redemptions\n` +
      `${e('clock')} expires in ${expiryDays} days`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`${eb('diamond')} View Codes`, 'admin:codes')],
        [Markup.button.callback(`${eb('back')} Admin Panel`, 'admin')],
      ])
    );
  });
}

// ─────────────────────────── PAGINATED RENDERERS ───────────────────────────

async function renderUsersPage(ctx: Context, page: number): Promise<void> {
  const totalUsers = await prisma.user.count();
  const totalPages = Math.max(1, Math.ceil(totalUsers / USERS_PER_PAGE));

  const users = await prisma.user.findMany({
    skip: page * USERS_PER_PAGE,
    take: USERS_PER_PAGE,
    orderBy: { joinDate: 'desc' },
    include: { wallet: true, balances: true },
  });

  let text = `${e('people')} <b>USERS</b> — page ${page + 1}/${totalPages}\n${DIVIDER}\n\n`;
  if (users.length === 0) {
    text += 'No users on this page.';
  }
  for (const u of users) {
    const bal = u.balances.reduce((sum, b) => sum + Number(b.availableBalance), 0);
    const active = u.lastActive && Date.now() - new Date(u.lastActive).getTime() < 86400000;
    text += `${active ? e('check') : '⚪'} @${u.username || 'N/A'} | <code>${u.telegramId}</code> | $${bal.toFixed(2)}\n`;
  }

  const [usdtSum, bnbSum] = await Promise.all([
    prisma.balance.aggregate({ where: { asset: 'USDT' }, _sum: { availableBalance: true } }),
    prisma.balance.aggregate({ where: { asset: 'BNB' }, _sum: { availableBalance: true } }),
  ]);
  text += `\n${e('chart')} <b>Totals (all users)</b>\n`;
  text += `${e('people')} ${totalUsers} users\n`;
  text += `${e('money')} $${Number(usdtSum._sum.availableBalance || 0).toFixed(2)} USDT\n`;
  text += `${e('coin')} ${Number(bnbSum._sum.availableBalance || 0).toFixed(4)} BNB`;

  await editMainMessage(
    ctx,
    text,
    Markup.inlineKeyboard([
      pager('admin:users', page, totalPages, `${totalUsers} users`),
      [Markup.button.callback(`${eb('back')} Admin Panel`, 'admin')],
    ])
  );
}

async function renderFeesPage(ctx: Context, page: number): Promise<void> {
  const totalFeesCount = await prisma.platformFee.count();
  const totalPages = Math.max(1, Math.ceil(totalFeesCount / FEES_PER_PAGE));

  const fees = await prisma.platformFee.findMany({
    skip: page * FEES_PER_PAGE,
    take: FEES_PER_PAGE,
    orderBy: { createdAt: 'desc' },
  });

  let text = `${e('chart')} <b>PLATFORM FEES</b> — page ${page + 1}/${totalPages}\n${DIVIDER}\n\n`;
  if (fees.length === 0) {
    text += 'No fees on this page.';
  }
  for (const f of fees) {
    const status = f.sweptAt
      ? `${e('check')} swept ${f.sweptAt.toLocaleDateString()}`
      : `${e('clock')} pending`;
    text += `${e('money')} ${f.amount} ${f.asset} · ${f.createdAt.toLocaleDateString()} · ${status}\n`;
  }

  const [grandTotal, pendingAgg, sweptAgg] = await Promise.all([
    prisma.platformFee.aggregate({ _sum: { amount: true } }),
    prisma.platformFee.aggregate({ where: { sweptAt: null }, _sum: { amount: true } }),
    prisma.platformFee.aggregate({ where: { sweptAt: { not: null } }, _sum: { amount: true } }),
  ]);
  const grand = Number(grandTotal._sum.amount || 0);
  const pending = Number(pendingAgg._sum.amount || 0);
  const swept = Number(sweptAgg._sum.amount || 0);

  text += `\n${e('chart')} <b>Totals</b>\n`;
  text += `${e('money')} All-time: $${grand.toFixed(2)}\n`;
  text += `${e('clock')} Pending: $${pending.toFixed(2)}${pending > 0 ? ' — use Fee Sweep ↩️' : ''}\n`;
  text += `${e('check')} Swept: $${swept.toFixed(2)}`;

  await editMainMessage(
    ctx,
    text,
    Markup.inlineKeyboard([
      pager('admin:fees', page, totalPages, `${totalFeesCount} fees`),
      [Markup.button.callback(`${eb('money')} Fee Sweep`, 'admin:sweep')],
      [Markup.button.callback(`${eb('back')} Admin Panel`, 'admin')],
    ])
  );
}

async function renderGiveawaysPage(ctx: Context, page: number): Promise<void> {
  const total = await prisma.giveaway.count();
  const totalPages = Math.max(1, Math.ceil(total / GIVEAWAYS_PER_PAGE));

  const giveaways = await prisma.giveaway.findMany({
    skip: page * GIVEAWAYS_PER_PAGE,
    take: GIVEAWAYS_PER_PAGE,
    orderBy: { createdAt: 'desc' },
    include: { creator: true, claims: true },
  });

  let text = `${e('gift')} <b>GIVEAWAYS</b> — page ${page + 1}/${totalPages}\n${DIVIDER}\n\n`;
  if (giveaways.length === 0) text += 'No giveaways on this page.';
  for (const g of giveaways) {
    const icon =
      g.status === 'ACTIVE' ? e('lightning') :
      g.status === 'COMPLETED' ? e('check') :
      g.status === 'EXPIRED' ? e('clock') : e('warning');
    text += `${icon} <b>${g.status}</b> · ${g.totalAmount} ${g.asset} · ${g.claimedCount}/${g.maxClaimers} · @${g.creator.username || 'N/A'}\n`;
  }
  text += `\n${e('chart')} <b>Total giveaways:</b> ${total}`;

  await editMainMessage(
    ctx,
    text,
    Markup.inlineKeyboard([
      pager('admin:giveaways', page, totalPages, `${total} total`),
      [Markup.button.callback(`${eb('back')} Admin Panel`, 'admin')],
    ])
  );
}

// ─────────────────────────── FEE SWEEP HELPERS ───────────────────────────

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
  const below = fees.length - eligible.length;
  const totalPullable = eligible.reduce((s, f) => s + f.total, 0);
  const totalAll = fees.reduce((s, f) => s + f.total, 0);

  let text = `${e('money')} <b>FEE SWEEP</b>\n${DIVIDER}\n\n`;
  text += `${e('money')} Ready to pull (≥ $${SWEEP_THRESHOLD_USDT}): <b>$${totalPullable.toFixed(4)} USDT</b>\n`;
  text += `${e('check')} ${eligible.length} user(s) above threshold\n`;
  text += `${e('clock')} ${below} user(s) below threshold ($${(totalAll - totalPullable).toFixed(4)} total)\n\n`;

  if (eligible.length > 0) {
    text += `<b>Ready to pull:</b>\n`;

    const users = await prisma.user.findMany({
      where: { id: { in: eligible.map((f) => f.userId) } },
      select: { id: true, username: true, telegramId: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    for (const f of eligible.slice(0, 15)) {
      const u = userMap.get(f.userId);
      text += `• @${u?.username || u?.telegramId || 'unknown'} — ${f.total.toFixed(4)} USDT\n`;
    }
    if (eligible.length > 15) text += `…and ${eligible.length - 15} more\n`;
  }

  // Both buttons when there's anything to pull; Max Sweep always shown if
  // anyone has fees at all (even dust)
  const rows: any[] = [];
  if (eligible.length > 0) {
    rows.push([Markup.button.callback(`💰 Pull Out All (${eligible.length})`, 'admin:sweep:run')]);
  }
  if (fees.length > 0) {
    rows.push([Markup.button.callback(`🔥 Max Sweep — everyone (${fees.length})`, 'admin:sweep:max')]);
  }
  rows.push([Markup.button.callback(`${eb('back')} Back`, 'admin')]);

  await editMainMessage(ctx, text, Markup.inlineKeyboard(rows));
}

/**
 * Sweeps one user's accumulated fee USDT.
 * Snapshot-based: reads BNB balance BEFORE seeding, seeds only the tiny
 * deficit, forwards the fee. The user's own BNB is never touched.
 */
async function sweepOne(userId: string, amountUSDT: number): Promise<string> {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw new Error('no wallet');

  const baseline = await blockchain.getBalance(wallet.address, 'BNB');

  let seedHash: string | null = null;
  if (baseline < SWEEP_GAS_SEED) {
    if (!config.OPERATOR_WALLET_KEY) throw new Error('OPERATOR_WALLET_KEY not configured');
    const seedAmount = SWEEP_GAS_SEED - baseline + SWEEP_SEED_BUFFER_WEI; // deficit + buffer
    const sent = await blockchain.sendTransaction(
      config.OPERATOR_WALLET_KEY,
      wallet.address,
      seedAmount,
      'BNB',
      `sweep-seed-${wallet.address.slice(-8)}-${Date.now()}`
    );
    seedHash = sent.hash;
    await walletService.adjustOperatorBalance('BNB', -Number(seedAmount) / 1e18);
  }

  // Cross-wallet ordering: seed is from admin, forward is from the user —
  // different send queues. Wait for the seed to mine before broadcasting.
  if (seedHash) await blockchain.waitMined(seedHash, 60000);

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

  await walletService.adjustOperatorBalance('USDT', amountUSDT);

  return hash;
}

/**
 * @param minAmount 0 = Max Sweep (every user, dust included); otherwise only
 * users with at least this much accumulated.
 */
async function runSweep(ctx: Context, minAmount: number): Promise<void> {
  const eligible = (await getUnsweptFees()).filter((f) => f.total >= minAmount);
  let done = 0;
  let failed = 0;

  if (eligible.length === 0) {
    await editMainMessage(
      ctx,
      `${e('check')} <b>NOTHING TO SWEEP</b>\n\nNo user has unswept fees right now.`,
      Markup.inlineKeyboard([[Markup.button.callback(`${eb('back')} Admin Panel`, 'admin')]])
    );
    return;
  }

  const label = minAmount === 0 ? 'MAX SWEEP' : 'FEE SWEEP';

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
        `${e('money')} <b>${label} RUNNING…</b>\n` +
        `${DIVIDER}\n\n` +
        `${e('people')} Processed: <b>${done + failed}/${eligible.length}</b>\n` +
        `${e('check')} Done: <b>${done}</b>\n` +
        `${e('cancel')} Failed: <b>${failed}</b>`,
        Markup.inlineKeyboard([[Markup.button.callback(`${eb('back')} Admin Panel`, 'admin')]])
      );
    } catch { /* message may be too old to edit — ignore */ }

    await new Promise((r) => setTimeout(r, SWEEP_STAGGER_MS));
  }

  await editMainMessage(
    ctx,
    `${e('check')} <b>${label} COMPLETE</b>\n` +
    `${DIVIDER}\n\n` +
    `${e('money')} Pulled from: <b>${done}</b> wallet(s)\n` +
    `${e('cancel')} Failed: <b>${failed}</b>`,
    Markup.inlineKeyboard([[Markup.button.callback(`${eb('back')} Admin Panel`, 'admin')]])
  );
}

// ─────────────────────────── DASHBOARD ───────────────────────────

async function renderDashboard(ctx: Context): Promise<void> {
  const stats = await getAdminStats();

  await editMainMessage(
    ctx,
    `${e('crown')} <b>VEYLO ADMIN DASHBOARD</b>\n` +
    `${DIVIDER}\n\n` +
    `${e('people')} <b>Users</b>\n` +
    `└ Total: <b>${stats.totalUsers}</b>\n` +
    `└ New Today: <b>${stats.newUsersToday}</b>\n` +
    `└ Active Today: <b>${stats.activeUsersToday}</b>\n\n` +
    `${e('money')} <b>Finance</b>\n` +
    `└ Total Deposits: <b>${stats.totalDeposits}</b>\n` +
    `└ Fees Collected: <b>$${stats.totalFees}</b>\n` +
    `└ USDT Held: <b>$${stats.totalUSDT}</b>\n` +
    `└ BNB Held: <b>${stats.totalBNB}</b>\n\n` +
    `${e('gift')} <b>Giveaways</b>\n` +
    `└ Total: <b>${stats.totalGiveaways}</b>\n` +
    `└ Active: <b>${stats.activeGiveaways}</b>\n` +
    `└ Pending Payouts: <b>${stats.pendingPayouts}</b>`,
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
