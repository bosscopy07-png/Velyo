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
  }): Promise<{ giveawayId: string; secureCode: string; amountPerUser: number }> {
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
    // Worst-case fee for the pre-checks below — the in-transaction re-check
    // applies the actual (reward-credit-discounted) total.
    const preFee = cost.fee;
    const preTotalCost = data.totalAmount + preFee;

    // Lazy wallet: creators need a real custodial wallet (funds + gas live there)
    await walletService.createWallet(data.creatorId);

    // ── REAL-BALANCE GATE ──
    // DB can hold phantom credits (old refunds, admin-era redeems). Only
    // on-chain truth may fund a giveaway. Conservative: full fee — the
    // in-tx re-check below applies the actual total after credit discount.
    const creatorWallet = await prisma.wallet.findUnique({ where: { userId: data.creatorId } });
    if (creatorWallet) {
      const raw = await blockchain.getBalance(creatorWallet.address, data.asset);
      const onChain = Number(raw) / 1e18;
      const lockedRow = await prisma.balance.findUnique({
        where: { userId_asset: { userId: data.creatorId, asset: data.asset } },
      });
      const pendingFees = await prisma.platformFee.aggregate({
        where: { sweptAt: null, asset: data.asset, transaction: { userId: data.creatorId } },
        _sum: { amount: true },
      });
      const realAvailable = onChain - Number(lockedRow?.lockedBalance ?? 0) - Number(pendingFees._sum.amount ?? 0);
      if (realAvailable < preTotalCost) {
        throw new Error(
          `Insufficient ${data.asset} — your wallet holds ${realAvailable.toFixed(6)} ${data.asset} on-chain ` +
          `(need ${preTotalCost.toFixed(6)} including fees). Deposit more ${data.asset} first.`
        );
      }
    }

    // ── SEED GAS FIRST ──────────────────────────────────────────────────
    // Fail fast: if the operator wallet can't fund the gas budget, we throw
    // BEFORE the giveaway exists — no locked funds, no unpayable giveaway.
    // (Old behavior: seed after creation, swallow failures, discover the
    // empty wallet at payout time as a permanent INSUFFICIENT_FUNDS unwind.)
    const seedHash = await this.seedPayoutGas(data.creatorId, giveawayId, data.maxClaimers + GAS_BUFFER_UNITS);

    const giveaway = await prisma.$transaction(async (tx) => {
      // ── REWARD CREDIT DISCOUNT (spec §4/§6) ──
      // Earned cashback/referral rewards live in the internal Reward ledger
      // (auditable; never phantom on-chain spendable balance). They are
      // consumed HERE, atomically with creation, as a credit against the
      // platform fee only — never the giveaway principal, never gas.
      const appliedCredit = await rewardsService.consumeCredit(tx, data.creatorId, data.asset, cost.platformFee);
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
          metadata: {
            giveawayId: g.id,
            feeBreakdown: {
              platformFee: platformFeeDue,
              gasFee: cost.gasFee,
              gasUnits: cost.gasUnits,
              appliedRewardCredit: appliedCredit, // auditable discount (spec §6)
            },
          },
        },
      });

      // Fee row 1: platform fee (net of consumed reward credit) — forwarded on-chain right
      // after creation
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

    // Immediately forward the full creation fee on-chain to the platform
    // wallet — waits for the seed to MINE first (cross-wallet ordering).
    const totalFeeForward = Number((cost.fee).toFixed(6));
    await this.forwardCreationFee(giveaway.id, data.creatorId, data.asset, totalFeeForward, seedHash);

    // ── CREATOR CASHBACK (spec §4/§49) ──
    // Percentage comes from the CENTRAL fee config (default 1%). Credited to
    // the internal Reward ledger (Reward row + REWARD transaction + balance
    // credit, one $transaction — see services/rewards.ts). Atomic +
    // idempotent: the key is deterministic per giveaway, so a retried
    // confirmation or a crash between creation and credit can never pay
    // twice. Runs AFTER the giveaway exists; failure is logged and never
    // breaks creation (the same call is safe to replay).
    try {
      const fees = await feeConfig.getFees();
      const cashback = feeConfig.percentOf(data.totalAmount, fees.creatorCashbackPercent);
      if (cashback > 0) {
        await rewardsService.creditReward({
          userId: data.creatorId,
          type: 'GIVEAWAY_CASHBACK',
          sourceType: 'giveaway',
          sourceId: giveaway.id,
          asset: data.asset,
          amount: cashback,
          idempotencyKey: hashIdempotencyKey('cashback', giveaway.id),
        });
      }
    } catch (err) {
      logger.error(`Creator cashback failed for giveaway ${giveaway.id} (retry-safe, reconcile manually): ${(err as Error).message}`);
    }

    logger.info(`Giveaway created: ${giveaway.id} by ${data.creatorId} (${data.totalAmount} ${data.asset}, fee ${preFee})`);
    return { giveawayId: giveaway.id, secureCode, amountPerUser };
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

      // Atomic: increment claimedCount only if not full. This prevents race
      // conditions where two users claim the last slot simultaneously.
      // Also auto-transition to FULL when claimedCount reaches maxClaimers.
      //
      // NOTE: this runs as the LAST eligible-state check in the flow — after the
      // giveaways.read state, the unique (giveawayId, userId) claim lookup, and the
      // status/expiry/full guards above. A retried callback from this point on
      // either hits the existing-claim branch above (idempotent) or this
      // guarded UPDATE returns nothing ("just filled up").
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

// ════════════════════════ PART 2 CONTINUES BELOW ════════════════════════
      async cancelGiveaway(giveawayId: string, userId: string): Promise<{ refundAmount: number; transactionHash: string | null; asset: string }> {
    // Atomic: only transition ACTIVE → CANCELLED if still ACTIVE.
    // If count = 0, someone else cancelled first — read their result, don't double-refund.
    const transition = await prisma.giveaway.updateMany({
      where: { id: giveawayId, creatorId: userId, status: 'ACTIVE' },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });

    if (transition.count === 0) {
      const existing = await prisma.giveaway.findUnique({ where: { id: giveawayId } });
      if (existing?.status === 'CANCELLED') {
        // Idempotent: report the outcome of the first (successful) call
        const { outstanding } = await computeOutstandingEscrow(giveawayId);
        return {
          refundAmount: outstanding,
          transactionHash: null,
          asset: existing.asset,
        };
      }
      throw new Error('Giveaway not found or no longer active');
    }

    // ── CANONICAL ESCROW RELEASE (see computeOutstandingEscrow) ──
    const { giveaway, outstanding } = await computeOutstandingEscrow(giveawayId);

    if (outstanding > 0) {
      const { hashIdempotencyKey } = await import('../utils/encryption');

      await prisma.$transaction(async (tx) => {
        await tx.balance.update({
          where: { userId_asset: { userId: giveaway.creatorId, asset: giveaway.asset } },
          data: {
            availableBalance: { increment: outstanding },
            lockedBalance: { decrement: outstanding },
          },
        });

        await tx.transaction.create({
          data: {
            userId: giveaway.creatorId,
            type: 'REFUND',
            asset: giveaway.asset,
            amount: outstanding,
            fee: 0,
            netAmount: outstanding,
            status: 'CONFIRMED',
            idempotencyKey: hashIdempotencyKey('refund', giveawayId),
            metadata: { giveawayId },
          },
        });
      });
    }

    // Reclaim seeded gas from the (now defunct) payout wallet — operator funds back.
    // Never throws into the cancel flow: worst case we log and an admin can reclaim later.
    await this.reclaimGas(giveawayId).catch((err) =>
      logger.error(`Gas reclaim after cancel failed for ${giveawayId}: ${(err as Error).message}`)
    );

    logger.info(`Giveaway ${giveawayId} cancelled by ${userId}, refunded ${outstanding}`);
    return { refundAmount: outstanding, transactionHash: null, asset: giveaway.asset };
  }

  /**
   * Seed the giveaway's payout wallet with gas for its claims + buffer.
   *
   * The "why": keeping the gas on the CREATOR's wallet (and forwarding the
   * creation fee from it) means the creator never needs BNB — only USDT.
   * The operator wallet funds the gas budget up front; `reclaimGas` sweeps
   * the change back to the operator once every claim is PAID. Seeding runs
   * BEFORE the giveaway exists in the DB, so a failure here means the
   * giveaway is never created and no funds are locked.
   *
   * @returns The seed transaction hash (must mine before any spend).
   */
  private async seedPayoutGas(creatorId: string, giveawayId: string, units: number): Promise<string> {
    if (!config.OPERATOR_WALLET_KEY) {
      throw new Error('OPERATOR_WALLET_KEY not configured — cannot seed gas');
    }

    const wallet = await walletService.createWallet(creatorId);
    const needed = Number((await estimateBnbTransferCost()) * units);
    const baseline = Number(await blockchain.getBalance(wallet.address, 'BNB')) / 1e18;

    const deficit = needed - baseline;
    if (deficit <= 0) {
      logger.info(`Payout gas already sufficient for ${wallet.address} (${baseline} BNB ≥ ${needed})`);
      return '';
    }

    // 1.5× headroom on the deficit — fee spikes between seed and spend
    // must not strand the wallet (that's the INSUFFICIENT_FUNDS unwind path).
    const padded = Number((deficit * 1.5).toFixed(6));
    logger.info(`Seeding ${padded} BNB gas to ${wallet.address} (deficit ${deficit}, ${units} units)`);

    const seedIdem = hashIdempotencyKey('seed', giveawayId);
    const { hash } = await blockchain.sendTransaction(
      config.OPERATOR_WALLET_KEY,
      wallet.address,
      BigInt(Math.floor(padded * 1e18)),
      'BNB',
      seedIdem
    );

    // Tracked for adjustOperatorBalance (called post-confirmation in queuePayout path)
    await redis.set(`gas:seeded:${giveawayId}`, padded.toString());

    return hash;
  }

  /**
   * Reclaim leftover seeded gas from the creator's wallet back to the
   * operator wallet — but ONLY from what this giveaway seeded (never touch
   * other giveaways' budgets or the user's own BNB).
   *
   * Protection: reads `gas:seeded:${giveawayId}` (set at seed time). Zero or
   * missing → nothing to reclaim (caller bug) or already reclaimed → skip.
   */
  async reclaimGas(giveawayId: string): Promise<void> {
    if (!config.OPERATOR_WALLET_KEY) return;

    const seededStr = await redis.get(`gas:seeded:${giveawayId}`);
    if (!seededStr) return;

    const seeded = parseFloat(seededStr);
    if (!(seeded > 0)) {
      await redis.del(`gas:seeded:${giveawayId}`);
      return;
    }

    const giveaway = await prisma.giveaway.findUnique({ where: { id: giveawayId }, include: { creator: true } });
    if (!giveaway) return;

    const wallet = await prisma.wallet.findUnique({ where: { userId: giveaway.creatorId } });
    if (!wallet) return;

    const bnbBalance = Number(await blockchain.getBalance(wallet.address, 'BNB')) / 1e18;

    // Leave a small safety margin (0.0003 BNB) for dust/future ops
    const margin = 0.0003;
    const reclaimable = Math.min(seeded, Math.max(0, bnbBalance - margin));

    if (reclaimable < 0.00001) {
      await redis.del(`gas:seeded:${giveawayId}`);
      return;
    }

    try {
      const { hash } = await blockchain.sendTransaction(
        wallet.encryptedPrivateKey,
        config.PLATFORM_FEE_WALLET,
        BigInt(Math.floor(reclaimable * 1e18)),
        'BNB',
        hashIdempotencyKey('reclaim', giveawayId)
      );

      // Confirm before adjusting the ledger so a dropped tx can't double-count
      await blockchain.waitMined(hash, 90000);
      await walletService.adjustOperatorBalance('BNB', -reclaimable);

      await redis.del(`gas:seeded:${giveawayId}`);
      logger.info(`Reclaimed ${reclaimable} BNB from ${wallet.address} (giveaway ${giveawayId})`);
    } catch (err) {
      logger.error(`Gas reclaim failed for ${giveawayId}: ${(err as Error).message} — key retained for retry`);
      // Key kept — the next reclaim attempt will retry with the same idempotency key
    }
  }

  /**
   * Forward the creation fee (platform + gas) to the platform wallet.
   * @param seedHash Seed tx hash — MUST mine first (cross-wallet ordering)
   */
  private async forwardCreationFee(
    giveawayId: string,
    creatorId: string,
    asset: string,
    amount: number,
    seedHash: string
  ): Promise<void> {
    try {
      if (seedHash) {
        await blockchain.waitMined(seedHash, 120000);
      }

      const wallet = await prisma.wallet.findUnique({ where: { userId: creatorId } });
      if (!wallet) return;

      const raw = await blockchain.getBalance(wallet.address, asset as AssetSymbol);
      const onChain = Number(raw) / 1e18;

      if (onChain < amount) {
        logger.warn(`Wallet ${wallet.address} short ${amount} ${asset} (has ${onChain}) — skipping fee forward`);
        return;
      }

      const { hash } = await blockchain.sendTransaction(
        wallet.encryptedPrivateKey,
        config.PLATFORM_FEE_WALLET,
        BigInt(Math.floor(amount * 1e18)),
        asset as AssetSymbol,
        hashIdempotencyKey('creation-fee-fwd', giveawayId)
      );

      // Wait for the forward to mine, then mark fee rows swept and settle the
      // operator ledger (seeded gas + forwarded fee arrive together).
      await blockchain.waitMined(hash, 120000);
      await prisma.platformFee.updateMany({
        where: { sweptAt: null, asset, transaction: { userId: creatorId, metadata: { path: ['giveawayId'], equals: giveawayId } } },
        data: { sweptAt: new Date() },
      });

      const seeded = parseFloat((await redis.get(`gas:seeded:${giveawayId}`)) || '0');
      if (seeded > 0) {
        await walletService.adjustOperatorBalance('BNB', -seeded);
        await redis.del(`gas:seeded:${giveawayId}`);
      }

      logger.info(`Forwarded creation fee ${amount} ${asset} for giveaway ${giveawayId} (tx ${hash})`);
    } catch (err) {
      logger.error(`Failed to forward creation fee for ${giveawayId}: ${(err as Error).message}`);
    }
  }

  async getGiveawayStats(giveawayId: string): Promise<{
    giveawayId: string;
    creatorId: string;
    totalAmount: string;
    amountPerUser: string;
    asset: string;
    claimedCount: number;
    maxClaimers: number;
    claims: Array<{
      id: string;
      claimOrder: number;
      status: string;
      claimedAt: Date;
      user: { username: string | null; firstName: string | null };
    }>;
    paidClaims: Array<{ id: string }>;
    pendingClaims: Array<{ id: string }>;
    failedClaims: Array<{ id: string }>;
  } | null> {
    const giveaway = await prisma.giveaway.findUnique({
      where: { id: giveawayId },
      include: {
        claims: {
          orderBy: { claimOrder: 'asc' },
          include: { user: { select: { username: true, firstName: true } } },
        },
      },
    });

    if (!giveaway) return null;

    return {
      giveawayId: giveaway.id,
      creatorId: giveaway.creatorId,
      totalAmount: giveaway.totalAmount.toString(),
      amountPerUser: giveaway.amountPerUser.toString(),
      asset: giveaway.asset,
      claimedCount: giveaway.claimedCount,
      maxClaimers: giveaway.maxClaimers,
      claims: giveaway.claims.map((c) => ({
        id: c.id,
        claimOrder: c.claimOrder,
        status: c.status,
        claimedAt: c.claimedAt,
        user: c.user,
      })),
      paidClaims: giveaway.claims.filter((c) => c.status === 'PAID'),
      pendingClaims: giveaway.claims.filter((c) => c.status === 'QUEUED' || c.status === 'PROCESSING' || c.status === 'ADDRESS_CONFIRMED'),
      failedClaims: giveaway.claims.filter((c) => c.status === 'FAILED'),
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
        
