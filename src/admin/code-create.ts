import { Context, Markup } from 'telegraf';
import { prisma } from '../database';
import { config } from '../config';
import { getUserSession, setUserSession, clearUserSession } from '../services/redis';
import { editMainMessage } from '../bot/utils/editMainMessage';
import { backKeyboard } from '../bot/keyboards/main';
import { e, eb } from '../utils/emoji';
import { logger } from '../utils/logger';
import { parseAdminCodeInput } from '../web/lib/admin-code';

/**
 * Fixes admin "Create Code" (wallet-balance redeem codes).
 * The original button set no input step, and the global text handler drops
 * any text sent without one — so the code text never reached its handler (or
 * was misread by a leftover redeem step). This gives the button its own step.
 * Registered BEFORE registerAdminCommands so it takes over `admin:code:create`.
 */
const STATE = 'admin_create_code';
const DIVIDER = `${e('sparkle')}━━━━━━━━━━━━━━━━━${e('sparkle')}`;
const isAdmin = (ctx: Context) => config.ADMIN_TELEGRAM_IDS.includes(ctx.from?.id.toString() ?? '');

export function registerAdminCodeCreate(bot: any): void {
  bot.action('admin:code:create', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await setUserSession(ctx.from!.id.toString(), { state: STATE });
    await editMainMessage(
      ctx,
      `${e('diamond')} <b>CREATE REDEEM CODE</b>\n${DIVIDER}\n\n` +
        `${e('edit')} Send in this format:\n<code>CODE|ASSET|AMOUNT|MAX_REDEMPTIONS|EXPIRY_DAYS</code>\n\n` +
        `${e('star')} Example: <code>VEYLO2026|USDT|10|100|7</code>\n\n` +
        `<i>Only CODE, ASSET and AMOUNT are required (defaults: 1 redemption, 30 days).</i>`,
      backKeyboard('admin')
    );
  });

  bot.on('text', async (ctx: Context, next: () => Promise<void>) => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    if (!ctx.from || text.startsWith('/') || !isAdmin(ctx)) return next();
    const tg = ctx.from.id.toString();
    const session = await getUserSession(tg);
    if (session?.state !== STATE) return next();
    try { await ctx.deleteMessage(); } catch { /* ignore */ }

    const parsed = parseAdminCodeInput(text);
    if (!parsed.ok) {
      await editMainMessage(ctx, `${e('warning')} ${parsed.error}\n\nExample: <code>VEYLO2026|USDT|10|100|7</code>`, backKeyboard('admin'));
      return; // keep the step open so the admin can resend
    }
    try {
      await prisma.redeemCode.create({
        data: {
          code: parsed.code, asset: parsed.asset, rewardAmount: parsed.amount, maxRedemptions: parsed.maxRedemptions,
          expiresAt: new Date(Date.now() + parsed.expiryDays * 86400000), createdBy: tg,
        },
      });
      await clearUserSession(tg);
      logger.info(`Redeem code ${parsed.code} created by admin ${tg}`);
      await editMainMessage(
        ctx,
        `${e('check')} <b>CODE CREATED</b>\n${DIVIDER}\n\n${e('diamond')} <code>${parsed.code}</code>\n` +
          `${e('gift')} ${parsed.amount} ${parsed.asset}\n${e('people')} ${parsed.maxRedemptions} redemption(s)\n${e('clock')} expires in ${parsed.expiryDays} days`,
        Markup.inlineKeyboard([
          [Markup.button.callback(`${eb('diamond')} View Codes`, 'admin:codes')],
          [Markup.button.callback(`${eb('back')} Admin Panel`, 'admin')],
        ])
      );
    } catch (err) {
      const dup = (err as { code?: string }).code === 'P2002';
      if (!dup) logger.error(`Admin code create failed: ${(err as Error).message}`);
      await editMainMessage(
        ctx,
        dup ? `${e('warning')} The code <code>${parsed.code}</code> already exists. Send a different code.` : `${e('warning')} Could not create the code. Please try again.`,
        backKeyboard('admin')
      );
    }
  });
}
