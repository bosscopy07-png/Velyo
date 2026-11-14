/**
 * Pure helpers for website claim codes and keyed hashing.
 * Depends ONLY on node:crypto so it is unit-testable without any services.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Crockford base32 (no I, L, O, U): unambiguous when read from a phone screen.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_PREFIX = 'VEYLO';
const GROUPS = 3;
const GROUP_LEN = 4;

/** 12 symbols x 5 bits = 60 bits of CSPRNG entropy. Server-side only. */
export function generateClaimCode(rand: (n: number) => Buffer = randomBytes): string {
  const bytes = rand(GROUPS * GROUP_LEN);
  const chars: string[] = [];
  for (const b of bytes) chars.push(ALPHABET[b & 31]); // 256 % 32 === 0 → no modulo bias
  const groups: string[] = [];
  for (let i = 0; i < GROUPS; i++) groups.push(chars.slice(i * GROUP_LEN, (i + 1) * GROUP_LEN).join(''));
  return `${CODE_PREFIX}-${groups.join('-')}`;
}

/** Canonical form used for hashing: uppercase, separators stripped, O→0, I/L→1. */
export function normalizeCode(input: string): string {
  let s = String(input ?? '').toUpperCase().replace(/[\s\-_]/g, '');
  if (s.startsWith(CODE_PREFIX)) s = s.slice(CODE_PREFIX.length);
  return s.replace(/O/g, '0').replace(/[IL]/g, '1');
}

export function isWellFormedCode(input: string): boolean {
  const n = normalizeCode(input);
  return n.length === GROUPS * GROUP_LEN && [...n].every((c) => ALPHABET.includes(c));
}

export function hmacHex(secret: string, domain: string, value: string): string {
  return createHmac('sha256', secret).update(`${domain}\u0000${value}`).digest('hex');
}

export function hashCode(secret: string, code: string): string {
  return hmacHex(secret, 'veylo:web-code:v1', normalizeCode(code));
}

/** IPv4 → as is. IPv6 → /64 prefix (a single customer can rotate the low 64 bits). */
export function normalizeIp(ip: string): string {
  const v = (ip || '').trim().replace(/^::ffff:/i, '');
  if (!v.includes(':')) return v;
  let groups: string[];
  if (v.includes('::')) {
    const [head, tail] = v.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  } else {
    groups = v.split(':');
  }
  return groups.slice(0, 4).map((g) => (parseInt(g || '0', 16) || 0).toString(16)).join(':');
}

export const hashIp = (secret: string, ip: string) => hmacHex(secret, 'veylo:ip:v1', normalizeIp(ip));
export const hashDevice = (secret: string, id: string) => hmacHex(secret, 'veylo:device:v1', id);
export const hashUa = (secret: string, ua: string) => hmacHex(secret, 'veylo:ua:v1', ua.slice(0, 300));

/** Payout address → keyed hash of the checksum-insensitive lowercase form. */
export function hashAddress(secret: string, address: string): string {
  return hmacHex(secret, 'veylo:addr:v1', address.trim().toLowerCase());
}

export function maskAddress(address: string): string {
  const a = address.trim();
  return a.length <= 12 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Short, non-reversible reference for evidence views (never a raw IP). */
export const shortRef = (hash: string | null | undefined) => (hash ? hash.slice(0, 10) : null);

// ── AES-256-GCM for the short-lived re-display copy of an ACTIVE code ─────────
function key(secret: string): Buffer {
  return createHmac('sha256', secret).update('veylo:web-code-cipher:v1').digest();
}

export function sealCode(secret: string, code: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(secret), iv);
  const enc = Buffer.concat([c.update(code, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function openCode(secret: string, sealed: string): string | null {
  try {
    const [iv, tag, enc] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
    const d = createDecipheriv('aes-256-gcm', key(secret), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
