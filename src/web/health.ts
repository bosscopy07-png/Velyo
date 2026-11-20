import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * Lightweight self-monitoring for the website: no dependencies, no per-request
 * allocations beyond one small record. Lets an admin see — after the fact —
 * whether the site was slow, erroring, out of memory or just freshly started.
 */
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
const startedAt = Date.now();
const WINDOW_MS = 5 * 60_000;
export const SLOW_MS = 1500;

interface Rec { t: number; ms: number; status: number }
let recs: Rec[] = [];

export function recordRequest(ms: number, status: number, now = Date.now()): void {
  recs.push({ t: now, ms, status });
  if (recs.length > 20000) recs = recs.slice(-10000);
}

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : 0);

export function requestSummary(now = Date.now()) {
  recs = recs.filter((r) => now - r.t <= WINDOW_MS);
  const ms = recs.map((r) => r.ms).sort((a, b) => a - b);
  return {
    windowMinutes: WINDOW_MS / 60_000,
    requests: recs.length,
    p50: Math.round(pct(ms, 0.5)),
    p95: Math.round(pct(ms, 0.95)),
    max: Math.round(ms[ms.length - 1] ?? 0),
    slow: recs.filter((r) => r.ms > SLOW_MS).length,
    serverErrors: recs.filter((r) => r.status >= 500).length,
    rateLimited: recs.filter((r) => r.status === 429).length,
  };
}

export interface Probes { db: () => Promise<unknown>; redis: () => Promise<unknown> }

async function timeIt(fn: () => Promise<unknown>): Promise<number | null> {
  const t = performance.now();
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
    return Math.round(performance.now() - t);
  } catch {
    return null;
  }
}

export async function siteHealth(probes: Probes) {
  const mem = process.memoryUsage();
  const lag = { p99: Math.round(loop.percentile(99) / 1e6), max: Math.round(loop.max / 1e6) };
  loop.reset();
  return {
    uptimeMinutes: Math.round((Date.now() - startedAt) / 60_000),
    rssMb: Math.round(mem.rss / 1048576),
    heapMb: Math.round(mem.heapUsed / 1048576),
    eventLoopLagMs: lag,
    dbPingMs: await timeIt(probes.db),
    redisPingMs: await timeIt(probes.redis),
    ...requestSummary(),
  };
}

export function formatHealth(h: Awaited<ReturnType<typeof siteHealth>>): string {
  const flags: string[] = [];
  if (h.uptimeMinutes < 10) flags.push('⚠️ Process started only ' + h.uptimeMinutes + ' min ago (restart or cold start).');
  if (h.rssMb > 400) flags.push('⚠️ Memory is high (' + h.rssMb + ' MB).');
  if (h.eventLoopLagMs.p99 > 200) flags.push('⚠️ The server was busy: event-loop delay p99 ' + h.eventLoopLagMs.p99 + ' ms (CPU limit).');
  if (h.dbPingMs === null || h.dbPingMs > 300) flags.push('⚠️ Database is slow or unreachable (' + (h.dbPingMs ?? 'timeout') + ').');
  if (h.redisPingMs === null || h.redisPingMs > 150) flags.push('⚠️ Redis is slow or unreachable (' + (h.redisPingMs ?? 'timeout') + ').');
  if (h.serverErrors > 0) flags.push('⚠️ ' + h.serverErrors + ' server errors in the last ' + h.windowMinutes + ' min.');
  if (h.slow > 0) flags.push('⚠️ ' + h.slow + ' slow requests (>' + SLOW_MS + ' ms).');
  return [
    '<b>SITE HEALTH</b>',
    `Uptime: ${h.uptimeMinutes} min · Memory: ${h.rssMb} MB (heap ${h.heapMb})`,
    `Event-loop delay: p99 ${h.eventLoopLagMs.p99} ms · max ${h.eventLoopLagMs.max} ms`,
    `Database ping: ${h.dbPingMs ?? 'FAILED'} ms · Redis ping: ${h.redisPingMs ?? 'FAILED'} ms`,
    `Last ${h.windowMinutes} min: ${h.requests} requests · median ${h.p50} ms · p95 ${h.p95} ms · slowest ${h.max} ms`,
    `Rate-limited: ${h.rateLimited} · Server errors: ${h.serverErrors}`,
    '',
    flags.length ? flags.join('\n') : '✅ Nothing unusual right now.',
  ].join('\n');
}
