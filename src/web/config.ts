import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { config as botConfig } from '../config';

/**
 * Website configuration. Parsed LAZILY (first use) so the Telegram bot keeps
 * booting exactly as before even if no website variable is set. Nothing here
 * hardcodes a domain; every public URL comes from the environment.
 *
 * Secrets: WEB_HASH_SECRET / WEB_CODE_SECRET fall back to a domain-separated
 * derivation of the existing WALLET_ENCRYPTION_KEY, so no new mandatory
 * secret is required to deploy — but dedicated values are recommended.
 */
const bool = (d: boolean) =>
  z.string().optional().transform((s) => (s === undefined || s === '' ? d : s === 'true'));
const int = (d: number) =>
  z.string().optional().transform((s) => (s === undefined || s === '' ? d : Number(s)));
const url = z.string().url().optional().or(z.literal('').transform(() => undefined));

const schema = z.object({
  WEB_PORT: int(8080),
  PUBLIC_WEBSITE_URL: url,
  API_BASE_URL: z.string().optional().default(''), // '' = same origin
  TELEGRAM_BOT_URL: url,
  TELEGRAM_CHANNEL_URL: url,
  SUPPORT_URL: url,
  WEB_HASH_SECRET: z.string().min(32).optional().or(z.literal('').transform(() => undefined)),
  WEB_CODE_SECRET: z.string().min(32).optional().or(z.literal('').transform(() => undefined)),
  TRUST_PROXY: z.string().optional().default('1'),

  RESERVATION_MINUTES: int(10),
  WEB_LISTING_SCOPE: z.enum(['all', 'admins']).optional().default('all'),
  WEB_CLAIM_ENABLED: bool(true),

  // Rate limits (fixed windows, Redis-backed)
  WEB_RL_CLAIM_PER_IP_HOUR: int(20),
  WEB_RL_CLAIM_PER_DEVICE_HOUR: int(6),
  WEB_RL_API_PER_IP_MINUTE: int(120),
  WEB_MAX_RESERVATIONS_PER_DEVICE_DAY: int(3),

  // Anti-abuse
  DUPLICATE_WALLET_ENFORCEMENT: bool(true),
  WEB_CODE_FAIL_LIMIT: int(8),
  WEB_CODE_FAIL_WINDOW_MINUTES: int(15),
});

export type WebConfig = ReturnType<typeof build>;

function derive(label: string): string {
  return createHmac('sha256', botConfig.WALLET_ENCRYPTION_KEY).update(label).digest('hex');
}

function build() {
  const e = schema.parse(process.env);
  const botUsername = botConfig.BOT_USERNAME.replace(/^@/, '');
  return {
    port: e.WEB_PORT,
    siteUrl: e.PUBLIC_WEBSITE_URL?.replace(/\/$/, ''),
    apiBase: e.API_BASE_URL,
    botUrl: e.TELEGRAM_BOT_URL ?? `https://t.me/${botUsername}`,
    botUsername,
    channelUrl: e.TELEGRAM_CHANNEL_URL ?? botConfig.COMMUNITY_CHANNEL_URL,
    /** Never invented: undefined hides every support link on the site. */
    supportUrl: e.SUPPORT_URL,
    hashSecret: e.WEB_HASH_SECRET ?? derive('veylo:web-hash-secret:v1'),
    codeSecret: e.WEB_CODE_SECRET ?? derive('veylo:web-code-secret:v1'),
    trustProxy: /^\d+$/.test(e.TRUST_PROXY) ? Number(e.TRUST_PROXY) : e.TRUST_PROXY === 'true' ? true : e.TRUST_PROXY === 'false' ? false : e.TRUST_PROXY,
    reservationMinutes: Math.min(120, Math.max(1, e.RESERVATION_MINUTES)),
    listingScope: e.WEB_LISTING_SCOPE,
    claimEnabled: e.WEB_CLAIM_ENABLED,
    rl: {
      claimPerIpHour: e.WEB_RL_CLAIM_PER_IP_HOUR,
      claimPerDeviceHour: e.WEB_RL_CLAIM_PER_DEVICE_HOUR,
      apiPerIpMinute: e.WEB_RL_API_PER_IP_MINUTE,
      maxReservationsPerDeviceDay: e.WEB_MAX_RESERVATIONS_PER_DEVICE_DAY,
    },
    duplicateWalletEnforcement: e.DUPLICATE_WALLET_ENFORCEMENT,
    codeFailLimit: e.WEB_CODE_FAIL_LIMIT,
    codeFailWindowMs: e.WEB_CODE_FAIL_WINDOW_MINUTES * 60_000,
    adminTelegramIds: botConfig.ADMIN_TELEGRAM_IDS,
  };
}

let cached: WebConfig | null = null;
export function webConfig(): WebConfig {
  return (cached ??= build());
}
