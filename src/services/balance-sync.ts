import { prisma } from '../database';
import { logger } from '../utils/logger';
import cron from 'node-cron';

/**
 * ============================================================================
 * UPGRADE: DB IS THE SINGLE SOURCE OF TRUTH (spec §37)
 * ============================================================================
 * Every balance mutation is recorded in the ledger (Transaction / Reward
 * rows: deposits, rewards, giveaway locks, refunds, redeems), so user
 * balances no longer need — and no longer receive — any on-chain reads.
 *
 * This service is now a DB-INTEGRITY WATCHDOG ONLY. Every 5 minutes it
 * detects impossible internal states and writes audit rows for human
 * review. It NEVER mutates balances: the old auto-heal era (which both
 * papered over and occasionally caused phantom balances by "correcting"
 * against chain state) is over.
 * ============================================================================
 */

const CRON_SCHEDULE = '30 */5 * * * *';

/** Tolerance for Decimal(36,18) float noise in comparisons. */
const TOLERANCE = 0.000001;

class BalanceSyncService {
  private isRunning = false;

  start(): void {
    cron.schedule(CRON_SCHEDULE, () => void this.checkIntegrity());
    logger.info('Balance integrity monitor started (DB-only, every 5 min, audit-only)');
  }

  private async checkIntegrity(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      await this.checkNegativeBalances();
      await this.checkEscrowVsLocked();
    } catch (err) {
      logger.error('Balance integrity run failed:', err);
    } finally {
      this.isRunning = false;
    }
  }

  /** Impossible state: any balance column below zero. */
  private async checkNegativeBalances(): Promise<void> {
    const rows = await prisma.balance.findMany({
      where: {
        OR: [{ availableBalance: { lt: 0 } }, { lockedBalance: { lt: 0 } }, { pendingBalance: { lt: 0 } }],
      },
      take: 100,
    });

    for (const r of rows) {
      logger.warn(
        `[BALANCE INTEGRITY] negative balance user=${r.userId} asset=${r.asset} ` +
        `available=${r.availableBalance} locked=${r.lockedBalance} pending=${r.pendingBalance}`
      );
      await prisma.auditLog.create({
        data: {
          userId: r.userId,
          action: 'BALANCE_NEGATIVE',
          entityType: 'Balance',
          entityId: `${r.userId}:${r.asset}`,
          newValue: {
            available: r.availableBalance.toString(),
            locked: r.lockedBalance.toString(),
            pending: r.pendingBalance.toString(),
          },
        },
      });
    }
  }

  /**
   * Internal consistency: the sum of outstanding escrow across a creator's
   * ACTIVE/FULL giveaways must equal their lockedBalance for that asset.
   * A mismatch means a lock/release went wrong somewhere — flag it, don't
   * guess-fix it.
   */
  private async checkEscrowVsLocked(): Promise<void> {
    const giveaways = await prisma.giveaway.findMany({
      where: { status: { in: ['ACTIVE', 'FULL'] } },
      include: { claims: true },
    });

    const escrow = new Map<string, number>();
    for (const g of giveaways) {
      const paidOut = g.claims.filter((c) => c.status === 'PAID').length * Number(g.amountPerUser);
      const outstanding = Math.max(0, Number(g.totalAmount) - paidOut);
      const key = `${g.creatorId}:${g.asset}`;
      escrow.set(key, (escrow.get(key) ?? 0) + outstanding);
    }

    for (const [key, expected] of escrow) {
      const [userId, asset] = key.split(':');
      const bal = await prisma.balance.findUnique({
        where: { userId_asset: { userId, asset } },
      });
      const locked = Number(bal?.lockedBalance ?? 0);
      if (Math.abs(locked - expected) > TOLERANCE) {
        logger.warn(
          `[BALANCE INTEGRITY] locked mismatch user=${userId} asset=${asset} locked=${locked} expectedEscrow=${expected}`
        );
        await prisma.auditLog.create({
          data: {
            userId,
            action: 'ESCROW_LOCKED_MISMATCH',
            entityType: 'Balance',
            entityId: key,
            oldValue: { locked },
            newValue: { expectedEscrow: expected },
          },
        });
      }
    }
  }
}

export const balanceSync = new BalanceSyncService();
        
