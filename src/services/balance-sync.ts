import { prisma } from '../database';
import { redis } from './redis';
import { blockchain } from './blockchain';
import { depositMonitor } from './deposit-monitor';
import { pendingGasSeedKey } from './gas';
import { config } from '../config';
import { logger } from '../utils/logger';
import cron from 'node-cron';
import {
  SYNC_ASSETS,
  SYNC_TOLERANCE,
  gatherBalanceComponents,
  type BalanceComponents,
  type SyncAsset,
} from './balance-accounting';

/**
 * ============================================================================
 * SELF-HEALING BALANCE SYNC (v3)
 * ============================================================================
 *
 * v1 auto-credited the raw onChain-vs-expected gap as a txHash-less
 * "chain-sync" deposit → real deposits got credited twice (once here,
 * once by the monitor) = phantom money.
 *
 * v2 fixed that by going detect-and-alert only → discrepancies never
 * healed and admins got spammed.
 *
 * v3 (this file) heals automatically, but ONLY through evidence:
 *
 *   chain > DB  → find the actual Transfer event(s) explaining the gap
 *                 and feed them through depositMonitor.handleDepositCheck,
 *                 the SAME fee-aware, idempotent, confirmation-gated
 *                 pipeline normal deposits use. The fee question answers
 *                 itself: claimAndCredit deducts flat fee + 1% + gas.
 *                 Nothing is minted from a bare delta ever again.
 *
 *   DB > chain  → the DB holds a phantom credit (old bug residue, admin
 *                 error, etc). Auto-debit the excess from
 *                 availableBalance + audit log. Deleting money that was
 *                 never real cannot hurt a user; it protects float.
 *
 *   Either way  → the discrepancy must persist across TWO consecutive
 *                 cycles (~10 min) before we touch anything, and any
 *                 in-flight deposit (monitor CONFIRMING/CONFIRMED rows)
 *                 or pending operator gas seed suppresses action — those
 *                 are the monitor's job, not ours.
 *
 * No Telegram notifications. Discrepancies that can't be attributed to a
 * real on-chain event are logged and left alone.
 * ============================================================================
 */

// Every 5 minutes at second 30 — offset from the deposit monitor's scans.
const CRON_SCHEDULE = '30 */5 * * * *';

/**
 * A deposit can be legitimately "in flight" for a full detection cycle
 * plus its 15-confirmation wait. Anything newer than this is the monitor
 * doing its job, not a discrepancy.
 */
const IN_FLIGHT_GRACE_MS = 25 * 60 * 1000;

/** How far back to look for missed Transfer events when chain > DB. */
const EVENT_LOOKBACK_BLOCKS = 1500;

/** Redis persistence gate: a diff must be seen twice (~10 min apart) before we act. */
const driftKey = (userId: string, asset: string) => `sync:drift:${userId}:${asset}`;
const DRIFT_TTL_SEC = 40 * 60;

class BalanceSyncService {
  private isRunning = false;

  start(): void {
    cron.schedule(CRON_SCHEDULE, () => void this.syncAll());
    logger.info('Balance self-heal sync started (every 5 min, heal-through-monitor, no alerts)');
  }

  private async syncAll(): Promise<void> {
    if (this.isRunning) return; // prevent overlapping runs
    this.isRunning = true;

    try {
      const wallets = await prisma.wallet.findMany({
        where: {
          status: 'ACTIVE',
          // Operator wallet is synced explicitly via adjustOperatorBalance —
          // its on-chain balance legitimately differs from any user ledger.
          address: { not: config.PLATFORM_FEE_WALLET },
        },
      });

      let rateLimited = false;
      for (const wallet of wallets) {
        for (const asset of SYNC_ASSETS) {
          try {
            await this.checkOne(wallet.userId, wallet.address, asset);
          } catch (err) {
            const msg = (err as Error).message ?? '';
            if (msg.includes('rate limit') || msg.includes('-32005') || msg.includes('limit exceeded')) {
              rateLimited = true;
              logger.warn('Balance sync: rate limited — aborting this cycle, next window retries.');
              break;
            }
            logger.error(`Balance sync failed for ${wallet.address} ${asset}: ${msg}`);
          }
          // Pace calls so wallets don't burst the RPC in one batch
          await sleep(400);
        }
        if (rateLimited) break;
        await sleep(500);
      }
    } catch (err) {
      logger.error('Balance sync run failed:', err);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * One wallet × one asset. Compare on-chain to expected; heal in the
   * appropriate direction only after the diff proves persistent and no
   * in-flight explanation exists.
   */
  private async checkOne(userId: string, address: string, asset: SyncAsset): Promise<void> {
    const ctx = await gatherBalanceComponents(userId, address, asset);

    const tol = SYNC_TOLERANCE[asset];
    const diff = ctx.onChain - ctx.expected; // positive: chain holds more

    if (Math.abs(diff) < tol) {
      await this.clearDrift(userId, asset);
      return;
    }

    // ── Transient explanations first: never heal what the monitor owns ──
    if (await this.hasInFlightDeposit(address, asset)) {
      logger.info(
        `Balance sync (${asset}) ${address}: diff ${fmt(diff)} — deposit in flight, monitor owns it. Skipping.`
      );
      return;
    }

    if (asset === 'BNB' && (await this.pendingGasSeedBnb(address)) > 0) {
      logger.info(
        `Balance sync (BNB) ${address}: diff ${fmt(diff)} — operator gas seed in transit. Skipping.`
      );
      return;
    }

    // ── Persistence gate: a diff must survive two cycles before we touch it ──
    if (!(await this.isPersistentDrift(userId, asset, diff, tol))) {
      logger.info(`Balance sync (${asset}) ${address}: diff ${fmt(diff)} first sight — watching one more cycle.`);
      return;
    }

    if (diff > 0) {
      await this.healMissingCredit(userId, address, asset, diff, ctx);
    } else {
      await this.healPhantomCredit(userId, asset, diff, ctx);
    }
  }

  // ------------------------------------------------------------------
  // chain > DB: something arrived on-chain that the DB never credited.
  // Find the REAL event and run it through the monitor's fee-aware
  // crediting pipeline — this is where "check the reason, get the fee
  // amount, match everything" actually happens.
  // ------------------------------------------------------------------

  private async healMissingCredit(
    userId: string,
    address: string,
    asset: SyncAsset,
    diff: number,
    ctx: BalanceComponents
  ): Promise<void> {
    if (asset === 'BNB') {
      // Native BNB has no Transfer log to attribute; the monitor's
      // balance-delta sweep owns BNB crediting (with its gas-seed ledger).
      // Reaching here means that sweep hasn't caught up — leave it alone.
      logger.warn(
        `[sync] Unexplained +${diff.toFixed(6)} BNB on ${address} (expected ${ctx.expected.toFixed(6)}) — ` +
        `no discrete event to attribute; monitor's balance sweep owns BNB. Left alone.`
      );
      await this.clearDrift(userId, asset);
      return;
    }

    const provider = await blockchain.getProvider();
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(1, currentBlock - EVENT_LOOKBACK_BLOCKS);

    const eventsByAddress = await blockchain.getTokenTransferEventsForAddresses(
      asset,
      [address.toLowerCase()],
      fromBlock,
      currentBlock
    );
    const events = eventsByAddress.get(address.toLowerCase()) ?? [];

    let fed = 0;
    for (const ev of events) {
      const known = await prisma.depositMonitor.findUnique({
        where: { txHash_address: { txHash: ev.txHash, address } },
      });

      // PROCESSED/CONFIRMED: monitor already handled (or is handling) it.
      // FAILED: proven invalid at some point — never revive.
      // CONFIRMING: in flight — the monitor owns it.
      if (known) continue;

      // Unknown to the monitor — this is the missing credit. Feed it
      // through the canonical pipeline: receipt check, confirmation
      // gating, flat fee + 1% + gas deduction, idempotent credit.
      await depositMonitor.handleDepositCheck(address, asset, ev.txHash, ev.amount, ev.from, ev.blockNumber);
      fed++;
    }

    if (fed > 0) {
      logger.info(
        `[sync] Healed ${address} (${asset}): fed ${fed} missed deposit event(s) through the deposit monitor ` +
        `(+${diff.toFixed(6)} diff — fees applied by the pipeline).`
      );
    } else {
      logger.warn(
        `[sync] Unexplained +${diff.toFixed(6)} ${asset} on ${address} — no unattributed Transfer event found ` +
        `in the last ${EVENT_LOOKBACK_BLOCKS} blocks. Left alone (monitor may still catch it).`
      );
    }

    await this.clearDrift(userId, asset);
  }

  // ------------------------------------------------------------------
  // DB > chain: the DB credits money the chain doesn't have (phantom
  // residue). Auto-debit the excess from availableBalance — capped at
  // what's actually available — and audit everything.
  // ------------------------------------------------------------------

  private async healPhantomCredit(userId: string, asset: SyncAsset, diff: number, ctx: BalanceComponents): Promise<void> {
    const debit = Math.abs(diff);
    const where = { userId_asset: { userId, asset } };

    const row = await prisma.balance.findUnique({ where });
    const available = Number(row?.availableBalance ?? 0);
    const applied = Math.min(debit, available);
    const remainder = Number((debit - applied).toFixed(8));

    await prisma.$transaction(async (tx) => {
      if (applied > 0) {
        await tx.balance.update({
          where,
          data: { availableBalance: { decrement: applied } },
        });
      }

      await tx.auditLog.create({
        data: {
          userId,
          action: 'BALANCE_SYNC_DEBIT',
          entityType: 'Balance',
          entityId: `${userId}:${asset}`,
          oldValue: {
            available,
            locked: ctx.locked,
            onChain: ctx.onChain,
            expected: ctx.expected,
          },
          newValue: {
            debited: applied,
            unresolvedRemainder: remainder, // exceeds availableBalance — human review
          },
        },
      });
    });

    logger.warn(
      `[sync] Healed phantom ${asset} for user ${userId}: DB exceeded chain by ${debit.toFixed(6)}, ` +
      `debited ${applied.toFixed(6)}` +
      (remainder > 0 ? ` — REMAINDER ${remainder.toFixed(6)} exceeds availableBalance, needs human review` : '')
    );

    await this.clearDrift(userId, asset);
  }

  // ------------------------------------------------------------------
  // Guards
  // ------------------------------------------------------------------

  /** A deposit the monitor has already seen but not yet finished crediting. */
  private async hasInFlightDeposit(address: string, asset: string): Promise<boolean> {
    const inFlight = await prisma.depositMonitor.findFirst({
      where: {
        address,
        asset,
        status: { in: ['PENDING', 'CONFIRMING', 'CONFIRMED'] },
        createdAt: { gte: new Date(Date.now() - IN_FLIGHT_GRACE_MS) },
      },
    });
    return !!inFlight;
  }

  /** Operator gas seeds in transit fully explain a positive BNB delta. */
  private async pendingGasSeedBnb(address: string): Promise<number> {
    const raw = await redis.get(pendingGasSeedKey(address));
    return raw ? parseFloat(raw) : 0;
  }

  /**
   * Two-cycle persistence gate. First sight of a diff: store it, do
   * nothing. If the SAME sign reappears next cycle with a comparable
   * magnitude, the diff is stable (not a tx in flight) → act. Any cycle
   * with no diff clears the stored state.
   */
  private async isPersistentDrift(userId: string, asset: string, diff: number, tol: number): Promise<boolean> {
    const key = driftKey(userId, asset);
    const raw = await redis.get(key);

    if (!raw) {
      await redis.set(key, JSON.stringify({ diff, at: Date.now() }), 'EX', DRIFT_TTL_SEC);
      return false;
    }

    let prev: { diff: number; at: number };
    try {
      prev = JSON.parse(raw);
    } catch {
      await redis.set(key, JSON.stringify({ diff, at: Date.now() }), 'EX', DRIFT_TTL_SEC);
      return false;
    }

    const ageMs = Date.now() - prev.at;
    const sameSign = Math.sign(prev.diff) === Math.sign(diff);
    const comparable = Math.abs(Math.abs(diff) - Math.abs(prev.diff)) <= Math.max(tol, 0.75 * Math.abs(prev.diff));

    // Refresh the observation window.
    await redis.set(key, JSON.stringify({ diff, at: Date.now() }), 'EX', DRIFT_TTL_SEC);

    if (sameSign && comparable && ageMs >= 2 * 60 * 1000) {
      return true;
    }

    return false;
  }

  private async clearDrift(userId: string, asset: string): Promise<void> {
    try {
      await redis.del(driftKey(userId, asset));
    } catch {
      // ignore
    }
  }
}

function fmt(n: number): string {
  return `${n > 0 ? '+' : ''}${n.toFixed(6)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const balanceSync = new BalanceSyncService();
                               
