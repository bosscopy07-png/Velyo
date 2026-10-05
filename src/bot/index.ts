import { Telegraf } from 'telegraf';
import { config } from '../config';
import { logger } from '../utils/logger';
import { securityMiddleware } from './middleware/security';
import { handleStart } from './commands/start';
import { handleClaim } from './commands/claim';
import { registerCallbacks } from './callbacks';
import { registerUpgradeCallbacks } from './callbacks/upgrade';
import { registerTextHandlers } from './handlers/text';
import { registerAdminCommands } from '../admin/commands';
import { registerAdminUpgrade } from '../admin/upgrade';
import { registerBroadcastAdmin } from '../admin/broadcast';
import { registerUserAdmin } from '../admin/users';
import { broadcastService } from '../services/broadcast';
import { depositSessionService } from '../services/deposit-session';
import { treasuryMonitor } from '../services/treasury';
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
registerUpgradeCallbacks(bot);
registerTextHandlers(bot);
registerAdminCommands(bot);
registerAdminUpgrade(bot);
registerBroadcastAdmin(bot);
registerUserAdmin(bot);
broadcastService.start(bot.telegram);

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

// ───────────────────────── In-process background jobs ─────────────────────────
// RPC POLICY (UPGRADE): the ONLY recurring chain contact is the deposit
// session's LIGHT monitor — and only while a session is live (auto-off at
// its 30-minute expiry). Everything else is DB-only or user/job-triggered.

// Deposit sessions: DB-only expiry sweeps + light monitoring of LIVE
// sessions (1/min, bounded batch). Zero RPC when no session is active.
depositSessionService.start();

// Claim expiry: DB-only.
claimExpiry.start();

// Balance integrity: DB-only watchdog (audit rows, no mutation, debounced).
balanceSync.start();

// Treasury health alerts: recurring RPC (payout-wallet gas + treasury USDT
// every 5 min). OFF by default — enable with ENABLE_TREASURY_MONITOR=true
// if you want low-balance alerts; monitoring is not required for operation.
if (config.ENABLE_TREASURY_MONITOR) {
  treasuryMonitor.start((message) => {
    for (const adminId of config.ADMIN_TELEGRAM_IDS) {
      bot.telegram.sendMessage(adminId, message, { parse_mode: 'HTML' }).catch((err) => {
        logger.error(`Treasury alert to ${adminId} failed: ${(err as Error).message}`);
      });
    }
  });
} else {
  logger.info('Treasury monitor DISABLED — no recurring RPC (enable with ENABLE_TREASURY_MONITOR=true if wanted)');
}

// NOTE: the legacy per-user depositMonitor is NOT started here at all.
// services/deposit-monitor.ts and workers/deposit.ts are dead code kept
// only for history — the DepositMonitor table remains in the DB for audit.
// (If you kept the ENABLE_LEGACY_DEPOSIT_MONITOR gate instead, ensure it is
//  false; deleting the import + gate entirely is the recommended final state.)

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
