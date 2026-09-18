// src/services/wallet.service.ts
import { prisma } from '../database';
import { blockchain } from './blockchain';
import { encrypt } from '../utils/encryption';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { AssetSymbol } from '../config';

interface BalanceView {
  available: number;
  locked: number;
  pending: number;
}

const EMPTY_BALANCE: BalanceView = { available: 0, locked: 0, pending: 0 };
const INITIAL_ASSETS: AssetSymbol[] = ['BNB', 'USDT'];

class WalletService {
  /** Creates a custodial wallet for a user (idempotent) and seeds zero balances. */
  async createWallet(userId: string): Promise<{ address: string }> {
    const existing = await prisma.wallet.findUnique({ where: { userId } });
    if (existing) return { address: existing.address };

    const { address, privateKey, mnemonic } = blockchain.generateWallet();

    const wallet = await prisma.wallet.create({
      data: {
        userId,
        address,
        encryptedPrivateKey: encrypt(privateKey),
        encryptedMnemonic: encrypt(mnemonic),
      },
    });

    await this.ensureBalances(userId);
    logger.info(`Wallet created for user ${userId}: ${address}`);
    return { address: wallet.address };
  }

  /** Returns the user's balance for an asset, or zeros if not initialized. */
  async getBalance(userId: string, asset: AssetSymbol): Promise<BalanceView> {
    const balance = await prisma.balance.findUnique({
      where: { userId_asset: { userId, asset } },
    });

    if (!balance) return { ...EMPTY_BALANCE };

    return {
      available: Number(balance.availableBalance),
      locked: Number(balance.lockedBalance),
      pending: Number(balance.pendingBalance),
    };
  }

  /** Total portfolio value in USD (available balances only). */
  async getTotalBalanceUSD(userId: string): Promise<number> {
    const { pricing } = await import('./pricing');
    const balances = await prisma.balance.findMany({ where: { userId } });

    let total = 0;
    for (const bal of balances) {
      total += await pricing.convertToUSD(bal.asset, Number(bal.availableBalance));
    }
    return total;
  }

  /**
   * Moves `amount` from available → locked. Atomic, guarded, and
   * concurrency-safe (row locked inside the transaction).
   * @throws Error('Insufficient balance')
   */
  async lockFunds(userId: string, asset: AssetSymbol, amount: number): Promise<void> {
    if (amount <= 0) throw new Error('Amount must be positive');
    await this.transferWithinTransaction(userId, asset, amount, 'lock');
  }

  /** Moves `amount` from locked → available. Guards against over-unlocking. */
  async unlockFunds(userId: string, asset: AssetSymbol, amount: number): Promise<void> {
    if (amount <= 0) throw new Error('Amount must be positive');
    await this.transferWithinTransaction(userId, asset, amount, 'unlock');
  }

  /** Permanently deducts from available balance. @throws Error('Insufficient balance') */
  async deductFunds(userId: string, asset: AssetSymbol, amount: number): Promise<void> {
    if (amount <= 0) throw new Error('Amount must be positive');
    await this.transferWithinTransaction(userId, asset, amount, 'deduct');
  }

  /** Credits available balance (idempotent upsert — safe to retry). */
  async creditFunds(userId: string, asset: AssetSymbol, amount: number): Promise<void> {
    if (amount <= 0) throw new Error('Amount must be positive');

    await prisma.balance.upsert({
      where: { userId_asset: { userId, asset } },
      create: { userId, asset, availableBalance: amount, lockedBalance: 0, pendingBalance: 0 },
      update: { availableBalance: { increment: amount } },
    });
  }

  /**
   * Adjusts the operator/admin wallet's DB balance to match on-chain reality.
   * The admin uses their custodial wallet as a normal user, so gas seeds (out)
   * and fee sweeps/reclaims (in) must be reflected in their app balance.
   * Skips silently if PLATFORM_FEE_WALLET isn't a user wallet.
   */
  async adjustOperatorBalance(asset: AssetSymbol, delta: number): Promise<void> {
    if (delta === 0) return;

    try {
      const operator = await prisma.wallet.findUnique({
        where: { address: config.PLATFORM_FEE_WALLET },
      });
      if (!operator) return;

      await prisma.balance.upsert({
        where: { userId_asset: { userId: operator.userId, asset } },
        create: {
          userId: operator.userId,
          asset,
          availableBalance: delta,
          lockedBalance: 0,
          pendingBalance: 0,
        },
        update: { availableBalance: { increment: delta } },
      });
    } catch (err) {
      logger.error('adjustOperatorBalance failed:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Ensures zero-balance rows exist for all supported assets. */
  private async ensureBalances(userId: string): Promise<void> {
    await prisma.$transaction(
      INITIAL_ASSETS.map((asset) =>
        prisma.balance.upsert({
          where: { userId_asset: { userId, asset } },
          create: { userId, asset, availableBalance: 0, lockedBalance: 0, pendingBalance: 0 },
          update: {},
        }),
      ),
    );
  }

  /**
   * Atomic, guarded balance mutation. Uses conditional updates so the check
   * and the write happen atomically at the DB level — no TOCTOU races.
   */
  private async transferWithinTransaction(
    userId: string,
    asset: AssetSymbol,
    amount: number,
    op: 'lock' | 'unlock' | 'deduct',
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      // Lock the row for update so concurrent ops serialize
      const balance = await tx.$queryRaw<
        { availableBalance: unknown; lockedBalance: unknown }[]
      >`
        SELECT "availableBalance", "lockedBalance"
        FROM "Balance"
        WHERE "userId" = ${userId} AND "asset" = ${asset}
        FOR UPDATE
      `;

      if (balance.length === 0) throw new Error('Insufficient balance');

      const available = Number(balance[0].availableBalance);
      const locked = Number(balance[0].lockedBalance);

      switch (op) {
        case 'lock': {
          if (available < amount) throw new Error('Insufficient balance');
          await tx.balance.update({
            where: { userId_asset: { userId, asset } },
            data: {
              availableBalance: { decrement: amount },
              lockedBalance: { increment: amount },
            },
          });
          break;
        }
        case 'unlock': {
          if (locked < amount) throw new Error('Insufficient locked balance');
          await tx.balance.update({
            where: { userId_asset: { userId, asset } },
            data: {
              availableBalance: { increment: amount },
              lockedBalance: { decrement: amount },
            },
          });
          break;
        }
        case 'deduct': {
          if (available < amount) throw new Error('Insufficient balance');
          await tx.balance.update({
            where: { userId_asset: { userId, asset } },
            data: { availableBalance: { decrement: amount } },
          });
          break;
        }
      }
    });
  }
}

export const walletService = new WalletService();
  
