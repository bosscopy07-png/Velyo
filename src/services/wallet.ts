import { prisma } from '../database';
import { blockchain } from './blockchain';
import { encrypt } from '../utils/encryption';
import { logger } from '../utils/logger';
import type { AssetSymbol } from '../config';

class WalletService {
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

    // Initialize balances
    const assets: AssetSymbol[] = ['BNB', 'USDT'];
    for (const asset of assets) {
      await prisma.balance.upsert({
        where: { userId_asset: { userId, asset } },
        create: { userId, asset, availableBalance: 0, lockedBalance: 0, pendingBalance: 0 },
        update: {},
      });
    }

    logger.info(`Wallet created for user ${userId}: ${address}`);
    return { address: wallet.address };
  }

  async getBalance(userId: string, asset: AssetSymbol): Promise<{ available: number; locked: number; pending: number }> {
    const balance = await prisma.balance.findUnique({
      where: { userId_asset: { userId, asset } },
    });
    
    if (!balance) return { available: 0, locked: 0, pending: 0 };
    
    return {
      available: Number(balance.availableBalance),
      locked: Number(balance.lockedBalance),
      pending: Number(balance.pendingBalance),
    };
  }

  async getTotalBalanceUSD(userId: string): Promise<number> {
    const { pricing } = await import('./pricing');
    const balances = await prisma.balance.findMany({ where: { userId } });
    
    let total = 0;
    for (const bal of balances) {
      const usdValue = await pricing.convertToUSD(bal.asset, Number(bal.availableBalance));
      total += usdValue;
    }
    
    return total;
  }

  async lockFunds(userId: string, asset: AssetSymbol, amount: number): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const balance = await tx.balance.findUnique({
        where: { userId_asset: { userId, asset } },
      });
      
      if (!balance || Number(balance.availableBalance) < amount) {
        throw new Error('Insufficient balance');
      }
      
      await tx.balance.update({
        where: { userId_asset: { userId, asset } },
        data: {
          availableBalance: { decrement: amount },
          lockedBalance: { increment: amount },
        },
      });
    });
  }

  async unlockFunds(userId: string, asset: AssetSymbol, amount: number): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.balance.update({
        where: { userId_asset: { userId, asset } },
        data: {
          availableBalance: { increment: amount },
          lockedBalance: { decrement: amount },
        },
      });
    });
  }

  async deductFunds(userId: string, asset: AssetSymbol, amount: number): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const balance = await tx.balance.findUnique({
        where: { userId_asset: { userId, asset } },
      });
      
      if (!balance || Number(balance.availableBalance) < amount) {
        throw new Error('Insufficient balance');
      }
      
      await tx.balance.update({
        where: { userId_asset: { userId, asset } },
        data: {
          availableBalance: { decrement: amount },
        },
      });
    });
  }

  async creditFunds(userId: string, asset: AssetSymbol, amount: number): Promise<void> {
    await prisma.balance.upsert({
      where: { userId_asset: { userId, asset } },
      create: {
        userId,
        asset,
        availableBalance: amount,
        lockedBalance: 0,
        pendingBalance: 0,
      },
      update: {
        availableBalance: { increment: amount },
      },
    });
  }
}

export const walletService = new WalletService();
