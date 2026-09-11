
import { Worker } from 'bullmq';
import { prisma } from '../database';
import { bullmqConnection } from '../services/redis';
import { blockchain } from '../services/blockchain';
import { config } from '../config';
import { logger } from '../utils/logger';
import { hashIdempotencyKey } from '../utils/encryption';

const worker = new Worker('deposits', async (job) => {
  const { address, asset, txHash, amount } = job.data;

  try {
    const existing = await prisma.transaction.findFirst({
      where: { transactionHash: txHash },
    });

    if (existing) {
      logger.info(`Deposit ${txHash} already processed`);
      return { status: 'already_processed' };
    }

    const receipt = await blockchain.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) {
      throw new Error('Transaction not confirmed or failed');
    }

    const wallet = await prisma.wallet.findUnique({ where: { address } });
    if (!wallet) throw new Error('Wallet not found');

    const feePercent = config.ENABLE_FEES ? config.PLATFORM_FEE_PERCENT : 0;
    const fee = amount * (feePercent / 100);
    const netAmount = amount - fee;

    await prisma.$transaction(async (tx) => {
      await tx.balance.upsert({
        where: { userId_asset: { userId: wallet.userId, asset } },
        create: {
          userId: wallet.userId,
          asset,
          availableBalance: netAmount,
          lockedBalance: 0,
          pendingBalance: 0,
        },
        update: {
          availableBalance: { increment: netAmount },
        },
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
          transactionHash: txHash,
          toAddress: address,
          idempotencyKey: hashIdempotencyKey('deposit', txHash),
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
      where: { txHash },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });

    logger.info(`Deposit processed: ${txHash} - ${netAmount} ${asset}`);
    return { status: 'completed', netAmount };
  } catch (err) {
    logger.error(`Deposit check failed for ${txHash}:`, err);
    throw err;
  }
}, {
  connection: bullmqConnection,
  concurrency: 3,
});

logger.info('Deposit worker started');
        
