import { Telegraf } from 'telegraf';
import { config } from '../config';
import { logger } from '../utils/logger';
import { securityMiddleware } from './middleware/security';
import { handleStart } from './commands/start';
import { registerCallbacks } from './callbacks';
import { registerTextHandlers } from './handlers/text';
import { registerAdminCommands } from '../admin/commands';
import express from 'express';
import type { Server } from 'http';

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

let pollingStarted = false;
let httpServer: Server | null = null;

// Launch
async function startBot(): Promise<void> {
  try {
    if (config.WEBHOOK_URL) {
      const app = express();
      app.use(express.json());
      app.use(await bot.createWebhook({ domain: config.WEBHOOK_URL }));

      httpServer = app.listen(config.WEBHOOK_PORT, () => {
        logger.info(`Webhook server running on port ${config.WEBHOOK_PORT}`);
      });
      // In webhook mode Telegraf has no polling loop to stop;
      // graceful shutdown = close the HTTP server (handled below).
    } else {
      await bot.launch();
      pollingStarted = true;
      logger.info('Bot started in polling mode');
    }
  } catch (err) {
    logger.error('Failed to start bot:', err);
    process.exit(1);
  }
}

startBot();

// Graceful shutdown — bot.stop() is only valid in long-polling mode;
// in webhook mode we close the express server instead.
async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down...`);

  if (pollingStarted) {
    try {
      await bot.stop(signal);
    } catch (err) {
      logger.error('Error while stopping bot:', err);
    }
  }

  if (httpServer) {
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  }

  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
