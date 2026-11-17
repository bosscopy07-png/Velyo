import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Request, RequestHandler, Response } from 'express';

/**
 * In-memory static file server: files are read + gzipped ONCE at startup, so
 * serving the site costs no disk or CPU per request, supports ETag/304, and
 * is small over slow mobile networks.
 */
const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
};
interface Entry { buf: Buffer; gz: Buffer | null; type: string; etag: string }

export const acceptsGzip = (req: Request) => /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));

export function staticHandler(dir: string): RequestHandler {
  const files = new Map<string, Entry>();
  for (const name of fs.readdirSync(dir)) {
    if (name === 'index.html') continue;
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    const buf = fs.readFileSync(full);
    const gzBuf = zlib.gzipSync(buf, { level: 9 });
    files.set('/' + name, {
      buf, gz: gzBuf.length < buf.length ? gzBuf : null,
      type: TYPES[path.extname(name)] ?? 'application/octet-stream',
      etag: '"' + crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 20) + '"',
    });
  }
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const f = files.get(req.path);
    if (!f) return next();
    res.setHeader('ETag', f.etag);
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    res.setHeader('Vary', 'Accept-Encoding');
    if (req.headers['if-none-match'] === f.etag) return void res.status(304).end();
    res.setHeader('Content-Type', f.type);
    const body = f.gz && acceptsGzip(req) ? (res.setHeader('Content-Encoding', 'gzip'), f.gz) : f.buf;
    res.setHeader('Content-Length', body.length);
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}

/** Small TTL cache for rendered HTML shells (they vary only by share-metadata). */
const shells = new Map<string, { at: number; raw: Buffer; gz: Buffer }>();
export function sendHtml(req: Request, res: Response, key: string, render: () => string, ttlMs = 30_000): void {
  let e = shells.get(key);
  if (!e || Date.now() - e.at > ttlMs) {
    if (shells.size > 500) shells.clear();
    const raw = Buffer.from(render(), 'utf8');
    e = { at: Date.now(), raw, gz: zlib.gzipSync(raw) };
    shells.set(key, e);
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Vary', 'Accept-Encoding');
  const body = acceptsGzip(req) ? (res.setHeader('Content-Encoding', 'gzip'), e.gz) : e.raw;
  res.setHeader('Content-Length', body.length);
  res.end(body);
  }
