import Redis from 'ioredis';
import { config } from '../config';
import { logger } from '../utils/logger';

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
});

redis.on('error', (err) => {
  logger.error('Redis error:', err);
});

redis.on('connect', () => {
  logger.info('Redis connected');
});

// Distributed lock for atomic giveaway claims
export async function acquireLock(lockKey: string, ttlMs = 10000): Promise<string | null> {
  const token = `${Date.now()}-${Math.random()}`;
  const result = await redis.set(lockKey, token, 'PX', ttlMs, 'NX');
  return result === 'OK' ? token : null;
}

export async function releaseLock(lockKey: string, token: string): Promise<void> {
  const current = await redis.get(lockKey);
  if (current === token) {
    await redis.del(lockKey);
  }
}

// Rate limiting
export async function checkRateLimit(key: string, maxRequests: number, windowMs: number): Promise<boolean> {
  const windowKey = `ratelimit:${key}:${Math.floor(Date.now() / windowMs)}`;
  const current = await redis.incr(windowKey);
  if (current === 1) {
    await redis.pexpire(windowKey, windowMs);
  }
  return current <= maxRequests;
}

// Session management
export async function setUserSession(telegramId: string, data: Record<string, unknown>, ttl = 300): Promise<void> {
  await redis.setex(`session:${telegramId}`, ttl, JSON.stringify(data));
}

export async function getUserSession(telegramId: string): Promise<Record<string, unknown> | null> {
  const data = await redis.get(`session:${telegramId}`);
  return data ? JSON.parse(data) : null;
}

export async function clearUserSession(telegramId: string): Promise<void> {
  await redis.del(`session:${telegramId}`);
}

// RPC fallback state
export async function markPrimaryRPCFailed(): Promise<void> {
  await redis.setex('rpc:primary:failed', 60, '1');
}

export async function isPrimaryRPCFailed(): Promise<boolean> {
  const failed = await redis.get('rpc:primary:failed');
  return failed === '1';
}

// Giveaway claim tracking
export async function trackGiveawayView(giveawayId: string): Promise<void> {
  await redis.incr(`giveaway:views:${giveawayId}`);
}

export async function getGiveawayViews(giveawayId: string): Promise<number> {
  const views = await redis.get(`giveaway:views:${giveawayId}`);
  return parseInt(views || '0');
}

// Idempotency for payouts
export async function checkIdempotency(key: string): Promise<boolean> {
  const exists = await redis.set(`idempotency:${key}`, '1', 'EX', 86400, 'NX');
  return exists === 'OK';
}
