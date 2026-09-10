import { Telegraf } from 'telegraf';
import { config } from '../config';
import { logger } from '../utils/logger';
import { securityMiddleware } from './middleware/security';
import { handleStart } from './commands/start';
import { registerCallbacks } from './callbacks';
import { registerTextHandlers } from './handlers/text';
import { registerAdminCommands } from '../admin/commands';
import express from 'express';

const bot = new Telegraf(config.BOT_TOKEN);

// Middleware
bot.use(securityMiddleware);

// Commands
bot.command('start', handleStart);

// Callbacks & Text
registerCallbacks(bot);
registerTextHandlers(bot);
registerAdminCommands(bot);

// Error handling
bot.catch((err: unknown, ctx: any) => {
  logger.error('Bot error:', err);
  try {
    ctx.reply(`${'⚠️'} An unexpected error occurred. Our team has been notified.`);
  } catch {}
});

let botStarted = false;

// Launch
async function startBot(): Promise<void> {
  try {
    if (config.WEBHOOK_URL) {
      const app = express();
      app.use(express.json());
      app.use(await bot.createWebhook({ domain: config.WEBHOOK_URL }));

      app.listen(config.WEBHOOK_PORT, () => {
        logger.info(`Webhook server running on port ${config.WEBHOOK_PORT}`);
      });
    } else {
      await bot.launch();
      logger.info('Bot started in polling mode');
    }
    botStarted = true;
  } catch (err) {
    logger.error('Failed to start bot:', err);
    process.exit(1);
  }
}

startBot();

// Graceful shutdown — only stop the bot if launch completed successfully,
// otherwise Telegraf throws "Bot is not running!".
async function shutdown(signal: string): Promise<void> {
  if (botStarted) {
    try {
      await bot.stop(signal);
    } catch (err) {
      logger.error('Error while stopping bot:', err);
    }
  }
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
