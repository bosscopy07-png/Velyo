
import { prisma } from '../database';
import { assertUserOperational } from './maintenance';
import { redis, acquireLock, releaseLock } from './redis';
import { blockchain } from './blockchain';
import { walletService } from './wallet';
import { config } from '../config';
import { generateSecureCode } from '../utils/validation';
import { logger } from '../utils/logger';
import { ensureGas, estimateBnbTransferCost } from './gas';
import { randomUUID } from 'crypto';
import type { AssetSymbol } from '../config';
// UPGRADE: central fee source + reward ledger (spec §4/§26/§49)
import { feeConfig } from './fee-config';
import { rewardsService } from './rewards';

/**
 * Gas economics — DYNAMIC.
 *
 * The old static 0.000002 BNB/tx budget fell BELOW the real network cost
 * (~0.0000026 BNB at the time of the INSUFFICIENT_FUNDS payout failures),
 * so every seeded wallet was underfunded and payouts/permanent unwinds
 * followed. Per-tx cost now comes from estimateBnbTransferCost()
 * (live gas price + 1.5× headroom) — never a stale constant.
 */
const BNB_USD_FALLBACK = 550;
/** Extra seeded units: 1 buffer for claim rounding + 1 for the fee-forward tx */
const GAS_BUFFER_UNITS = 2;

/** USDT value of `units` real BEP20 transfers (for charging gas to users) */
export async function estimateGasUSDT(units: number): Promise<number> {
  const bnbCost = (await estimateBnbTransferCost()) * units;
  let usd = 0;
  try {
    const { pricing } = await import('./pricing');
    usd = await pricing.convertToUSD('BNB', bnbCost);
  } catch {}
  if (!usd || usd <= 0) usd = bnbCost * BNB_USD_FALLBACK;
  return Number(usd.toFixed(6));
}

export interface CreationCost {
  platformFee: number;
  gasFee: number;
  fee: number;
  total: number;
  gasUnits: number;
}

export async function estimateCreationCost(totalAmount: number, maxClaimers: number): Promise<CreationCost> {
  const platformFee = config.ENABLE_FEES
    ? Number((totalAmount * (config.PLATFORM_FEE_PERCENT / 100)).toFixed(6))
    : 0;
  // claimers payouts + 1 buffer + 1 fee-forward transaction
  const gasUnits = maxClaimers + GAS_BUFFER_UNITS;
  const gasFee = await estimateGasUSDT(gasUnits);
  const fee = Number((platformFee + gasFee).toFixed(6));
  return { platformFee, gasFee, fee, total: Number((totalAmount + fee).toFixed(6)), gasUnits };
}

/**
 * ============================================================================
 * WHY THIS FUNCTION EXISTS — the second phantom-balance bug
 * ============================================================================
 * Three different places used to each compute "how much escrow to give
 * back to the creator" independently, from different (incomplete) inputs:
 *
 *   - claim-expiry.ts:  refunds `amountPerUser` for ONE expired claim
 *   - payout.ts:         refunds `amountPerUser` for ONE permanently-failed claim
 *   - cleanup.ts (OLD):  refunded `totalAmount - claimedCount * amountPerUser`
 *                        for the WHOLE giveaway when it naturally expired
 *
 * `claimedCount` reflects currently-occupied slots, not "ever claimed" —
 * it's decremented the moment a claim expires or its payout is unwound, so
 * a slot that was already refunded by claim-expiry.ts still looks
 * "unclaimed" to cleanup.ts's math. Result: cleanup.ts refunded the ENTIRE
 * remaining pot as if nothing had ever been given back, on top of whatever
 * claim-expiry.ts or payout.ts had already refunded for that same slot —
 * a real double-refund. It shows up as `lockedBalance` going negative and
 * `availableBalance` inflated by the same amount, with ZERO on-chain
 * footprint (this is pure internal bookkeeping — no blockchain transaction
 * happens on refund), so `balance-sync.ts`'s on-chain drift check can never
 * catch it: `available + locked` is unchanged, only the split between them
 * is wrong.
 *
 * Fix: ONE canonical calculation, driven by evidence already in the DB
 * (which claims were actually PAID, which REFUND transactions already
 * exist for this giveaway — tagged by `metadata.giveawayId`, whichever
 * code path created them) rather than by trusting `claimedCount`. Every
 * release path now asks this function "how much is still outstanding?"
 * and refunds exactly that — never more than once, never by guesswork.
 * ============================================================================
 */
export async function computeOutstandingEscrow(giveawayId: string): Promise<{
  giveaway: { id: string; creatorId: string; asset: string; totalAmount: unknown };
  outstanding: number;
}> {
  const giveaway = await prisma.giveaway.findUnique({
    where: { id: giveawayId },
    include: { claims: true },
  });

  if (!giveaway) {
    throw new Error(`computeOutstandingEscrow: giveaway ${giveawayId} not found`);
  }

  const amountPerUser = Number(giveaway.amountPerUser);

  // Money that actually left the wallet on-chain — genuinely consumed, never refundable.
  const paidOut = giveaway.claims.filter((c) => c.status === 'PAID').length * amountPerUser;

  // Every REFUND transaction already recorded for this giveaway, from ANY
  // code path (claim-expiry, payout-unwind, a previous cancel/expiry run).
  const alreadyRefundedAgg = await prisma.transaction.aggregate({
    where: {
      userId: giveaway.creatorId,
      asset: giveaway.asset,
      type: 'REFUND',
      metadata: { path: ['giveawayId'], equals: giveawayId },
    },
    _sum: { amount: true },
  });
  const alreadyRefunded = Number(alreadyRefundedAgg._sum.amount ?? 0);

  const outstanding = Math.max(
    0,
    Number((Number(giveaway.totalAmount) - paidOut - alreadyRefunded).toFixed(8))
  );

  return { giveaway, outstanding };
}

class GiveawayService {
  async createGiveaway(data: {
    creatorId: string;
    asset: AssetSymbol;
    totalAmount: number;
    maxClaimers: number;
    expiresAt?: Date;
  }): Promise<{ giveawayId: string; secureCode: string; amountPerUser: number; appliedCredit: number }> {
    // Maintenance gate — MUST stay first: before gas seeding, wallet creation
    // or any balance/ledger write. Throws a user-safe MaintenanceError.
    await assertUserOperational(data.creatorId);

    const amountPerUser = data.totalAmount / data.maxClaimers;
    const secureCode = generateSecureCode(20);
    // Client-generated ID so gas can be seeded BEFORE any DB write — if the
    // seed fails, createGiveaway throws and no funds ever move.
    const giveawayId = randomUUID();
    const { hashIdempotencyKey } = await import('../utils/encryption');

    const cost = await estimateCreationCost(data.totalAmount, data.maxClaimers);
    // Worst-case fee for the pre-checks — the in-transaction re-check applies
    // the actual (reward-credit-discounted) total.
    const preFee = cost.fee;
    const preTotalCost = data.totalAmount + preFee;

    // Lazy wallet: creators need a real custodial wallet (funds + gas live there)
    await walletService.createWallet(data.creatorId);

    // ── BALANCE GATE (spec §23/§37) ──
    // The DB ledger is the ONLY spendable source: deposit sessions and
    // rewards credit it; giveaways spend from it. Every mutation is
    // ledger-recorded. No on-chain fallback — no per-user chain reads.
    const preBalanceRow = await prisma.balance.findUnique({
      where: { userId_asset: { userId: data.creatorId, asset: data.asset } },
    });
    const internalAvailable = Number(preBalanceRow?.availableBalance ?? 0);
    if (internalAvailable < preTotalCost) {
      throw new Error(
        `Insufficient ${data.asset} — you have ${internalAvailable.toFixed(6)} in your VEYLO balance ` +
        `and need ${preTotalCost.toFixed(6)} including fees. Deposit more ${data.asset} first.`
      );
    }

    // ── SEED GAS FIRST ──────────────────────────────────────────────────
    // Fail fast: if the operator wallet can't fund the gas budget, we throw
    // BEFORE the giveaway exists — no locked funds, no unpayable giveaway.
    // (Old behavior: seed after creation, swallow failures, discover the
    // empty wallet at payout time as a permanent INSUFFICIENT_FUNDS unwind.)
    // Platform payout mode pays claimants from the PLATFORM wallet — no
    // per-giveaway gas seed on the creator's wallet is needed. Legacy
    // (creator) mode keeps seeding exactly as before.
    const seedHash =
      config.PAYOUT_ORIGIN === 'platform'
        ? null
        : await this.seedPayoutGas(data.creatorId, giveawayId, data.maxClaimers + GAS_BUFFER_UNITS);

    // Captured inside the transaction so the UI can disclose it (rewards
    // credit auto-discounts the platform fee).
    let appliedCredit = 0;

    const giveaway = await prisma.$transaction(async (tx) => {
      // ── REWARD CREDIT DISCOUNT (spec §4/§6) ──
      // Earned cashback/referral rewards (internal Reward ledger) are
      // consumed HERE, atomically with creation, as a credit against the
      // platform fee only — never the giveaway principal, never gas.
      appliedCredit = await rewardsService.consumeCredit(tx, data.creatorId, data.asset, cost.platformFee);
      const platformFeeDue = Number((cost.platformFee - appliedCredit).toFixed(8));
      const fee = Number((platformFeeDue + cost.gasFee).toFixed(6));
      const totalCost = data.totalAmount + fee;

      const balance = await tx.balance.findUnique({
        where: { userId_asset: { userId: data.creatorId, asset: data.asset } },
      });
      const available = Number(balance?.availableBalance ?? 0);
      if (available < totalCost) {
        throw new Error(
          `Insufficient ${data.asset} balance — you have ${available.toFixed(6)} ${data.asset}, ` +
          `need ${totalCost.toFixed(6)}. Deposit more ${data.asset} first.`
        );
      }

      await tx.balance.update({
        where: { userId_asset: { userId: data.creatorId, asset: data.asset } },
        data: {
          availableBalance: { decrement: totalCost },
          lockedBalance: { increment: data.totalAmount },
        },
      });

      const g = await tx.giveaway.create({
        data: {
          id: giveawayId,
          creatorId: data.creatorId,
          asset: data.asset,
          totalAmount: data.totalAmount,
          amountPerUser,
          maxClaimers: data.maxClaimers,
          secureCode,
          expiresAt: data.expiresAt,
          status: 'ACTIVE',
        },
      });

      await tx.transaction.create({
        data: {
          userId: data.creatorId,
          type: 'GIVEAWAY_CREATED',
          asset: data.asset,
          amount: data.totalAmount,
          fee,
          netAmount: -data.totalAmount,
          status: 'CONFIRMED',
          idempotencyKey: hashIdempotencyKey('giveaway', g.id),
          metadata: { giveawayId: g.id, feeBreakdown: { platformFee: cost.platformFee, gasFee: cost.gasFee, gasUnits: cost.gasUnits, appliedCredit } },
        },
      });

      // Fee row 1: 1% platform fee — forwarded on-chain right after creation
      if (platformFeeDue > 0) {
        const feeTx = await tx.transaction.create({
          data: {
            userId: data.creatorId,
            type: 'PLATFORM_FEE',
            asset: data.asset,
            amount: platformFeeDue,
            fee: 0,
            netAmount: platformFeeDue,
            status: 'CONFIRMED',
            metadata: { giveawayId: g.id, kind: 'creation_fee_1pct', appliedRewardCredit: appliedCredit },
            idempotencyKey: hashIdempotencyKey('creation-fee', g.id),
          },
        });
        await tx.platformFee.create({
          data: { transactionId: feeTx.id, asset: data.asset, amount: platformFeeDue, feeWallet: config.PLATFORM_FEE_WALLET },
        });
      }

      // Fee row 2: gas charge — forwarded on-chain right after creation
      if (cost.gasFee > 0) {
        const gasTx = await tx.transaction.create({
          data: {
            userId: data.creatorId,
            type: 'PLATFORM_FEE',
            asset: data.asset,
            amount: cost.gasFee,
            fee: 0,
            netAmount: cost.gasFee,
            status: 'CONFIRMED',
            metadata: { giveawayId: g.id, kind: 'creation_gas', gasUnits: cost.gasUnits },
            idempotencyKey: hashIdempotencyKey('creation-gas', g.id),
          },
        });
        await tx.platformFee.create({
          data: { transactionId: gasTx.id, asset: data.asset, amount: cost.gasFee, feeWallet: config.PLATFORM_FEE_WALLET },
        });
      }

      return g;
    });

    // NOTE: creator cashback settles at COMPLETION (workers/payout.
    // maybeCompleteGiveaway) — ONLY when EVERY claimant has been paid.
    // Created-then-cancelled giveaways never reach COMPLETED → no cashback.

    if (config.PAYOUT_ORIGIN === 'platform') {
      // Platform mode: the creator's payment is INTERNAL — their balance was
      // debited and treasury already holds the backing (deposits forward
      // there). No on-chain fee forward or gas seed: settle the fee rows
      // internally as swept.
      await prisma.platformFee.updateMany({
        where: {
          sweptAt: null,
          transaction: { userId: data.creatorId, metadata: { path: ['giveawayId'], equals: giveaway.id } },
        },
        data: { sweptAt: new Date() },
      });
    } else {
      // Immediately forward the full creation fee on-chain to the platform
      // wallet — waits for the seed to MINE first (cross-wallet ordering).
      const feeForward = Number((cost.fee).toFixed(6));
      await this.forwardCreationFee(giveaway.id, data.creatorId, data.asset, feeForward, seedHash);
    }

    logger.info(`Giveaway created: ${giveaway.id} by ${data.creatorId} (${data.totalAmount} ${data.asset}, fee ${preFee}, credit ${appliedCredit})`);
    return { giveawayId: giveaway.id, secureCode, amountPerUser, appliedCredit };
}
    /**
   * Sends the creator's full creation fee (1% + gas charge) on-chain to the
   * platform fee wallet. Marks the giveaway's platformFee rows swept on
   * success; leaves them pending on failure (admin sweep is the fallback).
   *
   * `seedHash`: the gas-seed tx hash from seedPayoutGas. The seed comes from
   * the ADMIN wallet and this forward from the CREATOR wallet — different
   * senders, so the per-address queue cannot order them. We must wait for
   * the seed to mine explicitly, else the node validates the forward against
   * a confirmed balance that doesn't include the seed (INSUFFICIENT_FUNDS).
   */
  private async forwardCreationFee(
    giveawayId: string,
    creatorId: string,
    asset: AssetSymbol,
    amount: number,
    seedHash: string | null
  ): Promise<void> {
    if (amount <= 0) return;

    try {
      if (seedHash) await blockchain.waitMined(seedHash, 60000);

      const wallet = await prisma.wallet.findUnique({ where: { userId: creatorId } });
      if (!wallet) return;

      // Belt-and-braces: top up to the CURRENT network cost before signing.
      // Covers "no seed was needed at creation" wallets and any drift between
      // the seed and now. No-op when the wallet is already funded.
      await ensureGas(wallet.address, await estimateBnbTransferCost(), `creation-fwd-${giveawayId}`);

      const raw = BigInt(Math.floor(amount * 1e18));
      const { hash } = await blockchain.sendTransaction(
        wallet.encryptedPrivateKey,
        config.PLATFORM_FEE_WALLET,
        raw,
        asset,
        `creation-fwd-${giveawayId}`
      );

      await prisma.platformFee.updateMany({
        where: {
          sweptAt: null,
          transaction: { userId: creatorId, metadata: { path: ['giveawayId'], equals: giveawayId } },
        },
        data: { sweptAt: new Date() },
      });
      await walletService.adjustOperatorBalance(asset, amount);
      logger.info(`Creation fee forwarded: ${amount} ${asset} → platform wallet (tx ${hash})`);
    } catch (err) {
      logger.error(`Creation fee forward failed for giveaway ${giveawayId} (stays pending for admin sweep): ${(err as Error).message}`);
    }
  }

  /**
   * Seeds gas from the admin wallet; returns the seed tx hash (or null).
   *
   * THROWS on failure — ensureGas propagates, and so do we. Seeding must
   * never fail silently again: an unseeded wallet means a guaranteed
   * INSUFFICIENT_FUNDS payout unwind later.
   */
  private async seedPayoutGas(creatorId: string, giveawayId: string, units: number): Promise<string | null> {
    let wallet = await prisma.wallet.findUnique({ where: { userId: creatorId } });
    if (!wallet) {
      await walletService.createWallet(creatorId);
      wallet = await prisma.wallet.findUnique({ where: { userId: creatorId } });
      if (!wallet) throw new Error(`seedPayoutGas: wallet provisioning failed for ${creatorId}`);
    }

    const baseline = await blockchain.getBalance(wallet.address, 'BNB');
    // Dynamic, network-derived budget — (maxClaimers + buffer) × current
    // transfer cost with headroom. Never the old static 0.000002 constant.
    const neededBnb = Number((units * (await estimateBnbTransferCost())).toFixed(8));

    const { seededBnb, hash } = await ensureGas(wallet.address, neededBnb, `giveaway-${giveawayId}`);

    await redis.set(
      `gas:credit:${giveawayId}`,
      JSON.stringify({
        address: wallet.address,
        baseline: baseline.toString(),
        seeded: BigInt(Math.floor(seededBnb * 1e18)).toString(),
      }),
      'EX', 60 * 60 * 24 * 30
    );
    return hash;
  }

  /**
   * After all claims are paid (or the giveaway is cancelled):
   * leftover seeded BNB → admin wallet, creator refunded the USDT value
   * of the leftover.
   */
  async reclaimGas(giveawayId: string): Promise<void> {
    try {
      const raw = await redis.get(`gas:credit:${giveawayId}`);
      if (!raw) return;
      const credit = JSON.parse(raw) as { address: string; baseline: string; seeded: string };

      if (BigInt(credit.seeded) === 0n) {
        await redis.del(`gas:credit:${giveawayId}`);
        return;
      }

      const wallet = await prisma.wallet.findUnique({ where: { address: credit.address } });
      if (!wallet) {
        await redis.del(`gas:credit:${giveawayId}`);
        return;
      }

      const current = await blockchain.getBalance(credit.address, 'BNB');
      const ours = current - BigInt(credit.baseline);

      // Dynamic reclaim cost — the old hardcoded 0.0000018 was also below
      // the real network cost, so the reclaim tx itself could fail.
      const reclaimTxGas = BigInt(Math.ceil((await estimateBnbTransferCost()) * 1e18));

      if (ours <= reclaimTxGas) {
        logger.info(`Gas reclaim for ${giveawayId}: leftover ${ours} wei below reclaim cost — kept as wallet float.`);
        await redis.del(`gas:credit:${giveawayId}`);
        return;
      }

      const sendBack = ours - reclaimTxGas;
      const { hash } = await blockchain.sendTransaction(
        wallet.encryptedPrivateKey,
        config.PLATFORM_FEE_WALLET,
        sendBack,
        'BNB',
        `gas-reclaim-${giveawayId}`
      );
      logger.info(`Gas reclaimed for ${giveawayId}: ${Number(sendBack) / 1e18} BNB → admin (tx ${hash})`);
      await walletService.adjustOperatorBalance('BNB', Number(sendBack) / 1e18);

      // Refund the USD value of the reclaimed BNB (USDT ≈ USD).
      const reclaimedBnb = Number(sendBack) / 1e18;
      let usd = 0;
      try {
        const { pricing } = await import('./pricing');
        usd = await pricing.convertToUSD('BNB', reclaimedBnb);
      } catch {}
      if (!usd || usd <= 0) usd = reclaimedBnb * BNB_USD_FALLBACK;
      const refundUSDT = Number(usd.toFixed(6));

      if (refundUSDT > 0) {
        await walletService.creditFunds(wallet.userId, 'USDT', refundUSDT);
        const { hashIdempotencyKey } = await import('../utils/encryption');
        await prisma.transaction.create({
          data: {
            userId: wallet.userId,
            type: 'REFUND',
            asset: 'USDT',
            amount: refundUSDT,
            fee: 0,
            netAmount: refundUSDT,
            status: 'CONFIRMED',
            idempotencyKey: hashIdempotencyKey('gas-refund', giveawayId),
            metadata: { kind: 'gas_refund', giveawayId, reclaimedBNB: reclaimedBnb },
          },
        });
        logger.info(`Gas refund for ${giveawayId}: ${refundUSDT} USDT credited to creator`);
      }

      await redis.del(`gas:credit:${giveawayId}`);
    } catch (err) {
      logger.error(`Gas reclaim failed for ${giveawayId}: ${(err as Error).message}`);
    }
        }
                                                                                      async claimGiveaway(giveawayId: string, userId: string): Promise<{ success: boolean; reason?: string; claimOrder?: number }> {
    // Maintenance gate — before the claim lock and any claim/ledger write.
    try {
      await assertUserOperational(userId);
    } catch (err) {
      if ((err as { code?: string }).code === 'MAINTENANCE_ACTIVE') {
        return { success: false, reason: '🔧 VEYLO is under maintenance. Please try again later.' };
      }
      throw err;
    }

    const lockKey = `giveaway:claim:${giveawayId}`;
    const lockToken = await acquireLock(lockKey, 5000);

    if (!lockToken) {
      return { success: false, reason: 'System busy, please try again' };
    }

    try {
      const existingClaim = await prisma.giveawayClaim.findUnique({
        where: { giveawayId_userId: { giveawayId, userId } },
      });

      if (existingClaim) {
        return { success: false, reason: 'You already claimed this giveaway' };
      }

      const giveaway = await prisma.giveaway.findUnique({
        where: { id: giveawayId },
        include: { claims: true },
      });

      if (!giveaway) return { success: false, reason: 'Giveaway not found' };

      // ── CREATOR BLOCK CHECK (spec §8) ──
      // Scoped blocks ONLY: creator-scoped (giveawayId IS NULL) or
      // giveaway-scoped. NEVER a global platform ban — User.status remains
      // admin-only. Server-side check; callback payload never trusted.
      const { attributionService } = await import('./attribution');
      if (await attributionService.isBlocked({ creatorId: giveaway.creatorId, giveawayId, userId })) {
        return { success: false, reason: 'You are not eligible to claim this giveaway' };
      }

      if (giveaway.status !== 'ACTIVE') return { success: false, reason: 'Giveaway is not active' };
      if (giveaway.expiresAt && giveaway.expiresAt < new Date()) {
        return { success: false, reason: 'Giveaway has expired' };
      }
      if (giveaway.claimedCount >= giveaway.maxClaimers) {
        return { success: false, reason: 'Giveaway is full' };
      }

      const result = await prisma.$queryRaw<{ claimedCount: number }[]>`
        UPDATE giveaways
        SET "claimedCount" = "claimedCount" + 1,
            status = CASE
              WHEN "claimedCount" + 1 >= "maxClaimers" THEN 'FULL'::"GiveawayStatus"
              ELSE status
            END,
            "updatedAt" = NOW()
        WHERE id = ${giveawayId}
          AND "claimedCount" < "maxClaimers"
          AND status = 'ACTIVE'
        RETURNING "claimedCount"
      `;

      if (!result || result.length === 0) {
        return { success: false, reason: 'Giveaway just filled up' };
      }

      const claimOrder = result[0].claimedCount;

      await prisma.giveawayClaim.create({
        data: { giveawayId, userId, status: 'RESERVED', claimOrder },
      });

      logger.info(`Giveaway ${giveawayId} claimed by ${userId}, order: ${claimOrder}`);
      return { success: true, claimOrder };
    } finally {
      await releaseLock(lockKey, lockToken);
    }
  }

  async submitAddress(claimId: string, address: string): Promise<void> {
    await prisma.giveawayClaim.update({
      where: { id: claimId },
      data: { walletAddress: address, status: 'ADDRESS_CONFIRMED' },
    });

    // Anti-looting signals (spec §9): advisory ClaimFlag rows ONLY. No IP
    // logic of any kind (a bot cannot see IPs; shared IPs are meaningless),
    // no automatic bans, and flags never block the payout — creators and
    // admins review them in the claimant/security views.
    try {
      const { claimRiskService } = await import('./claim-risk');
      void claimRiskService.evaluateClaim(claimId);
    } catch (err) {
      logger.error(`Claim risk evaluation failed for ${claimId} (non-fatal): ${(err as Error).message}`);
    }
  }

  async cancelGiveaway(giveawayId: string, userId: string): Promise<{ success: boolean; reason?: string }> {
    const giveaway = await prisma.giveaway.findUnique({
      where: { id: giveawayId },
      include: { claims: true },
    });

    if (!giveaway) return { success: false, reason: 'Giveaway not found' };
    if (giveaway.creatorId !== userId) return { success: false, reason: 'Not authorized' };
    if (giveaway.claims.some((c) => c.status === 'PAID')) {
      return { success: false, reason: 'Cannot cancel: payouts already sent' };
    }

    // ATOMIC transition: exactly one caller can move out of ACTIVE/FULL.
    // A double-tap, or an unwind racing a cancel, gets count 0 → no refund.
    const transitioned = await prisma.giveaway.updateMany({
      where: { id: giveawayId, status: { in: ['ACTIVE', 'FULL'] } },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    if (transitioned.count === 0) {
      return { success: false, reason: 'Already cancelled' };
    }

    // Re-read AFTER the transition: no new claims can start (status is now
    // CANCELLED) and any unwind that already released a slot is reflected
    // here.
    const fresh = await prisma.giveaway.findUnique({
      where: { id: giveawayId },
      include: { claims: true },
    });
    if (!fresh) return { success: false, reason: 'Giveaway not found' };

    const { outstanding } = await computeOutstandingEscrow(giveawayId);

    if (outstanding > 0) {
      await prisma.$transaction(async (tx) => {
        await tx.balance.update({
          where: { userId_asset: { userId: fresh.creatorId, asset: fresh.asset } },
          data: {
            availableBalance: { increment: outstanding },
            lockedBalance: { decrement: outstanding },
          },
        });

        const { hashIdempotencyKey } = await import('../utils/encryption');
        await tx.transaction.create({
          data: {
            userId: fresh.creatorId,
            type: 'REFUND',
            asset: fresh.asset,
            amount: outstanding,
            fee: 0,
            netAmount: outstanding,
            status: 'CONFIRMED',
            idempotencyKey: hashIdempotencyKey('refund', giveawayId),
            metadata: { giveawayId, kind: 'cancel' },
          },
        });
      });
    }

    await this.reclaimGas(giveawayId);
    return { success: true };
  }
    async getGiveawayStats(giveawayId: string): Promise<{
    totalReward: number;
    totalSlots: number;
    linkOpens: number;
    claimAttempts: number;
    spotsSecured: number;
    payoutsCompleted: number;
    remainingSlots: number;
  }> {
    const giveaway =
      (await prisma.giveaway.findUnique({ where: { id: giveawayId }, include: { claims: true } })) ??
      (await prisma.giveaway.findUnique({ where: { secureCode: giveawayId }, include: { claims: true } }));

    if (!giveaway) throw new Error('Giveaway not found');

    const linkOpens = await redis
      .get(`giveaway:views:${giveawayId}`)
      .then((v) => parseInt(v || '0'));

    return {
      totalReward: Number(giveaway.totalAmount),
      totalSlots: giveaway.maxClaimers,
      linkOpens,
      claimAttempts: giveaway.attemptCount,
      spotsSecured: giveaway.claimedCount,
      payoutsCompleted: giveaway.claims.filter((c) => c.status === 'PAID').length,
      remainingSlots: giveaway.maxClaimers - giveaway.claimedCount,
    };
  }

  async trackAttempt(giveawayId: string): Promise<void> {
    await prisma.giveaway.update({
      where: { id: giveawayId },
      data: { attemptCount: { increment: 1 } },
    });
  }
}

export const giveawayService = new GiveawayService();
