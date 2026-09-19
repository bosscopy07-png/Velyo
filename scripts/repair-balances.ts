import { prisma } from '../src/database';
import { blockchain } from '../src/services/blockchain';
import { config } from '../src/config';

/**
 * One-time balance repair.
 *
 * IMPORTANT:
 * This script makes the database balance match the LIVE
 * on-chain wallet balance exactly.
 *
 * No fee deduction.
 * No locked-balance deduction.
 * No redeem adjustment.
 * No clamping.
 *
 * DB availableBalance = actual on-chain wallet balance
 *
 * Run from Render shell:
 * npx ts-node scripts/repair-balances.ts
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
  console.log('Starting live on-chain balance sync...\n');

  for (const wallet of wallets) {
    for (const asset of ['BNB', 'USDT'] as const) {
      try {
        // Get the CURRENT balance directly from the blockchain.
        const raw = await blockchain.getBalance(wallet.address, asset);

        // Both BNB and USDT use 18 decimals on BSC in this service.
        const onChain = Number(raw) / 1e18;

        if (!Number.isFinite(onChain) || onChain < 0) {
          throw new Error(`Invalid on-chain balance: ${raw}`);
        }

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
            lockedBalance: 0,
          },
        });

        console.log(
          `${wallet.address} ${asset}: ` +
          `LIVE=${onChain.toFixed(6)} → DB=${onChain.toFixed(6)}`
        );

      } catch (err) {
        console.error(
          `SKIP ${wallet.address} ${asset}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  console.log('\nBalance sync completed.');
}

main()
  .catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
