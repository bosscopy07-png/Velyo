import { prisma } from '../src/database';
import { ethers } from 'ethers';
import { computeOutstandingEscrow } from '../src/services/giveaway';

/**
 * REPAIR: locked/available split corrupted by the cleanup.ts double-refund
 * bug (see comment above `computeOutstandingEscrow` in services/giveaway.ts).
 *
 * This does NOT touch the blockchain and does NOT change a user's total
 * balance (available + locked). The bug never moved real money — it's an
 * internal bookkeeping split error, so the fix is purely internal too:
 * recompute what `lockedBalance` SHOULD be (the sum of outstanding escrow
 * across every giveaway this user has ever created, per asset) and move
 * the difference back out of `availableBalance`.
 *
 * That's why `balance-sync.ts` / `repair-balances.ts` (on-chain vs DB)
 * can never catch or fix this on their own: they only ever look at
 * `available + locked` together.
 *
 * Usage:
 *   Inspect one wallet (no changes written):
 *     npx ts-node scripts/repair-locked-balance.ts 0xYOUR_WALLET
 *
 *   Inspect ALL users with at least one giveaway (no changes written):
 *     npx ts-node scripts/repair-locked-balance.ts
 *
 *   Actually apply the fix:
 *     npx ts-node scripts/repair-locked-balance.ts --confirm
 *     npx ts-node scripts/repair-locked-balance.ts 0xYOUR_WALLET --confirm
 */

const TOLERANCE = 0.000001;

async function correctLockedBalance(userId: string, asset: string): Promise<number> {
  const giveaways = await prisma.giveaway.findMany({
    where: { creatorId: userId, asset },
    select: { id: true },
  });

  let total = 0;
  for (const g of giveaways) {
    const { outstanding } = await computeOutstandingEscrow(g.id);
    total += outstanding;
  }

  return Number(total.toFixed(8));
}

async function repairUser(userId: string, label: string, apply: boolean): Promise<{ fixed: number; skipped: number; unchanged: number }> {
  let fixed = 0;
  let skipped = 0;
  let unchanged = 0;

  const balances = await prisma.balance.findMany({ where: { userId } });

  for (const balance of balances) {
    const currentAvailable = Number(balance.availableBalance);
    const currentLocked = Number(balance.lockedBalance);
    const total = currentAvailable + currentLocked;

    const correctLocked = await correctLockedBalance(userId, balance.asset);
    const diff = currentLocked - correctLocked; // positive = locked overstated; negative (our bug) = locked understated (went negative)

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Wallet/user:      ${label}`);
    console.log(`Asset:            ${balance.asset}`);
    console.log(`Current available:${currentAvailable}`);
    console.log(`Current locked:   ${currentLocked}`);
    console.log(`Correct locked:   ${correctLocked}  (sum of outstanding escrow across all giveaways created)`);
    console.log(`Locked diff:      ${diff >= 0 ? '+' : ''}${diff.toFixed(8)}`);

    if (Math.abs(diff) < TOLERANCE) {
      console.log(`✓ within tolerance — no change needed.`);
      unchanged++;
      continue;
    }

    const correctAvailable = Number((total - correctLocked).toFixed(8));

    console.log(`Suggested available: ${correctAvailable}  (total unchanged: ${total})`);

    if (correctAvailable < 0) {
      console.error(
        `✗ SKIP: suggested availableBalance would be negative (${correctAvailable}). ` +
          `This user's giveaway history needs a human look before touching it.`
      );
      skipped++;
      continue;
    }

    if (!apply) {
      console.log(`(dry run — pass --confirm to apply.)`);
      continue;
    }

    await prisma.$transaction(async (tx) => {
      await tx.balance.update({
        where: { userId_asset: { userId, asset: balance.asset } },
        data: {
          availableBalance: correctAvailable,
          lockedBalance: correctLocked,
        },
      });

      await tx.auditLog.create({
        data: {
          userId,
          action: 'LOCKED_BALANCE_REPAIR',
          entityType: 'Balance',
          entityId: `${userId}:${balance.asset}`,
          oldValue: { availableBalance: currentAvailable, lockedBalance: currentLocked },
          newValue: { availableBalance: correctAvailable, lockedBalance: correctLocked },
        },
      });
    });

    console.log(`✓ Fixed: available ${currentAvailable} → ${correctAvailable}, locked ${currentLocked} → ${correctLocked}`);
    fixed++;
  }

  return { fixed, skipped, unchanged };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--confirm');
  const requestedAddress = args.find((a) => a.startsWith('0x'))?.trim();

  if (!apply) {
    console.log('DRY RUN — no balances will be changed. Pass --confirm to apply.\n');
  }

  let users: { id: string; address: string }[];

  if (requestedAddress) {
    if (!ethers.isAddress(requestedAddress)) {
      throw new Error(`Invalid wallet address: ${requestedAddress}`);
    }

    const wallet = await prisma.wallet.findFirst({
      where: { address: { equals: requestedAddress, mode: 'insensitive' } },
    });

    if (!wallet) throw new Error(`No wallet found for ${requestedAddress}`);

    users = [{ id: wallet.userId, address: wallet.address }];
  } else {
    // Only users who have ever created a giveaway can possibly have this bug.
    const creators = await prisma.giveaway.findMany({
      distinct: ['creatorId'],
      select: { creatorId: true, creator: { select: { wallet: { select: { address: true } } } } },
    });

    users = creators.map((c) => ({ id: c.creatorId, address: c.creator.wallet?.address ?? '(no wallet)' }));
  }

  console.log(`Found ${users.length} user(s) to check.\n`);

  let fixed = 0;
  let skipped = 0;
  let unchanged = 0;

  for (const user of users) {
    console.log(`\n############################################`);
    console.log(`# ${user.address} (userId ${user.id})`);
    console.log(`############################################`);

    const result = await repairUser(user.id, user.address, apply);
    fixed += result.fixed;
    skipped += result.skipped;
    unchanged += result.unchanged;
  }

  console.log('\n================================');
  console.log(apply ? 'Repair completed' : 'Dry run completed');
  console.log(`Users checked:     ${users.length}`);
  console.log(`${apply ? 'Fixed' : 'Would fix'}:            ${fixed}`);
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
      
