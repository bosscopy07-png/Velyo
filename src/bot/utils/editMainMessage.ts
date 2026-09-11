import { Context } from 'telegraf';
import { prisma } from '../../database';
import { logger } from '../../utils/logger';

export const VEYLO_IMAGE = 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1788789976/file_00000000d1ec81f4adfb8b48d09eb39d_k1fwyl.png';

/**
 * Returns true if the Telegram error means "edit succeeded, nothing changed".
 * This is NOT a failure — treat it as a successful no-op edit.
 */
function isNotModifiedError(err: unknown): boolean {
  const desc = (err as any)?.response?.description ?? (err as Error)?.message ?? '';
  return typeof desc === 'string' && desc.toLowerCase().includes('not modified');
}

/**
 * Universal "edit the main message" helper.
 *
 * Order of operations (edit-only policy):
 *   1. editMessageCaption   (cheapest)
 *   2. editMessageMedia     (handles type changes)
 *   3. delete + send new    (ONLY when editing is genuinely impossible)
 *
 * "message is not modified" counts as SUCCESS at every step.
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

  if (!chatId) {
    logger.warn(`editMainMessage: no chatId for ${telegramId}`);
    return;
  }

  // No main message on record — nothing to edit, must create one
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

  // 1. Try caption edit
  try {
    await ctx.telegram.editMessageCaption(
      chatId,
      messageId,
      undefined,
      caption,
      { parse_mode: 'HTML', reply_markup: keyboard?.reply_markup as any }
    );
    return;
  } catch (err) {
    if (isNotModifiedError(err)) return; // success no-op
    logger.warn(`editMainMessage: caption edit failed for ${telegramId} (msg ${messageId}): ${(err as any)?.response?.description ?? (err as Error).message}`);
  }

  // 2. Try media edit
  try {
    await ctx.telegram.editMessageMedia(
      chatId,
      messageId,
      undefined,
      { type: 'photo', media: VEYLO_IMAGE, caption, parse_mode: 'HTML' },
      { reply_markup: keyboard?.reply_markup as any }
    );
    return;
  } catch (err) {
    if (isNotModifiedError(err)) return; // success no-op
    logger.warn(`editMainMessage: media edit failed for ${telegramId} (msg ${messageId}): ${(err as any)?.response?.description ?? (err as Error).message}`);
  }

  // 3. Editing genuinely impossible — delete old, send new, remember ID
  logger.warn(`editMainMessage: falling back to delete+resend for ${telegramId} (msg ${messageId})`);
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
    
