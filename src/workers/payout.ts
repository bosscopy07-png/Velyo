import { Worker } from 'bullmq';
import { prisma } from '../database';
import { bullmqConnection } from '../services/redis';
import { blockchain } from '../services/blockchain';
import { config, ASSETS } from '../config';
import { logger } from '../utils/logger';

const worker = new Worker('payouts', async (job) => {
  const { claimId, userId, address, amount, asset, idempotencyKey } = job.data;

  // Idempotency via CLAIM STATE — failed jobs must be able to retry
  const claim = await prisma.giveawayClaim.findUnique({
    where: { id: claimId },
    include: { giveaway: true },
  });

  if (!claim) throw new Error('Claim not found');
  if (claim.status === 'PAID') {
    logger.info(`Claim ${claimId} already PAID (tx ${claim.payoutTransactionHash})`);
    return { status: 'already_paid', hash: claim.payoutTransactionHash };
  }
  if (claim.status === 'PROCESSING' && claim.payoutTransactionHash) {
    // Previous attempt broadcast the tx but crashed before confirming — resume
    const receipt = await blockchain.getTransactionReceipt(claim.payoutTransactionHash);
    if (receipt && receipt.status === 1) {
      await finalizePaid(claimId, userId, asset, amount, address, claim.payoutTransactionHash, idempotencyKey);
      return { status: 'completed', hash: claim.payoutTransactionHash };
    }
  }

  await prisma.giveawayClaim.update({
    where: { id: claimId },
    data: { status: 'PROCESSING' },
  });

  try {
    // Hot wallet: first wallet in the DB (the operator/creator wallet).
    // Gas was seeded at giveaway creation — this worker never sends BNB.
    const platformWallet = await prisma.wallet.findFirst({
      orderBy: { createdAt: 'asc' },
    });
    if (!platformWallet) throw new Error('Platform wallet not found');

    const gasBal = await blockchain.getBalance(platformWallet.address, 'BNB');
    if (gasBal < 1500000000000000n) { // < 0.0015 BNB
      logger.warn(`Hot wallet ${platformWallet.address} low on BNB (${gasBal} wei). Payout gas was seeded at creation — if this fails, re-check.`);
    }

    const assetConfig = ASSETS[asset as keyof typeof ASSETS];
    const decimals = BigInt(10) ** BigInt(assetConfig.decimals);
    const amountBigInt = BigInt(Math.floor(amount * Number(decimals)));

    const { hash } = await blockchain.sendTransaction(
      platformWallet.encryptedPrivateKey,
      address,
      amountBigInt,
      asset as keyof typeof ASSETS,
      idempotencyKey
    );

    // Record hash immediately so a crash after broadcast is resumable
    await prisma.giveawayClaim.update({
      where: { id: claimId },
      data: { payoutTransactionHash: hash },
    });

    const receipt = await blockchain.waitForConfirmations(hash, 15, 300000);
    if (!receipt || receipt.status !== 1) {
      throw new Error('Transaction failed on chain');
    }

    await finalizePaid(claimId, userId, asset, amount, address, hash, idempotencyKey);
    logger.info(`Payout completed: ${hash} for claim ${claimId}`);
    return { status: 'completed', hash };
  } catch (err) {
    logger.error(`Payout attempt failed for claim ${claimId}: ${(err as Error).message}`);
    await prisma.giveawayClaim.update({
      where: { id: claimId },
      data: { status: 'FAILED', failedReason: (err as Error).message },
    });
    throw err; // BullMQ retry
  }
}, {
  connection: bullmqConnection,
  concurrency: config.QUEUE_CONCURRENCY,
});

async function finalizePaid(
  claimId: string,
  userId: string,
  asset: string,
  amount: number,
  address: string,
  hash: string,
  idempotencyKey: string
): Promise<void> {
  await prisma.giveawayClaim.update({
    where: { id: claimId },
    data: { status: 'PAID', payoutTransactionHash: hash },
  });

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
}

worker.on('completed', (job) => {
  logger.info(`Payout job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  logger.error(`Payout job ${job?.id} failed:`, err);
});

logger.info('Payout worker started');