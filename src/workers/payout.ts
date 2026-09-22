import { Worker, UnrecoverableError } from 'bullmq';
import { prisma } from '../database';
import { bullmqConnection } from '../services/redis';
import { blockchain } from '../services/blockchain';
import { config, ASSETS } from '../config';
import { logger } from '../utils/logger';

const MIN_GAS_WEI = 1500000000000000n; // 0.0015 BNB
const CONFIRMATIONS = 15;
const CONFIRM_TIMEOUT_MS = 300_000;

/** Claim states that are allowed to enter PROCESSING (terminal states excluded) */
const PAYOUTABLE_STATUSES = ['QUEUED', 'RESERVED', 'ADDRESS_PENDING', 'ADDRESS_CONFIRMED', 'PROCESSING'] as const;

/** Errors where retrying is pointless — the tx will revert identically every time. */
function isPermanentRevert(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  return (
    msg.includes('transfer amount exceeds balance') ||
    msg.includes('insufficient funds') ||
    msg.includes('INSUFFICIENT_FUNDS') ||
    (msg.includes('execution reverted') && msg.includes('BEP20'))
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

type ClaimWithGiveaway = {
  id: string;
  giveawayId: string;
  status: string;
  payoutTransactionHash: string | null;
  giveaway: { creatorId: string; asset: string };
};

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

  // ── Crash recovery: broadcast previously but never finalized ──
  if (claim.status === 'PROCESSING') {
    if (claim.payoutTransactionHash) {
      const receipt = await blockchain.getTransactionReceipt(claim.payoutTransactionHash);
      if (receipt?.status === 1) {
        await finalizePaid(claim, userId, address, amount, idempotencyKey, claim.payoutTransactionHash);
        await maybeReclaimGas(claim.giveawayId);
        return { status: 'completed', hash: claim.payoutTransactionHash };
      }
      // Dropped or reverted on-chain — clear the stale hash and rebroadcast below
      logger.warn(`Stale PROCESSING hash ${claim.payoutTransactionHash} for claim ${claimId} — will rebroadcast`);
      await prisma.giveawayClaim.update({
        where: { id: claimId },
        data: { payoutTransactionHash: null },
      });
    } else {
      // PROCESSING with no hash = worker died before broadcasting — safe to retry
      logger.info(`Claim ${claimId} stuck PROCESSING without hash — retrying`);
    }
  }

  // ── Preflight: verify on-chain funds BEFORE broadcasting ──
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
    await unwindFailedPayout(claim, amount, 'CREATOR_WALLET_UNDERFUNDED');
    throw new UnrecoverableError(
      `Creator wallet ${creatorWallet.address} holds ${onChainAsset} ${asset}, needs ${amountBigInt}. ` +
      `Claim unwound; manual review required.`
    );
  }
  if (gasBal < MIN_GAS_WEI) {
    logger.warn(`Creator wallet ${creatorWallet.address} low on BNB (${gasBal} wei) — payout may fail`);
  }

  // ── Mark PROCESSING (guarded — only one worker wins per claim) ──
  const marked = await prisma.giveawayClaim.updateMany({
    where: { id: claimId, status: { in: [...PAYOUTABLE_STATUSES] } },
    data: { status: 'PROCESSING' },
  });
  if (marked.count === 0) {
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

    await finalizePaid(claim, userId, address, amount, idempotencyKey, hash);
    await maybeReclaimGas(claim.giveawayId);

    logger.info(`Payout completed: ${hash} for claim ${claimId}`);
    return { status: 'completed', hash };
  } catch (err) {
    const msg = (err as Error).message;

    if (isPermanentRevert(err)) {
      // Guaranteed to revert again — unwind and stop forever
      await unwindFailedPayout(claim, amount, msg);
      throw new UnrecoverableError(`Permanent payout failure for claim ${claimId}: ${msg}`);
    }

    // Transient (RPC, network, timeout) — revert to QUEUED for a clean retry
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
 * available balance AND release the claim's slot on the giveaway atomically.
 *
 * Releasing the slot is what prevents the double-refund: once released, a
 * later cancelGiveaway no longer counts this share as escrowed, so it is
 * never refunded a second time. FULL giveaways reopen (status → ACTIVE).
 *
 * Race safety vs cancel: the whole thing runs in one transaction. If the
 * giveaway was already CANCELLED, cancel already refunded every funded slot
 * — so we skip our refund entirely (cancel owns it). The guarded FAILED
 * transition makes the whole path idempotent.
 */
async function unwindFailedPayout(
  claim: ClaimWithGiveaway,
  amount: number,
  reason: string
): Promise<void> {
  const claimId = claim.id;
  const creatorId = claim.giveaway.creatorId;
  const asset = claim.giveaway.asset;

  // Guarded terminal transition — a double-call never double-refunds.
  const res = await prisma.giveawayClaim.updateMany({
    where: { id: claimId, status: { notIn: ['PAID', 'FAILED'] } },
    data: { status: 'FAILED', failedReason: reason.slice(0, 500) },
  });
  if (res.count === 0) return; // already terminal

  await prisma.$transaction(async (tx) => {
    // Re-check giveaway status inside the tx: if a cancel won the race,
    // cancel already refunded this share — releasing the slot AND refunding
    // here would double-pay the creator.
    const giveaway = await tx.giveaway.findUnique({
      where: { id: claim.giveawayId },
      select: { status: true },
    });

    if (giveaway && giveaway.status !== 'CANCELLED') {
      // Release the slot so a later cancel won't refund this share again,
      // and reopen the giveaway if it had gone FULL.
      await tx.$queryRaw`
        UPDATE giveaways
        SET "claimedCount" = "claimedCount" - 1,
            status = CASE WHEN status = 'FULL' THEN 'ACTIVE'::"GiveawayStatus" ELSE status END,
            "updatedAt" = NOW()
        WHERE id = ${claim.giveawayId} AND "claimedCount" > 0
      `;

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
          type: 'REFUND',
          asset,
          amount,
          fee: 0,
          netAmount: amount,
          status: 'CONFIRMED',
          idempotencyKey: `payout-unwind-${claimId}`,
          metadata: { kind: 'payout_unwind', claimId, giveawayId: claim.giveawayId, reason },
        },
      });
    }
  });

  logger.error(`Payout unwound for claim ${claimId}: ${amount} ${asset} returned to creator, slot released (${reason})`);
}

/**
 * Reclaim seeded gas once every claim is in a terminal state (PAID or FAILED).
 * Requiring ALL claims PAID would strand the BNB seed forever when one fails.
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

/**
 * Finalize a confirmed payout: guarded PAID transition, release the creator's
 * locked slice, record the reward tx, and link it to the claim via the
 * schema's payoutTransactionId relation.
 */
async function finalizePaid(
  claim: { id: string; giveaway: { creatorId: string; asset: string } },
  userId: string,
  address: string,
  amount: number,
  idempotencyKey: string,
  hash: string
): Promise<void> {
  // Guarded transition: only one finalize ever runs per claim
  const res = await prisma.giveawayClaim.updateMany({
    where: { id: claim.id, status: { not: 'PAID' } },
    data: { status: 'PAID', payoutTransactionHash: hash },
  });
  if (res.count === 0) return;

  await prisma.$transaction(async (tx) => {
    await tx.balance.update({
      where: { userId_asset: { userId: claim.giveaway.creatorId, asset: claim.giveaway.asset } },
      data: { lockedBalance: { decrement: amount } },
    });

    const payoutTx = await tx.transaction.create({
      data: {
        userId,
        type: 'GIVEAWAY_REWARD',
        asset: claim.giveaway.asset,
        amount,
        fee: 0,
        netAmount: amount,
        status: 'CONFIRMED',
        transactionHash: hash,
        toAddress: address,
        idempotencyKey: `${idempotencyKey}_tx`,
      },
    });

    await tx.giveawayClaim.update({
      where: { id: claim.id },
      data: { payoutTransactionId: payoutTx.id },
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

      
