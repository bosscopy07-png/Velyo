import { Telegraf } from 'telegraf';
import { config } from '../config';
import { logger } from '../utils/logger';
import { securityMiddleware } from './middleware/security';
import { handleStart } from './commands/start';
import { handleClaim } from './commands/claim';
import { registerCallbacks } from './callbacks';
import { registerTextHandlers } from './handlers/text';
import { registerAdminCommands } from '../admin/commands';
import { depositMonitor } from '../services/deposit-monitor';
import { claimExpiry } from '../services/claim-expiry';
import { balanceSync } from '../services/balance-sync';
import '../workers/payout';
import '../workers/cleanup';
import express from 'express';
import type { Server } from 'http';

// handlerTimeout: fail a hung update at 45s instead of Telegraf's default
// 90s. Combined with the 15s RPC timeouts in blockchain.ts, a dead node now
// produces a fast, caught error — not a 90-second frozen tap.
const bot = new Telegraf(config.BOT_TOKEN, { handlerTimeout: 45000 });

// Middleware
bot.use(securityMiddleware);

// Commands
bot.command('start', handleStart);
bot.command('claim', handleClaim);

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

async function startBot(): Promise<void> {
  try {
    if (config.WEBHOOK_URL) {
      const app = express();
      app.use(express.json());
      app.use(await bot.createWebhook({ domain: config.WEBHOOK_URL }));

      httpServer = app.listen(config.WEBHOOK_PORT, () => {
        logger.info(`Webhook server running on port ${config.WEBHOOK_PORT}`);
      });
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

// In-process background jobs
depositMonitor.start();
claimExpiry.start();
balanceSync.start();

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
