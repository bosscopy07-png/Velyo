import { Worker, UnrecoverableError } from 'bullmq';
import { prisma } from '../database';
import { bullmqConnection } from '../services/redis';
import { blockchain } from '../services/blockchain';
import { ensureGas, estimateBnbTransferCost } from '../services/gas';
import { config, ASSETS } from '../config';
import { logger } from '../utils/logger';
// UPGRADE (spec §23): dedicated platform payout wallet
import { getPayoutWallet } from '../services/treasury';

const CONFIRMATIONS = 15;
const CONFIRM_TIMEOUT_MS = 300_000;

/** Claim states that are allowed to enter PROCESSING (terminal states excluded) */
const PAYOUTABLE_STATUSES = ['QUEUED', 'RESERVED', 'ADDRESS_PENDING', 'ADDRESS_CONFIRMED', 'PROCESSING'] as const;

/**
 * Errors where retrying is pointless — the ASSET transfer itself will
 * revert identically every time (e.g. the creator wallet genuinely doesn't
 * hold enough USDT).
 *
 * NOTE: "insufficient funds" for GAS is deliberately NOT permanent anymore.
 * ensureGas() tops the wallet up from the operator wallet before every
 * send; if it's still short, the operator wallet is dry — that's transient
 * (retry later), not a reason to touch creator funds.
 *
 * Policy on permanent failure: DO NOT unwind. No refund, no slot release,
 * no FAILED bookkeeping. The claim simply returns to QUEUED and stops
 * retrying; the CREATOR cancels the giveaway to reclaim the escrow, which
 * refunds exactly the right amount exactly once via
 * computeOutstandingEscrow (PAID claims + existing REFUND rows).
 */
function isPermanentRevert(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  return (
    msg.includes('transfer amount exceeds balance') ||
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

  // ── UPGRADE (spec §23): select the signing wallet ──
  // 'platform' (default): the dedicated payout wallet pays the claimant
  // on-chain (env-configurable via PAYOUT_WALLET_ADDRESS/PAYOUT_WALLET_KEY);
  // the creator's payment was their internal VEYLO balance, which was
  // locked at creation. 'creator' (legacy): the claimant is paid from the
  // creator's custodial wallet.
  const payoutOrigin = config.PAYOUT_ORIGIN;
  let signerAddress: string;
  let signerEncryptedKey: string;

  if (payoutOrigin === 'platform') {
    let payoutWallet: { address: string; key: string };
    try {
      payoutWallet = getPayoutWallet();
    } catch (err) {
      throw new UnrecoverableError((err as Error).message);
    }
    signerAddress = payoutWallet.address;
    signerEncryptedKey = payoutWallet.key;
  } else {
    const creatorWallet = await prisma.wallet.findUnique({
      where: { userId: claim.giveaway.creatorId },
    });
    if (!creatorWallet) throw new UnrecoverableError('Creator wallet not found');
    signerAddress = creatorWallet.address;
    signerEncryptedKey = creatorWallet.encryptedPrivateKey;
  }

  const assetKey = asset as keyof typeof ASSETS;
  const assetConfig = ASSETS[assetKey];
  const amountBigInt = BigInt(Math.floor(amount * 10 ** assetConfig.decimals));

  // ── Preflight: verify on-chain funds BEFORE broadcasting ──
  const onChainAsset = await blockchain.getBalance(signerAddress, assetKey);

  if (onChainAsset < amountBigInt) {
    // NO unwind, NO refund, NO slot release — just stop.
    // Creator cancels the giveaway to reclaim; or tops up and an admin/
    // future job can requeue. State is left untouched (still QUEUED).
    throw new UnrecoverableError(
      `Payout wallet ${signerAddress} holds ${onChainAsset} ${asset}, needs ${amountBigInt}. ` +
      `Payout left pending — no funds moved. Creator can cancel the giveaway for a full refund.`
    );
  }

  // ── Gas BEFORE marking PROCESSING ──
  // Creator mode: ensureGas seeds from the operator wallet to the CURRENT
  // network cost and waits for the seed to mine, so the payout can never
  // hit the INSUFFICIENT_FUNDS unwind path anymore.
  // Platform mode: the payout wallet is a standing platform wallet — it
  // cannot seed itself, so we verify it already holds enough BNB; if not,
  // this is TRANSIENT (retry after top-up) and the treasury monitor alerts
  // the admins. Runs BEFORE the PROCESSING transition either way, so a
  // failure here leaves the claim cleanly in QUEUED.
  if (payoutOrigin === 'platform') {
    const needed = BigInt(Math.ceil((await estimateBnbTransferCost()) * 1e18));
    const bnbBalance = await blockchain.getBalance(signerAddress, 'BNB');
    if (bnbBalance < needed) {
      throw new Error(
        `Platform payout wallet ${signerAddress} is short on BNB gas ` +
        `(${bnbBalance} < ${needed}). Transient — retry after treasury top-up.`
      );
    }
  } else {
    await ensureGas(signerAddress, await estimateBnbTransferCost(), `payout-${claimId}`);
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
      signerEncryptedKey,
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

    logger.info(`Payout completed: ${hash} for claim ${claimId} (origin: ${payoutOrigin})`);
    return { status: 'completed', hash };
  } catch (err) {
    const msg = (err as Error).message;

    if (isPermanentRevert(err)) {
      // Guaranteed to revert again. Per policy: DO NOT refund, DO NOT
      // release the slot, DO NOT mark FAILED. Just put the claim back to
      // QUEUED so the state is clean, then stop retrying. The creator
      // cancels the giveaway to reclaim the escrow.
      await prisma.giveawayClaim.update({
        where: { id: claimId },
        data: { status: 'QUEUED', payoutTransactionHash: null },
      });
      logger.error(
        `Permanent payout failure for claim ${claimId}: ${msg}. ` +
        `Left QUEUED — no refund issued. Creator can cancel the giveaway to reclaim funds.`
      );
      throw new UnrecoverableError(`Permanent payout failure for claim ${claimId}: ${msg}`);
    }

    // Transient (RPC, network, timeout, operator-wallet-dry gas seed) —
    // revert to QUEUED for a clean retry.
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
 * Reclaim seeded gas once every claim is in a terminal state (PAID).
 * Note: failed-then-left-QUEUED claims keep the giveaway out of the
 * reclaim condition until the creator cancels (cancelGiveaway →
 * reclaimGas handles it there). That's intentional — the seed stays
 * available in case the payout is ever requeued after a top-up.
 */
async function maybeReclaimGas(giveawayId: string): Promise<void> {
  // UPGRADE: no-op in platform payout mode — there are no per-giveaway gas
  // seeds to reclaim (the payout wallet is a standing platform wallet).
  if (config.PAYOUT_ORIGIN === 'platform') return;
  try {
    const [totalClaims, paidClaims] = await Promise.all([
      prisma.giveawayClaim.count({ where: { giveawayId } }),
      prisma.giveawayClaim.count({
        where: { giveawayId, status: 'PAID' },
      }),
    ]);
    if (totalClaims > 0 && paidClaims >= totalClaims) {
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
    logger.error(`Payout job ${job?.id} permanently stopped (no more retries): ${err.message}`);
  } else {
    logger.error(`Payout job ${job?.id} failed:`, err);
  }
});

logger.info(`Payout worker started (origin: ${config.PAYOUT_ORIGIN})`);
  
