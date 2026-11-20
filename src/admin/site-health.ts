import { Context } from 'telegraf';
import { config } from '../config';
import { prisma } from '../database';
import { redis } from '../services/redis';
import { formatHealth, siteHealth } from '../web/health';

/** /sitehealth (admin only): is the website healthy, slow, or freshly restarted? */
export function registerSiteHealth(bot: any): void {
  bot.command('sitehealth', async (ctx: Context) => {
    if (!config.ADMIN_TELEGRAM_IDS.includes(ctx.from?.id.toString() ?? '')) return;
    const h = await siteHealth({ db: () => prisma.$queryRaw`SELECT 1`, redis: () => redis.ping() });
    await ctx.reply(formatHealth(h), { parse_mode: 'HTML' });
  });
              }
                    
