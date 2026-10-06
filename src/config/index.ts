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
  // QuickNode endpoint (legacy small-scan provider, kept for failover).
  BSC_QUICKNODE_RPC: z
    .string()
    .url()
    .default('https://dry-fabled-firefly.bsc.quiknode.pro/b3fe69e21c3a3151f6b8e67bf661830acde8256a'),
  BSC_PUBLIC_RPCS: z.string().transform((s) => s.split(',').map((url) => url.trim())),
  BSC_CHAIN_ID: z.string().default('56').transform(Number),

  // Dedicated RPC for ALL transaction sends (payouts, seeds, forwards) —
  // isolated from the read/scan pools so scanning never delays or
  // rate-limits broadcasting.
  BSC_TX_RPC: z.string().min(1),
  // Dedicated RPC for the SMALL safety scan only (30s after each BIG scan).
  BSC_SMALL_SCAN_RPC: z.string().min(1),

  WALLET_ENCRYPTION_KEY: z.string().min(32),
  PLATFORM_FEE_WALLET: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  // Encrypted private key of the operator/admin wallet (same wallet as
  // PLATFORM_FEE_WALLET): supplies tiny BNB gas and receives fees.
  OPERATOR_WALLET_KEY: z.string().optional(),

  // ── Payout wallet (platform mode) ──
  // The wallet that SIGNS giveaway payouts when PAYOUT_ORIGIN=platform.
  // Prefer setting it from the admin panel (Admin → Treasury → Set Payout
  // Wallet) — stored encrypted in the database, verified, rotatable without
  // a redeploy. These env values are the fallback and must contain the
  // ENCRYPTED key (same scheme as OPERATOR_WALLET_KEY).
  PAYOUT_WALLET_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  PAYOUT_WALLET_KEY: z.string().optional(),

  PLATFORM_FEE_PERCENT: z.string().default('1.0').transform(Number),
  MINIMUM_AMOUNT_USD: z.string().default('0.25').transform(Number),
  ENABLE_FEES: z.string().default('true').transform((s) => s === 'true'),

  // Deposit flat fee: standard tier, and the reduced tier for small deposits
  DEPOSIT_FLAT_FEE_USD: z.string().default('0.1').transform(Number),
  DEPOSIT_FLAT_FEE_SMALL_USD: z.string().default('0.05').transform(Number),
  DEPOSIT_FLAT_FEE_TIER_USD: z.string().default('0.5').transform(Number),

  // ── Central reward business rules (defaults; admins can tune at runtime
  // in Admin → Finance — the live values live in SystemConfig 'fee_config').
  // CASHBACK: 0.5% of the giveaway amount, credited when it fully pays out.
  // REFERRAL: 1% OF THE CASHBACK the referred creator earned (not of the
  // giveaway amount). $2 giveaway → $0.01 cashback → referrer gets $0.0001.
  REWARD_CREATOR_PERCENT: z.string().default('0.5').transform(Number),
  REWARD_REFERRAL_PERCENT: z.string().default('1.0').transform(Number),

  // ── Who signs giveaway payout transactions ──
  // 'platform' (default) = the platform payout wallet pays claimants
  // on-chain; the creator pays from their internal VEYLO balance (which
  // deposits and rewards credit). 'creator' = legacy custodial mode.
  PAYOUT_ORIGIN: z.enum(['creator', 'platform']).default('platform'),

  // ── On-chain confirmations before a payout is finalized and the
  // claimant notified. BSC reorgs beyond ~5 blocks are practically unheard
  // of; 15 confirmations added ~45s of dead wait for no real safety. ──
  PAYOUT_CONFIRMATIONS: z.string().default('5').transform(Number),

  // ── Deposit session window (minutes) ──
  // While a session is live, its address gets a LIGHT background check
  // (~1/min). Monitoring stops automatically when the session expires.
  DEPOSIT_SESSION_TTL_MINUTES: z.string().default('30').transform(Number),

  // ── Deposit treasury forwarding ──
  // SINGLE-WALLET MODE (default 'false'): the deposit/pool address IS the
  // treasury wallet, so the post-credit sweep is skipped entirely — no BNB
  // per deposit, no pool-key decrypts, no gas reserves. Set 'true' only if
  // pool and treasury are separate wallets again.
  DEPOSIT_FORWARD_TO_TREASURY: z.string().default('false').transform((s) => s === 'true'),

  // ── Legacy per-user deposit monitoring ──
  // Kept only as a documented transition switch. The legacy monitor
  // (services/deposit-monitor.ts) is NOT started by bot/index.ts anymore.
  // User wallets REMAIN in the DB — they are simply retired as deposit
  // endpoints; deposits use company pool sessions.
  ENABLE_LEGACY_DEPOSIT_MONITOR: z.string().default('false').transform((s) => s === 'true'),

  // ── Treasury health alerts ──
  // When 'true', reads the payout-wallet BNB and treasury USDT on-chain
  // every 5 min and alerts admins on low balances / queue backlog.
  // OFF by default — operation does not require recurring RPC.
  ENABLE_TREASURY_MONITOR: z.string().default('false').transform((s) => s === 'true'),

  PRICE_API_URL: z.string().default('https://api.coingecko.com/api/v3'),
  NGN_RATE_API_URL: z.string().default('https://api.exchangerate-api.com/v4/latest/USD'),
  COINGECKO_API_KEY: z.string().default(''),

  QUEUE_CONCURRENCY: z.string().default('5').transform(Number),
  PAYOUT_RETRY_DELAY_MS: z.string().default('30000').transform(Number),

  ENABLE_DEPOSITS: z.string().default('true').transform((s) => s === 'true'),
  ENABLE_GIVEAWAYS: z.string().default('true').transform((s) => s === 'true'),
  ENABLE_PAYOUTS: z.string().default('true').transform((s) => s === 'true'),
  // Initial default only — the live maintenance state is stored in the database
  // (SystemConfig 'maintenance_mode') and toggled from the admin panel.
  MAINTENANCE_MODE: z.string().default('false').transform((s) => s === 'true'),
  // Shown in the maintenance notice so users can follow updates.
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
  
