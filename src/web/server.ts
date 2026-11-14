import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { checkRateLimit } from '../services/redis';
import { logger } from '../utils/logger';
import { webConfig } from './config';
import { hashDevice, hashIp, hashUa } from './lib/codes';
import { getPublicGiveaway, listPublicGiveaways, platformStats } from './public';
import { reserveSlot, sweepExpired, type RequestSignals } from './reservations';

/**
 * VEYLO public website server. Separate process from the Telegram bot; shares
 * the same PostgreSQL + Redis. Public API responses contain only what the
 * website needs — never internal ids, claim secrets, user data or raw IPs.
 */

const PUBLIC_DIR = process.env.WEB_PUBLIC_DIR
  ? path.resolve(process.env.WEB_PUBLIC_DIR)
  : path.resolve(__dirname, '../../web/public');

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;

function signalsOf(req: Request): RequestSignals {
  const cfg = webConfig();
  const dev = String(req.get('x-veylo-device') ?? '');
  const ua = String(req.get('user-agent') ?? '');
  return {
    ipHash: req.ip ? hashIp(cfg.hashSecret, req.ip) : null,
    deviceHash: DEVICE_RE.test(dev) ? hashDevice(cfg.hashSecret, dev) : null,
    uaHash: ua ? hashUa(cfg.hashSecret, ua) : null,
  };
}

/** Fixed-window limiter. Fails CLOSED (503) if Redis is unavailable. */
function limit(name: string, max: (cfg: ReturnType<typeof webConfig>) => number, windowMs: number, by: (req: Request) => string | null) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = by(req);
      if (!key) return next();
      const ok = await checkRateLimit(`web:${name}:${key}`, max(webConfig()), windowMs);
      if (!ok) return res.status(429).json({ error: 'RATE_LIMITED' });
      next();
    } catch (err) {
      logger.error(`[web] rate limiter error: ${(err as Error).message}`);
      res.status(503).json({ error: 'UNAVAILABLE' });
    }
  };
}

export function createApp() {
  const cfg = webConfig();
  const app = express();
  app.set('trust proxy', cfg.trustProxy);
  app.disable('x-powered-by');

  // ── Security headers + (optional) CORS for a separately hosted frontend ──
  app.use((req, res, next) => {
    const connect = ["'self'", cfg.apiBase].filter(Boolean).join(' ');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src ${connect}; ` +
        `base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    const origin = req.get('origin');
    if (origin && cfg.siteUrl && origin === cfg.siteUrl) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Veylo-Device');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  const api = express.Router();
  api.use(express.json({ limit: '2kb' }));
  api.use(limit('api', (c) => c.rl.apiPerIpMinute, 60_000, (r) => (r.ip ? hashIp(cfg.hashSecret, r.ip) : null)));
  api.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  api.get('/config', (_req, res) => {
    res.json({
      brand: 'VEYLO',
      botUrl: cfg.botUrl,
      channelUrl: cfg.channelUrl,
      supportUrl: cfg.supportUrl ?? null,
      reservationMinutes: cfg.reservationMinutes,
      claimEnabled: cfg.claimEnabled,
    });
  });

  api.get('/stats', async (_req, res) => {
    try { res.json(await platformStats()); }
    catch (err) { logger.error(`[web] stats: ${(err as Error).message}`); res.status(500).json({ error: 'SERVER_ERROR' }); }
  });

  api.get('/giveaways', async (req, res) => {
    try {
      const onlyOpen = req.query.status !== 'all';
      const limitN = Math.min(30, Math.max(1, Number(req.query.limit) || 12));
      res.json({ giveaways: await listPublicGiveaways({ onlyOpen, limit: limitN }) });
    } catch (err) { logger.error(`[web] list: ${(err as Error).message}`); res.status(500).json({ error: 'SERVER_ERROR' }); }
  });

  api.get('/giveaways/:slug', async (req, res) => {
    try {
      const g = await getPublicGiveaway(req.params.slug);
      if (!g) return res.status(404).json({ error: 'NOT_FOUND' });
      res.json({ giveaway: g.view });
    } catch (err) { logger.error(`[web] detail: ${(err as Error).message}`); res.status(500).json({ error: 'SERVER_ERROR' }); }
  });

  // The central feature: no account, no login, no Telegram needed.
  api.post(
    '/giveaways/:slug/claim-code',
    limit('claim:ip', (c) => c.rl.claimPerIpHour, 3_600_000, (r) => (r.ip ? hashIp(cfg.hashSecret, r.ip) : null)),
    limit('claim:dev', (c) => c.rl.claimPerDeviceHour, 3_600_000, (r) => {
      const d = String(r.get('x-veylo-device') ?? '');
      return DEVICE_RE.test(d) ? hashDevice(cfg.hashSecret, d) : null;
    }),
    async (req, res) => {
      try {
        // Fresh read every time — availability is NEVER taken from a cache or the client.
        const g = await getPublicGiveaway(req.params.slug);
        if (!g) return res.status(404).json({ error: 'NOT_FOUND' });
        const result = await reserveSlot(g.id, signalsOf(req));
        if (result.ok) {
          const code = result.code;
          return res.json({
            code,
            expiresAt: result.expiresAt.toISOString(),
            reservationMinutes: cfg.reservationMinutes,
            botLink: `${cfg.botUrl}?start=redeem_${code}`,
            reused: result.reused,
          });
        }
        const map = { FULL: 409, EXPIRED: 410, NOT_ACTIVE: 409, NOT_FOUND: 404, BUSY: 503, DEVICE_LIMIT: 429, DISABLED: 503 } as const;
        res.status(map[result.error]).json({ error: result.error });
      } catch (err) {
        logger.error(`[web] claim-code: ${(err as Error).message}`);
        res.status(500).json({ error: 'SERVER_ERROR' }); // never leak internals
      }
    }
  );

  api.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  app.use('/api/v1', api);

  // ── Static site + SPA shell (with per-giveaway share metadata) ──
  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));

  const shell = () => fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const boot = () =>
    JSON.stringify({
      botUrl: cfg.botUrl, channelUrl: cfg.channelUrl, supportUrl: cfg.supportUrl ?? null,
      reservationMinutes: cfg.reservationMinutes, apiBase: cfg.apiBase,
    }).replace(/</g, '\\u003c');

  async function page(req: Request, res: Response, meta?: { title: string; desc: string }) {
    const base = cfg.siteUrl ?? `${req.protocol}://${req.get('host')}`;
    const title = meta?.title ?? 'VEYLO — Discover Giveaways. Claim Rewards.';
    const desc = meta?.desc ?? 'Discover active giveaways, claim your code, and complete your reward through the VEYLO Telegram bot.';
    const html = shell()
      .replace(/\{\{TITLE\}\}/g, esc(title))
      .replace(/\{\{DESC\}\}/g, esc(desc))
      .replace(/\{\{URL\}\}/g, esc(base + req.path))
      .replace(/\{\{BASE\}\}/g, esc(base))
      .replace('{{BOOT}}', boot());
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  }

  app.get('/g/:slug', async (req, res) => {
    try {
      const g = await getPublicGiveaway(req.params.slug);
      if (g) {
        const v = g.view;
        return page(req, res, {
          title: `${v.title} — VEYLO`,
          desc: `${v.amountPerUser} ${v.asset} per participant · ${v.availableSlots} of ${v.maxClaimers} slots available. Claim your code on VEYLO.`,
        });
      }
    } catch (err) { logger.error(`[web] share meta: ${(err as Error).message}`); }
    return page(req, res);
  });
  app.get(['/', '/giveaways'], (req, res) => page(req, res));
  app.use((req, res) => {
    if (!req.accepts('html')) return res.status(404).end();
    res.status(404);
    return page(req, res);
  });

  return app;
}

export function startWebServer(): void {
  const cfg = webConfig();
  const app = createApp();
  const sweep = () => sweepExpired().catch((e) => logger.error(`[web] sweep failed: ${(e as Error).message}`));
  void sweep();
  setInterval(sweep, 60_000).unref();
  app.listen(cfg.port, () => logger.info(`VEYLO website listening on :${cfg.port} (site ${cfg.siteUrl ?? 'url from request host'})`));
}

if (require.main === module) startWebServer();
    
