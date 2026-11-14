import { Context, Markup } from 'telegraf';
import { prisma } from '../database';
import { getUserSession, setUserSession, clearUserSession } from '../services/redis';
import { redeemWebCode, type RedeemResult } from '../web/redeem';
import { registerPayoutAddress } from '../web/antiabuse';
import { handleStart } from './commands/start';
import { backKeyboard } from './keyboards/main';
import { editMainMessage } from './utils/editMainMessage';
import { e, eb } from '../utils/emoji';
import { logger } from '../utils/logger';
import { config } from '../config';

/**
 * VEYLO website giveaway-code redemption (Telegram side).
 *
 * Self-contained module. It does NOT touch the wallet-credit "Redeem Code"
 * feature (session state `redeem_code`) — this flow uses its own state
 * `giveaway_redeem_code`, callback `giveaway:redeemcode` and command
 * `/redeemgiveaway`. After validation it hands over to the existing claim →
 * address → confirm → payout pipeline unchanged.
 */

const SESSION_STATE = 'giveaway_redeem_code';
const DIVIDER = `${e('sparkle')}━━━━━━━━━━━━━━━━━${e('sparkle')}`;

const deadEnd = () =>
  Markup.inlineKeyboard([
    [Markup.button.url('📢 Join our Channel', config.COMMUNITY_CHANNEL_URL)],
    [Markup.button.callback(`${eb('back')} Back`, 'main')],
  ]);

async function promptForCode(ctx: Context): Promise<void> {
  await setUserSession(ctx.from!.id.toString(), { state: SESSION_STATE });
  await editMainMessage(
    ctx,
    `${e('gift')} <b>REDEEM GIVEAWAY CODE</b>\n${DIVIDER}\n\n` +
      `Send the claim code you generated on the VEYLO website.\n\n` +
      `${e('edit')} Example: <code>VEYLO-AB12-CD34-EF56</code>\n\n` +
      `<i>This is for website giveaway codes. Wallet-balance codes use the Wallet menu.</i>`,
    backKeyboard('main')
  );
}

async function promptForAddress(ctx: Context, asset: string, claimId: string): Promise<void> {
  await setUserSession(ctx.from!.id.toString(), { state: 'awaiting_payout_address', claimId, asset });
  await editMainMessage(
    ctx,
    `${e('party')} <b>CODE VERIFIED — SPOT SECURED!</b>\n\n` +
      `Reward: <b>${asset}</b> payout pending.\n\n` +
      `${e('deposit')} <b>SEND YOUR ${asset} BEP20 WALLET ADDRESS</b>\n\n` +
      `Type or paste the address below.\n\n` +
      `⚠️ Must support BNB Smart Chain (BEP20)`,
    backKeyboard('main')
  );
}

const FAIL_COPY: Record<string, string> = {
  EXPIRED: `${e('clock')} <b>CODE EXPIRED</b>\n\nThis code is no longer valid. Open the giveaway on the VEYLO website to generate a fresh one.`,
  USED: `${e('warning')} <b>CODE ALREADY USED</b>\n\nThis code has already been redeemed and can't be used again.`,
  GIVEAWAY_CLOSED: `${e('warning')} <b>GIVEAWAY ENDED</b>\n\nThis giveaway is no longer accepting claims.`,
  FULL: `${e('warning')} <b>GIVEAWAY FULL</b>\n\nAll available spots have been claimed.`,
  ALREADY_CLAIMED: `${e('check')} <b>ALREADY CLAIMED</b>\n\nYou have already claimed this giveaway.`,
  BLOCKED: `${e('warning')} You are not eligible to claim this giveaway.`,
  BUSY: `${e('clock')} The system is busy. Please try again in a moment — your code is still valid.`,
  MAINTENANCE: `🔧 VEYLO is under maintenance. Please try again later.`,
  RATE_LIMITED: `${e('warning')} <b>TOO MANY ATTEMPTS</b>\n\nPlease wait a few minutes before trying another code.`,
  ERROR: `${e('warning')} Something went wrong while redeeming your code. Please try again shortly.`,
};

async function render(ctx: Context, result: RedeemResult): Promise<void> {
  const tg = ctx.from!.id.toString();
  if (result.ok) {
    await promptForAddress(ctx, result.asset, result.claimId);
    return;
  }
  if (result.code === 'ALREADY_CLAIMED' && result.resumable && result.claimId && result.asset) {
    await promptForAddress(ctx, result.asset, result.claimId);
    return;
  }
  if (result.code === 'INVALID') {
    // Keep the input step open so the user can retry; never reveal why (no oracle).
    await setUserSession(tg, { state: SESSION_STATE });
    await editMainMessage(
      ctx,
      `${e('warning')} <b>CODE NOT RECOGNISED</b>\n\nCheck the code and send it again, or generate a new one on the VEYLO website.`,
      backKeyboard('main')
    );
    return;
  }
  if (result.code !== 'BUSY') await clearUserSession(tg);
  await editMainMessage(ctx, FAIL_COPY[result.code] ?? FAIL_COPY.ERROR, deadEnd());
}

async function runRedeem(ctx: Context, rawCode: string): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user) {
    await ctx.reply(`${e('warning')} Please send /start first.`, { parse_mode: 'HTML' });
    return;
  }
  try {
    await render(ctx, await redeemWebCode({ rawCode, userId: user.id, telegramId }));
  } catch (err) {
    logger.error(`Giveaway code redemption error: ${(err as Error).message}`, err);
    await editMainMessage(ctx, FAIL_COPY.ERROR, backKeyboard('main'));
  }
}

export function registerGiveawayRedeem(bot: any): void {
  // /start redeem_<CODE> — the website's "Open Veylo Bot" button. Runs the
  // normal /start first (creates the user, shows the menu), then redeems.
  bot.use(async (ctx: Context, next: () => Promise<void>) => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const m = text.match(/^\/start(?:@\w+)?\s+redeem_([A-Za-z0-9-]{8,64})$/);
    if (!m) return next();
    await handleStart(ctx);
    await runRedeem(ctx, m[1]);
  });

  // /redeemgiveaway [CODE]
  bot.command('redeemgiveaway', async (ctx: Context) => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const code = text.split(/\s+/)[1]?.trim();
    try { await ctx.deleteMessage(); } catch { /* keep chat tidy, best effort */ }
    if (!code) return promptForCode(ctx);
    await runRedeem(ctx, code);
  });

  // Main-menu button
  bot.action('giveaway:redeemcode', async (ctx: Context) => {
    try {
      await ctx.answerCbQuery();
      await promptForCode(ctx);
    } catch (err) {
      logger.error(`redeemcode button error: ${(err as Error).message}`);
    }
  });

  // Code typed after tapping the button. Anything else falls through untouched.
  bot.on('text', async (ctx: Context, next: () => Promise<void>) => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    if (!ctx.from || text.startsWith('/')) return next();
    const session = await getUserSession(ctx.from.id.toString());
    if (session?.state !== SESSION_STATE) return next();
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
    await runRedeem(ctx, text.trim());
  });

  // Duplicate-wallet guard in front of the EXISTING payout:confirm handler.
  // Not a duplicate → next() → the original handler runs exactly as before.
  bot.action(/^payout:confirm:(.+)$/, async (ctx: Context, next: () => Promise<void>) => {
    try {
      const claimId = (ctx as any).match[1] as string;
      const session = await getUserSession(ctx.from!.id.toString());
      const address = session?.state === 'awaiting_payout_confirm' ? ((session as any).address as string) : undefined;
      if (!address) return next();

      const claim = await prisma.giveawayClaim.findUnique({ where: { id: claimId }, select: { status: true, userId: true } });
      if (!claim || claim.status !== 'RESERVED') return next();

      const decision = await registerPayoutAddress({ claimId, address });
      if (decision.outcome !== 'DUPLICATE') return next();

      await ctx.answerCbQuery('Duplicate wallet address');
      await clearUserSession(ctx.from!.id.toString());
      await editMainMessage(
        ctx,
        `${e('warning')} <b>ALREADY CLAIMED</b>\n\nYou have already claimed this giveaway using this wallet address.\n\nNo payout will be sent for this attempt.`,
        deadEnd()
      );
    } catch (err) {
      if ((err as Error).message.includes('contention')) {
        try { await ctx.answerCbQuery('Busy — please tap Confirm again.', { show_alert: true }); } catch { /* ignore */ }
        return;
      }
      // Never let the website tables break the original payout flow.
      logger.error(`Duplicate-wallet guard error (continuing with original flow): ${(err as Error).message}`);
      return next();
    }
  });
}
