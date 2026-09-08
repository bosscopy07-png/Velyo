import { prisma } from '../database';
import { blockchain } from './blockchain';
import { queueDepositCheck } from '../queues';
import { logger } from '../utils/logger';
import { config } from '../config';
import cron from 'node-cron';

class DepositMonitorService {
  private isRunning = false;

  start(): void {
    // Run every 30 seconds
    cron.schedule('*/30 * * * * *', () => this.scanDeposits());
    logger.info('Deposit monitor started');
  }

  private async scanDeposits(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      // Get all active wallets
      const wallets = await prisma.wallet.findMany({
        where: { status: 'ACTIVE' },
        include: { user: true },
      });

      const currentBlock = await blockchain.getProvider().then(p => p.getBlockNumber());
      const fromBlock = currentBlock - 50; // Check last 50 blocks

      for (const wallet of wallets) {
        // Check USDT transfers
        try {
          const events = await blockchain.getTokenTransferEvents(
            'USDT',
            wallet.address,
            fromBlock,
            currentBlock
          );

          for (const event of events) {
            const exists = await prisma.depositMonitor.findUnique({
              where: { txHash_address: { txHash: event.txHash, address: wallet.address } },
            });

            if (!exists) {
              // Create monitor record
              await prisma.depositMonitor.create({
                data: {
                  address: wallet.address,
                  asset: 'USDT',
                  txHash: event.txHash,
                  amount: Number(event.amount) / 1e18,
                  status: 'PENDING',
                },
              });

              // Queue for processing
              await queueDepositCheck({
                address: wallet.address,
                asset: 'USDT',
                txHash: event.txHash,
                amount: Number(event.amount) / 1e18,
              });
            }
          }
        } catch (err) {
          logger.error(`Error scanning USDT for ${wallet.address}:`, err);
        }
      }
    } catch (err) {
      logger.error('Deposit scan error:', err);
    } finally {
      this.isRunning = false;
    }
  }
}

export const depositMonitor = new DepositMonitorService();
