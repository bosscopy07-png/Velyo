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
import { prisma } from '../database';
import { getUserSession } from '../services/redis';
import { setPayoutNotifier } from '../workers/payout';
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
// RPC POLICY: the ONLY recurring chain contact is the deposit session's
// LIGHT monitor — only while a session is live, auto-off at its 30-minute
// expiry. Everything else is DB-only or user/job-triggered.

depositSessionService.start();

// Claim expiry: DB-only.
claimExpiry.start();

// Balance integrity: DB-only watchdog (audit rows, no mutation, debounced).
balanceSync.start();

// Treasury health alerts: recurring RPC every 5 min. OFF by default.
if (config.ENABLE_TREASURY_MONITOR) {
  treasuryMonitor.start((message) => {
    for (const adminId of config.ADMIN_TELEGRAM_IDS) {
      bot.telegram.sendMessage(adminId, message, { parse_mode: 'HTML' }).catch((err) => {
        logger.error(`Treasury alert to ${adminId} failed: ${(err as Error).message}`);
      });
    }
  });
} else {
  logger.info('Treasury monitor DISABLED (enable with ENABLE_TREASURY_MONITOR=true)');
}

// ── Deposit credited notifier: AUTO-EDIT, never a new message ──
depositSessionService.setNotifier(({ userId, amount, asset }) => {
  void (async () => {
    try {
      const u = await prisma.user.findUnique({ where: { id: userId } });
      if (!u?.chatId || !u.mainMessageId) return;
      const sess = await getUserSession(u.telegramId);
      if (sess?.state) return; // user mid-flow — don't touch their screen

      const text =
        `${'✅'} <b>DEPOSIT CREDITED</b>\n\n` +
        `Your deposit of <b>${amount} ${asset}</b> was detected and added to your VEYLO balance automatically.\n\n` +
        `No action needed.`;
      const reply_markup = {
        inline_keyboard: [[{ text: '💼 Open Wallet', callback_data: 'wallet' }]],
      };
      const chatId = u.chatId;
      const msgId = parseInt(u.mainMessageId, 10);
      if (Number.isNaN(msgId)) return;

      try {
        await bot.telegram.editMessageCaption(chatId, msgId, undefined, text, { parse_mode: 'HTML', reply_markup });
      } catch {
        try {
          await bot.telegram.editMessageText(chatId, msgId, undefined, text, { parse_mode: 'HTML', reply_markup });
        } catch { /* message gone — silent */ }
      }
    } catch { /* notifier is best-effort */ }
  })();
});

// ── Payout notifier: AUTO-EDIT the claimant's message to REWARD PAID ──
setPayoutNotifier(({ userId, amount, asset, hash }) => {
  void (async () => {
    try {
      const u = await prisma.user.findUnique({ where: { id: userId } });
      if (!u?.chatId || !u.mainMessageId) return;
      const sess = await getUserSession(u.telegramId);
      if (sess?.state) return;

      const text =
        `${'🏆'} <b>REWARD PAID</b>\n\n` +
        `Your giveaway reward of <b>${amount} ${asset}</b> has been sent on-chain.\n\n` +
        `Tx: <code>${hash}</code>`;
      const reply_markup = {
        inline_keyboard: [[{ text: '💼 Open Wallet', callback_data: 'wallet' }]],
      };
      const chatId = u.chatId;
      const msgId = parseInt(u.mainMessageId, 10);
      if (Number.isNaN(msgId)) return;

      try {
        await bot.telegram.editMessageCaption(chatId, msgId, undefined, text, { parse_mode: 'HTML', reply_markup });
      } catch {
        try {
          await bot.telegram.editMessageText(chatId, msgId, undefined, text, { parse_mode: 'HTML', reply_markup });
        } catch { /* message gone — silent */ }
      }
    } catch { /* notifier is best-effort */ }
  })();
});

// NOTE: the legacy per-user depositMonitor is not started here at all.

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
        
