import { Context } from 'telegraf';
import { prisma } from '../../database';
import { walletService } from '../../services/wallet';
import { clearUserSession, setUserSession } from '../../services/redis';
import { mainKeyboard } from '../keyboards/main';
import { formatWelcomeMessage } from '../messages';
import { editMainMessage, VEYLO_IMAGE } from '../utils/editMainMessage';
import { logger } from '../../utils/logger';
import { giveawayService } from '../../services/giveaway';
import { Markup } from 'telegraf';
import { e } from '../../utils/emoji';
import { config } from '../../config';

export async function handleStart(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const telegramId = from.id.toString();
  const startPayload = (ctx as any).startPayload as string | undefined;
  const isAdmin = config.ADMIN_TELEGRAM_IDS.includes(telegramId);

  try {
    // Find or create user
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

    // FIX: always guarantee a wallet exists for this user.
    // Previously, an existing user without a wallet stayed wallet-less forever,
    // which is what made the bot appear to "create a new wallet" / lose the old one.
    if (!user.wallet) {
      await walletService.createWallet(user.id);
      logger.info(`Wallet provisioned for existing user ${telegramId}`);
      user = await prisma.user.findUnique({
        where: { telegramId },
        include: { wallet: true },
      });
    }

    // Handle deep links
    if (startPayload?.startsWith('giveaway_')) {
      const code = startPayload.replace('giveaway_', '');
      await handleGiveawayDeepLink(ctx, user!.id, code);
      return;
    }

    await clearUserSession(telegramId);

    const caption = formatWelcomeMessage(from.first_name || 'there');
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // Try to edit the existing main message; if impossible the helper
    // deletes it and sends a fresh one (edit-only policy).
    if (user!.mainMessageId) {
      try {
        await ctx.telegram.editMessageMedia(
          chatId,
          parseInt(user!.mainMessageId),
          undefined,
          {
            type: 'photo',
            media: VEYLO_IMAGE,
            caption,
            parse_mode: 'HTML',
          },
          { reply_markup: mainKeyboard(isAdmin).reply_markup }
        );
        return;
      } catch {
        // fall through: edit not possible → delete old, send new below
        try {
          await ctx.telegram.deleteMessage(chatId, parseInt(user!.mainMessageId));
        } catch {
          // already gone
        }
      }
    }

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
    await ctx.reply(`${e('warning')} Something went wrong. Please try /start again.`);
  }
}

async function handleGiveawayDeepLink(ctx: Context, userId: string, code: string): Promise<void> {
  try {
    const giveaway = await prisma.giveaway.findUnique({
      where: { secureCode: code },
      include: { claims: true, creator: true },
    });

    if (!giveaway) {
      await editMainMessage(ctx, `${e('warning')} Giveaway not found or expired.`, mainKeyboard(false));
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
          mainKeyboard(false)
        );
      } else if (existingClaim.status === 'ADDRESS_CONFIRMED' || existingClaim.status === 'QUEUED' || existingClaim.status === 'PROCESSING') {
        await editMainMessage(ctx, `${e('clock')} Your reward is being processed. Please wait.`, mainKeyboard(false));
      } else if (existingClaim.status === 'ADDRESS_PENDING') {
        await promptForAddress(ctx, giveaway.asset, existingClaim.id);
      } else {
        await editMainMessage(ctx, `${e('check')} You already secured a spot in this giveaway!`, mainKeyboard(false));
      }
      return;
    }

    if (giveaway.status === 'FULL') {
      await editMainMessage(
        ctx,
        `${e('warning')} <b>GIVEAWAY FULL</b>\n\nAll available spots have already been claimed.\n\nBetter luck next time. ${e('lightning')}`,
        mainKeyboard(false)
      );
      return;
    }

    if (giveaway.status !== 'ACTIVE') {
      await editMainMessage(ctx, `${e('warning')} This giveaway is no longer active.`, mainKeyboard(false));
      return;
    }

    if (giveaway.expiresAt && giveaway.expiresAt < new Date()) {
      await editMainMessage(ctx, `${e('warning')} This giveaway has expired.`, mainKeyboard(false));
      return;
    }

    const result = await giveawayService.claimGiveaway(giveaway.id, userId);

    if (!result.success) {
      await editMainMessage(ctx, `${e('warning')} ${result.reason}`, mainKeyboard(false));
      return;
    }

    await editMainMessage(
      ctx,
      `${e('party')} <b>SPOT SECURED!</b>\n\nReward: <b>${giveaway.amountPerUser} ${giveaway.asset}</b>\n\nYour reward will be sent after you provide your ${giveaway.asset} BEP20 address.\n\n⚠️ Must support BNB Smart Chain (BEP20)`,
      mainKeyboard(false)
    );

    await setUserSession(ctx.from!.id.toString(), {
      state: 'awaiting_payout_address',
      claimId: (await prisma.giveawayClaim.findUnique({
        where: { giveawayId_userId: { giveawayId: giveaway.id, userId } },
      }))!.id,
      asset: giveaway.asset,
    });
  } catch (err) {
    logger.error('Giveaway deep link error:', err);
    await editMainMessage(ctx, `${e('warning')} Unable to process giveaway link.`, mainKeyboard(false));
  }
}

async function promptForAddress(ctx: Context, asset: string, claimId: string): Promise<void> {
  await setUserSession(ctx.from!.id.toString(), {
    state: 'awaiting_payout_address',
    claimId,
    asset,
  });

  await editMainMessage(
    ctx,
    `📥 Send your ${asset} BEP20 wallet address.\n\n⚠️ Must support BNB Smart Chain (BEP20)`,
    { reply_markup: undefined }
  );
                                         }
      
