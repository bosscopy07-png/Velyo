import { Context } from 'telegraf';
import { prisma } from '../../database';
import { logger } from '../../utils/logger';

export const VEYLO_IMAGE = 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1788789976/file_00000000d1ec81f4adfb8b48d09eb39d_k1fwyl.png';

/**
 * Universal "edit the main message" helper.
 *
 * Order of operations (per product requirement: auto-edit ONLY):
 *   1. Try editMessageCaption  (cheapest)
 *   2. Try editMessageMedia    (type changed)
 *   3. Delete the old main message and send a fresh photo+caption
 *      (only when editing is impossible)
 *
 * If the user has no main message yet, one is created and stored.
 */
export async function editMainMessage(
  ctx: Context,
  caption: string,
  keyboard?: { reply_markup?: unknown }
): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const telegramId = from.id.toString();
  const user = await prisma.user.findUnique({ where: { telegramId } });
  const chatId = ctx.chat?.id ?? (user?.chatId ? parseInt(user.chatId) : undefined);

  if (!chatId) return;

  // No main message on record yet — must create one
  if (!user?.mainMessageId) {
    const msg = await ctx.telegram.sendPhoto(chatId, VEYLO_IMAGE, {
      caption,
      parse_mode: 'HTML',
      reply_markup: keyboard?.reply_markup as any,
    });
    if (user) {
      await prisma.user.update({
        where: { id: user.id },
        data: { mainMessageId: msg.message_id.toString() },
      });
    }
    return;
  }

  const messageId = parseInt(user.mainMessageId);

  // 1. Edit caption
  try {
    await ctx.telegram.editMessageCaption(
      chatId,
      messageId,
      undefined,
      caption,
      { parse_mode: 'HTML', reply_markup: keyboard?.reply_markup as any }
    );
    return;
  } catch {
    // fall through
  }

  // 2. Edit media (handles cases where message type changed)
  try {
    await ctx.telegram.editMessageMedia(
      chatId,
      messageId,
      undefined,
      { type: 'photo', media: VEYLO_IMAGE, caption, parse_mode: 'HTML' },
      { reply_markup: keyboard?.reply_markup as any }
    );
    return;
  } catch {
    // fall through
  }

  // 3. Editing impossible — delete old, send new, remember the new id
  try {
    await ctx.telegram.deleteMessage(chatId, messageId);
  } catch {
    // already deleted or unmodifiable — proceed anyway
  }

  try {
    const msg = await ctx.telegram.sendPhoto(chatId, VEYLO_IMAGE, {
      caption,
      parse_mode: 'HTML',
      reply_markup: keyboard?.reply_markup as any,
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { mainMessageId: msg.message_id.toString() },
    });
  } catch (err) {
    logger.error('editMainMessage: failed to send replacement message:', err);
  }
}
