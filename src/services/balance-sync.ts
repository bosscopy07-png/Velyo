import { prisma } from '../database';
import { blockchain } from './blockchain';
import { config } from '../config';
import { logger } from '../utils/logger';
import cron from 'node-cron';

/** Ignore differences smaller than this (chain dust / rounding) */
const SYNC_TOLERANCE: Record<string, number> = {
  USDT: 0.000001,
  BNB: 0.0000001,
};

class BalanceSyncService {
  private isRunning = false;

  start(): void {
    cron.schedule('*/2 * * * *', () => void this.syncAll());
    logger.info('Balance sync started (on-chain → DB, every 2 min)');
  }

  private async syncAll(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const wallets = await prisma.wallet.findMany({
        where: {
          status: 'ACTIVE',
          // Operator wallet is synced explicitly via adjustOperatorBalance
          address: { not: config.PLATFORM_FEE_WALLET },
        },
      });

      for (const wallet of wallets) {
        for (const asset of ['USDT', 'BNB'] as const) {
          try {
            await this.syncOne(wallet.userId, wallet.address, asset);
          } catch (err) {
            logger.error(`Balance sync failed for ${wallet.address} ${asset}: ${(err as Error).message}`);
          }
        }
      }
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * expectedOnChain = available + locked + unsweptFees − redeemCredits
   * Anything beyond tolerance = a movement the monitor missed → self-heal.
   */
  private async syncOne(userId: string, address: string, asset: 'USDT' | 'BNB'): Promise<void> {
    const raw = await blockchain.getBalance(address, asset);
    const onChain = Number(raw) / 1e18;

    const balance = await prisma.balance.findUnique({
      where: { userId_asset: { userId, asset } },
    });

    const [feesAgg, redeemAgg] = await Promise.all([
      prisma.platformFee.aggregate({
        where: { sweptAt: null, asset, transaction: { userId } },
        _sum: { amount: true },
      }),
      prisma.codeRedemption.aggregate({
        where: { userId, code: { asset } },
        _sum: { amount: true },
      }),
    ]);

    const available = Number(balance?.availableBalance ?? 0);
    const locked = Number(balance?.lockedBalance ?? 0);
    const unsweptFees = Number(feesAgg._sum.amount ?? 0);
    const redeemCredits = Number(redeemAgg._sum.amount ?? 0);

    const expected = available + locked + unsweptFees - redeemCredits;
    const diff = onChain - expected;

    if (Math.abs(diff) < (SYNC_TOLERANCE[asset] ?? 0.000001)) return;

    await prisma.$transaction(async (tx) => {
      await tx.balance.upsert({
        where: { userId_asset: { userId, asset } },
        create: { userId, asset, availableBalance: diff, lockedBalance: 0, pendingBalance: 0 },
        update: { availableBalance: { increment: diff } },
      });

      const { hashIdempotencyKey } = await import('../utils/encryption');
      await tx.transaction.create({
        data: {
          userId,
          type: 'DEPOSIT',
          asset,
          amount: Math.abs(diff),
          fee: 0,
          netAmount: diff,
          status: 'CONFIRMED',
          idempotencyKey: hashIdempotencyKey('chain-sync', userId, asset, Math.floor(Date.now() / 120000)),
          metadata: { kind: 'chain-sync', address, onChain, expected, diff },
        },
      });
    });

    logger.warn(
      `Balance sync (${asset}) ${address}: adjusted ${diff > 0 ? '+' : ''}${diff} ` +
      `(on-chain ${onChain} vs expected ${expected.toFixed(6)})`
    );
  }
}

export const balanceSync = new BalanceSyncService();
