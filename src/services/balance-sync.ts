import { prisma } from '../database';
import { config } from '../config';
import { logger } from '../utils/logger';
import cron from 'node-cron';
import {
  SYNC_ASSETS,
  SYNC_TOLERANCE,
  gatherBalanceComponents,
  solveAvailableForOnChain,
  type BalanceComponents,
} from './balance-accounting';

/**
 * ============================================================================
 * WHY THIS FILE NO LONGER TOUCHES `availableBalance`
 * ============================================================================
 *
 * This job used to auto-credit (or auto-debit) `availableBalance` by the raw
 * gap between the live on-chain balance and a computed "expected" figure,
 * with NO check against the deposit monitor's own ledger (`DepositMonitor`).
 *
 * That created real, reproducible phantom credits: a deposit lands on-chain,
 * this job runs BEFORE the deposit monitor's cron has credited it (normal
 * detection window is up to ~90s, much longer during an RPC stall/backlog),
 * sees `onChain > expected`, and "self-heals" by minting the gap as a brand
 * new, txHash-less "chain-sync" deposit. Minutes later the deposit monitor
 * ALSO credits the same real Transfer event through its own (correct,
 * idempotent) path. Net result: one real deposit, credited twice.
 *
 * A blockchain deposit must be credited in exactly one place:
 * `deposit-monitor.ts::processDeposit` / `claimAndCredit`, guarded by the
 * `DepositMonitor` table and the `Transaction.idempotencyKey` unique
 * constraint. This job's only job now is to DETECT drift and tell a human,
 * never to mint or burn balance on its own.
 * ============================================================================
 */

// Every 5 minutes at second 30 — deliberately offset from the deposit monitor
// (second 0/30 of every minute) so the two never burst the RPC simultaneously.
const CRON_SCHEDULE = '30 */5 * * * *';

/**
 * A deposit can be legitimately "in flight" — seen on-chain, not yet
 * credited — for one full detection cycle plus its confirmation wait.
 * Anything newer than this grace window is not a discrepancy, it's just
 * the deposit monitor doing its job; skip it rather than flag it.
 */
const IN_FLIGHT_GRACE_MS = 20 * 60 * 1000; // 20 minutes, comfortably covers 15-confirmation waits

class BalanceSyncService {
  private isRunning = false;

  start(): void {
    cron.schedule(CRON_SCHEDULE, () => void this.syncAll());
    logger.info('Balance drift monitor started (detect-and-flag only, every 5 min)');
  }

  private async syncAll(): Promise<void> {
    if (this.isRunning) return; // prevent overlapping runs
    this.isRunning = true;

    try {
      const wallets = await prisma.wallet.findMany({
        where: {
          status: 'ACTIVE',
          // Operator wallet is synced explicitly via adjustOperatorBalance —
          // its on-chain balance legitimately differs from any user ledger.
          address: { not: config.PLATFORM_FEE_WALLET },
        },
      });

      let rateLimited = false;
      for (const wallet of wallets) {
        for (const asset of SYNC_ASSETS) {
          try {
            await this.checkOne(wallet.userId, wallet.address, asset);
          } catch (err) {
            const msg = (err as Error).message ?? '';
            if (msg.includes('rate limit') || msg.includes('-32005') || msg.includes('limit exceeded')) {
              rateLimited = true;
              logger.warn('Balance drift check: rate limited — aborting this cycle, next window retries.');
              break;
            }
            logger.error(`Balance drift check failed for ${wallet.address} ${asset}: ${msg}`);
          }
          // Pace calls so wallets don't burst the RPC in one batch
          await sleep(400);
        }
        if (rateLimited) break;
        await sleep(500);
      }
    } catch (err) {
      logger.error('Balance drift run failed:', err);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Compares live on-chain balance to what the app believes it should be.
   * NEVER mutates `availableBalance`. Any discrepancy beyond dust tolerance
   * is either (a) a deposit still in flight — skipped, or (b) genuinely
   * unexplained — flagged via AuditLog + a best-effort admin alert.
   */
  private async checkOne(userId: string, address: string, asset: (typeof SYNC_ASSETS)[number]): Promise<void> {
    const ctx = await gatherBalanceComponents(userId, address, asset);

    const tol = SYNC_TOLERANCE[asset] ?? 0.000001;
    const diff = ctx.onChain - ctx.expected;

    if (Math.abs(diff) < tol) return;

    if (await this.hasInFlightDeposit(address, asset)) {
      logger.info(
        `Balance drift (${asset}) ${address}: diff ${diff.toFixed(6)} — deposit in flight, skipping this cycle.`
      );
      return;
    }

    await this.flagDiscrepancy(ctx, diff);
  }

  /** A deposit the monitor has already seen but not yet finished crediting. */
  private async hasInFlightDeposit(address: string, asset: string): Promise<boolean> {
    const inFlight = await prisma.depositMonitor.findFirst({
      where: {
        address,
        asset,
        status: { in: ['PENDING', 'CONFIRMING', 'CONFIRMED'] },
        createdAt: { gte: new Date(Date.now() - IN_FLIGHT_GRACE_MS) },
      },
    });
    return !!inFlight;
  }

  /**
   * Records the discrepancy for a human to investigate. Deliberately does
   * NOT touch `Balance` — minting money automatically was the bug; a
   * negative diff (app believes more exists than the chain shows) is just
   * as dangerous to "auto-fix" as a positive one, since it would silently
   * debit a user who may be owed an explanation instead.
   */
  private async flagDiscrepancy(ctx: BalanceComponents, diff: number): Promise<void> {
    const suggestedAvailable = solveAvailableForOnChain(ctx);

    logger.warn(
      `[BALANCE DRIFT] ${ctx.asset} ${ctx.address} (user ${ctx.userId}): ` +
        `onChain=${ctx.onChain} expected=${ctx.expected.toFixed(6)} diff=${diff > 0 ? '+' : ''}${diff.toFixed(6)} ` +
        `— NOT auto-adjusted. Suggested availableBalance if legitimate: ${suggestedAvailable.toFixed(6)}.`
    );

    try {
      await prisma.auditLog.create({
        data: {
          userId: ctx.userId,
          action: 'BALANCE_DRIFT_DETECTED',
          entityType: 'Balance',
          entityId: `${ctx.userId}:${ctx.asset}`,
          oldValue: {
            available: ctx.available,
            locked: ctx.locked,
            unsweptFees: ctx.unsweptFees,
            redeemCredits: ctx.redeemCredits,
            gasRefunds: ctx.gasRefunds,
            expected: ctx.expected,
          },
          newValue: {
            onChain: ctx.onChain,
            diff,
            suggestedAvailable,
          },
        },
      });
    } catch (err) {
      logger.error('Failed to record balance-drift audit log:', err);
    }

    await this.notifyAdmins(
      `⚠️ <b>BALANCE DRIFT DETECTED</b>\n\n` +
        `<b>Asset:</b> ${ctx.asset}\n` +
        `<b>Wallet:</b> <code>${ctx.address}</code>\n` +
        `<b>On-chain:</b> ${ctx.onChain}\n` +
        `<b>Expected:</b> ${ctx.expected.toFixed(6)}\n` +
        `<b>Diff:</b> ${diff > 0 ? '+' : ''}${diff.toFixed(6)}\n\n` +
        `No auto-adjustment made. Review manually.`
    );
  }

  private async notifyAdmins(html: string): Promise<void> {
    for (const telegramId of config.ADMIN_TELEGRAM_IDS) {
      try {
        await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: telegramId, text: html, parse_mode: 'HTML' }),
        });
      } catch (err) {
        logger.error(`Balance drift admin notify failed for ${telegramId}:`, err);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const balanceSync = new BalanceSyncService();
  
