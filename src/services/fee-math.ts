/**
 * Pure financial math helpers — NO config, NO database imports, so they are
 * unit-testable in isolation (tests/upgrade.test.ts).
 *
 * Convention (matches the codebase): one rounding to 8dp at the boundary,
 * never chain floats beyond it. Prisma persists Decimal(36,18).
 */

/** percent of amount, rounded once to 8dp. */
export function percentOf(amount: number, percent: number): number {
  if (!(amount > 0) || !(percent > 0)) return 0;
  return Number(((amount * percent) / 100).toFixed(8));
}

/** Tiered deposit flat fee in USD (same rule as the legacy flatFeeFor). */
export function depositFlatFeeUSD(
  amountUSD: number,
  fees: { enableFees: boolean; depositFlatFeeTierUSD: number; depositFlatFeeSmallUSD: number; depositFlatFeeUSD: number }
): number {
  if (!fees.enableFees) return 0;
  return amountUSD < fees.depositFlatFeeTierUSD ? fees.depositFlatFeeSmallUSD : fees.depositFlatFeeUSD;
}

/**
 * Unique amount suffix — the constant "0.1" prefix is ALWAYS present, and
 * the unique digits follow it: 0.1000–0.1999 (1000 candidates). So a $5
 * deposit reads "5.1568", "5.1234", "5.1976" — never "5.2356". The unique
 * component never starts with 0 and never leaves the 0.1 band.
 */
export const SUFFIX_MIN = 0.1;
export const SUFFIX_MAX = 0.1999;
const SUFFIX_STEP = 0.0001; // 3 unique digits after the constant 0.1
const CANDIDATES = 1000; // 0.1000 .. 0.1999

export function pickUniqueSuffix(taken: number[], rand: () => number = Math.random): number {
  const takenSet = new Set(taken.map((t) => Number(t.toFixed(4))));
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = Number((SUFFIX_MIN + Math.floor(rand() * CANDIDATES) * SUFFIX_STEP).toFixed(4));
    if (candidate >= SUFFIX_MIN && candidate <= SUFFIX_MAX && !takenSet.has(candidate)) return candidate;
  }
  // Deterministic sweep of the full 0.1 band (only if all 1000 are taken —
  // practically unreachable).
  for (let i = 0; i < CANDIDATES; i++) {
    const candidate = Number((SUFFIX_MIN + i * SUFFIX_STEP).toFixed(4));
    if (!takenSet.has(candidate)) return candidate;
  }
  return SUFFIX_MAX;
}

/** expected on-chain amount = requested + fee + unique suffix (one rounding). */
export function computeExpectedAmount(requested: number, fee: number, suffix: number): number {
  return Number((requested + fee + suffix).toFixed(8));
}
