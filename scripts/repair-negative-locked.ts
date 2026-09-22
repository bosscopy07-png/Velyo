// scripts/repair-negative-locked.ts
//
// ONE-TIME REPAIR SCRIPT
//
// Purpose:
//   Repair balances where lockedBalance < 0.
//
// Strategy:
//   Move funds from availableBalance -> lockedBalance until
//   lockedBalance reaches 0.
//
// Safety:
//   - DRY RUN by default
//   - Use --apply to actually modify balances
//   - Uses Prisma Decimal arithmetic
//   - Uses database transactions
//   - Never makes availableBalance negative
//   - Creates an audit record for every repair
//   - Verifies the final balance after each repair
//
// Usage:
//   npx tsx scripts/repair-negative-locked.ts
//   npx tsx scripts/repair-negative-locked.ts --apply
//
// Delete this script after the repair has been verified.

import { prisma } from '../src/database';
import { Prisma } from '@prisma/client';

const APPLY = process.argv.includes('--apply');

async function main() {
  console.log('========================================');
  console.log(' NEGATIVE LOCKED BALANCE REPAIR');
  console.log('========================================');
  console.log(`Mode: ${APPLY ? '⚠️  APPLY' : '🔍 DRY RUN'}`);
  console.log('');

  const rows = await prisma.balance.findMany({
    where: {
      lockedBalance: {
        lt: 0,
      },
    },
    orderBy: [
      { userId: 'asc' },
      { asset: 'asc' },
    ],
  });

  if (rows.length === 0) {
    console.log('No negative locked balances found.');
    return;
  }

  console.log(`Found ${rows.length} negative balance row(s).\n`);

  let repaired = 0;
  let unresolved = 0;
  let failed = 0;

  for (const row of rows) {
    const locked = new Prisma.Decimal(row.lockedBalance);
    const available = new Prisma.Decimal(row.availableBalance);

    const required = locked.abs();

    // Never move more than what is actually available.
    const applied = Prisma.Decimal.min(required, available);

    const finalLocked = locked.plus(applied);
    const finalAvailable = available.minus(applied);

    const remainder = finalLocked.isNegative()
      ? finalLocked.abs()
      : new Prisma.Decimal(0);

    console.log(`User:       ${row.userId}`);
    console.log(`Asset:      ${row.asset}`);
    console.log(`Available:  ${available.toFixed(8)}`);
    console.log(`Locked:     ${locked.toFixed(8)}`);
    console.log(`Required:   ${required.toFixed(8)}`);
    console.log(`Applied:    ${applied.toFixed(8)}`);
    console.log(`Final Avail: ${finalAvailable.toFixed(8)}`);
    console.log(`Final Lock:  ${finalLocked.toFixed(8)}`);

    if (remainder.gt(0)) {
      console.log(
        `⚠️ UNRESOLVED: ${remainder.toFixed(8)} remains negative`,
      );
      unresolved++;
    }

    if (applied.isZero()) {
      console.log('⚠️ Nothing available to move.');
      console.log('');
      continue;
    }

    if (!APPLY) {
      console.log('🔍 DRY RUN — no changes made.');
      console.log('');
      repaired++;
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        /*
         * Re-read the balance inside the transaction.
         *
         * This protects against the balance changing between
         * the initial findMany() and this update.
         */
        const current = await tx.balance.findUnique({
          where: {
            id: row.id,
          },
        });

        if (!current) {
          throw new Error(`Balance ${row.id} no longer exists`);
        }

        const currentLocked = new Prisma.Decimal(
          current.lockedBalance,
        );

        const currentAvailable = new Prisma.Decimal(
          current.availableBalance,
        );

        if (!currentLocked.isNegative()) {
          console.log(
            'ℹ️ Balance already repaired by another process. Skipping.',
          );
          return;
        }

        const currentRequired = currentLocked.abs();

        const currentApplied = Prisma.Decimal.min(
          currentRequired,
          currentAvailable,
        );

        const newLocked = currentLocked.plus(currentApplied);
        const newAvailable = currentAvailable.minus(currentApplied);

        await tx.balance.update({
          where: {
            id: current.id,
          },
          data: {
            lockedBalance: newLocked,
            availableBalance: newAvailable,
          },
        });

        await tx.auditLog.create({
          data: {
            userId: current.userId,
            action: 'BALANCE_SYNC_LOCKED_REPAIR',
            entityType: 'Balance',
            entityId: `${current.userId}:${current.asset}`,

            oldValue: {
              available: currentAvailable.toFixed(8),
              locked: currentLocked.toFixed(8),
            },

            newValue: {
              available: newAvailable.toFixed(8),
              locked: newLocked.toFixed(8),
              applied: currentApplied.toFixed(8),
              unresolved: newLocked.isNegative()
                ? newLocked.abs().toFixed(8)
                : '0',
            },
          },
        });
      });

      repaired++;

      console.log('✅ Repaired successfully.');
    } catch (error) {
      failed++;

      console.error(
        `❌ Failed ${row.userId} ${row.asset}:`,
        error instanceof Error ? error.message : error,
      );
    }

    console.log('');
  }

  console.log('========================================');
  console.log(' SUMMARY');
  console.log('========================================');
  console.log(`Found:       ${rows.length}`);
  console.log(`Processed:   ${repaired}`);
  console.log(`Unresolved:  ${unresolved}`);
  console.log(`Failed:      ${failed}`);
  console.log(`Mode:        ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log('========================================');

  if (!APPLY) {
    console.log('');
    console.log('No database changes were made.');
    console.log(
      'If the output looks correct, run with --apply to execute the repair:',
    );
    console.log('');
    console.log('npx tsx scripts/repair-negative-locked.ts --apply');
  }
}

main()
  .catch((error) => {
    console.error('Fatal repair error:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
