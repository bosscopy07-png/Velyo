import { prisma } from '../src/database';
import { ethers } from 'ethers';
import { computeOutstandingEscrow } from '../src/services/giveaway';

/**
 * READ-ONLY. Lists every giveaway a user has ever created, with its
 * status and outstanding escrow (per computeOutstandingEscrow), plus a
 * breakdown of its claims by status. Use this to find WHICH giveaway is
 * responsible for a lockedBalance that doesn't match reality before
 * deciding whether to cancel it (via the bot's normal cancel flow, which
 * now uses the fixed computeOutstandingEscrow-based refund).
 *
 * Usage:
 *   npx ts-node scripts/inspect-user-giveaways.ts 0xYOUR_WALLET
 */

async function main(): Promise<void> {
  const address = process.argv[2]?.trim();

  if (!address || !ethers.isAddress(address)) {
    throw new Error('Usage: npx ts-node scripts/inspect-user-giveaways.ts 0xWALLET_ADDRESS');
  }

  const wallet = await prisma.wallet.findFirst({
    where: { address: { equals: address, mode: 'insensitive' } },
  });

  if (!wallet) throw new Error(`No wallet found for ${address}`);

  const giveaways = await prisma.giveaway.findMany({
    where: { creatorId: wallet.userId },
    include: { claims: true },
    orderBy: { createdAt: 'desc' },
  });

  if (giveaways.length === 0) {
    console.log('This user has never created a giveaway.');
    return;
  }

  console.log(`Found ${giveaways.length} giveaway(s) created by ${address} (userId ${wallet.userId})\n`);

  let totalOutstanding = 0;

  for (const g of giveaways) {
    const { outstanding } = await computeOutstandingEscrow(g.id);
    totalOutstanding += outstanding;

    const claimCounts: Record<string, number> = {};
    for (const c of g.claims) {
      claimCounts[c.status] = (claimCounts[c.status] ?? 0) + 1;
    }

    console.log(`${'='.repeat(70)}`);
    console.log(`Giveaway:        ${g.id}`);
    console.log(`Created:         ${g.createdAt.toISOString()}`);
    console.log(`Status:          ${g.status}${g.expiresAt ? `  (expires ${g.expiresAt.toISOString()})` : '  (no expiry)'}`);
    console.log(`Asset:           ${g.asset}`);
    console.log(`Total pot:       ${g.totalAmount}`);
    console.log(`Amount/claimer:  ${g.amountPerUser}`);
    console.log(`Slots:           ${g.claimedCount}/${g.maxClaimers} claimed`);
    console.log(`Claims by status:${Object.keys(claimCounts).length ? '' : ' (none)'}`);
    for (const [status, count] of Object.entries(claimCounts)) {
      console.log(`   ${status}: ${count}`);
    }
    console.log(`Outstanding escrow (per current DB history): ${outstanding} ${g.asset}`);
    if (outstanding > 0 && (g.status === 'ACTIVE' || g.status === 'FULL')) {
      console.log(`   ⚠ STILL OPEN with outstanding escrow — this is likely (part of) the phantom-funded locked balance.`);
    }
    console.log('');
  }

  console.log(`${'='.repeat(70)}`);
  console.log(`Total outstanding escrow across all giveaways: ${totalOutstanding.toFixed(8)}`);
  console.log(`(Compare this to the "Correct locked" figure from repair-locked-balance.ts)`);
}

main()
  .catch((err) => {
    console.error('\nFATAL:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
      
