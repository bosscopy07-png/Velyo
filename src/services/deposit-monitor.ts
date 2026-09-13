import { prisma } from '../database';
import { blockchain } from './blockchain';
import { config } from '../config';
import { logger } from '../utils/logger';
import { hashIdempotencyKey } from '../utils/encryption';
import type { TransactionResponse } from 'ethers';
import cron from 'node-cron';

const ASSET_DECIMALS: Record<string, number> = { BNB: 18, USDT: 18 };

class DepositMonitorService {
  private isRunning = false;

  start(): void {
    cron.schedule('*/30 * * * * *', () => void this.scanDeposits());
    logger.info('Deposit monitor started (in-process crediting + fee forwarding)');
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

      // ethers v6 types Block.transactions as string[] (hashes); with
      // prefetchTxs=true the runtime returns full TransactionResponse objects.
      const txs = block.transactions as unknown as TransactionResponse[];

      for (const tx of txs) {
        if (tx.to?.toLowerCase() === address.toLowerCase() && tx.value > BigInt(0)) {
          results.push({ from: tx.from, amount: tx.value, txHash: tx.hash });
        }
      }
    }
    return results;
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

    const receipt = await blockchain.getTransactionReceipt(event.txHash);
    if (!receipt || receipt.status !== 1) return;

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
          fromAddress: event.from,
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

    logger.info(`Deposit credited: ${netAmount} ${asset} (tx ${event.txHash})`);

    // Forward the fee ON-CHAIN to the admin fee wallet.
    // Requires a little BNB in the user's custodial wallet for gas; if the
    // transfer fails the fee stays recorded in platformFee for manual sweep.
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

        logger.info(`Fee forwarded: ${fee} ${asset} → ${config.PLATFORM_FEE_WALLET} (tx ${hash})`);
      } catch (err) {
        logger.error(
          `Fee forward failed for ${event.txHash} (fee ${fee} ${asset} recorded in platform_fees — sweep manually). Reason: ${(err as Error).message}`
        );
      }
    }

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
