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
  BSC_PUBLIC_RPCS: z.string().transform((s) => s.split(',').map((url) => url.trim())),
  BSC_CHAIN_ID: z.string().default('56').transform(Number),

  WALLET_ENCRYPTION_KEY: z.string().min(32),
  PLATFORM_FEE_WALLET: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  // Encrypted private key of the operator/admin wallet (same wallet as
  // PLATFORM_FEE_WALLET): supplies tiny BNB gas at giveaway creation and
  // during fee sweeps.
  OPERATOR_WALLET_KEY: z.string().optional(),

  PLATFORM_FEE_PERCENT: z.string().default('1.0').transform(Number),
  MINIMUM_AMOUNT_USD: z.string().default('0.1').transform(Number),
  ENABLE_FEES: z.string().default('true').transform((s) => s === 'true'),

  PRICE_API_URL: z.string().default('https://api.coingecko.com/api/v3'),
  NGN_RATE_API_URL: z.string().default('https://api.exchangerate-api.com/v4/latest/USD'),
  // CoinGecko demo API key — set via env var ONLY. Never hardcode keys here;
  // this file is committed to git. Empty = anonymous rate limits (still works).
  COINGECKO_API_KEY: z.string().default(''),

  QUEUE_CONCURRENCY: z.string().default('5').transform(Number),
  PAYOUT_RETRY_DELAY_MS: z.string().default('30000').transform(Number),

  ENABLE_DEPOSITS: z.string().default('true').transform((s) => s === 'true'),
  ENABLE_GIVEAWAYS: z.string().default('true').transform((s) => s === 'true'),
  ENABLE_PAYOUTS: z.string().default('true').transform((s) => s === 'true'),
  MAINTENANCE_MODE: z.string().default('false').transform((s) => s === 'true'),
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
