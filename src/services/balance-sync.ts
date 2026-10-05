import { Prisma } from '@prisma/client';
import cron from 'node-cron';

import { prisma } from '../database';
import { redis } from './redis';
import { logger } from '../utils/logger';

/**
 * BALANCE INTEGRITY WATCHDOG
 *
 * Purpose:
 * - Detect impossible balance states.
 * - Detect giveaway escrow/locked-balance mismatches.
 * - Use Prisma Decimal for ALL financial arithmetic.
 * - Debounce repeated alerts.
 * - Write audit records for detected inconsistencies.
 *
 * IMPORTANT:
 * This service NEVER mutates balances.
 *
 * The database ledger remains the single source of truth.
 */

const CRON_SCHEDULE = '30 */5 * * * *';

const DECIMAL_ZERO = new Prisma.Decimal(0);
const TOLERANCE = new Prisma.Decimal('0.000000000000000001');

const ALERT_DEBOUNCE_SEC = 24 * 60 * 60;

const ACTIVE_GIVEAWAY_STATUSES = [
  'ACTIVE',
  'FULL',
] as const;

class BalanceSyncService {
  private isRunning = false;

  /**
   * Start the watchdog.
   *
   * Runs every 5 minutes at second 30.
   */
  start(): void {
    cron.schedule(CRON_SCHEDULE, () => {
      void this.checkIntegrity();
    });

    logger.info(
      '[BALANCE INTEGRITY] watchdog started — DB-only, Decimal-safe, debounced'
    );
  }

  /**
   * Prevent overlapping watchdog runs.
   */
  private async checkIntegrity(): Promise<void> {
    if (this.isRunning) {
      logger.debug?.(
        '[BALANCE INTEGRITY] previous check still running; skipping'
      );

      return;
    }

    this.isRunning = true;

    try {
      await this.checkNegativeBalances();
      await this.checkGiveawayEscrow();
    } catch (err) {
      logger.error(
        '[BALANCE INTEGRITY] watchdog run failed:',
        err
      );
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Returns true only when this is the first alert for the
   * specified key during the debounce window.
   *
   * Redis failure intentionally fails OPEN:
   * we still want the integrity alert delivered.
   */
  private async freshAlert(key: string): Promise<boolean> {
    try {
      const result = await redis.set(
        `balint:${key}`,
        '1',
        'EX',
        ALERT_DEBOUNCE_SEC,
        'NX'
      );

      return result === 'OK';
    } catch (err) {
      logger.warn(
        '[BALANCE INTEGRITY] Redis debounce unavailable; delivering alert',
        err
      );

      return true;
    }
  }

  /**
   * Detect negative available / locked / pending balances.
   *
   * Financial balances should never be negative.
   */
  private async checkNegativeBalances(): Promise<void> {
    const rows = await prisma.balance.findMany({
      where: {
        OR: [
          {
            availableBalance: {
              lt: DECIMAL_ZERO,
            },
          },
          {
            lockedBalance: {
              lt: DECIMAL_ZERO,
            },
          },
          {
            pendingBalance: {
              lt: DECIMAL_ZERO,
            },
          },
        ],
      },
      take: 100,
      orderBy: {
        updatedAt: 'asc',
      },
    });

    if (rows.length === 0) {
      return;
    }

    for (const balance of rows) {
      const key = `${balance.userId}:${balance.asset}`;

      if (!(await this.freshAlert(`negative:${key}`))) {
        continue;
      }

      logger.warn(
        `[BALANCE INTEGRITY] NEGATIVE BALANCE ` +
        `user=${balance.userId} ` +
        `asset=${balance.asset} ` +
        `available=${balance.availableBalance.toString()} ` +
        `locked=${balance.lockedBalance.toString()} ` +
        `pending=${balance.pendingBalance.toString()}`
      );

      try {
        await prisma.auditLog.create({
          data: {
            userId: balance.userId,
            action: 'BALANCE_NEGATIVE',
            entityType: 'Balance',
            entityId: key,
            newValue: {
              available: balance.availableBalance.toString(),
              locked: balance.lockedBalance.toString(),
              pending: balance.pendingBalance.toString(),
            },
          },
        });
      } catch (err) {
        logger.error(
          `[BALANCE INTEGRITY] failed to create negative-balance audit ` +
          `user=${balance.userId} asset=${balance.asset}`,
          err
        );
      }
    }
  }

  /**
   * Calculate the amount that should remain locked for every
   * creator + asset based on active giveaways.
   *
   * IMPORTANT:
   *
   * We intentionally use Prisma.Decimal everywhere.
   *
   * No Number().
   * No floating-point multiplication.
   * No Math.max().
   */
  private async calculateExpectedEscrow(): Promise<
    Map<
      string,
      {
        creatorId: string;
        asset: string;
        expected: Prisma.Decimal;
      }
    >
  > {
    const giveaways = await prisma.giveaway.findMany({
      where: {
        status: {
          in: [...ACTIVE_GIVEAWAY_STATUSES],
        },
      },
      include: {
        claims: {
          select: {
            status: true,
          },
        },
      },
    });

    const escrow = new Map<
      string,
      {
        creatorId: string;
        asset: string;
        expected: Prisma.Decimal;
      }
    >();

    for (const giveaway of giveaways) {
      const paidClaims = giveaway.claims.filter(
        (claim) => claim.status === 'PAID'
      ).length;

      /**
       * totalAmount
       *
       * minus:
       *
       * amountPerUser * number of PAID claims
       */
      const paidOut = giveaway.amountPerUser.mul(paidClaims);

      let outstanding = giveaway.totalAmount.sub(paidOut);

      /**
       * Never allow the expected escrow calculation to become
       * negative due to an inconsistent giveaway record.
       */
      if (outstanding.lessThan(DECIMAL_ZERO)) {
        outstanding = DECIMAL_ZERO;
      }

      if (outstanding.lessThanOrEqualTo(TOLERANCE)) {
        continue;
      }

      const key = `${giveaway.creatorId}:${giveaway.asset}`;

      const existing = escrow.get(key);

      if (existing) {
        existing.expected = existing.expected.add(outstanding);
      } else {
        escrow.set(key, {
          creatorId: giveaway.creatorId,
          asset: giveaway.asset,
          expected: outstanding,
        });
      }
    }

    return escrow;
  }

  /**
   * Compare expected giveaway escrow against Balance.lockedBalance.
   *
   * This method NEVER changes Balance.
   */
  private async checkGiveawayEscrow(): Promise<void> {
    const escrow = await this.calculateExpectedEscrow();

    if (escrow.size === 0) {
      return;
    }

    for (const entry of escrow.values()) {
      const {
        creatorId,
        asset,
        expected,
      } = entry;

      const balance = await prisma.balance.findUnique({
        where: {
          userId_asset: {
            userId: creatorId,
            asset,
          },
        },
        select: {
          userId: true,
          asset: true,
          lockedBalance: true,
        },
      });

      const actualLocked =
        balance?.lockedBalance ?? DECIMAL_ZERO;

      const difference = actualLocked.sub(expected).abs();

      if (difference.lessThanOrEqualTo(TOLERANCE)) {
        continue;
      }

      const key = `${creatorId}:${asset}`;

      /**
       * Only alert once per 24 hours for the same
       * user + asset mismatch.
       */
      if (!(await this.freshAlert(`mismatch:${key}`))) {
        continue;
      }

      logger.warn(
        `[BALANCE INTEGRITY] ESCROW / LOCKED MISMATCH ` +
        `user=${creatorId} ` +
        `asset=${asset} ` +
        `locked=${actualLocked.toString()} ` +
        `expectedEscrow=${expected.toString()} ` +
        `difference=${difference.toString()}`
      );

      try {
        await prisma.auditLog.create({
          data: {
            userId: creatorId,
            action: 'ESCROW_LOCKED_MISMATCH',
            entityType: 'Balance',
            entityId: key,

            oldValue: {
              locked: actualLocked.toString(),
            },

            newValue: {
              expectedEscrow: expected.toString(),
              difference: difference.toString(),
            },
          },
        });
      } catch (err) {
        logger.error(
          `[BALANCE INTEGRITY] failed to create escrow mismatch audit ` +
          `user=${creatorId} asset=${asset}`,
          err
        );
      }
    }
  }
}

export const balanceSync = new BalanceSyncService();
