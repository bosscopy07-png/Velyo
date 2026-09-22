import { prisma } from '../src/database';
import { ethers } from 'ethers';
import { computeOutstandingEscrow } from '../src/services/giveaway';

/**
 * ONE-TIME CATCH-UP: a giveaway that is already CANCELLED or EXPIRED
 * should always have `computeOutstandingEscrow(...) === 0` — every dollar
 * either got PAID out or got REFUNDED when it was closed. If it's still
 * showing outstanding escrow, that refund never fully happened (the old
 * `cancelGiveaway`/`cleanup.ts` bug), and it never WILL happen on its own —
 * `cleanup.ts` only looks at `ACTIVE` giveaways, and a giveaway can't be
 * cancelled twice. This sweeps that missed refund into `availableBalance`
 * now (never `lockedBalance` — a terminal giveaway's money isn't "still
 * locked," it's just unreturned).
 *
 * Safe to re-run: each sweep is tagged with a unique idempotencyKey per
 * giveaway, so a giveaway already swept contributes 0 the second time
 * (its own sweep transaction is itself counted as "already refunded" by
 * computeOutstandingEscrow).
 *
 * Usage:
 *   npx ts-node scripts/sweep-terminal-giveaway-escrow.ts 0xYOUR_WALLET
 *   npx ts-node scripts/sweep-terminal-giveaway-escrow.ts 0xYOUR_WALLET --confirm
 *   npx ts-node scripts/sweep-terminal-giveaway-escrow.ts --confirm   (ALL users)
 */

const TERMINAL_STATUSES = ['CANCELLED', 'EXPIRED'];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--confirm');
  const requestedAddress = args.find((a) => a.startsWith('0x'))?.trim();

  if (!apply) {
    console.log('DRY RUN — no balances will be changed. Pass --confirm to apply.\n');
  }

  let userIds: string[];

  if (requestedAddress) {
    if (!ethers.isAddress(requestedAddress)) {
      throw new Error(`Invalid wallet address: ${requestedAddress}`);
    }
    const wallet = await prisma.wallet.findFirst({
      where: { address: { equals: requestedAddress, mode: 'insensitive' } },
    });
    if (!wallet) throw new Error(`No wallet found for ${requestedAddress}`);
    userIds = [wallet.userId];
  } else {
    const creators = await prisma.giveaway.findMany({
      where: { status: { in: TERMINAL_STATUSES } },
      distinct: ['creatorId'],
      select: { creatorId: true },
    });
    userIds = creators.map((c) => c.creatorId);
  }

  let swept = 0;
  let unchanged = 0;

  for (const userId of userIds) {
    const giveaways = await prisma.giveaway.findMany({
      where: { creatorId: userId, status: { in: TERMINAL_STATUSES } },
    });

    for (const g of giveaways) {
      const { outstanding } = await computeOutstandingEscrow(g.id);

      if (outstanding <= 0.000001) {
        unchanged++;
        continue;
      }

      console.log(`${'='.repeat(60)}`);
      console.log(`Giveaway:    ${g.id}  (${g.status})`);
      console.log(`Asset:       ${g.asset}`);
      console.log(`Total pot:   ${g.totalAmount}`);
      console.log(`Missed refund to sweep: ${outstanding} ${g.asset}`);

      if (!apply) {
        console.log(`(dry run — pass --confirm to apply.)`);
        continue;
      }

      const idempotencyKey = `refund|terminal-sweep|${g.id}`;

      await prisma.$transaction(async (tx) => {
        await tx.balance.update({
          where: { userId_asset: { userId: g.creatorId, asset: g.asset } },
          data: { availableBalance: { increment: outstanding } },
        });

        await tx.transaction.create({
          data: {
            userId: g.creatorId,
            type: 'REFUND',
            asset: g.asset,
            amount: outstanding,
            fee: 0,
            netAmount: outstanding,
            status: 'CONFIRMED',
            idempotencyKey,
            metadata: { giveawayId: g.id, kind: 'terminal_sweep' },
          },
        });

        await tx.auditLog.create({
          data: {
            userId: g.creatorId,
            action: 'GIVEAWAY_ESCROW_TERMINAL_SWEEP',
            entityType: 'Giveaway',
            entityId: g.id,
            oldValue: { outstanding },
            newValue: { sweptToAvailable: outstanding },
          },
        });
      });

      console.log(`✓ Swept ${outstanding} ${g.asset} into availableBalance for user ${g.creatorId}`);
      swept++;
    }
  }

  console.log('\n================================');
  console.log(apply ? 'Sweep completed' : 'Dry run completed');
  console.log(`${apply ? 'Swept' : 'Would sweep'}: ${swept}`);
  console.log(`Already clean:  ${unchanged}`);
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
  
