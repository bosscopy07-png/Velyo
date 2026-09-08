import { Worker } from 'bullmq';
import { prisma } from '../database';
import { redis, checkIdempotency } from '../services/redis';
import { blockchain } from '../services/blockchain';
import { walletService } from '../services/wallet';
import { config, ASSETS } from '../config';
import { logger } from '../utils/logger';
import { payoutQueue } from '../queues';

const worker = new Worker('payouts', async (job) => {
  const { claimId, userId, address, amount, asset, idempotencyKey } = job.data;
  
  // Idempotency check
  const isNew = await checkIdempotency(idempotencyKey);
  if (!isNew) {
    logger.info(`Payout ${idempotencyKey} already processed`);
    return { status: 'already_processed' };
  }

  // Update claim status
  await prisma.giveawayClaim.update({
    where: { id: claimId },
    data: { status: 'PROCESSING' },
  });

  try {
    // Get wallet
    const wallet = await prisma.wallet.findUnique({
      where: { userId: config.PLATFORM_FEE_WALLET },
    });
    
    if (!wallet) throw new Error('Platform wallet not found');

    const assetConfig = ASSETS[asset as keyof typeof ASSETS];
    const decimals = BigInt(10) ** BigInt(assetConfig.decimals);
    const amountBigInt = BigInt(Math.floor(amount * Number(decimals)));

    // Send transaction
    const { hash } = await blockchain.sendTransaction(
      wallet.encryptedPrivateKey,
      address,
      amountBigInt,
      asset as any,
      idempotencyKey
    );

    // Wait for confirmations
    const receipt = await blockchain.waitForConfirmations(hash, 15, 300000);

    if (!receipt || receipt.status !== 1) {
      throw new Error('Transaction failed on chain');
    }

    // Update claim
    await prisma.giveawayClaim.update({
      where: { id: claimId },
      data: {
        status: 'PAID',
        payoutTransactionHash: hash,
      },
    });

    // Record transaction
    await prisma.transaction.create({
      data: {
        userId,
        type: 'GIVEAWAY_REWARD',
        asset,
        amount,
        fee: 0,
        netAmount: amount,
        status: 'CONFIRMED',
        transactionHash: hash,
        toAddress: address,
        idempotencyKey: `${idempotencyKey}_tx`,
      },
    });

    logger.info(`Payout completed: ${hash} for claim ${claimId}`);
    return { status: 'completed', hash };
  } catch (err) {
    logger.error(`Payout failed for claim ${claimId}:`, err);
    
    await prisma.giveawayClaim.update({
      where: { id: claimId },
      data: {
        status: 'FAILED',
        failedReason: (err as Error).message,
      },
    });
    
    throw err; // Trigger retry
  }
}, {
  connection: redis,
  concurrency: config.QUEUE_CONCURRENCY,
});

worker.on('completed', (job) => {
  logger.info(`Payout job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  logger.error(`Payout job ${job?.id} failed:`, err);
});

logger.info('Payout worker started');
