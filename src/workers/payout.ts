import { Worker, UnrecoverableError } from 'bullmq';
import { prisma } from '../database';
import { bullmqConnection } from '../services/redis';
import { blockchain } from '../services/blockchain';
import { config, ASSETS } from '../config';
import { logger } from '../utils/logger';

const MIN_GAS_WEI = 1500000000000000n; // 0.0015 BNB
const CONFIRMATIONS = 15;
const CONFIRM_TIMEOUT_MS = 300000;

/** Errors where retrying is pointless — the tx will revert identically every time. */
function isPermanentRevert(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  return (
    msg.includes('transfer amount exceeds balance') ||
    msg.includes('insufficient funds') ||
    msg.includes('INSUFFICIENT_FUNDS') ||
    msg.includes('execution reverted') && msg.includes('BEP20')
  );
}

interface PayoutJobData {
  claimId: string;
  userId: string;
  address: string;
  amount: number;
  asset: string;
  idempotencyKey: string;
}

const worker = new Worker<PayoutJobData>('payouts', async (job) => {
  const { claimId, userId, address, amount, asset, idempotencyKey } = job.data;

  const claim = await prisma.giveawayClaim.findUnique({
    where: { id: claimId },
    include: { giveaway: true },
  });

  if (!claim) throw new UnrecoverableError('Claim not found');
  if (claim.status === 'PAID') {
    logger.info(`Claim ${claimId} already PAID (tx ${claim.payoutTransactionHash})`);
    return { status: 'already_paid', hash: claim.payoutTransactionHash };
  }

  // Crash-recovery: we broadcast a tx previously but never finalized.
  if (claim.status === 'PROCESSING' && claim.payoutTransactionHash) {
    const receipt = await blockchain.getTransactionReceipt(claim.payoutTransactionHash);
    if (receipt?.status === 1) {
      await finalizePaid(claimId, userId, claim.giveaway.creatorId, asset, amount, address, claim.payoutTransactionHash, idempotencyKey);
      await maybeReclaimGas(claim.giveawayId);
      return { status: 'completed', hash: claim.payoutTransactionHash };
    }
    // Tx dropped or reverted on-chain — clear the stale hash and fall through to resend
    logger.warn(`Stale PROCESSING hash ${claim.payoutTransactionHash} for claim ${claimId} — will rebroadcast`);
    await prisma.giveawayClaim.update({
      where: { id: claimId },
      data: { payoutTransactionHash: null },
    });
  }

  // ── Preflight: verify on-chain funds BEFORE broadcasting ──────────────
  const creatorWallet = await prisma.wallet.findUnique({
    where: { userId: claim.giveaway.creatorId },
  });
  if (!creatorWallet) throw new UnrecoverableError('Creator wallet not found');

  const assetKey = asset as keyof typeof ASSETS;
  const assetConfig = ASSETS[assetKey];
  const amountBigInt = BigInt(Math.floor(amount * 10 ** assetConfig.decimals));

  const [onChainAsset, gasBal] = await Promise.all([
    blockchain.getBalance(creatorWallet.address, assetKey),
    blockchain.getBalance(creatorWallet.address, 'BNB'),
  ]);

  if (onChainAsset < amountBigInt) {
    await unwindFailedPayout(claimId, claim.giveaway.creatorId, asset, amount, 'CREATOR_WALLET_UNDERFUNDED');
    throw new UnrecoverableError(
      `Creator wallet ${creatorWallet.address} holds ${onChainAsset} ${asset}, needs ${amountBigInt}. ` +
      `Claim unwound; manual review required.`
    );
  }
  if (gasBal < MIN_GAS_WEI) {
    logger.warn(`Creator wallet ${creatorWallet.address} low on BNB (${gasBal} wei) — payout may fail`);
  }

  // ── Mark PROCESSING (idempotent, only from a non-terminal state) ──────
  const marked = await prisma.giveawayClaim.updateMany({
    where: { id: claimId, status: { in: ['QUEUED', 'RESERVED', 'ADDRESS_CONFIRMED', 'PROCESSING'] } },
    data: { status: 'PROCESSING' },
  });
  if (marked.count === 0) {
    // Another worker picked it up concurrently — let it win
    return { status: 'concurrent_skip' };
  }

  try {
    const { hash } = await blockchain.sendTransaction(
      creatorWallet.encryptedPrivateKey,
      address,
      amountBigInt,
      assetKey,
      idempotencyKey
    );

    await prisma.giveawayClaim.update({
      where: { id: claimId },
      data: { payoutTransactionHash: hash },
    });

    const receipt = await blockchain.waitForConfirmations(hash, CONFIRMATIONS, CONFIRM_TIMEOUT_MS);
    if (!receipt || receipt.status !== 1) {
      throw new Error('Transaction failed on chain');
    }

    await finalizePaid(claimId, userId, claim.giveaway.creatorId, asset, amount, address, hash, idempotencyKey);
    await maybeReclaimGas(claim.giveawayId);

    logger.info(`Payout completed: ${hash} for claim ${claimId}`);
    return { status: 'completed', hash };
  } catch (err) {
    const msg = (err as Error).message;

    if (isPermanentRevert(err)) {
      // Guaranteed to revert again — unwind and stop forever
      await unwindFailedPayout(claimId, claim.giveaway.creatorId, asset, amount, msg);
      throw new UnrecoverableError(`Permanent payout failure for claim ${claimId}: ${msg}`);
    }

    // Transient (RPC, network, timeout) — revert to QUEUED so the retry is clean
    logger.error(`Transient payout failure for claim ${claimId}: ${msg} — will retry`);
    await prisma.giveawayClaim.update({
      where: { id: claimId },
      data: { status: 'QUEUED', payoutTransactionHash: null },
    });
    throw err;
  }
}, {
  connection: bullmqConnection,
  concurrency: config.QUEUE_CONCURRENCY,
});

/**
 * A payout that can never succeed: return the locked slice to the creator's
 * available balance and mark the claim terminal. Idempotent — safe to call
 * once per claim (guarded by the FAILED transition).
 */
async function unwindFailedPayout(
  claimId: string,
  creatorId: string,
  asset: string,
  amount: number,
  reason: string
): Promise<void> {
  const res = await prisma.giveawayClaim.updateMany({
    where: { id: claimId, status: { notIn: ['PAID', 'FAILED'] } },
    data: { status: 'FAILED', failedReason: reason },
  });
  if (res.count === 0) return; // already terminal — don't double-refund

  await prisma.$transaction(async (tx) => {
    await tx.balance.update({
      where: { userId_asset: { userId: creatorId, asset } },
      data: {
        lockedBalance: { decrement: amount },
        availableBalance: { increment: amount },
      },
    });

    await tx.transaction.create({
      data: {
        userId: creatorId,
        type: 'GIVEAWAY_REFUND',
        asset,
        amount,
        fee: 0,
        netAmount: amount,
        status: 'CONFIRMED',
        idempotencyKey: `payout-unwind-${claimId}`,
        metadata: { claimId, reason },
      },
    });
  });

  logger.error(`Payout unwound for claim ${claimId}: ${amount} ${asset} returned to creator (${reason})`);
}

/**
 * Reclaim seeded gas once every claim is in a terminal state (PAID or FAILED).
 * Previously this required ALL claims PAID — one permanent failure meant the
 * BNB seed sat in the wallet forever.
 */
async function maybeReclaimGas(giveawayId: string): Promise<void> {
  try {
    const [totalClaims, terminalClaims] = await Promise.all([
      prisma.giveawayClaim.count({ where: { giveawayId } }),
      prisma.giveawayClaim.count({
        where: { giveawayId, status: { in: ['PAID', 'FAILED'] } },
      }),
    ]);
    if (totalClaims > 0 && terminalClaims >= totalClaims) {
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
  // Guarded transition: only one finalize ever runs per claim
  const res = await prisma.giveawayClaim.updateMany({
    where: { id: claimId, status: { not: 'PAID' } },
    data: { status: 'PAID', payoutTransactionHash: hash },
  });
  if (res.count === 0) return;

  await prisma.$transaction(async (tx) => {
    await tx.balance.update({
      where: { userId_asset: { userId: creatorId, asset } },
      data: { lockedBalance: { decrement: amount } },
    });

    await tx.transaction.create({
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
  });
}

worker.on('completed', (job) => {
  logger.info(`Payout job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  if (err instanceof UnrecoverableError) {
    logger.error(`Payout job ${job?.id} permanently failed (no more retries): ${err.message}`);
  } else {
    logger.error(`Payout job ${job?.id} failed (will retry):`, err);
  }
});

logger.info('Payout worker started');
                                         
