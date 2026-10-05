import { prisma } from '../database';
import { redis } from './redis';
import { logger } from '../utils/logger';
import cron from 'node-cron';

/**
 * DB-INTEGRITY WATCHDOG ONLY (spec §37). The DB ledger is the single
 * source of truth; this detects impossible internal states and writes
 * audit rows. It NEVER mutates balances. Alerts are debounced to one log
 * line + one audit row per user:asset per 24h — known legacy leftovers
 * must not spam the console every 5 minutes.
 */

const CRON_SCHEDULE = '30 */5 * * * *';
const TOLERANCE = 0.000001;
const ALERT_DEBOUNCE_SEC = 24 * 3600;

class BalanceSyncService {
  private isRunning = false;

  start(): void {
    cron.schedule(CRON_SCHEDULE, () => void this.checkIntegrity());
    logger.info('Balance integrity monitor started (DB-only, debounced)');
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

  /** True only for the FIRST check inside the debounce window. */
  private async freshAlert(key: string): Promise<boolean> {
    try {
      const ok = await redis.set(`balint:${key}`, '1', 'EX', ALERT_DEBOUNCE_SEC, 'NX');
      return ok === 'OK';
    } catch {
      return true; // redis down → deliver anyway
    }
  }

  private async checkNegativeBalances(): Promise<void> {
    const rows = await prisma.balance.findMany({
      where: {
        OR: [{ availableBalance: { lt: 0 } }, { lockedBalance: { lt: 0 } }, { pendingBalance: { lt: 0 } }],
      },
      take: 100,
    });

    for (const r of rows) {
      const key = `${r.userId}:${r.asset}`;
      if (!(await this.freshAlert(`neg:${key}`))) continue; // debounced — stay silent
      logger.warn(
        `[BALANCE INTEGRITY] negative balance user=${r.userId} asset=${r.asset} ` +
        `available=${r.availableBalance} locked=${r.lockedBalance} pending=${r.pendingBalance}`
      );
      await prisma.auditLog.create({
        data: {
          userId: r.userId,
          action: 'BALANCE_NEGATIVE',
          entityType: 'Balance',
          entityId: key,
          newValue: {
            available: r.availableBalance.toString(),
            locked: r.lockedBalance.toString(),
            pending: r.pendingBalance.toString(),
          },
        },
      });
    }
  }

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
      if (expected <= TOLERANCE) continue;
      const [userId, asset] = key.split(':');
      const bal = await prisma.balance.findUnique({
        where: { userId_asset: { userId, asset } },
      });
      const locked = Number(bal?.lockedBalance ?? 0);
      if (Math.abs(locked - expected) > TOLERANCE) {
        if (!(await this.freshAlert(`mismatch:${key}`))) continue; // debounced — stay silent
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
