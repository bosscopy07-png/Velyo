import { Context } from 'telegraf';
import { prisma } from '../../database';
import { clearUserSession, setUserSession } from '../../services/redis';
import { mainKeyboard, backKeyboard } from '../keyboards/main';
import { formatWelcomeMessage } from '../messages';
import { editMainMessage, VEYLO_IMAGE } from '../utils/editMainMessage';
import { logger } from '../../utils/logger';
import { giveawayService } from '../../services/giveaway';
import { e } from '../../utils/emoji';
import { config } from '../../config';

export async function handleStart(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const telegramId = from.id.toString();
  const isAdmin = config.ADMIN_TELEGRAM_IDS.includes(telegramId);

  // Payload from Telegraf, with a raw-text fallback
  const text = ctx.message && 'text' in ctx.message ? (ctx.message.text as string) : '';
  const m = text.match(/^\/start(?:@\w+)?\s+(\S+)/);
  const startPayload = ((ctx as any).startPayload as string | undefined) ?? m?.[1];

  logger.info(`[start] payload="${startPayload ?? ''}" from ${telegramId}`);

  try {
    let user = await prisma.user.findUnique({
      where: { telegramId },
      include: { wallet: true },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          telegramId,
          username: from.username,
          firstName: from.first_name,
          lastName: from.last_name,
          chatId: ctx.chat?.id.toString(),
          status: 'ACTIVE',
        },
        include: { wallet: true },
      });
      logger.info(`New user registered: ${telegramId}`);
    } else {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          username: from.username,
          firstName: from.first_name,
          lastName: from.last_name,
          chatId: ctx.chat?.id.toString(),
          lastActive: new Date(),
        },
      });
    }

    // NOTE: no eager wallet provisioning. Wallets are created lazily — only
    // when the user taps Wallet/Deposit or creates a giveaway. Giveaway
    // claimants never need one (rewards go to an address they provide).

    if (startPayload?.startsWith('giveaway_')) {
      const code = startPayload.replace('giveaway_', '');
      // FIX: do NOT delete the stored main message here.
      // handleGiveawayDeepLink edits it in place — deleting it first was the
      // cause of the "bad edit" warnings on every step of the claim flow.
      await handleGiveawayDeepLink(ctx, user!.id, code);
      return;
    }

    await clearUserSession(telegramId);

    const caption = formatWelcomeMessage(from.first_name || 'there');
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    await deleteMainMessage(ctx, user!);

    const msg = await ctx.replyWithPhoto(VEYLO_IMAGE, {
      caption,
      parse_mode: 'HTML',
      reply_markup: mainKeyboard(isAdmin).reply_markup,
    });

    await prisma.user.update({
      where: { id: user!.id },
      data: { mainMessageId: msg.message_id.toString() },
    });
  } catch (err) {
    logger.error('Start command error:', err);
    await ctx.reply(`${e('warning')} Something went wrong. Please try /start again.`, { parse_mode: 'HTML' });
  }
}

/** Best-effort deletion of the user's stored main message. */
async function deleteMainMessage(ctx: Context, user: { mainMessageId: string | null }): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId || !user.mainMessageId) return;
  try {
    await ctx.telegram.deleteMessage(chatId, parseInt(user.mainMessageId));
  } catch {
    // already gone or not deletable — non-fatal
  }
}

/** Exported so the /claim command can reuse the exact same claim flow. */
export async function handleGiveawayDeepLink(ctx: Context, userId: string, code: string): Promise<void> {
  try {
    const giveaway = await prisma.giveaway.findUnique({
      where: { secureCode: code },
      include: { claims: true, creator: true },
    });

    // FIX: error/terminal states show a single Back button that returns to
    // the dashboard ('main'), not the full inline main menu.
    if (!giveaway) {
      await editMainMessage(ctx, `${e('warning')} Giveaway not found or expired.`, backKeyboard('main'));
      return;
    }

    await giveawayService.trackAttempt(giveaway.id);

    const existingClaim = await prisma.giveawayClaim.findUnique({
      where: { giveawayId_userId: { giveawayId: giveaway.id, userId } },
    });

    if (existingClaim) {
      if (existingClaim.status === 'PAID') {
        await editMainMessage(
          ctx,
          `${e('check')} You already received your reward for this giveaway!\n\nTx: <code>${existingClaim.payoutTransactionHash || 'Pending'}</code>`,
          backKeyboard('main')
        );
      } else if (existingClaim.status === 'ADDRESS_CONFIRMED' || existingClaim.status === 'QUEUED' || existingClaim.status === 'PROCESSING') {
        await editMainMessage(ctx, `${e('clock')} Your reward is being processed. Please wait.`, backKeyboard('main'));
      } else if (
        existingClaim.status === 'RESERVED' ||
        existingClaim.status === 'ADDRESS_PENDING' ||
        existingClaim.status === 'FAILED'
      ) {
        await promptForAddress(ctx, giveaway.asset, existingClaim.id);
      } else {
        await editMainMessage(ctx, `${e('check')} You already secured a spot in this giveaway!`, backKeyboard('main'));
      }
      return;
    }

    if (giveaway.status === 'FULL') {
      await editMainMessage(
        ctx,
        `${e('warning')} <b>GIVEAWAY FULL</b>\n\nAll available spots have already been claimed.\n\nBetter luck next time.`,
        backKeyboard('main')
      );
      return;
    }

    if (giveaway.status !== 'ACTIVE') {
      await editMainMessage(ctx, `${e('warning')} This giveaway is no longer active.`, backKeyboard('main'));
      return;
    }

    if (giveaway.expiresAt && giveaway.expiresAt < new Date()) {
      await editMainMessage(ctx, `${e('warning')} This giveaway has expired.`, backKeyboard('main'));
      return;
    }

    const result = await giveawayService.claimGiveaway(giveaway.id, userId);

    if (!result.success) {
      await editMainMessage(ctx, `${e('warning')} ${result.reason}`, backKeyboard('main'));
      return;
    }

    const claim = await prisma.giveawayClaim.findUnique({
      where: { giveawayId_userId: { giveawayId: giveaway.id, userId } },
    });

    await setUserSession(ctx.from!.id.toString(), {
      state: 'awaiting_payout_address',
      claimId: claim!.id,
      asset: giveaway.asset,
    });

    await promptForAddress(ctx, giveaway.asset, claim!.id);
  } catch (err) {
    logger.error('Giveaway deep link error:', err);
    await editMainMessage(ctx, `${e('warning')} Unable to process giveaway claim.`, backKeyboard('main'));
  }
}

/**
 * Address prompt — SPOT SECURED celebration + instructions with ONLY a Back
 * button. No main menu to mis-tap while the bot waits for the address.
 */
async function promptForAddress(ctx: Context, asset: string, claimId: string): Promise<void> {
  await setUserSession(ctx.from!.id.toString(), {
    state: 'awaiting_payout_address',
    claimId,
    asset,
  });

  await editMainMessage(
    ctx,
    `${e('party')} <b>SPOT SECURED!</b>\n\n` +
    `Reward: <b>${asset}</b> payout pending.\n\n` +
    `${e('deposit')} <b>SEND YOUR ${asset} BEP20 WALLET ADDRESS</b>\n\n` +
    `Type or paste the address below.\n\n` +
    `⚠️ Must support BNB Smart Chain (BEP20)`,
    backKeyboard('main')
  );
      }
                            
