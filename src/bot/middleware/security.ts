import { Context } from 'telegraf';
import { config } from '../../config';
import { checkRateLimit, getUserSession, clearUserSession } from '../../services/redis';
import { maintenance } from '../../services/maintenance';
import {
  MaintenanceCheckInput,
  isBlockedDuringMaintenance,
  shouldClearSessionOnBlock,
} from '../../services/maintenance-policy';
import { formatMaintenanceMessage } from '../messages';
import { maintenanceKeyboard } from '../keyboards/main';
import { editMainMessage } from '../utils/editMainMessage';
import { logger } from '../../utils/logger';
import { broadcastService } from '../../services/broadcast';
import { e } from '../../utils/emoji';

const ADMIN_IDS = new Set(config.ADMIN_TELEGRAM_IDS);

export async function securityMiddleware(ctx: Context, next: () => Promise<void>): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const telegramId = from.id.toString();

  // Any interaction = the user is in the chat and has seen pending broadcasts:
  // start their auto-delete countdown. Runs BEFORE the maintenance gate so it
  // also works for maintenance announcements. Fire-and-forget, never throws.
  void broadcastService.onUserActivity(telegramId);

  // Maintenance mode (admins bypass). State comes from the database (cached
  // for ~2s), NOT from the environment. Runs first so stale inline keyboards,
  // old wizard sessions and deep links are all re-checked on every update.
  if (!ADMIN_IDS.has(telegramId) && (await maintenance.isEnabled())) {
    if (await blockedByMaintenance(ctx, telegramId)) return;
  }

  // Rate limiting
  const allowed = await checkRateLimit(`user:${telegramId}`, 30, 60000); // 30 requests/minute
  if (!allowed) {
    logger.warn(`Rate limit hit for user ${telegramId}`);
    await ctx.reply(`${e('warning')} Too many requests. Please slow down.`);
    return;
  }

  // Check if user is banned
  const user = await (await import('../../database')).prisma.user.findUnique({
    where: { telegramId },
    select: { status: true },
  });

  if (user?.status === 'BANNED') {
    await ctx.reply('Your account has been suspended.');
    return;
  }

  await next();
}

export function isAdmin(ctx: Context): boolean {
  return ADMIN_IDS.has(ctx.from?.id.toString() || '');
}

/**
 * Returns true (and answers the user) when this non-admin update must not run
 * because maintenance is ON. Only the Back button proceeds.
 */
async function blockedByMaintenance(ctx: Context, telegramId: string): Promise<boolean> {
  const cbData = (ctx.callbackQuery as { data?: string } | undefined)?.data;
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : undefined;

  let input: MaintenanceCheckInput = { type: 'other' };
  let sessionState: string | null = null;

  if (ctx.callbackQuery) {
    input = { type: 'callback', data: cbData ?? '' };
  } else if (typeof text === 'string') {
    try {
      const session = await getUserSession(telegramId);
      sessionState = (session?.state as string | undefined) ?? null;
    } catch (err) {
      // Fail closed while maintenance is active: treat as "mid-flow".
      logger.warn(`Session read failed during maintenance for ${telegramId}: ${(err as Error).message}`);
      sessionState = 'unknown';
    }
    input = { type: 'text', text, sessionState };
  }

  if (!isBlockedDuringMaintenance(input)) return false;

  logger.info(`[maintenance] blocked ${input.type} from ${telegramId}`);

  try {
    if (ctx.callbackQuery) {
      // Stop the loading spinner silently, then turn the tapped message
      // itself into the maintenance screen (edit, never a new message).
      await ctx.answerCbQuery().catch(() => undefined);
      await showMaintenanceScreen(ctx);
      return true;
    }

    if (shouldClearSessionOnBlock(sessionState)) {
      await clearUserSession(telegramId);
    }
    try { await ctx.deleteMessage(); } catch { /* keep chat tidy, best effort */ }

    await showMaintenanceScreen(ctx);
  } catch (err) {
    logger.warn(`Failed to send maintenance notice to ${telegramId}: ${(err as Error).message}`);
  }
  return true;
}

function isNotModified(err: unknown): boolean {
  const d = (err as any)?.response?.description ?? (err as Error)?.message ?? '';
  return typeof d === 'string' && d.toLowerCase().includes('not modified');
}

/** Edits the tapped message into the maintenance screen (Back + channel link). */
async function showMaintenanceScreen(ctx: Context): Promise<void> {
  const text = formatMaintenanceMessage();
  const keyboard = maintenanceKeyboard();
  const extra = { parse_mode: 'HTML' as const, reply_markup: keyboard.reply_markup };

  if (ctx.callbackQuery) {
    try { await ctx.editMessageCaption(text, extra); return; }
    catch (err) { if (isNotModified(err)) return; }
    try { await ctx.editMessageText(text, extra); return; }
    catch (err) { if (isNotModified(err)) return; }
  }
  // Text update or tapped message not editable: edit the stored main message.
  await editMainMessage(ctx, text, keyboard);
  }
