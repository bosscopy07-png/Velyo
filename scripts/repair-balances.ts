import { ethers } from 'ethers';
import { prisma } from '../src/database';
import { blockchain } from '../src/services/blockchain';
import { config, type AssetSymbol } from '../src/config';

/**
 * EMERGENCY BALANCE REPAIR
 *
 * Purpose:
 *   Sync availableBalance to the wallet's CURRENT live on-chain balance.
 *
 * Rules:
 *   - availableBalance = live on-chain balance
 *   - DO NOT subtract fees
 *   - DO NOT add redeems/refunds
 *   - DO NOT modify lockedBalance
 *   - DO NOT modify pendingBalance
 *   - Skip the platform fee wallet
 *
 * Usage:
 *
 *   Test ONE wallet:
 *   npx ts-node scripts/repair-balances.ts 0xYOUR_WALLET
 *
 *   Repair ALL active wallets:
 *   npx ts-node scripts/repair-balances.ts
 *
 * IMPORTANT:
 *   This script uses the correct decimals for each asset.
 *   BNB = 18 decimals.
 *   ERC-20 tokens = contract.decimals().
 */

const ASSETS_TO_REPAIR: AssetSymbol[] = ['BNB', 'USDT'];

async function getOnChainBalance(
  address: string,
  asset: AssetSymbol
): Promise<number> {
  const raw = await blockchain.getBalance(address, asset);

  const decimals =
    asset === 'BNB'
      ? 18
      : await blockchain.getTokenDecimals(asset);

  const formatted = ethers.formatUnits(raw, decimals);

  const value = Number(formatted);

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `Invalid on-chain balance for ${asset}: raw=${raw.toString()}, decimals=${decimals}, formatted=${formatted}`
    );
  }

  return value;
}

async function repairWallet(
  wallet: {
    address: string;
    userId: string;
  }
): Promise<{ repaired: number; skipped: number }> {
  let repaired = 0;
  let skipped = 0;

  for (const asset of ASSETS_TO_REPAIR) {
    try {
      console.log(`\nReading LIVE ${asset} balance...`);

      const raw = await blockchain.getBalance(wallet.address, asset);

      const decimals =
        asset === 'BNB'
          ? 18
          : await blockchain.getTokenDecimals(asset);

      const formatted = ethers.formatUnits(raw, decimals);
      const onChain = Number(formatted);

      if (!Number.isFinite(onChain) || onChain < 0) {
        throw new Error(
          `Invalid on-chain balance: raw=${raw.toString()}, decimals=${decimals}, formatted=${formatted}`
        );
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
      const difference = onChain - oldAvailable;

      console.log(`\n${'='.repeat(60)}`);
      console.log(`Wallet:    ${wallet.address}`);
      console.log(`Asset:     ${asset}`);
      console.log(`Raw:       ${raw.toString()}`);
      console.log(`Decimals:  ${decimals}`);
      console.log(`DB:        ${oldAvailable.toFixed(8)}`);
      console.log(`CHAIN:     ${formatted}`);
      console.log(
        `DIFF:      ${difference >= 0 ? '+' : ''}${difference.toFixed(8)}`
      );
      console.log(`${'='.repeat(60)}`);

      /**
       * IMPORTANT:
       *
       * Only availableBalance is changed.
       *
       * lockedBalance and pendingBalance are intentionally NOT included
       * in the update object, so Prisma leaves their existing values
       * untouched.
       */
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

      console.log(`✓ ${asset} availableBalance repaired.`);

      repaired++;
    } catch (err) {
      skipped++;

      console.error(
        `✗ SKIP ${wallet.address} ${asset}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return { repaired, skipped };
}

async function main(): Promise<void> {
  /**
   * Optional single-wallet mode.
   *
   * Example:
   * npx ts-node scripts/repair-balances.ts 0xcA4B...
   */
  const requestedAddress = process.argv[2]?.trim();

  let wallets;

  if (requestedAddress) {
    if (!ethers.isAddress(requestedAddress)) {
      throw new Error(`Invalid wallet address: ${requestedAddress}`);
    }

    console.log(`Single-wallet repair mode.`);
    console.log(`Address: ${requestedAddress}\n`);

    wallets = await prisma.wallet.findMany({
      where: {
        status: 'ACTIVE',
        address: {
          equals: requestedAddress,
        },
      },
    });

    /**
     * Some database collations may be case-sensitive.
     *
     * If the exact-case lookup finds nothing, retry with a case-insensitive
     * comparison where Prisma/database support allows it.
     */
    if (wallets.length === 0) {
      wallets = await prisma.wallet.findMany({
        where: {
          status: 'ACTIVE',
          address: {
            equals: requestedAddress,
            mode: 'insensitive',
          },
        },
      });
    }
  } else {
    console.log(`ALL-WALLET repair mode.`);

    wallets = await prisma.wallet.findMany({
      where: {
        status: 'ACTIVE',
        address: {
          not: config.PLATFORM_FEE_WALLET,
        },
      },
    });
  }

  if (wallets.length === 0) {
    throw new Error(
      requestedAddress
        ? `No ACTIVE wallet found for ${requestedAddress}`
        : 'No active wallets found.'
    );
  }

  /**
   * Never repair the platform fee wallet.
   */
  const filteredWallets = wallets.filter(
    (wallet) =>
      wallet.address.toLowerCase() !==
      config.PLATFORM_FEE_WALLET.toLowerCase()
  );

  console.log(`Found ${filteredWallets.length} wallet(s).`);
  console.log('Emergency balance repair starting...\n');

  let repaired = 0;
  let skipped = 0;

  for (const wallet of filteredWallets) {
    console.log(`\n############################################`);
    console.log(`# ${wallet.address}`);
    console.log(`############################################`);

    const result = await repairWallet(wallet);

    repaired += result.repaired;
    skipped += result.skipped;
  }

  console.log('\n================================');
  console.log('Emergency repair completed');
  console.log(`Wallets processed: ${filteredWallets.length}`);
  console.log(`Repaired:          ${repaired}`);
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
