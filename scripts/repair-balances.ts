import { prisma } from '../src/database';
import { blockchain } from '../src/services/blockchain';
import { config } from '../src/config';

/**
 * EMERGENCY BALANCE REPAIR
 *
 * Purpose:
 *   Remove phantom DB credits by syncing availableBalance
 *   to the wallet's CURRENT on-chain balance.
 *
 * Rules:
 *   - availableBalance = live on-chain balance
 *   - DO NOT subtract fees
 *   - DO NOT add redeems/refunds
 *   - DO NOT modify lockedBalance
 *   - DO NOT modify pendingBalance
 *   - Skip the platform fee wallet
 *
 * Run:
 *   npx ts-node scripts/repair-balances.ts
 */

async function main(): Promise<void> {
  const wallets = await prisma.wallet.findMany({
    where: {
      status: 'ACTIVE',
      address: {
        not: config.PLATFORM_FEE_WALLET,
      },
    },
  });

  console.log(`Found ${wallets.length} active wallets.`);
  console.log('Emergency balance repair starting...\n');

  let repaired = 0;
  let skipped = 0;

  for (const wallet of wallets) {
    for (const asset of ['BNB', 'USDT'] as const) {
      try {
        // Read LIVE blockchain balance
        const raw = await blockchain.getBalance(wallet.address, asset);

        const onChain = Number(raw) / 1e18;

        if (!Number.isFinite(onChain) || onChain < 0) {
          throw new Error(`Invalid on-chain balance: ${raw}`);
        }

        const existing = await prisma.balance.findUnique({
          where: {
            userId_asset: {
              userId: wallet.userId,
              asset,
            },
          },
        });

        const oldAvailable = Number(existing?.availableBalance ?? 0);

        // IMPORTANT:
        // Only availableBalance is repaired.
        // lockedBalance and pendingBalance are untouched.
        await prisma.balance.upsert({
          where: {
            userId_asset: {
              userId: wallet.userId,
              asset,
            },
          },
          create: {
            userId: wallet.userId,
            asset,
            availableBalance: onChain,
            lockedBalance: 0,
            pendingBalance: 0,
          },
          update: {
            availableBalance: onChain,
          },
        });

        const difference = onChain - oldAvailable;

        console.log(
          `${wallet.address} ${asset}: ` +
          `DB=${oldAvailable.toFixed(6)} ` +
          `CHAIN=${onChain.toFixed(6)} ` +
          `DIFF=${difference >= 0 ? '+' : ''}${difference.toFixed(6)}`
        );

        repaired++;

      } catch (err) {
        skipped++;

        console.error(
          `SKIP ${wallet.address} ${asset}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  console.log('\n================================');
  console.log('Emergency repair completed');
  console.log(`Repaired: ${repaired}`);
  console.log(`Skipped:  ${skipped}`);
  console.log('================================');
}

main()
  .catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
