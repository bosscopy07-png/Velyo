import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  BOT_USERNAME: z.string().min(1),
  WEBHOOK_URL: z.string().optional(),
  WEBHOOK_PORT: z.string().default('3000').transform(Number),

  ADMIN_TELEGRAM_IDS: z.string().transform((s) => s.split(',').map((id) => id.trim())),
  ADMIN_API_KEY: z.string().min(1),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  BSC_PRIMARY_RPC: z.string().min(1),
  BSC_QUICKNODE_RPC: z
    .string()
    .url()
    .default('https://dry-fabled-firefly.bsc.quiknode.pro/b3fe69e21c3a3151f6b8e67bf661830acde8256a'),
  BSC_PUBLIC_RPCS: z.string().transform((s) => s.split(',').map((url) => url.trim())),
  BSC_CHAIN_ID: z.string().default('56').transform(Number),

  BSC_TX_RPC: z.string().min(1),
  BSC_SMALL_SCAN_RPC: z.string().min(1),

  WALLET_ENCRYPTION_KEY: z.string().min(32),
  PLATFORM_FEE_WALLET: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  OPERATOR_WALLET_KEY: z.string().optional(),

  PLATFORM_FEE_PERCENT: z.string().default('1.0').transform(Number),
  MINIMUM_AMOUNT_USD: z.string().default('0.25').transform(Number),
  ENABLE_FEES: z.string().default('true').transform((s) => s === 'true'),

  DEPOSIT_FLAT_FEE_USD: z.string().default('0.1').transform(Number),
  DEPOSIT_FLAT_FEE_SMALL_USD: z.string().default('0.05').transform(Number),
  DEPOSIT_FLAT_FEE_TIER_USD: z.string().default('0.5').transform(Number),

  // ── Phase-2 upgrade: central reward business rules (defaults only; the
  // live values live in SystemConfig 'fee_config' and are editable by admins) ──
  REWARD_CREATOR_PERCENT: z.string().default('1.0').transform(Number),
  REWARD_REFERRAL_PERCENT: z.string().default('1.0').transform(Number),

  // ── Phase-2 upgrade: who signs giveaway payout transactions ──
  // 'creator' (legacy, default) = claimant is paid from the creator's
  // custodial wallet. 'platform' = claimant is paid from the platform payout
  // wallet (OPERATOR_WALLET_KEY / PLATFORM_FEE_WALLET); the creator's balance
  // lock is unchanged (internal reservation only).
  PAYOUT_ORIGIN: z.enum(['creator', 'platform']).default('creator'),
    // ── Phase-2 upgrade: legacy per-user deposit monitoring ──
  // New deposits use company pool sessions (services/deposit-session.ts).
  // Personal wallets are NOT monitored for deposits when this is false.
  // User wallets REMAIN in the DB and still custody giveaway funds/gas —
  // they are only retired as deposit endpoints.
  ENABLE_LEGACY_DEPOSIT_MONITOR: z.string().default('false').transform((s) => s === 'true'),
  
  // ── Phase-2 upgrade: deposit session window (minutes) ──
  DEPOSIT_SESSION_TTL_MINUTES: z.string().default('30').transform(Number),

  PRICE_API_URL: z.string().default('https://api.coingecko.com/api/v3'),
  NGN_RATE_API_URL: z.string().default('https://api.exchangerate-api.com/v4/latest/USD'),
  COINGECKO_API_KEY: z.string().default(''),

  QUEUE_CONCURRENCY: z.string().default('5').transform(Number),
  PAYOUT_RETRY_DELAY_MS: z.string().default('30000').transform(Number),

  ENABLE_DEPOSITS: z.string().default('true').transform((s) => s === 'true'),
  ENABLE_GIVEAWAYS: z.string().default('true').transform((s) => s === 'true'),
  ENABLE_PAYOUTS: z.string().default('true').transform((s) => s === 'true'),
  MAINTENANCE_MODE: z.string().default('false').transform((s) => s === 'true'),
  COMMUNITY_CHANNEL_URL: z.string().url().default('https://t.me/VeyloNetwork'),
});

export const config = envSchema.parse(process.env);

export const ASSETS = {
  BNB: {
    symbol: 'BNB',
    name: 'BNB',
    network: 'BNB Smart Chain',
    chainId: 56,
    decimals: 18,
    contractAddress: null,
    isNative: true,
  },
  USDT: {
    symbol: 'USDT',
    name: 'Tether USD',
    network: 'BNB Smart Chain',
    chainId: 56,
    decimals: 18,
    contractAddress: '0x55d398326f99059fF775485246999027B3197955',
    isNative: false,
  },
} as const;

export type AssetSymbol = keyof typeof ASSETS;

export const GIVEAWAY_EXPIRY_OPTIONS = [
  { label: '1 Hour', hours: 1 },
  { label: '6 Hours', hours: 6 },
  { label: '24 Hours', hours: 24 },
  { label: '3 Days', hours: 72 },
  { label: '7 Days', hours: 168 },
  { label: 'No Expiry', hours: null },
] as const;
    
