import { prisma } from '../database';
import { config } from '../config';
import { redis } from './redis';
import { blockchain } from './blockchain';
import { depositMonitor } from './deposit-monitor';
import { logger } from '../utils/logger';
import cron from 'node-cron';
import {
  SYNC_ASSETS,
  SYNC_TOLERANCE,
  gatherBalanceComponents,
  solveAvailableForOnChain,
  type BalanceComponents,
  type SyncAsset,
} from './balance-accounting';

/**
 * ============================================================================
 * WHAT THIS FILE DOES, AND WHY IT'S SAFE
 * ============================================================================
 * Runs every 5 minutes, checks every active wallet against the chain, and
 * self-heals two different kinds of drift automatically. No Telegram
 * notifications — everything is silent, recorded to AuditLog only.
 *
 * A discrepancy only ever triggers action once it has persisted across TWO
 * consecutive 5-minute checks (~8+ minutes). A wallet mid-giveaway-lock or
 * mid-fee-forward looks momentarily "off" for a few seconds; requiring
 * persistence means we never act on a wallet that's simply between two
 * legitimate internal steps.
 *
 * DIRECTION 1 — DB shows MORE than the chain (expected > onChain):
 *   Auto-corrected DOWN to match the chain. This can never invent money —
 *   it only ever removes balance that was never really backed on-chain —
 *   so it's safe to automate. (Skipped, not forced, if the correction
 *   would make availableBalance negative — that means something else is
 *   wrong, e.g. corrupted lockedBalance, and needs a human look.)
 *
 * DIRECTION 2 — chain shows MORE than the DB (onChain > expected):
 *   This is the dangerous direction to get wrong — it's exactly how the
 *   old version of this file created real double-credits (see git history:
 *   it used to just mint the raw gap). Instead of guessing at the amount,
 *   this now goes and finds the ACTUAL on-chain deposit transaction
 *   responsible (a targeted rescan of Transfer logs for that one address,
 *   much further back than the normal scanner looks) and feeds it through
 *   `depositMonitor.handleDepositCheck` — the exact same idempotent,
 *   fee-aware, confirmation-gated path a normal deposit uses. If the
 *   normal scanner already caught it (or catches it later), the shared
 *   `DepositMonitor` dedup means this can never credit it twice. If
 *   nothing new turns up on-chain, it's not a missed deposit — logged for
 *   manual review instead of guessed at.
 * ============================================================================
 */

const CRON_SCHEDULE = '30 */5 * * * *';

/** How long a discrepancy must persist, same direction, before acting. */
const PERSISTENCE_MS = 8 * 60 * 1000;

/** How far back to look for a missed USDT deposit — comfortably covers an extended scanner outage. */
const DEEP_RESCAN_BLOCKS = 6000; // ~5 hours on BSC (~3s/block)

const IN_FLIGHT_GRACE_MS = 20 * 60 * 1000;

interface PendingDrift {
  direction: 'positive' | 'negative';
  firstSeenAt: number;
}

class BalanceSyncService {
  private isRunning = false;

  start(): void {
    cron.schedule(CRON_SCHEDULE, () => void this.syncAll());
    logger.info('Balance drift monitor started (auto-heal, silent, every 5 min)');
  }

  private async syncAll(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const wallets = await prisma.wallet.findMany({
        where: {
          status: 'ACTIVE',
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
              logger.warn('Balance sync: rate limited — aborting this cycle, next window retries.');
              break;
            }
            logger.error(`Balance sync failed for ${wallet.address} ${asset}: ${msg}`);
          }
          await sleep(400);
        }
        if (rateLimited) break;
        await sleep(500);
      }
    } catch (err) {
      logger.error('Balance sync run failed:', err);
    } finally {
      this.isRunning = false;
    }
  }

  private pendingKey(address: string, asset: string): string {
    return `sync:pending:${address.toLowerCase()}:${asset}`;
  }

  private async getPending(address: string, asset: string): Promise<PendingDrift | null> {
    const raw = await redis.get(this.pendingKey(address, asset));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PendingDrift;
    } catch {
      return null;
    }
  }

  private async setPending(address: string, asset: string, drift: PendingDrift): Promise<void> {
    await redis.set(this.pendingKey(address, asset), JSON.stringify(drift), 'EX', 3600);
  }

  private async clearPending(address: string, asset: string): Promise<void> {
    await redis.del(this.pendingKey(address, asset));
  }

  private async checkOne(userId: string, address: string, asset: SyncAsset): Promise<void> {
    const ctx = await gatherBalanceComponents(userId, address, asset);

    const tol = SYNC_TOLERANCE[asset] ?? 0.000001;
    const diff = ctx.onChain - ctx.expected;

    if (Math.abs(diff) < tol) {
      await this.clearPending(address, asset);
      return;
    }

    if (await this.hasInFlightDeposit(address, asset)) {
      // Not a real discrepancy — the deposit monitor is mid-flight on this
      // wallet right now. Don't let it start a persistence timer.
      await this.clearPending(address, asset);
      return;
    }

    const direction: PendingDrift['direction'] = diff > 0 ? 'positive' : 'negative';
    const pending = await this.getPending(address, asset);

    if (!pending || pending.direction !== direction) {
      await this.setPending(address, asset, { direction, firstSeenAt: Date.now() });
      return; // wait for the next cycle to confirm this isn't transient
    }

    if (Date.now() - pending.firstSeenAt < PERSISTENCE_MS) {
      return; // seen once already, not persistent enough yet
    }

    // Persistent, confirmed discrepancy — act, then reset the timer either way.
    try {
      if (direction === 'negative') {
        await this.healOverstated(ctx);
      } else {
        await this.investigateUnderstated(ctx);
      }
    } finally {
      await this.clearPending(address, asset);
    }
  }

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
   * DB believes there's more than the chain actually holds. Safe to
   * correct automatically — this only ever removes balance, never
   * invents it — UNLESS the correction would go negative, which means
   * something else (e.g. corrupted lockedBalance) is going on and a
   * human needs to look rather than have this silently paper over it.
   */
  private async healOverstated(ctx: BalanceComponents): Promise<void> {
    const correctAvailable = solveAvailableForOnChain(ctx);

    if (correctAvailable < 0) {
      logger.warn(
        `[BALANCE SYNC] ${ctx.asset} ${ctx.address}: correction would go negative (${correctAvailable.toFixed(6)}) — needs manual review, not auto-fixed.`
      );

      await prisma.auditLog.create({
        data: {
          userId: ctx.userId,
          action: 'BALANCE_DRIFT_NEEDS_REVIEW',
          entityType: 'Balance',
          entityId: `${ctx.userId}:${ctx.asset}`,
          oldValue: { available: ctx.available, locked: ctx.locked },
          newValue: { onChain: ctx.onChain, wouldBeAvailable: correctAvailable },
        },
      });

      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.balance.update({
        where: { userId_asset: { userId: ctx.userId, asset: ctx.asset } },
        data: { availableBalance: correctAvailable },
      });

      await tx.auditLog.create({
        data: {
          userId: ctx.userId,
          action: 'BALANCE_AUTO_CORRECTED_DOWN',
          entityType: 'Balance',
          entityId: `${ctx.userId}:${ctx.asset}`,
          oldValue: { availableBalance: ctx.available },
          newValue: { availableBalance: correctAvailable, onChain: ctx.onChain },
        },
      });
    });

    logger.info(
      `[BALANCE SYNC] ${ctx.asset} ${ctx.address}: auto-corrected availableBalance ${ctx.available} → ${correctAvailable.toFixed(6)} (was overstated vs. chain)`
    );
  }

  /**
   * Chain holds more than the DB explains. Rather than crediting the raw
   * gap (how the old double-credit bug happened), find the actual
   * on-chain transaction responsible and run it through the exact same
   * canonical deposit path the scanner uses — fee deduction included,
   * fully idempotent against anything the scanner already processed.
   */
  private async investigateUnderstated(ctx: BalanceComponents): Promise<void> {
    if (ctx.asset !== 'USDT') {
      // BNB is already watched live, every cycle, by the delta method in
      // deposit-monitor.ts's checkNativeBalance — a persistent unexplained
      // BNB gap this check independently confirms is unusual enough to
      // just flag rather than guess at.
      logger.warn(
        `[BALANCE SYNC] ${ctx.asset} ${ctx.address}: chain shows more than DB explains (diff +${(ctx.onChain - ctx.expected).toFixed(6)}) and it isn't a fresh deposit — needs manual review.`
      );

      await prisma.auditLog.create({
        data: {
          userId: ctx.userId,
          action: 'BALANCE_DRIFT_NEEDS_REVIEW',
          entityType: 'Balance',
          entityId: `${ctx.userId}:${ctx.asset}`,
          oldValue: { expected: ctx.expected },
          newValue: { onChain: ctx.onChain },
        },
      });

      return;
    }

    try {
      const provider = await blockchain.getProvider();
      const currentBlock = await provider.getBlockNumber();
      const fromBlock = Math.max(1, currentBlock - DEEP_RESCAN_BLOCKS);

      const eventsByAddress = await blockchain.getTokenTransferEventsForAddresses(
        'USDT',
        [ctx.address.toLowerCase()],
        fromBlock,
        currentBlock
      );

      const events = eventsByAddress.get(ctx.address.toLowerCase()) ?? [];

      if (events.length === 0) {
        logger.warn(
          `[BALANCE SYNC] USDT ${ctx.address}: chain shows more than DB explains, but no Transfer event found in the last ${DEEP_RESCAN_BLOCKS} blocks — not a missed deposit, needs manual review.`
        );

        await prisma.auditLog.create({
          data: {
            userId: ctx.userId,
            action: 'BALANCE_DRIFT_NEEDS_REVIEW',
            entityType: 'Balance',
            entityId: `${ctx.userId}:USDT`,
            oldValue: { expected: ctx.expected },
            newValue: { onChain: ctx.onChain },
          },
        });

        return;
      }

      // handleDepositCheck is a no-op for anything already PROCESSED/
      // CONFIRMED/FAILED in DepositMonitor — safe to just replay every
      // event found, new or old.
      for (const event of events) {
        await depositMonitor.handleDepositCheck(
          ctx.address,
          'USDT',
          event.txHash,
          event.amount,
          event.from,
          event.blockNumber
        );
      }

      logger.info(
        `[BALANCE SYNC] USDT ${ctx.address}: rescanned ${events.length} Transfer event(s) from the last ${DEEP_RESCAN_BLOCKS} blocks and replayed them through the normal deposit path.`
      );
    } catch (err) {
      logger.error(`[BALANCE SYNC] Deep rescan failed for ${ctx.address}:`, err);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const balanceSync = new BalanceSyncService();
    
