/**
 * Pure financial math helpers.
 *
 * NO config imports.
 * NO database imports.
 * Safe to unit-test in isolation.
 *
 * Money convention:
 * - Prisma persists Decimal(36,18)
 * - Calculations are rounded ONCE at the boundary to 8 decimal places.
 * - Do not chain floating-point rounding internally.
 */

/**
 * Calculate a percentage of an amount.
 *
 * Example:
 * percentOf(100, 2.5) => 2.5
 */
export function percentOf(amount: number, percent: number): number {
  if (!(amount > 0) || !(percent > 0)) {
    return 0;
  }

  return Number(((amount * percent) / 100).toFixed(8));
}

/**
 * Tiered deposit flat fee in USD.
 *
 * Legacy rule:
 * - Fees disabled => 0
 * - Below the configured tier => small fee
 * - At or above the tier => normal fee
 */
export function depositFlatFeeUSD(
  amountUSD: number,
  fees: {
    enableFees: boolean;
    depositFlatFeeTierUSD: number;
    depositFlatFeeSmallUSD: number;
    depositFlatFeeUSD: number;
  }
): number {
  if (!fees.enableFees) {
    return 0;
  }

  return amountUSD < fees.depositFlatFeeTierUSD
    ? fees.depositFlatFeeSmallUSD
    : fees.depositFlatFeeUSD;
}

/**
 * Unique deposit suffix.
 *
 * IMPORTANT:
 * The first digit after the decimal point is ALWAYS `1`.
 *
 * Format:
 *
 *   0.1XX
 *
 * Examples:
 *
 *   0.101
 *   0.113
 *   0.157
 *   0.199
 *
 * If the 3-decimal space is exhausted, fallback to:
 *
 *   0.1XXX
 *
 * Examples:
 *
 *   0.1001
 *   0.1234
 *   0.1578
 *   0.1999
 *
 * Therefore a $5 deposit becomes something like:
 *
 *   $5.101
 *   $5.137
 *   $5.199
 *   $5.1234
 *
 * The `1` is permanent and is NEVER replaced.
 */

export const SUFFIX_MIN = 0.101;
export const SUFFIX_MAX = 0.199;

const FALLBACK_MIN = 0.1001;
const FALLBACK_MAX = 0.1999;

/**
 * Pick a unique suffix from the available live-session suffixes.
 *
 * First tries 0.101 - 0.199.
 * If unavailable, falls back to 0.1001 - 0.1999.
 */
export function pickUniqueSuffix(
  taken: number[],
  rand: () => number = Math.random
): number {
  /**
   * First pool:
   *
   * 0.101 ... 0.199
   *
   * These have exactly:
   *   `1` + two unique digits
   */
  const taken3 = new Set(
    taken.map((value) => Number(value.toFixed(3)))
  );

  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = Number(
      (0.101 + Math.floor(rand() * 99) * 0.001).toFixed(3)
    );

    if (
      candidate >= SUFFIX_MIN &&
      candidate <= SUFFIX_MAX &&
      !taken3.has(candidate)
    ) {
      return candidate;
    }
  }

  /**
   * Fallback pool:
   *
   * 0.1001 ... 0.1999
   *
   * The `1` immediately after the decimal remains permanent.
   */
  const taken4 = new Set(
    taken.map((value) => Number(value.toFixed(4)))
  );

  for (let i = 1001; i <= 1999; i++) {
    const candidate = Number((i / 10000).toFixed(4));

    if (
      candidate >= FALLBACK_MIN &&
      candidate <= FALLBACK_MAX &&
      !taken4.has(candidate)
    ) {
      return candidate;
    }
  }

  /**
   * Deterministic escape.
   *
   * This should only be reached if the entire fallback range
   * is occupied.
   */
  return FALLBACK_MAX;
}

/**
 * Calculate the expected on-chain deposit amount.
 *
 * Formula:
 *
 *   requested amount
 *   + deposit fee
 *   + unique suffix
 *
 * Rounded ONCE to 8 decimal places at the boundary.
 *
 * Example:
 *
 *   requested = 5
 *   fee       = 0
 *   suffix    = 0.137
 *
 *   result    = 5.137
 */
export function computeExpectedAmount(
  requested: number,
  fee: number,
  suffix: number
): number {
  return Number(
    (requested + fee + suffix).toFixed(8)
  );
}
