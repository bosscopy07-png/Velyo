import { prisma } from '../database';
import { blockchain } from './blockchain';

/**
 * SINGLE SOURCE OF TRUTH for "what should this wallet's on-chain balance
 * equal, given everything the app currently believes about this user".
 *
 * Before this module existed, `services/balance-sync.ts` (automatic,
 * every 5 min) and `scripts/repair-balances.ts` (manual) each computed
 * this independently, and disagreed:
 *
 *   - balance-sync:      expected = available + locked + unsweptFees
 *                                    - redeemCredits - gasRefunds
 *   - repair-balances:   expected = available   (nothing else subtracted)
 *
 * Running the manual repair therefore always left a fresh "discrepancy"
 * for the automatic sync to "fix" on its very next tick — a feedback
 * loop, not a fix. Both now import `gatherBalanceComponents` from here.
 */

export const SYNC_ASSETS = ['USDT', 'BNB'] as const;
export type SyncAsset = (typeof SYNC_ASSETS)[number];

/** Ignore differences smaller than this (chain dust / float rounding). */
export const SYNC_TOLERANCE: Record<SyncAsset, number> = {
  USDT: 0.001,
  BNB: 0.00001,
};

export interface BalanceComponents {
  userId: string;
  address: string;
  asset: SyncAsset;
  /** Live balance read directly from the chain right now. */
  onChain: number;
  /** User's spendable balance per the DB. */
  available: number;
  /** Giveaway escrow held for the creator. */
  locked: number;
  /** Platform fees already deducted from the user's balance but not yet swept off-chain — still physically sitting in the wallet. */
  unsweptFees: number;
  /** USDT credited via redeem codes — app credit, never funded on-chain. */
  redeemCredits: number;
  /** USDT refunded for unused seeded BNB gas — app credit, no on-chain movement. */
  gasRefunds: number;
  /** available + locked + unsweptFees - redeemCredits - gasRefunds */
  expected: number;
}

/** Gathers every component of "expected on-chain balance" for one user/asset. */
export async function gatherBalanceComponents(
  userId: string,
  address: string,
  asset: SyncAsset
): Promise<BalanceComponents> {
  const raw = await blockchain.getBalance(address, asset);
  const onChain = Number(raw) / 1e18;

  const balance = await prisma.balance.findUnique({
    where: { userId_asset: { userId, asset } },
  });

  const [feesAgg, redeemAgg, gasRefundAgg] = await Promise.all([
    prisma.platformFee.aggregate({
      where: { sweptAt: null, asset, transaction: { userId } },
      _sum: { amount: true },
    }),
    prisma.codeRedemption.aggregate({
      where: { userId, code: { asset } },
      _sum: { amount: true },
    }),
    // Gas refunds (kind: 'gas_refund') are app-credit USDT — subtract them
    // from the expectation just like redeem credits.
    prisma.transaction.aggregate({
      where: {
        userId,
        asset,
        type: 'REFUND',
        metadata: { path: ['kind'], equals: 'gas_refund' },
      },
      _sum: { amount: true },
    }),
  ]);

  const available = Number(balance?.availableBalance ?? 0);
  const locked = Number(balance?.lockedBalance ?? 0);
  const unsweptFees = Number(feesAgg._sum.amount ?? 0);
  const redeemCredits = Number(redeemAgg._sum.amount ?? 0);
  const gasRefunds = Number(gasRefundAgg._sum.amount ?? 0);

  const expected = available + locked + unsweptFees - redeemCredits - gasRefunds;

  return {
    userId,
    address,
    asset,
    onChain,
    available,
    locked,
    unsweptFees,
    redeemCredits,
    gasRefunds,
    expected,
  };
}

/**
 * The `availableBalance` value that would make `expected` equal the live
 * on-chain balance, holding every other component fixed. This is what a
 * correct repair (or a human reviewing a flagged discrepancy) should set
 * `availableBalance` to — NOT the raw on-chain balance itself, which
 * ignores unswept fees and app-only credits with no on-chain backing.
 */
export function solveAvailableForOnChain(ctx: BalanceComponents): number {
  return ctx.onChain - ctx.locked - ctx.unsweptFees + ctx.redeemCredits + ctx.gasRefunds;
}
