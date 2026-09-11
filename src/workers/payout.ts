import { Worker } from 'bullmq';
import { prisma } from '../database';
import { bullmqConnection, checkIdempotency } from '../services/redis';
import { blockchain } from '../services/blockchain';
import { config, ASSETS } from '../config';
import { logger } from '../utils/logger';

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
    // Get platform hot wallet — the wallet whose job is to fund payouts.
    // NOTE: userId here must be the platform wallet owner's user id, not an address.
    const platformWallet = await prisma.wallet.findFirst({
      orderBy: { createdAt: 'asc' },
    });

    if (!platformWallet) throw new Error('Platform wallet not found');

    const assetConfig = ASSETS[asset as keyof typeof ASSETS];
    const decimals = BigInt(10) ** BigInt(assetConfig.decimals);
    const amountBigInt = BigInt(Math.floor(amount * Number(decimals)));

    // Send transaction
    const { hash } = await blockchain.sendTransaction(
      platformWallet.encryptedPrivateKey,
      address,
      amountBigInt,
      asset as keyof typeof ASSETS,
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
  connection: bullmqConnection,
  concurrency: config.QUEUE_CONCURRENCY,
});

worker.on('completed', (job) => {
  logger.info(`Payout job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  logger.error(`Payout job ${job?.id} failed:`, err);
});

logger.info('Payout worker started');
