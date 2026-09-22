import { ethers } from 'ethers';
import { prisma } from '../src/database';
import { config, type AssetSymbol } from '../src/config';
import {
  gatherBalanceComponents,
  solveAvailableForOnChain,
  SYNC_ASSETS,
  SYNC_TOLERANCE,
} from '../src/services/balance-accounting';

/**
 * EMERGENCY BALANCE REPAIR
 *
 * ------------------------------------------------------------------------
 * WHY THIS NO LONGER SETS availableBalance = raw on-chain balance
 * ------------------------------------------------------------------------
 * The previous version of this script did exactly that — and that formula
 * disagrees with the one `balance-sync.ts` uses to decide whether a wallet
 * looks wrong in the first place:
 *
 *   old repair:     availableBalance := onChain
 *   balance-sync:   expected := available + locked + unsweptFees
 *                               - redeemCredits - gasRefunds
 *
 * Running the old repair would zero out legitimate redeem-code credits
 * (which have no on-chain backing at all) and hand a user any unswept
 * platform fee still sitting in the wallet, then guarantee balance-sync
 * found a fresh "discrepancy" on its very next tick. Repair, drift,
 * repeat.
 *
 * This version imports the exact same formula balance-sync uses
 * (`src/services/balance-accounting.ts`) so the two can never disagree.
 * It also runs in DRY-RUN mode by default — pass --confirm to actually
 * write changes.
 *
 * Usage:
 *   Inspect one wallet (no changes written):
 *     npx ts-node scripts/repair-balances.ts 0xYOUR_WALLET
 *
 *   Inspect ALL active wallets (no changes written):
 *     npx ts-node scripts/repair-balances.ts
 *
 *   Actually apply the fix:
 *     npx ts-node scripts/repair-balances.ts --confirm
 *     npx ts-node scripts/repair-balances.ts 0xYOUR_WALLET --confirm
 */

const ASSETS_TO_REPAIR: AssetSymbol[] = [...SYNC_ASSETS];

async function repairWallet(
  wallet: { address: string; userId: string },
  apply: boolean
): Promise<{ repaired: number; skipped: number; unchanged: number }> {
  let repaired = 0;
  let skipped = 0;
  let unchanged = 0;

  for (const asset of ASSETS_TO_REPAIR) {
    try {
      const ctx = await gatherBalanceComponents(wallet.userId, wallet.address, asset);
      const suggestedAvailable = solveAvailableForOnChain(ctx);
      const diff = ctx.onChain - ctx.expected;
      const tol = SYNC_TOLERANCE[asset] ?? 0.000001;

      console.log(`\n${'='.repeat(60)}`);
      console.log(`Wallet:             ${wallet.address}`);
      console.log(`Asset:              ${asset}`);
      console.log(`On-chain:           ${ctx.onChain}`);
      console.log(`DB availableBalance:${ctx.available}`);
      console.log(`lockedBalance:      ${ctx.locked}`);
      console.log(`unswept fees:       ${ctx.unsweptFees}`);
      console.log(`redeem credits:     ${ctx.redeemCredits}`);
      console.log(`gas refunds:        ${ctx.gasRefunds}`);
      console.log(`expected on-chain:  ${ctx.expected.toFixed(8)}`);
      console.log(`diff:               ${diff >= 0 ? '+' : ''}${diff.toFixed(8)}`);
      console.log(`suggested new availableBalance: ${suggestedAvailable.toFixed(8)}`);
      console.log(`${'='.repeat(60)}`);

      if (Math.abs(diff) < tol) {
        console.log(`✓ ${asset} within tolerance — no change needed.`);
        unchanged++;
        continue;
      }

      if (suggestedAvailable < 0) {
        console.error(
          `✗ SKIP ${asset}: suggested availableBalance is negative (${suggestedAvailable.toFixed(8)}) — ` +
            `this wallet needs a human to look at unswept fees / redeem history before touching it. Not applying.`
        );
        skipped++;
        continue;
      }

      if (!apply) {
        console.log(`(dry run — would set availableBalance to ${suggestedAvailable.toFixed(8)}. Pass --confirm to apply.)`);
        continue;
      }

      const before = ctx.available;

      await prisma.$transaction(async (tx) => {
        await tx.balance.upsert({
          where: { userId_asset: { userId: wallet.userId, asset } },
          create: {
            userId: wallet.userId,
            asset,
            availableBalance: suggestedAvailable,
            lockedBalance: 0,
            pendingBalance: 0,
          },
          update: { availableBalance: suggestedAvailable },
        });

        await tx.auditLog.create({
          data: {
            userId: wallet.userId,
            action: 'BALANCE_MANUAL_REPAIR',
            entityType: 'Balance',
            entityId: `${wallet.userId}:${asset}`,
            oldValue: { availableBalance: before },
            newValue: { availableBalance: suggestedAvailable, onChain: ctx.onChain },
          },
        });
      });

      console.log(`✓ ${asset} availableBalance: ${before} → ${suggestedAvailable.toFixed(8)}`);
      repaired++;
    } catch (err) {
      skipped++;
      console.error(`✗ SKIP ${wallet.address} ${asset}:`, err instanceof Error ? err.message : err);
    }
  }

  return { repaired, skipped, unchanged };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--confirm');
  const requestedAddress = args.find((a) => a.startsWith('0x'))?.trim();

  if (!apply) {
    console.log('DRY RUN — no balances will be changed. Pass --confirm to apply.\n');
  }

  let wallets;

  if (requestedAddress) {
    if (!ethers.isAddress(requestedAddress)) {
      throw new Error(`Invalid wallet address: ${requestedAddress}`);
    }

    console.log(`Single-wallet mode.`);
    console.log(`Address: ${requestedAddress}\n`);

    wallets = await prisma.wallet.findMany({
      where: { status: 'ACTIVE', address: { equals: requestedAddress } },
    });

    if (wallets.length === 0) {
      wallets = await prisma.wallet.findMany({
        where: { status: 'ACTIVE', address: { equals: requestedAddress, mode: 'insensitive' } },
      });
    }
  } else {
    console.log(`ALL-WALLET mode.`);

    wallets = await prisma.wallet.findMany({
      where: { status: 'ACTIVE', address: { not: config.PLATFORM_FEE_WALLET } },
    });
  }

  if (wallets.length === 0) {
    throw new Error(requestedAddress ? `No ACTIVE wallet found for ${requestedAddress}` : 'No active wallets found.');
  }

  const filteredWallets = wallets.filter(
    (wallet) => wallet.address.toLowerCase() !== config.PLATFORM_FEE_WALLET.toLowerCase()
  );

  console.log(`Found ${filteredWallets.length} wallet(s).\n`);

  let repaired = 0;
  let skipped = 0;
  let unchanged = 0;

  for (const wallet of filteredWallets) {
    console.log(`\n############################################`);
    console.log(`# ${wallet.address}`);
    console.log(`############################################`);

    const result = await repairWallet(wallet, apply);
    repaired += result.repaired;
    skipped += result.skipped;
    unchanged += result.unchanged;
  }

  console.log('\n================================');
  console.log(apply ? 'Repair completed' : 'Dry run completed');
  console.log(`Wallets processed: ${filteredWallets.length}`);
  console.log(`${apply ? 'Repaired' : 'Would repair'}:          ${repaired}`);
  console.log(`Unchanged:         ${unchanged}`);
  console.log(`Skipped:           ${skipped}`);
  console.log('================================');
}

main()
  .catch((err) => {
    console.error('\nFATAL:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
  
