import { Worker } from 'bullmq';
import { prisma } from '../database';
import { bullmqConnection } from '../services/redis';
import { blockchain } from '../services/blockchain';
import { config, ASSETS } from '../config';
import { logger } from '../utils/logger';

const worker = new Worker('payouts', async (job) => {
  const { claimId, userId, address, amount, asset, idempotencyKey } = job.data;

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
    const receipt = await blockchain.getTransactionReceipt(claim.payoutTransactionHash);
    if (receipt && receipt.status === 1) {
      await finalizePaid(claimId, userId, claim.giveaway.creatorId, asset, amount, address, claim.payoutTransactionHash, idempotencyKey);
      await maybeReclaimGas(claim.giveawayId, claim.giveaway.maxClaimers);
      return { status: 'completed', hash: claim.payoutTransactionHash };
    }
  }

  await prisma.giveawayClaim.update({
    where: { id: claimId },
    data: { status: 'PROCESSING' },
  });

  try {
    // Funds live in the CREATOR's wallet (and that's where gas was seeded)
    const creatorWallet = await prisma.wallet.findUnique({
      where: { userId: claim.giveaway.creatorId },
    });
    if (!creatorWallet) throw new Error('Creator wallet not found');

    const gasBal = await blockchain.getBalance(creatorWallet.address, 'BNB');
    if (gasBal < 1500000000000000n) {
      logger.warn(`Creator wallet ${creatorWallet.address} low on BNB (${gasBal} wei). Payout gas was seeded at creation — if this fails, re-check.`);
    }

    const assetConfig = ASSETS[asset as keyof typeof ASSETS];
    const decimals = BigInt(10) ** BigInt(assetConfig.decimals);
    const amountBigInt = BigInt(Math.floor(amount * Number(decimals)));

    const { hash } = await blockchain.sendTransaction(
      creatorWallet.encryptedPrivateKey,
      address,
      amountBigInt,
      asset as keyof typeof ASSETS,
      idempotencyKey
    );

    await prisma.giveawayClaim.update({
      where: { id: claimId },
      data: { payoutTransactionHash: hash },
    });

    const receipt = await blockchain.waitForConfirmations(hash, 15, 300000);
    if (!receipt || receipt.status !== 1) {
      throw new Error('Transaction failed on chain');
    }

    await finalizePaid(claimId, userId, claim.giveaway.creatorId, asset, amount, address, hash, idempotencyKey);
    await maybeReclaimGas(claim.giveawayId, claim.giveaway.maxClaimers);

    logger.info(`Payout completed: ${hash} for claim ${claimId}`);
    return { status: 'completed', hash };
  } catch (err) {
    logger.error(`Payout attempt failed for claim ${claimId}: ${(err as Error).message}`);
    await prisma.giveawayClaim.update({
      where: { id: claimId },
      data: { status: 'FAILED', failedReason: (err as Error).message },
    });
    throw err;
  }
}, {
  connection: bullmqConnection,
  concurrency: config.QUEUE_CONCURRENCY,
});

/** Once every claim is PAID, sweep unused seeded gas back to the admin wallet. */
async function maybeReclaimGas(giveawayId: string, maxClaimers: number): Promise<void> {
  try {
    const paidCount = await prisma.giveawayClaim.count({
      where: { giveawayId, status: 'PAID' },
    });
    if (paidCount >= maxClaimers) {
      const { giveawayService } = await import('../services/giveaway');
      await giveawayService.reclaimGas(giveawayId);
    }
  } catch (err) {
    logger.error(`Post-payout gas reclaim check failed: ${(err as Error).message}`);
  }
}

async function finalizePaid(
  claimId: string,
  userId: string,
  creatorId: string,
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

  await prisma.balance.update({
    where: { userId_asset: { userId: creatorId, asset } },
    data: { lockedBalance: { decrement: amount } },
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
  
