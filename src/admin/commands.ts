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
import { maintenance } from '../services/maintenance';

/** 0.000002 BNB = 2×10^12 wei (2,000,000,000,000) */
const SWEEP_GAS_SEED = 2000000000000n;
const SWEEP_SEED_BUFFER_WEI = 500000000000n; // 0.0000005 BNB buffer on top of deficit
/** Standard sweep threshold — Max Sweep ignores this entirely */
const SWEEP_THRESHOLD_USDT = 0.1;
/** On-chain reserve left in the wallet + minimum worth sweeping */
const SWEEP_RESERVE_USDT = 0.01;

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
    Markup.button.callback(`${eb('message')} Broadcast`, 'admin:broadcast'),
    Markup.button.callback(`${eb('search')} Find User`, 'admin:search'),
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

function fmtUtc(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

async function renderMaintenancePanel(ctx: Context, notice?: string): Promise<void> {
  // Force a fresh DB read so the admin always sees the real persisted state.
  const st = await maintenance.getState({ force: true });

  let text =
    `🔧 <b>MAINTENANCE MODE</b>\n${DIVIDER}\n\n` +
    (notice ? `${notice}\n\n` : '') +
    `Status: ${st.enabled ? '🔴 <b>ENABLED</b>' : '🟢 <b>DISABLED</b>'}\n`;

  if (st.enabled && st.enabledAt) {
    text += `Enabled: ${fmtUtc(st.enabledAt)}${st.enabledBy ? ` by <code>${st.enabledBy}</code>` : ''}\n`;
  }
  text += `Last change: ${fmtUtc(st.changedAt)}${st.changedBy ? ` by <code>${st.changedBy}</code>` : ''}\n\n`;
  text += st.enabled
    ? `<i>Every button a user taps (except Back) shows the maintenance screen with a Back button and the channel link. Admins are unaffected. Background deposit monitoring and already-queued payouts keep running.</i>`
    : `<i>Enabling blocks all user actions (Back + channel link only). Admins are unaffected.</i>`;

  await editMainMessage(
    ctx,
    text,
    Markup.inlineKeyboard([
      [
        st.enabled
          ? Markup.button.callback('✅ Disable Maintenance', 'admin:maintenance:set:off')
          : Markup.button.callback('🔧 Enable Maintenance', 'admin:maintenance:set:on'),
      ],
      [Markup.button.callback(`${eb('refresh')} Refresh`, 'admin:maintenance')],
      [Markup.button.callback(`${eb('back')} Back`, 'admin:emergency')],
    ])
  );
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

  // ─────────────────────────── MAINTENANCE MODE ───────────────────────────

  bot.action('admin:maintenance', async (ctx: Context) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('Not authorized.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    await renderMaintenancePanel(ctx);
  });

  bot.action(/^admin:maintenance:set:(on|off)$/, async (ctx: Context) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('Not authorized.', { show_alert: true });
      return;
    }
    const enable = (ctx as any).match[1] === 'on';
    const adminId = ctx.from!.id.toString();

    try {
      // Persists to the DB + writes the audit log in one transaction, then
      // re-reads the DB to confirm. Throws if anything fails.
      const { changed } = await maintenance.setEnabled(enable, adminId);
      logger.warn(
        `Admin ${adminId} ${enable ? 'ENABLED' : 'DISABLED'} maintenance mode${changed ? '' : ' (no change)'}`
      );
      await ctx.answerCbQuery(enable ? '🔧 Maintenance Mode ENABLED' : '✅ Maintenance Mode DISABLED', {
        show_alert: true,
      });
      await renderMaintenancePanel(
        ctx,
        enable
          ? `${e('warning')} <b>Maintenance Mode ENABLED</b> — users now only see the maintenance screen (Back + channel link).`
          : `${e('check')} <b>Maintenance Mode DISABLED</b> — normal operations resumed.`
      );
    } catch (err) {
      logger.error(`Maintenance toggle failed for admin ${adminId}: ${(err as Error).message}`);
      try {
        await ctx.answerCbQuery('Failed to change maintenance mode. State was NOT changed — check logs.', {
          show_alert: true,
        });
      } catch { /* ignore */ }
    }
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

  // One tappable button per user → full profile (2 per row keeps it compact)
  const userButtons = users.map((u) =>
    Markup.button.callback(
      `${u.username ? '@' + u.username : u.firstName || u.telegramId}`.slice(0, 24),
      `admin:user:${u.id}`
    )
  );
  const userRows: any[] = [];
  for (let i = 0; i < userButtons.length; i += 2) userRows.push(userButtons.slice(i, i + 2));

  await editMainMessage(
    ctx,
    text,
    Markup.inlineKeyboard([
      ...userRows,
      pager('admin:users', page, totalPages, `${totalUsers} users`),
      [
        Markup.button.callback(`${eb('search')} Find User`, 'admin:s
