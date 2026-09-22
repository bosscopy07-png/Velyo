import { Worker } from 'bullmq';
import { bullmqConnection } from '../services/redis';
import { depositMonitor } from '../services/deposit-monitor';
import { logger } from '../utils/logger';

/**
 * This worker used to contain its OWN copy of the deposit-crediting logic,
 * with its own dedup check (`Transaction.findFirst({ transactionHash })`,
 * global, no wallet-address scoping) and its own idempotency key
 * (`hash('deposit', txHash)` — missing the address that the scanner's key
 * includes). Two different keys for the same real-world deposit meant the
 * `Transaction.idempotencyKey` unique constraint could NOT catch a double
 * credit between this worker and the cron scanner in `deposit-monitor.ts`.
 *
 * Fixed by deleting the duplicate logic entirely. This worker now only
 * validates its job payload and calls back into the exact same code path
 * the scanner uses (`depositMonitor.handleDepositCheck`), so there is
 * exactly one implementation of "credit a deposit" in the whole app.
 *
 * Nothing in the current codebase enqueues jobs onto the `'deposits'`
 * queue (see `queues/index.ts::queueDepositCheck`) — this worker is kept
 * running only so any future manual/admin "recheck this deposit" tool has
 * a safe, already-idempotent place to land.
 */
const worker = new Worker(
  'deposits',
  async (job) => {
    const { address, asset, txHash, rawAmount, from, blockNumber } = job.data as {
      address: string;
      asset: string;
      txHash: string;
      /** Raw on-chain integer amount (wei), as a string — see queueDepositCheck. */
      rawAmount: string;
      from?: string;
      blockNumber?: number;
    };

    if (!address || !asset || !txHash || !rawAmount) {
      throw new Error(`Deposit job missing required fields: ${JSON.stringify(job.data)}`);
    }

    await depositMonitor.handleDepositCheck(
      address,
      asset,
      txHash,
      BigInt(rawAmount),
      from ?? '',
      blockNumber
    );

    logger.info(`Deposit queue job delegated to depositMonitor for ${txHash} (${address})`);

    return { status: 'delegated' };
  },
  {
    connection: bullmqConnection,
    concurrency: 3,
  }
);

worker.on('failed', (job, err) => {
  logger.error(`Deposit queue job failed for ${job?.id}:`, err);
});

logger.info('Deposit worker started (delegates to depositMonitor — single credit path)');
