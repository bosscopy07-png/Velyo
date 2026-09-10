import { Context } from 'telegraf';
import { prisma } from '../../database';
import { walletService } from '../../services/wallet';
import { setUserSession, clearUserSession } from '../../services/redis';
import { mainKeyboard } from '../keyboards/main';
import { formatWelcomeMessage } from '../messages';
import { logger } from '../../utils/logger';
import { giveawayService } from '../../services/giveaway';
import { Markup } from 'telegraf';
import { e } from '../../utils/emoji';
import { config } from '../../config';

const VEYLO_IMAGE = 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1788789976/file_00000000d1ec81f4adfb8b48d09eb39d_k1fwyl.png';

export async function handleStart(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const telegramId = from.id.toString();
  const startPayload = (ctx as any).startPayload as string | undefined;

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

      // Auto-create wallet
      await walletService.createWallet(user.id);
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

    // Handle deep links
    if (startPayload?.startsWith('giveaway_')) {
      const code = startPayload.replace('giveaway_', '');
      await handleGiveawayDeepLink(ctx, user.id, code);
      return;
    }

    // Clear any stale session
    await clearUserSession(telegramId);

    const caption = formatWelcomeMessage(from.first_name || 'there');
    const chatId = ctx.chat?.id;

    if (!chatId) return;

    // Check for existing main message
    if (user.mainMessageId) {
      try {
        await ctx.telegram.editMessageMedia(
          chatId,
          parseInt(user.mainMessageId),
          undefined,
          {
            type: 'photo',
            media: VEYLO_IMAGE,
            caption,
            parse_mode: 'HTML',
          },
          { reply_markup: mainKeyboard.reply_markup }
        );
        return;
      } catch {
        // Message was deleted or unavailable, send new one
      }
    }

    // Send new main message
    const msg = await ctx.replyWithPhoto(VEYLO_IMAGE, {
      caption,
      parse_mode: 'HTML',
      reply_markup: mainKeyboard.reply_markup,
    });

    await prisma.user.update({
      where: { id: user.id },
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
      await ctx.reply(`${e('warning')} Giveaway not found or expired.`);
      return;
    }

    // Track view
    await giveawayService.trackAttempt(giveaway.id);

    const existingClaim = await prisma.giveawayClaim.findUnique({
      where: { giveawayId_userId: { giveawayId: giveaway.id, userId } },
    });

    if (existingClaim) {
      if (existingClaim.status === 'PAID') {
        await ctx.reply(
          `${e('check')} You already received your reward for this giveaway!\n\n` +
          `Tx: <code>${existingClaim.payoutTransactionHash || 'Pending'}</code>`,
          { parse_mode: 'HTML' }
        );
      } else if (existingClaim.status === 'ADDRESS_CONFIRMED' || existingClaim.status === 'QUEUED' || existingClaim.status === 'PROCESSING') {
        await ctx.reply(`${e('clock')} Your reward is being processed. Please wait.`);
      } else if (existingClaim.status === 'ADDRESS_PENDING') {
        await promptForAddress(ctx, giveaway.asset, existingClaim.id);
      } else {
        await ctx.reply(`${e('check')} You already secured a spot in this giveaway!`);
      }
      return;
    }

    if (giveaway.status === 'FULL') {
      await ctx.reply(
        `${e('warning')} <b>GIVEAWAY FULL</b>\n\n` +
        `All available spots have already been claimed.\n\nBetter luck next time. ${e('lightning')}`,
        { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([
          [Markup.button.url(`${e('rocket')} Explore VEYLO`, `https://t.me/${config.BOT_USERNAME}`)]
        ]).reply_markup }
      );
      return;
    }

    if (giveaway.status !== 'ACTIVE') {
      await ctx.reply(`${e('warning')} This giveaway is no longer active.`);
      return;
    }

    if (giveaway.expiresAt && giveaway.expiresAt < new Date()) {
      await ctx.reply(`${e('warning')} This giveaway has expired.`);
      return;
    }

    // Attempt atomic claim
    const result = await giveawayService.claimGiveaway(giveaway.id, userId);

    if (!result.success) {
      await ctx.reply(`${e('warning')} ${result.reason}`);
      return;
    }

    // Success! Prompt for address
    await ctx.reply(
      `${e('party')} <b>SPOT SECURED!</b>\n\n` +
      `Reward: <b>${giveaway.amountPerUser} ${giveaway.asset}</b>\n\n` +
      `Your reward will be sent after you provide your ${giveaway.asset} BEP20 address.\n\n` +
      `⚠️ Must support BNB Smart Chain (BEP20)`,
      { parse_mode: 'HTML' }
    );

    await setUserSession(ctx.from!.id.toString(), {
      state: 'awaiting_payout_address',
      claimId: (await prisma.giveawayClaim.findUnique({
        where: { giveawayId_userId: { giveawayId: giveaway.id, userId } }
      }))!.id,
      asset: giveaway.asset,
    });

  } catch (err) {
    logger.error('Giveaway deep link error:', err);
    await ctx.reply(`${e('warning')} Unable to process giveaway link.`);
  }
}

async function promptForAddress(ctx: Context, asset: string, claimId: string): Promise<void> {
  await setUserSession(ctx.from!.id.toString(), {
    state: 'awaiting_payout_address',
    claimId,
    asset,
  });
  
  await ctx.reply(
    `📥 Send your ${asset} BEP20 wallet address.\n\n` +
    `⚠️ Must support BNB Smart Chain (BEP20)`
  );
}
