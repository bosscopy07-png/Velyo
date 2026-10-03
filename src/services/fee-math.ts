/**
 * Unique amount suffix.
 *
 * The first decimal digit is ALWAYS `1`.
 *
 * Examples:
 *   $5     -> $5.113
 *   $5     -> $5.157
 *   $5     -> $5.1047
 *
 * Structure:
 *   requested + fee + 0.1 + unique digits
 *
 * The permanent `1` is never replaced.
 */

export const SUFFIX_MIN = 0.101;
export const SUFFIX_MAX = 0.199;

const FALLBACK_MIN = 0.1001;
const FALLBACK_MAX = 0.1999;

export function pickUniqueSuffix(
  taken: number[],
  rand: () => number = Math.random
): number {
  // First try 2 digits after the permanent `1`.
  // Produces: 0.101 ... 0.199
  const taken3 = new Set(
    taken.map((t) => Number(t.toFixed(3)))
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

  // Fallback: 3 digits after the permanent `1`.
  // Produces: 0.1001 ... 0.1999
  const taken4 = new Set(
    taken.map((t) => Number(t.toFixed(4)))
  );

  for (let i = 101; i <= 1999; i++) {
    const candidate = Number((i / 10000).toFixed(4));

    if (
      candidate >= FALLBACK_MIN &&
      candidate <= FALLBACK_MAX &&
      !taken4.has(candidate)
    ) {
      return candidate;
    }
  }

  // Deterministic escape.
  return FALLBACK_MAX;
}
