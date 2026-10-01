import test from 'node:test';
import assert from 'node:assert/strict';
import {
  percentOf,
  depositFlatFeeUSD,
  pickUniqueSuffix,
  computeExpectedAmount,
  SUFFIX_MIN,
  SUFFIX_MAX,
} from '../src/services/fee-math';

// ── percentOf ──────────────────────────────────────────────

test('percentOf: 1% of 1 = 0.01', () => {
  assert.equal(percentOf(1, 1), 0.01);
});

test('percentOf: 1% of 100 = 1', () => {
  assert.equal(percentOf(100, 1), 1);
});

test('percentOf: 0 amount or 0 percent = 0', () => {
  assert.equal(percentOf(0, 1), 0);
  assert.equal(percentOf(100, 0), 0);
  assert.equal(percentOf(-5, 1), 0);
});

test('percentOf: no float-chain drift beyond 8dp', () => {
  // 0.1 + 0.2 style drift must not accumulate: result is rounded once.
  const a = percentOf(33.33, 1);
  assert.equal(a, 0.3333);
});

// ── depositFlatFeeUSD ──────────────────────────────────────

test('deposit fee: small tier applies under threshold', () => {
  const fees = { enableFees: true, depositFlatFeeTierUSD: 0.5, depositFlatFeeSmallUSD: 0.05, depositFlatFeeUSD: 0.1 };
  assert.equal(depositFlatFeeUSD(0.3, fees), 0.05);
  assert.equal(depositFlatFeeUSD(10, fees), 0.1);
});

test('deposit fee: disabled = 0', () => {
  const fees = { enableFees: false, depositFlatFeeTierUSD: 0.5, depositFlatFeeSmallUSD: 0.05, depositFlatFeeUSD: 0.1 };
  assert.equal(depositFlatFeeUSD(10, fees), 0);
});

// ── pickUniqueSuffix ───────────────────────────────────────

test('suffix: never collides with taken values', () => {
  const taken = [0.000001, 0.000002, 0.000003];
  let i = 0;
  const rand = () => (i++ % 3) / 3; // deterministic, hits "taken" values first
  const suffix = pickUniqueSuffix(taken, rand);
  assert.ok(!taken.includes(suffix));
  assert.ok(suffix >= SUFFIX_MIN && suffix <= SUFFIX_MAX * 2);
});

test('suffix: deterministic fallback escapes a full range', () => {
  const taken = Array.from({ length: 999 }, (_, i) => Number(((i + 1) * SUFFIX_MIN).toFixed(6)));
  const suffix = pickUniqueSuffix(taken, () => 0);
  assert.ok(!taken.includes(suffix));
});

// ── computeExpectedAmount ──────────────────────────────────

test('expected amount = requested + fee + suffix, single rounding', () => {
  assert.equal(computeExpectedAmount(5, 0.1, 0.000001), 5.100001);
  assert.equal(computeExpectedAmount(0.1, 0.05, 0.000002), 0.150002);
});
