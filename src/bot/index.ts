import { Telegraf } from 'telegraf';
import express from 'express';
import type { Server } from 'http';
import { config } from './config';
import { logger } from './utils/logger';
import { securityMiddleware } from './middleware/security';
import { handleStart } from './commands/start';
import { handleClaim } from './commands/claim';
import { registerCallbacks } from './callbacks';
import { registerTextHandlers } from './handlers/text';
import { registerAdminCommands } from './admin/commands';
import { depositMonitor } from './services/deposit-monitor';
import { claimExpiry } from './services/claim-expiry';
import { balanceSync } from './services/balance-sync';
import { prisma } from './database';
import { redis } from './services/redis';
import './workers/payout';
import './workers/cleanup';

const bot = new Telegraf(config.BOT_TOKEN);

// ─── Middleware ────────────────────────────────────────────────────────────
bot.use(securityMiddleware);

// ─── Commands ──────────────────────────────────────────────────────────────
bot.command('start', handleStart);
bot.command('claim', handleClaim); // manual giveaway claim (fallback for broken deep links)

// ─── Callbacks, text & admin ───────────────────────────────────────────────
registerCallbacks(bot);
registerTextHandlers(bot);
registerAdminCommands(bot);

// ─── Global error handling ─────────────────────────────────────────────────
bot.catch((err: unknown, ctx: { reply: (text: string) => Promise<unknown> }) => {
  logger.error('Bot error:', err);
  try {
    void ctx.reply('⚠️ An unexpected error occurred. Our team has been notified.');
  } catch { /* ignore reply failures */ }
});

// ─── Lifecycle ─────────────────────────────────────────────────────────────
let httpServer: Server | null = null;

async function startBot(): Promise<void> {
  if (config.WEBHOOK_URL) {
    const app = express();
    app.use(express.json());
    app.use(await bot.createWebhook({ domain: config.WEBHOOK_URL }));

    httpServer = app.listen(config.WEBHOOK_PORT, () => {
      logger.info(`Webhook server running on port ${config.WEBHOOK_PORT}`);
    });
    logger.info('Bot started in webhook mode');
  } else {
    await bot.launch();
    logger.info('Bot started in polling mode');
  }
}

function startBackgroundJobs(): void {
  // In-process background jobs (single service deployment, e.g. Render)
  depositMonitor.start();
  claimExpiry.start();
  balanceSync.start();
}

async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down...`);

  try {
    await bot.stop(signal);
  } catch (err) {
    logger.error('Error while stopping bot:', err);
  }

  if (httpServer) {
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  }

  await prisma.$disconnect().catch(() => {});
  await redis.quit().catch(() => {});

  process.exit(0);
}

async function main(): Promise<void> {
  try {
    await startBot();
    startBackgroundJobs();
  } catch (err) {
    logger.error('Failed to start bot:', err);
    process.exit(1);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

void main();
  
