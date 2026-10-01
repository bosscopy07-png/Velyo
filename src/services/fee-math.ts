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

export const SUFFIX_MIN = 1e-6;
export const SUFFIX_MAX = 999e-6;

/** Pick a unique amount suffix not present in `taken` (active sessions). */
export function pickUniqueSuffix(taken: number[], rand: () => number = Math.random): number {
  const takenSet = new Set(taken.map((t) => Number(t.toFixed(6))));
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = Number((SUFFIX_MIN + Math.floor(rand() * 999) * SUFFIX_MIN).toFixed(6));
    if (candidate >= SUFFIX_MIN && candidate <= SUFFIX_MAX && !takenSet.has(candidate)) return candidate;
  }
  // Fallback: deterministic shift outside the taken set.
  return Number((SUFFIX_MAX + taken.length * SUFFIX_MIN).toFixed(6));
}

/** expected on-chain amount = requested + fee + unique suffix (one rounding). */
export function computeExpectedAmount(requested: number, fee: number, suffix: number): number {
  return Number((requested + fee + suffix).toFixed(8));
}
