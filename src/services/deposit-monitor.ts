import { prisma } from '../database';
import { blockchain } from './blockchain';
import { redis } from './redis';
import { config } from '../config';
import { logger } from '../utils/logger';
import { hashIdempotencyKey } from '../utils/encryption';

const ASSET_DECIMALS: Record<string, number> = { BNB: 18, USDT: 18 };
const MAX_LOG_WINDOW = 500; // cap getLogs range — public RPCs reject huge ranges

class DepositMonitorService {
  private isRunning = false;

  start(): void {
    // Every 60s (was 30s) — halves request volume
    cron.schedule('0 * * * * *', () => void this.scanDeposits());
    logger.info('Deposit monitor started (credit-efficient mode)');
  }

  private async scanDeposits(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const wallets = await prisma.wallet.findMany({
        where: { status: 'ACTIVE' },
        include: { user: true },
      });
      if (wallets.length === 0) return;

      const provider = await blockchain.getProvider();
      const currentBlock = await provider.getBlockNumber();

      // Resume from where we last scanned (per-instance cursor in Redis)
      const cursorKey = 'monitor:lastBlock';
      const cached = await redis.get(cursorKey);
      const lastScanned = cached ? parseInt(cached) : currentBlock - 20;
      const fromBlock = Math.max(lastScanned + 1, currentBlock - MAX_LOG_WINDOW);

      for (const wallet of wallets) {
        // USDT: event logs over only the NEW blocks since last scan
        try {
          if (fromBlock <= currentBlock) {
            const events = await blockchain.getTokenTransferEvents(
              'USDT',
              wallet.address,
              fromBlock,
              currentBlock
            );
            for (const event of events) {
              await this.processDeposit(wallet, 'USDT', {
                from: event.from,
                amount: event.amount,
                txHash: event.txHash,
              });
            }
          }
        } catch (err) {
          logger.error(`Error scanning USDT for ${wallet.address}:`, err);
        }

        // BNB: cheap balance-diff instead of fetching full blocks
        try {
          await this.checkNativeBalance(wallet, currentBlock);
        } catch (err) {
          logger.error(`Error checking BNB balance for ${wallet.address}:`, err);
        }
      }

      // Advance cursor only after a full pass
      await redis.set(cursorKey, currentBlock.toString());
    } catch (err) {
      logger.error('Deposit scan error:', err);
    } finally {
      this.isRunning = false;
    }
  }

  private async checkNativeBalance(
    wallet: { address: string; userId: string; encryptedPrivateKey: string; user: { chatId: string | null; telegramId: string } },
    currentBlock: number
  ): Promise<void> {
    const key = `monitor:bal:${wallet.address}:BNB`;
    const raw = await blockchain.getBalance(wallet.address, 'BNB');
    const current = Number(raw) / 1e18;

    const prevStr = await redis.get(key);
    await redis.set(key, current.toFixed(8));

    if (!prevStr) return; // first sighting — establish baseline, don't credit

    const prev = parseFloat(prevStr);
    const diff = current - prev;
    if (diff <= 0) return; // no new deposit (fee forwards/payouts decrease — ignored)

    // Synthetic-but-stable idempotency key for diff-based crediting
    await this.processDeposit(wallet, 'BNB', {
      from: '',
      amount: BigInt(Math.floor(diff * 1e18)),
      txHash: `bnb-diff:${wallet.address}:${currentBlock}`,
    });
  }

  private async processDeposit(
    wallet: {
      address: string;
      userId: string;
      encryptedPrivateKey: string;
      user: { chatId: string | null; telegramId: string };
    },
    asset: string,
    event: { from: string; amount: bigint; txHash: string }
  ): Promise<void> {
    const existing = await prisma.transaction.findFirst({
      where: { transactionHash: event.txHash },
    });
    if (existing) return;

    const seen = await prisma.depositMonitor.findUnique({
      where: { txHash_address: { txHash: event.txHash, address: wallet.address } },
    });
    if (seen?.status === 'PROCESSED') return;

    // getLogs events are already confirmed; balance-diff deposits are too
    const decimals = ASSET_DECIMALS[asset] ?? 18;
    const amount = Number(event.amount) / 10 ** decimals;
    if (amount <= 0) return;

    const feePercent = config.ENABLE_FEES ? config.PLATFORM_FEE_PERCENT : 0;
    const fee = amount * (feePercent / 100);
    const netAmount = amount - fee;

    await prisma.depositMonitor.upsert({
      where: { txHash_address: { txHash: event.txHash, address: wallet.address } },
      create: { address: wallet.address, asset, txHash: event.txHash, amount, status: 'CONFIRMING' },
      update: {},
    });

    let depositTxId = '';
    await prisma.$transaction(async (tx) => {
      await tx.balance.upsert({
        where: { userId_asset: { userId: wallet.userId, asset } },
        create: { userId: wallet.userId, asset, availableBalance: netAmount, lockedBalance: 0, pendingBalance: 0 },
        update: { availableBalance: { increment: netAmount } },
      });

      const depositTx = await tx.transaction.create({
        data: {
          userId: wallet.userId,
          type: 'DEPOSIT',
          asset,
          amount,
          fee,
          netAmount,
          status: 'CONFIRMED',
          transactionHash: event.txHash,
          fromAddress: event.from || null,
          toAddress: wallet.address,
          idempotencyKey: hashIdempotencyKey('deposit', event.txHash),
        },
      });
      depositTxId = depositTx.id;

      if (fee > 0) {
        await tx.platformFee.create({
          data: {
            transactionId: depositTx.id,
            asset,
            amount: fee,
            feeWallet: config.PLATFORM_FEE_WALLET,
          },
        });
      }
    });

    await prisma.depositMonitor.updateMany({
      where: { txHash: event.txHash },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });

    logger.info(`Deposit credited: ${netAmount} ${asset} (${event.txHash.slice(0, 20)}...)`);

    // Forward the fee ON-CHAIN (needs a little BNB for gas in the wallet)
    if (fee > 0) {
      try {
        const rawFee = BigInt(Math.floor(fee * 1e18));
        const { hash } = await blockchain.sendTransaction(
          wallet.encryptedPrivateKey,
          config.PLATFORM_FEE_WALLET,
          rawFee,
          asset as 'BNB' | 'USDT',
          hashIdempotencyKey('fee-forward', event.txHash)
        );

        await prisma.transaction.create({
          data: {
            userId: wallet.userId,
            type: 'PLATFORM_FEE',
            asset,
            amount: fee,
            fee: 0,
            netAmount: fee,
            status: 'CONFIRMED',
            transactionHash: hash,
            toAddress: config.PLATFORM_FEE_WALLET,
            metadata: { depositTxId, depositTxHash: event.txHash },
            idempotencyKey: hashIdempotencyKey('fee-forward-tx', event.txHash),
          },
        });

        logger.info(`Fee forwarded: ${fee} ${asset} → fee wallet`);
      } catch (err) {
        logger.error(`Fee forward failed for ${event.txHash} (recorded for manual sweep): ${(err as Error).message}`);
      }
    }

    if (wallet.user.chatId) {
      await this.notify(
        wallet.user.chatId,
        `🟢 <b>DEPOSIT RECEIVED</b>\n\n<b>Amount:</b> ${amount} ${asset}\n` +
        (fee > 0 ? `<b>Fee:</b> ${fee.toFixed(6)} ${asset}\n<b>Credited:</b> ${netAmount.toFixed(6)} ${asset}\n` : '') +
        `<b>Ref:</b> <code>${event.txHash.slice(0, 24)}...</code>`
      );
    }
  }

  private async notify(chatId: string, html: string): Promise<void> {
    try {
      await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML' }),
      });
    } catch (err) {
      logger.error('Deposit notify failed:', err);
    }
  }
}

import cron from 'node-cron';

export const depositMonitor = new DepositMonitorService();
                                        
