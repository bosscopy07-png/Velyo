import { Queue, Job } from 'bullmq';
import { config } from '../config';
import { bullmqConnection } from '../services/redis';

// Queue instances — MUST use bullmqConnection (maxRetriesPerRequest: null).
// Passing the shared `redis` client here crashes BullMQ instantly.
export const payoutQueue = new Queue('payouts', { connection: bullmqConnection });
export const depositQueue = new Queue('deposits', { connection: bullmqConnection });
export const notificationQueue = new Queue('notifications', { connection: bullmqConnection });

// Job producers
export async function queuePayout(data: {
  claimId: string;
  giveawayId: string;
  userId: string;
  address: string;
  amount: number;
  asset: string;
  idempotencyKey: string;
}): Promise<Job> {
  return payoutQueue.add('process-payout', data, {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: config.PAYOUT_RETRY_DELAY_MS,
    },
    removeOnComplete: 100,
    removeOnFail: 50,
    jobId: data.idempotencyKey, // Prevent duplicates
  });
}

export async function queueDepositCheck(data: {
  address: string;
  asset: string;
  txHash: string;
  amount: number;
}): Promise<Job> {
  return depositQueue.add('check-deposit', data, {
    attempts: 10,
    backoff: {
      type: 'fixed',
      delay: 10000,
    },
    removeOnComplete: 100,
    removeOnFail: 50,
  });
}

export async function queueNotification(data: {
  telegramId: string;
  message: string;
  options?: Record<string, unknown>;
}): Promise<Job> {
  return notificationQueue.add('send-notification', data, {
    attempts: 3,
    backoff: { type: 'fixed', delay: 5000 },
  });
  }
