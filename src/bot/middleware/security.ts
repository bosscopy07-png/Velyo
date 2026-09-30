import { Context, Markup } from 'telegraf';
import { config } from '../../config';
import { checkRateLimit, getUserSession, clearUserSession } from '../../services/redis';
import { maintenance } from '../../services/maintenance';
import {
  MaintenanceCheckInput,
  isBlockedDuringMaintenance,
  shouldClearSessionOnBlock,
} from '../../services/maintenance-policy';
import { formatMaintenanceMessage, MAINTENANCE_ALERT_TEXT } from '../messages';
import { logger } from '../../utils/logger';
import { e } from '../../utils/emoji';

const ADMIN_IDS = new Set(config.ADMIN_TELEGRAM_IDS);

export async function securityMiddleware(ctx: Context, next: () => Promise<void>): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const telegramId = from.id.toString();

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
 * because maintenance is ON. Read-only actions return false and proceed.
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
      await ctx.answerCbQuery(MAINTENANCE_ALERT_TEXT, { show_alert: true });
      return true;
    }

    if (shouldClearSessionOnBlock(sessionState)) {
      await clearUserSession(telegramId);
    }
    try { await ctx.deleteMessage(); } catch { /* keep chat tidy, best effort */ }

    await ctx.reply(formatMaintenanceMessage(), {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.url('📢 Updates', config.COMMUNITY_CHANNEL_URL)]]),
    });
  } catch (err) {
    logger.warn(`Failed to send maintenance notice to ${telegramId}: ${(err as Error).message}`);
  }
  return true;
  }
