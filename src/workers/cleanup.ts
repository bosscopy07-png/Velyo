import { prisma } from '../database';
import { walletService } from '../services/wallet';
import { logger } from '../utils/logger';
import cron from 'node-cron';

// Expired giveaway cleanup
cron.schedule('0 * * * *', async () => {
  logger.info('Running expired giveaway cleanup...');
  
  const expired = await prisma.giveaway.findMany({
    where: {
      status: 'ACTIVE',
      expiresAt: { lt: new Date() },
    },
  });

  for (const giveaway of expired) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.giveaway.update({
          where: { id: giveaway.id },
          data: { status: 'EXPIRED' },
        });

        const unclaimedSpots = giveaway.maxClaimers - giveaway.claimedCount;
        if (unclaimedSpots > 0) {
          const refundAmount = Number(giveaway.totalAmount) - (giveaway.claimedCount * Number(giveaway.amountPerUser));
          
          if (refundAmount > 0) {
            await tx.balance.update({
              where: { userId_asset: { userId: giveaway.creatorId, asset: giveaway.asset } },
              data: {
                availableBalance: { increment: refundAmount },
                lockedBalance: { decrement: refundAmount },
              },
            });

            await tx.transaction.create({
              data: {
                userId: giveaway.creatorId,
                type: 'REFUND',
                asset: giveaway.asset,
                amount: refundAmount,
                fee: 0,
                netAmount: refundAmount,
                status: 'CONFIRMED',
                idempotencyKey: `refund|expired|${giveaway.id}`,
              },
            });
          }
        }
      });
      
      logger.info(`Expired giveaway processed: ${giveaway.id}`);
    } catch (err) {
      logger.error(`Failed to expire giveaway ${giveaway.id}:`, err);
    }
  }
});

logger.info('Cleanup worker started');
