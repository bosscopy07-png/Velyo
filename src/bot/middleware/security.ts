import { Context } from 'telegraf';
import { config } from '../../config';
import { checkRateLimit } from '../../services/redis';
import { logger } from '../../utils/logger';
import { e } from '../../utils/emoji';

const ADMIN_IDS = new Set(config.ADMIN_TELEGRAM_IDS);

export async function securityMiddleware(ctx: Context, next: () => Promise<void>): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const telegramId = from.id.toString();

  // Maintenance mode check (admins bypass)
  if (config.MAINTENANCE_MODE && !ADMIN_IDS.has(telegramId)) {
    await ctx.reply(
      `${e('warning')} <b>MAINTENANCE MODE</b>\n\n` +
      `VEYLO is currently under maintenance. Please check back later.`,
      { parse_mode: 'HTML' }
    );
    return;
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
