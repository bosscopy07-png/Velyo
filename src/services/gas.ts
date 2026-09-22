import { blockchain } from './blockchain';
import { walletService } from './wallet';
import { redis } from './redis';
import { config } from '../config';
import { logger } from '../utils/logger';
import { hashIdempotencyKey } from '../utils/encryption';

/**
 * Pending gas-seed ledger — SAME Redis key the deposit monitor already
 * subtracts in checkNativeBalance(), so a seed is never misread as a
 * user BNB deposit.
 */
export const pendingGasSeedKey = (address: string): string =>
  `monitor:seed:pending:${address.toLowerCase()}`;

const SEED_LEDGER_TTL_SEC = 600;

/**
 * Dynamic cost of ONE BEP20 transfer in BNB, with 1.5× headroom.
 *
 * The old static 0.000002 BNB budget is BELOW the real network cost
 * (~0.0000026 BNB at the time of the INSUFFICIENT_FUNDS failures) —
 * that under-budget is why every seeded wallet ran dry. This reads the
 * live gas price instead of trusting a constant.
 */
export async function estimateBnbTransferCost(): Promise<number> {
  try {
    const provider = await blockchain.getProvider();
    const feeData = await provider.getFeeData();
    const gasPrice: bigint = feeData.gasPrice ?? 50_000_000n; // 0.05 gwei fallback
    const gasLimit = 65_000n; // BEP20 transfer + padding
    const cost = (gasPrice * gasLimit * 15n) / 10n; // 1.5× headroom
    return Number(cost) / 1e18;
  } catch {
    return 0.000004; // safe static fallback
  }
}

async function recordPendingSeed(address: string, amountBnb: number): Promise<void> {
  await redis.incrbyfloat(pendingGasSeedKey(address), amountBnb);
  await redis.expire(pendingGasSeedKey(address), SEED_LEDGER_TTL_SEC);
}

async function clearPendingSeed(address: string, amountBnb: number): Promise<void> {
  await redis.incrbyfloat(pendingGasSeedKey(address), -amountBnb);
}

/**
 * Guarantees `address` holds at least `minBnb` before it must sign an
 * outgoing transaction. Tops up from the operator wallet and WAITS for
 * the seed to mine, so the caller can send its real tx immediately after.
 *
 * Returns { seededBnb, hash } — seededBnb is 0 when the wallet was
 * already funded (hash null).
 *
 * THROWS if a top-up was required but could not be completed. Callers
 * must treat that as RETRYABLE, never as a permanent payout failure.
 */
export async function ensureGas(
  address: string,
  minBnb: number,
  tag: string
): Promise<{ seededBnb: number; hash: string | null }> {
  const balance = Number(await blockchain.getBalance(address, 'BNB')) / 1e18;

  if (balance >= minBnb) {
    return { seededBnb: 0, hash: null };
  }

  if (!config.OPERATOR_WALLET_KEY) {
    throw new Error(
      `OPERATOR_WALLET_KEY not configured — cannot seed ${minBnb.toFixed(8)} BNB to ${address} (${tag})`
    );
  }

  const seededBnb = Number((minBnb - balance).toFixed(10));

  // Record BEFORE broadcasting so the deposit monitor can never misread
  // the incoming seed as a user deposit.
  await recordPendingSeed(address, seededBnb);

  try {
    const { hash } = await blockchain.sendTransaction(
      config.OPERATOR_WALLET_KEY,
      address,
      BigInt(Math.ceil(seededBnb * 1e18)),
      'BNB',
      hashIdempotencyKey('gas-seed', tag)
    );

    await blockchain.waitMined(hash, 90_000);
    await walletService.adjustOperatorBalance('BNB', -seededBnb);
    logger.info(`Gas seed (${tag}): ${seededBnb} BNB → ${address}, mined ${hash}`);
    return { seededBnb, hash };
  } catch (err) {
    await clearPendingSeed(address, seededBnb);
    throw new Error(`Gas seed failed for ${tag}: ${(err as Error).message}`);
  }
}
