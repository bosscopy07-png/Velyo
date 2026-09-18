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

// Dedicated connection for BullMQ (queues + workers).
// BullMQ issues blocking commands (BRPOPLPUSH etc.) which REQUIRE
// maxRetriesPerRequest: null — the shared client's value of 3 crashes it
// with "BullMQ: Your redis options maxRetriesPerRequest must be null."
export const bullmqConnection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

bullmqConnection.on('error', (err) => {
  logger.error('BullMQ Redis error:', err);
});

bullmqConnection.on('connect', () => {
  logger.info('BullMQ Redis connected');
});

// Graceful shutdown helper (wired into the SIGINT/SIGTERM handler)
export async function closeConnections(): Promise<void> {
  await Promise.allSettled([redis.quit(), bullmqConnection.quit()]);
}

// ─────────────────────────── Distributed locks ───────────────────────────

/**
 * Acquires a lock with an owner token. Returns the token on success, null if
 * the lock is held by someone else. Caller MUST pass the token to releaseLock.
 */
export async function acquireLock(lockKey: string, ttlMs = 10000): Promise<string | null> {
  const token = `${Date.now()}-${Math.random()}`;
  const result = await redis.set(lockKey, token, 'PX', ttlMs, 'NX');
  return result === 'OK' ? token : null;
}

// Atomically "delete only if I still own it" — the naive get-then-del has a
// race: if the lock expired and was re-acquired between GET and DEL, we'd
// delete someone else's lock. Lua makes the check+delete atomic.
const RELEASE_LOCK_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  else
    return 0
  end
`;

export async function releaseLock(lockKey: string, token: string): Promise<void> {
  await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, token);
}

// ─────────────────────────── Rate limiting ───────────────────────────

export async function checkRateLimit(key: string, maxRequests: number, windowMs: number): Promise<boolean> {
  const windowKey = `ratelimit:${key}:${Math.floor(Date.now() / windowMs)}`;
  const current = await redis.incr(windowKey);
  if (current === 1) {
    await redis.pexpire(windowKey, windowMs);
  }
  return current <= maxRequests;
}

// ─────────────────────────── Sessions ───────────────────────────

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

// ─────────────────────────── RPC failover ───────────────────────────

export async function markPrimaryRPCFailed(): Promise<void> {
  await redis.setex('rpc:primary:failed', 60, '1');
}

export async function isPrimaryRPCFailed(): Promise<boolean> {
  const failed = await redis.get('rpc:primary:failed');
  return failed === '1';
}

// ─────────────────────────── Giveaway tracking ───────────────────────────

export async function trackGiveawayView(giveawayId: string): Promise<void> {
  await redis.incr(`giveaway:views:${giveawayId}`);
}

export async function getGiveawayViews(giveawayId: string): Promise<number> {
  const views = await redis.get(`giveaway:views:${giveawayId}`);
  return parseInt(views || '0', 10);
}

// ─────────────────────────── Idempotency ───────────────────────────

/**
 * Claims an idempotency key. Returns TRUE if this is the FIRST time the key
 * has been seen (caller should proceed), FALSE if it was already claimed
 * (caller should abort as a duplicate).
 *
 * Note: this is the opposite of what a "check" returning boolean might imply
 * — the old doc-less version caused bugs where callers inverted the logic.
 */
export async function claimIdempotencyKey(key: string, ttlSec = 86400): Promise<boolean> {
  const result = await redis.set(`idempotency:${key}`, '1', 'EX', ttlSec, 'NX');
  return result === 'OK';
  }
