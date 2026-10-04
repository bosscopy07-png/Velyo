import { Context, Markup } from 'telegraf';
import { prisma } from '../database';
import { e, eb } from '../utils/emoji';
import { logger } from '../utils/logger';
import { editMainMessage } from '../bot/utils/editMainMessage';
import { backKeyboard } from '../bot/keyboards/main';
import { feeConfig, type FeeConfig } from '../services/fee-config';
import { claimRiskService } from '../services/claim-risk';
import { treasuryMonitor } from '../services/treasury';
import { redis, setUserSession } from '../services/redis';

/**
 * Phase-2 admin surface: Finance (runtime fee config), Security (duplicate
 * claim flags), Treasury (roles, balances, payout wallet, deposit pool).
 * All actions: admin-only, audited, validated.
 */

const DIVIDER = `${e('sparkle')}━━━━━━━━━━━━━━━━━${e('sparkle')}`;

const FEE_FIELDS: Array<{ key: keyof FeeConfig; label: string; hint: string }> = [
  { key: 'platformFeePercent', label: 'Platform Fee %', hint: 'charged on giveaway creation' },
  { key: 'creatorCashbackPercent', label: 'Creator Cashback %', hint: 'paid when a giveaway fully pays out' },
  { key: 'referralRewardPercent', label: 'Referral Reward %', hint: 'when a referred user completes a giveaway' },
  { key: 'depositFlatFeeUSD', label: 'Deposit Fee $ (standard)', hint: 'per deposit session' },
  { key: 'depositFlatFeeSmallUSD', label: 'Deposit Fee $ (small)', hint: 'below the tier amount' },
  { key: 'depositFlatFeeTierUSD', label: 'Small-Deposit Tier $', hint: 'USD threshold for small fee' },
  { key: 'minAmountUSD', label: 'Minimum Amount $', hint: 'minimum deposit/giveaway value' },
];

export function registerAdminUpgrade(bot: any): void {
  const guard = (fn: (ctx: Context) => Promise<void>) => async (ctx: Context) => {
    try {
      await fn(ctx);
    } catch (err) {
      logger.error(`Admin upgrade error: ${(err as Error).message}`, err);
      try {
        await ctx.answerCbQuery('Something went wrong. Try again.', { show_alert: true });
      } catch { /* ignore */ }
    }
  };

  // ═══════════════ FINANCE ═══════════════
  bot.action('admin:finance', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const fees = await feeConfig.getFees();
    const lines = [
      `${eb('money')} <b>FEE CONFIGURATION</b>`, DIVIDER, '',
      ...FEE_FIELDS.map((f) => {
        const v = fees[f.key];
        const shown = typeof v === 'boolean' ? (v ? 'ON' : 'OFF') : v;
        return `${f.label}: <code>${shown}</code>\n   <i>${f.hint}</i>`;
      }),
      '',
      'Tap a fee to change it. Validated (0–100%) and audit-logged.',
    ];
    const rows = FEE_FIELDS.map((f) => [Markup.button.callback(`✏️ ${f.label}`, `admin:fee:set:${f.key}`)]);
    rows.push([Markup.button.callback(`${eb('back')} Admin`, 'admin')]);
    await editMainMessage(ctx, lines.join('\n'), Markup.inlineKeyboard(rows));
  }));

  bot.action(/admin:fee:set:(.+)/, guard(async (ctx: Context) => {
    const key = (ctx as any).match[1] as keyof FeeConfig;
    if (!FEE_FIELDS.some((f) => f.key === key)) {
      await ctx.answerCbQuery('Unknown fee.', { show_alert: true });
      return;
    }
    const field = FEE_FIELDS.find((f) => f.key === key)!;
    await ctx.answerCbQuery();
    await setUserSession(ctx.from!.id.toString(), { state: 'admin_fee_edit', feeKey: key });
    await editMainMessage(
      ctx,
      `${eb('money')} <b>SET ${field.label.toUpperCase()}</b>\n${DIVIDER}\n\nCurrent rule: <i>${field.hint}</i>\n\nEnter the new numeric value.`,
      backKeyboard('admin:finance')
    );
  }));

  // ═══════════════ SECURITY ═══════════════
  bot.action('admin:security', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const flags = await claimRiskService.listOpenFlags();
    const lines = [
      `${eb('shield')} <b>SECURITY — DUPLICATE SIGNALS</b>`, DIVIDER, '',
      flags.length === 0 ? 'No open flags. 🎉' : `${flags.length} open flag(s):`, '',
    ];
    const rows: any[] = [];
    for (const f of flags) {
      const u = f.claim.user;
      const who = u.username ? `@${u.username}` : `ID ${u.telegramId}`;
      lines.push(`⚠️ <b>${f.signal}</b> — ${who}`, `   giveaway <code>${f.giveawayId.slice(0, 8)}…</code> · ${f.createdAt.toLocaleString()}`);
      rows.push([
        Markup.button.callback(`✅ Dismiss`, `admin:flag:dismiss:${f.id}`),
        Markup.button.callback(`🚫 Confirm abuse`, `admin:flag:confirm:${f.id}`),
      ]);
    }
    rows.push([Markup.button.callback(`${eb('back')} Admin`, 'admin')]);
    await editMainMessage(ctx, lines.join('\n'), Markup.inlineKeyboard(rows));
  }));

  bot.action(/admin:flag:(dismiss|confirm):(.+)/, guard(async (ctx: Context) => {
    const [, action, flagId] = (ctx as any).match;
    await claimRiskService.reviewFlag(flagId, ctx.from!.id.toString(), action === 'dismiss' ? 'DISMISSED' : 'CONFIRMED');
    await ctx.answerCbQuery(action === 'dismiss' ? 'Flag dismissed.' : 'Flag confirmed.');
    await editMainMessage(
      ctx,
      `${e('check')} Flag ${action === 'dismiss' ? 'dismissed' : 'confirmed'}.` +
        (action === 'confirm' ? '\n\nReview the user in Admin → Find User if further action is needed.' : ''),
      backKeyboard('admin:security')
    );
  }));

  // ═══════════════ TREASURY ═══════════════
  bot.action('admin:treasury', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const status = await treasuryMonitor.getStatus();
    const text = [
      `${eb('money')} <b>TREASURY</b>`, DIVIDER, '',
      `<b>Address:</b> <code>${status.address}</code>`,
      `<b>Payout wallet:</b> <code>${status.payoutAddress}</code>`,
      `<b>Payout origin:</b> ${status.payoutOrigin === 'platform' ? '🏦 Platform wallet' : '👤 Creator wallets (legacy)'}`,
      `<b>Legacy user-wallet monitoring:</b> ${status.legacyMonitorEnabled ? '🟡 ON (transition)' : '⚫ OFF'}`,
      '',
      `🟡 BNB (gas): <b>${status.bnb.toFixed(6)}</b>`,
      `🟢 USDT: <b>${status.usdt.toFixed(2)}</b>`,
      `💳 Company deposit addresses: <b>${status.companyWalletsActive}</b>`,
      `⏳ Sessions awaiting: <b>${status.depositSessionsAwaiting}</b>`,
      `📤 Payouts in queue: <b>${status.pendingPayouts ?? 'unavailable'}</b>`,
    ].join('\n');
    await editMainMessage(ctx, text, Markup.inlineKeyboard([
      [Markup.button.callback(`${eb('deposit')} Deposit Pool`, 'admin:dwallets')],
      [Markup.button.callback(`${eb('lock')} Set Payout Wallet`, 'admin:payoutwallet:set')],
      [Markup.button.callback(`${eb('back')} Admin`, 'admin')],
    ]));
  }));

  bot.action('admin:payoutwallet:set', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    await setUserSession(ctx.from!.id.toString(), { state: 'admin_payout_wallet' });
    await editMainMessage(
      ctx,
      `${eb('lock')} <b>SET PAYOUT WALLET</b>\n${DIVIDER}\n\nSend one message:\n\n<code>0xPayoutAddress 0xPrivateKey</code>\n\n` +
      `The key is verified against the address and stored encrypted. This wallet pays claimants (keep BNB for gas).`,
      backKeyboard('admin:treasury')
    );
  }));

  bot.action('admin:dwallets', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    const wallets = await prisma.companyDepositWallet.findMany({
      orderBy: { lastAssignedAt: { sort: 'asc', nulls: 'first' } },
      take: 15,
    });
    const lines = [
      `${eb('deposit')} <b>COMPANY DEPOSIT POOL</b>`, DIVIDER, '',
      wallets.length === 0 ? 'No company deposit addresses configured.' : '',
      ...wallets.map((w) => {
        const idle = w.lastAssignedAt ? `${Math.round((Date.now() - w.lastAssignedAt.getTime()) / 60000)}m ago` : 'never';
        return `${w.status === 'ACTIVE' ? '🟢' : '⚫'} <code>${w.address.slice(0, 10)}…${w.address.slice(-4)}</code> — ${w.status} · assigned ${idle}`;
      }),
    ];
    const rows: any[] = wallets
      .filter((w) => w.status === 'ACTIVE')
      .map((w) => [Markup.button.callback(`⚫ Disable ${w.address.slice(0, 8)}…`, `admin:dwallet:disable:${w.id}`)]);
    rows.push([Markup.button.callback(`➕ Add Address`, 'admin:dwallet:add')]);
    rows.push([Markup.button.callback(`${eb('back')} Treasury`, 'admin:treasury')]);
    await editMainMessage(ctx, lines.join('\n'), Markup.inlineKeyboard(rows));
  }));

  bot.action('admin:dwallet:add', guard(async (ctx: Context) => {
    await ctx.answerCbQuery();
    await setUserSession(ctx.from!.id.toString(), { state: 'admin_dwallet_add' });
    await editMainMessage(
      ctx,
      `${eb('deposit')} <b>ADD COMPANY DEPOSIT ADDRESS</b>\n${DIVIDER}\n\nSend:\n\n<code>0xAddress 0xPrivateKey</code>\n\n` +
      `⚠️ The key is verified against the address and encrypted before storage. Never paste keys elsewhere.`,
      backKeyboard('admin:dwallets')
    );
  }));

  bot.action(/admin:dwallet:disable:(.+)/, guard(async (ctx: Context) => {
    const id = (ctx as any).match[1];
    await prisma.companyDepositWallet.update({ where: { id }, data: { status: 'DISABLED' } });
    await prisma.auditLog.create({
      data: { adminId: ctx.from!.id.toString(), action: 'DEPOSIT_WALLET_DISABLE', entityType: 'company_deposit_wallet', entityId: id },
    });
    await ctx.answerCbQuery('Address disabled. Historical sessions remain intact.');
    await editMainMessage(ctx, `${e('check')} Company deposit address disabled.\nHistorical records remain for audit.`, backKeyboard('admin:dwallets'));
  }));

  void redis;
}
