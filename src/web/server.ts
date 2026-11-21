import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { checkRateLimit, redis, trackGiveawayView } from '../services/redis';
import { logger } from '../utils/logger';
import { webConfig } from './config';
import { hashAddress, hashDevice, hashIp, hashUa, maskAddress, safeEqual } from './lib/codes';
import { ethers } from 'ethers';
import { getPublicGiveaway, platformStats, resolveSlug } from './public';
import { looksLikeEvmAddress } from './lib/address';
import { staticHandler, sendHtml } from './static';
import { codeStatus } from './status';
import { forget } from './cache';
import { recordRequest, SLOW_MS } from './health';
import { giveawayService } from '../services/giveaway';
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

/** Real client IP. Uses X-Forwarded-For counted from the RIGHT by the number of trusted proxy hops. */
/** True only for requests carrying the secret LOADTEST_SECRET (admin traffic test). Off unless that env var is set. */
function isLoadTest(req: Request): boolean {
  const secret = webConfig().loadTestSecret;
  const given = String(req.get('x-veylo-loadtest') ?? '');
  return !!secret && given.length === secret.length && safeEqual(given, secret);
}

function clientIp(req: Request): string | null {
  if (isLoadTest(req)) { // each simulated visitor presents its own virtual IP
    const v = String(req.get('x-veylo-test-ip') ?? '');
    if (/^[0-9a-f:.]{3,45}$/i.test(v)) return v;
  }
  const hops = webConfig().trustProxy;
  const xff = String(req.get('x-forwarded-for') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (typeof hops === 'number' && hops > 0 && xff.length) return xff[Math.max(0, xff.length - hops)];
  return req.socket.remoteAddress ?? null;
}
const isHttps = (req: Request) => req.get('x-forwarded-proto') === 'https' || req.secure;

function signalsOf(req: Request): RequestSignals {
  const cfg = webConfig();
  const dev = String(req.get('x-veylo-device') ?? '');
  const ua = String(req.get('user-agent') ?? '');
  return {
    ipHash: clientIp(req) ? hashIp(cfg.hashSecret, clientIp(req)!) : null,
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

/**
 * All website routes as a Router, so they can be mounted on the bot's existing
 * webhook server (same service, same URL) OR run standalone via createApp().
 */
export function createWebRouter(): express.Router {
  const cfg = webConfig();
  const app = express.Router();

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
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
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

  // Request timing: feeds /sitehealth and logs slow requests so an outage leaves evidence.
  app.use((req, res, next) => {
    const t0 = performance.now();
    res.on('finish', () => {
      const ms = performance.now() - t0;
      recordRequest(ms, res.statusCode);
      if (ms > SLOW_MS) logger.warn(`[web] slow request ${req.method} ${req.path} took ${Math.round(ms)}ms (status ${res.statusCode})`);
    });
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  const api = express.Router();
  api.use(express.json({ limit: '2kb' }));
  api.use(limit('api', (c) => c.rl.apiPerIpMinute, 60_000, (r) => (clientIp(r) ? hashIp(cfg.hashSecret, clientIp(r)!) : null)));
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

  api.get('/giveaways/:slug', async (req, res) => {
    try {
      const g = await getPublicGiveaway(req.params.slug);
      if (!g) return res.status(404).json({ error: 'NOT_FOUND' });
      res.json({ giveaway: g.view });
    } catch (err) { logger.error(`[web] detail: ${(err as Error).message}`); res.status(500).json({ error: 'SERVER_ERROR' }); }
  });

  // Counts a website visit in the SAME "Link Opens" counter the bot's giveaway statistics already show.
  // Deduplicated per visitor per hour so refreshing or polling never inflates it.
  api.post('/giveaways/:slug/view', async (req, res) => {
    try {
      const id = await resolveSlug(req.params.slug);
      if (!id) return res.status(404).json({ error: 'NOT_FOUND' });
      const who = signalsOf(req);
      const visitor = who.deviceHash ?? who.ipHash;
      if (!isLoadTest(req) && visitor && (await redis.set(`giveaway:viewseen:${id}:${visitor}`, '1', 'EX', 3600, 'NX')) === 'OK') await trackGiveawayView(id);
      res.json({ ok: true });
    } catch (err) {
      logger.warn(`[web] view tracking skipped: ${(err as Error).message}`);
      res.json({ ok: true }); // analytics must never produce a user-facing error
    }
  });

  // The central feature: no account, no login, no Telegram needed — but the visitor
  // must enter the BEP20 wallet that will receive the reward before a code is issued.
  api.post(
    '/giveaways/:slug/claim-code',
    limit('claim:ip', (c) => c.rl.claimPerIpHour, 3_600_000, (r) => (clientIp(r) ? hashIp(cfg.hashSecret, clientIp(r)!) : null)),
    limit('claim:dev', (c) => c.rl.claimPerDeviceHour, 3_600_000, (r) => {
      const d = String(r.get('x-veylo-device') ?? '');
      return DEVICE_RE.test(d) ? hashDevice(cfg.hashSecret, d) : null;
    }),
    async (req, res) => {
      try {
        const address = String(req.body?.address ?? '').trim();
        if (!looksLikeEvmAddress(address) || !ethers.isAddress(address)) return res.status(400).json({ error: 'INVALID_ADDRESS' });
        const id = await resolveSlug(req.params.slug); // id lookup only; status/capacity are decided fresh inside reserveSlot
        if (!id) return res.status(404).json({ error: 'NOT_FOUND' });
        const result = await reserveSlot(id, signalsOf(req), { addressHash: hashAddress(cfg.hashSecret, address), maskedAddress: maskAddress(address) });
        if (result.ok) {
          if (!result.reused) forget(`gw:${req.params.slug}`); // the page must show the slot as taken straight away
          // A freshly issued code counts as a claim attempt in the bot's giveaway statistics.
          if (!result.reused && !isLoadTest(req)) giveawayService.trackAttempt(id).catch((e) => logger.warn(`[web] attempt tracking skipped: ${(e as Error).message}`));
          const code = result.code;
          return res.json({
            code,
            expiresAt: result.expiresAt.toISOString(),
            reservationMinutes: cfg.reservationMinutes,
            botLink: `${cfg.botUrl}?start=redeem_${code}`,
            maskedAddress: result.maskedAddress,
            reused: result.reused,
          });
        }
        const map = {
          FULL: 409, EXPIRED: 410, NOT_ACTIVE: 409, NOT_FOUND: 404, BUSY: 503, DEVICE_LIMIT: 429, DISABLED: 503,
          ADDRESS_USED: 409, ALREADY_CLAIMED: 409, IP_LIMIT: 429,
        } as const;
        res.status(map[result.error]).json({ error: result.error, mayReopen: result.mayReopen ?? false });
      } catch (err) {
        logger.error(`[web] claim-code: ${(err as Error).message}`);
        res.status(500).json({ error: 'SERVER_ERROR' }); // never leak internals
      }
    }
  );

  // Status of a code the visitor already holds (shows the payout receipt after redemption).
  api.post(
    '/code-status',
    limit('status:ip', () => 2000, 3_600_000, (r) => (clientIp(r) ? hashIp(cfg.hashSecret, clientIp(r)!) : null)),
    limit('status:dev', () => 600, 3_600_000, (r) => {
      const d = String(r.get('x-veylo-device') ?? '');
      return DEVICE_RE.test(d) ? hashDevice(cfg.hashSecret, d) : null;
    }),
    async (req, res) => {
      try {
        res.json(await codeStatus(String(req.body?.code ?? '').slice(0, 64)));
      } catch (err) {
        logger.error(`[web] code-status: ${(err as Error).message}`);
        res.status(500).json({ error: 'SERVER_ERROR' });
      }
    }
  );

  api.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  app.use('/api/v1', api);

  // ── Static site + SPA shell (with per-giveaway share metadata) ──
  app.use(staticHandler(PUBLIC_DIR));

  const shellHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'); // read once, not per request
  const shell = () => shellHtml;
  const boot = () =>
    JSON.stringify({
      botUrl: cfg.botUrl, channelUrl: cfg.channelUrl, supportUrl: cfg.supportUrl ?? null,
      reservationMinutes: cfg.reservationMinutes, apiBase: cfg.apiBase,
    }).replace(/</g, '\\u003c');

  async function page(req: Request, res: Response, meta?: { title: string; desc: string }) {
    const base = cfg.siteUrl ?? `${isHttps(req) ? 'https' : req.protocol}://${req.get('host')}`;
    const title = meta?.title ?? 'VEYLO — Create Giveaways. Share the Link. Reward Your Community.';
    const desc = meta?.desc ?? 'VEYLO is a Telegram giveaway platform: deposit USDT or BNB, create a giveaway, share your link, and your community claims their rewards.';
    sendHtml(req, res, `${base}|${req.path}|${title}|${desc}`, () =>
      shell()
        .replace(/\{\{TITLE\}\}/g, esc(title))
        .replace(/\{\{DESC\}\}/g, esc(desc))
        .replace(/\{\{URL\}\}/g, esc(base + req.path))
        .replace(/\{\{BASE\}\}/g, esc(base))
        .replace('{{BOOT}}', boot())
    );
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
  app.get('/giveaways', (_req, res) => res.redirect(301, '/')); // there is no public giveaway directory
  app.get('/', (req, res) => page(req, res));
  app.use((req, res) => {
    if (!req.accepts('html')) return res.status(404).end();
    res.status(404);
    return page(req, res);
  });

  return app;
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(createWebRouter());
  return app;
}

let maintenanceStarted = false;
/** Reservation expiry cleanup timer (idempotent; safe to call more than once). */
export function startWebMaintenance(): void {
  if (maintenanceStarted) return;
  maintenanceStarted = true;
  const sweep = () => sweepExpired().catch((e) => logger.error(`[web] sweep failed: ${(e as Error).message}`));
  void sweep();
  setInterval(sweep, 60_000).unref();
}

export function startWebServer(): void {
  const cfg = webConfig();
  const app = createApp();
  startWebMaintenance();
  app.listen(cfg.port, () => logger.info(`VEYLO website listening on :${cfg.port} (site ${cfg.siteUrl ?? 'url from request host'})`));
}

if (require.main === module) startWebServer();
                                   
