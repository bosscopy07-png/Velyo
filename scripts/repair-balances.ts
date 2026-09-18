import { prisma } from '../src/database';
import { blockchain } from '../src/services/blockchain';
import { config } from '../src/config';

/**
 * One-time repair: sets every user's available balance to on-chain truth:
 *   available = onChain − locked − unsweptFees  (clamped at 0)
 * This wipes negative balances and phantom credits (old double-refunds,
 * self-redeemed codes) — they were never real coins.
 *
 * Run: npx ts-node scripts/repair-balances.ts   (from the Render shell)
 */
async function main(): Promise<void> {
  const wallets = await prisma.wallet.findMany({
    where: { status: 'ACTIVE', address: { not: config.PLATFORM_FEE_WALLET } },
  });

  for (const w of wallets) {
    for (const asset of ['BNB', 'USDT'] as const) {
      try {
        const raw = await blockchain.getBalance(w.address, asset);
        const onChain = Number(raw) / 1e18;

        const bal = await prisma.balance.findUnique({
          where: { userId_asset: { userId: w.userId, asset } },
        });
        const locked = Number(bal?.lockedBalance ?? 0);

        const fees = await prisma.platformFee.aggregate({
          where: { sweptAt: null, asset, transaction: { userId: w.userId } },
          _sum: { amount: true },
        });
        const unswept = Number(fees._sum.amount ?? 0);

        const newAvail = Math.max(0, onChain - locked - unswept);

        await prisma.balance.upsert({
          where: { userId_asset: { userId: w.userId, asset } },
          create: { userId: w.userId, asset, availableBalance: newAvail, lockedBalance: 0, pendingBalance: 0 },
          update: { availableBalance: newAvail },
        });

        console.log(`${w.address} ${asset}: chain=${onChain.toFixed(6)} locked=${locked} fees=${unswept.toFixed(6)} → available=${newAvail.toFixed(6)}`);
      } catch (err) {
        console.error(`SKIP ${w.address} ${asset}: ${(err as Error).message}`);
      }
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
