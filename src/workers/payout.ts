import { Worker, UnrecoverableError } from 'bullmq';
import { prisma } from '../database';
import { bullmqConnection } from '../services/redis';
import { blockchain } from '../services/blockchain';
import { ensureGas, estimateBnbTransferCost } from '../services/gas';
import { config, ASSETS } from '../config';
import { logger } from '../utils/logger';
// UPGRADE (spec §23): dedicated platform payout wallet (DB-configurable)
import { getPayoutWallet } from '../services/treasury';

const CONFIRMATIONS = config.PAYOUT_CONFIRMATIONS;
const CONFIRM_TIMEOUT_MS = 300_000;

/**
 * Wired by bot/index.ts: auto-EDITS the claimant's main message to
 * "REWARD PAID" with the tx hash when the payout finalizes — no new
 * message, no silent waiting at "QUEUED".
 */
type PayoutNotifier = (e: { userId: string; amount: number; asset: string; hash: string }) => void;
let payoutNotifier: PayoutNotifier | null = null;
export function setPayoutNotifier(fn: PayoutNotifier): void {
  payoutNotifier = fn;
}

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

  // ── Dead-giveaway guard ──
  // A CANCELLED/EXPIRED/FAILED giveaway's escrow was already released to the
  // creator via computeOutstandingEscrow (which counts these unpaid slots).
  // Paying them would double-spend from the treasury — mark the claims dead
  // and drain the queue instead.
  if (['CANCELLED', 'EXPIRED', 'FAILED'].includes(claim.giveaway.status)) {
    await prisma.giveawayClaim.updateMany({
      where: { id: claimId, status: { not: 'PAID' } },
      data: { status: 'FAILED', failedReason: `Giveaway ${claim.giveaway.status.toLowerCase()}` },
    });
    logger.info(`Claim ${claimId} closed: giveaway is ${claim.giveaway.status} — no payout, creator already refunded.`);
    return { status: 'giveaway_closed' };
  }

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
        await maybeCompleteGiveaway(claim.giveawayId);
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
  // 'platform' (default): the payout wallet pays the claimant on-chain;
  // the creator's payment was their internal VEYLO balance, locked at
  // creation. 'creator' (legacy): paid from the creator's custodial wallet.
  const payoutOrigin = config.PAYOUT_ORIGIN;
  let signerAddress: string;
  let signerEncryptedKey: string;

  if (payoutOrigin === 'platform') {
    let payoutWallet: { address: string; key: string };
    try {
      payoutWallet = await getPayoutWallet();
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

  // ── Preflight: funds + gas checked IN PARALLEL (was sequential RPC
  // round-trips — each could add seconds or trigger a slow failover). ──
  const [onChainAsset, bnbBalance, transferCost] = await Promise.all([
    blockchain.getBalance(signerAddress, assetKey),
    blockchain.getBalance(signerAddress, 'BNB'),
    estimateBnbTransferCost(),
  ]);

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
  // Creator mode: ensureGas seeds to the CURRENT network cost and waits
  // for the seed to mine — no INSUFFICIENT_FUNDS unwind path anymore.
  // Platform mode: the payout wallet is standing — it can't seed itself, so
  // we verify it holds enough BNB (transient if short; treasury monitor
  // alerts admins). Runs BEFORE the PROCESSING transition either way.
  if (payoutOrigin === 'platform') {
    const needed = BigInt(Math.ceil(transferCost * 1e18));
    if (bnbBalance < needed) {
      throw new Error(
        `Platform payout wallet ${signerAddress} is short on BNB gas ` +
        `(${bnbBalance} < ${needed}). Transient — retry after treasury top-up.`
      );
    }
  } else {
    await ensureGas(signerAddress, transferCost, `payout-${claimId}`);
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
    await maybeCompleteGiveaway(claim.giveawayId);

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
  // UPGRADE: cashback + referral settle at COMPLETION (not creation).
// When EVERY slot is PAID: mark COMPLETED (guarded — one worker wins), then
// credit exactly once each:
//   - CREATOR CASHBACK: creatorCashbackPercent (default 0.5%) of totalAmount
//     to the creator ("credited after it's all given out").
//   - REFERRAL REWARD: referralRewardPercent (default 1%) OF THE CASHBACK
//     the referred creator earned — NOT a percentage of the giveaway amount.
//     $2 giveaway → $0.01 cashback → referrer earns 1% × 0.01 = $0.0001.
// Both idempotent via deterministic per-giveaway keys — retries never
// double-pay. Cancelled/expired giveaways never reach COMPLETED.
async function maybeCompleteGiveaway(giveawayId: string): Promise<void> {
  try {
    const g = await prisma.giveaway.findUnique({ where: { id: giveawayId }, include: { claims: true } });
    if (!g) return;
    const paid = g.claims.filter((c) => c.status === 'PAID').length;
    if (paid < g.maxClaimers) return; // not fully given out yet

    const transitioned = await prisma.giveaway.updateMany({
      where: { id: giveawayId, status: { in: ['ACTIVE', 'FULL'] } },
      data: { status: 'COMPLETED' },
    });
    if (transitioned.count === 0) return; // another worker already settled it

    const { feeConfig } = await import('../services/fee-config');
    const { rewardsService } = await import('../services/rewards');
    const { attributionService } = await import('../services/attribution');
    const { hashIdempotencyKey } = await import('../utils/encryption');
    const fees = await feeConfig.getFees();
    const total = Number(g.totalAmount);

    const cashback = feeConfig.percentOf(total, fees.creatorCashbackPercent);
    if (cashback > 0) {
      await rewardsService.creditReward({
        userId: g.creatorId,
        type: 'GIVEAWAY_CASHBACK',
        sourceType: 'giveaway',
        sourceId: giveawayId,
        asset: g.asset,
        amount: cashback,
        idempotencyKey: hashIdempotencyKey('cashback', giveawayId),
      });
    }

    const referrer = await attributionService.getReferrerOf(g.creatorId);
    if (referrer && referrer.id !== g.creatorId) {
      const refReward = feeConfig.percentOf(cashback, fees.referralRewardPercent);
      if (refReward > 0) {
        await rewardsService.creditReward({
          userId: referrer.id,
          type: 'REFERRAL_REWARD',
          sourceType: 'giveaway',
          sourceId: giveawayId,
          asset: g.asset,
          amount: refReward,
          idempotencyKey: hashIdempotencyKey('referral-reward', giveawayId),
          metadata: { referredCreatorId: g.creatorId, cashbackBasis: cashback },
        });
      }
    }
    logger.info(`Giveaway ${giveawayId} COMPLETED — cashback/referral settled`);
  } catch (err) {
    // Non-fatal: keys are idempotent, a later attempt is safe.
    logger.error(`maybeCompleteGiveaway(${giveawayId}) failed (non-fatal): ${(err as Error).message}`);
  }
}

/**
 * Reclaim seeded gas once every claim is in a terminal state (PAID).
 * Note: failed-then-left-QUEUED claims keep the giveaway out of the
 * reclaim condition until the creator cancels (cancelGiveaway →
 * reclaimGas handles it there). That's intentional — the seed stays
 * available in case the payout is ever requeued after a top-up.
 */
async function maybeReclaimGas(giveawayId: string): Promise<void> {
  // UPGRADE: no-op in platform payout mode — no per-giveaway gas seeds.
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

  // Tell the claimant immediately (bot/index.ts auto-edits their message).
  payoutNotifier?.({ userId, amount, asset: claim.giveaway.asset, hash });
}

worker.on('completed', (job) => {
  logger.info(`Payout job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  if (err instanceof UnrecoverableError) {
    logger.error(`Payout job ${job?.id} permanently stopped (no more retries): ${err.message}`);
  } else {
    logger.error(`Payout job ${job?.id} failed (will retry):`, err);
  }
});

logger.info(`Payout worker started (origin: ${config.PAYOUT_ORIGIN}, confs: ${CONFIRMATIONS})`);
