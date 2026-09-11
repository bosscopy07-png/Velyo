import { prisma } from '../database';
import { blockchain } from './blockchain';
import { config } from '../config';
import { logger } from '../utils/logger';
import { hashIdempotencyKey } from '../utils/encryption';
import cron from 'node-cron';

const ASSET_DECIMALS: Record<string, number> = { BNB: 18, USDT: 18 };

class DepositMonitorService {
  private isRunning = false;

  start(): void {
    cron.schedule('*/30 * * * * *', () => void this.scanDeposits());
    logger.info('Deposit monitor started (in-process crediting)');
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

      const currentBlock = await (await blockchain.getProvider()).getBlockNumber();
      const fromBlock = Math.max(0, currentBlock - 50);

      for (const wallet of wallets) {
        for (const asset of ['USDT', 'BNB'] as const) {
          try {
            const events =
              asset === 'BNB'
                ? await this.getNativeTransfers(wallet.address, fromBlock, currentBlock)
                : await blockchain.getTokenTransferEvents(asset, wallet.address, fromBlock, currentBlock);

            for (const event of events) {
              await this.processDeposit(wallet, asset, event);
            }
          } catch (err) {
            logger.error(`Error scanning ${asset} for ${wallet.address}:`, err);
          }
        }
      }
    } catch (err) {
      logger.error('Deposit scan error:', err);
    } finally {
      this.isRunning = false;
    }
  }

  private async getNativeTransfers(
    address: string,
    fromBlock: number,
    toBlock: number
  ): Promise<Array<{ from: string; amount: bigint; txHash: string }>> {
    const provider = await blockchain.getProvider();
    const results: Array<{ from: string; amount: bigint; txHash: string }> = [];
    for (let b = fromBlock; b <= toBlock; b++) {
      const block = await provider.getBlock(b, true);
      if (!block) continue;
      for (const tx of block.transactions) {
        if (tx.to?.toLowerCase() === address.toLowerCase() && tx.value > BigInt(0)) {
          results.push({ from: tx.from, amount: tx.value, txHash: tx.hash });
        }
      }
    }
    return results;
  }

  private async processDeposit(
    wallet: { address: string; userId: string; user: { chatId: string | null; telegramId: string } },
    asset: string,
    event: { from: string; amount: bigint; txHash: string }
  ): Promise<void> {
    // Idempotency guard (mirror of the old worker's transactionHash check)
    const existing = await prisma.transaction.findFirst({
      where: { transactionHash: event.txHash },
    });
    if (existing) return;

    const seen = await prisma.depositMonitor.findUnique({
      where: { txHash_address: { txHash: event.txHash, address: wallet.address } },
    });
    if (seen?.status === 'PROCESSED') return;

    // Verify on-chain before crediting
    const receipt = await blockchain.getTransactionReceipt(event.txHash);
    if (!receipt || receipt.status !== 1) return; // not confirmed yet — next scan will catch it

    const decimals = ASSET_DECIMALS[asset] ?? 18;
    const amount = Number(event.amount) / 10 ** decimals;
    if (amount <= 0) return;

    // Same fee logic as the original deposit worker
    const feePercent = config.ENABLE_FEES ? config.PLATFORM_FEE_PERCENT : 0;
    const fee = amount * (feePercent / 100);
    const netAmount = amount - fee;

    // Mark seen first so a crash mid-credit can never double-pay
    await prisma.depositMonitor.upsert({
      where: { txHash_address: { txHash: event.txHash, address: wallet.address } },
      create: { address: wallet.address, asset, txHash: event.txHash, amount, status: 'CONFIRMING' },
      update: {},
    });

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
          fromAddress: event.from,
          toAddress: wallet.address,
          idempotencyKey: hashIdempotencyKey('deposit', event.txHash),
        },
      });

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

    logger.info(`Deposit credited in-process: ${netAmount} ${asset} (tx ${event.txHash})`);

    if (wallet.user.chatId) {
      await this.notify(
        wallet.user.chatId,
        `🟢 <b>DEPOSIT RECEIVED</b>\n\n<b>Amount:</b> ${amount} ${asset}\n` +
        (fee > 0 ? `<b>Fee:</b> ${fee.toFixed(6)} ${asset}\n<b>Credited:</b> ${netAmount.toFixed(6)} ${asset}\n` : '') +
        `<b>Tx:</b> <code>${event.txHash}</code>`
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

export const depositMonitor = new DepositMonitorService();
                                                          
