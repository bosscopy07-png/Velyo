import { Queue, Worker, Job } from 'bullmq';
import { config } from '../config';
import { redis } from '../services/redis';
import { logger } from '../utils/logger';

// Queue instances
export const payoutQueue = new Queue('payouts', { connection: redis });
export const depositQueue = new Queue('deposits', { connection: redis });
export const notificationQueue = new Queue('notifications', { connection: redis });

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
