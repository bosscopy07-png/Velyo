import cron from 'node-cron';
import { prisma } from '../database';
import { redis } from './redis';
import { blockchain } from './blockchain';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Treasury — platform fund roles and health monitoring (spec §22/§34).
 *
 * ROLE SEPARATION (deliberate even where one physical wallet serves two
 * roles — spec §22):
 *   USER_BALANCE    → internal accounting rows (Balance table)
 *   DEPOSIT_ADDRESS → company pool addresses (CompanyDepositWallet)
 *   TREASURY        → platform operational funds = PLATFORM_FEE_WALLET
 *   PAYOUT_WALLET   → signs giveaway payouts; set from the admin panel
 *                     (stored encrypted in SystemConfig) or PAYOUT_WALLET_*
 *                     env, falling back to OPERATOR_WALLET_KEY
 *
 * Alerting: low BNB on the PAYOUT wallet / low USDT in treasury / large
 * pending payout queue / empty deposit pool. Debounced in Redis (one alert
 * per kind per hour) — never spams.
 */

export const TREASURY_ROLES = {
  USER_BALANCE: 'USER_BALANCE',
  DEPOSIT_ADDRESS: 'DEPOSIT_ADDRESS',
  TREASURY: 'TREASURY',
  PAYOUT_WALLET: 'PAYOUT_WALLET',
} as const;
export type TreasuryRole = (typeof TREASURY_ROLES)[keyof typeof TREASURY_ROLES];

/** Who signs giveaway payout transactions (spec §23, config-gated). */
export function getPayoutOrigin(): 'creator' | 'platform' {
  return config.PAYOUT_ORIGIN;
}

export function getTreasuryAddress(): string {
  return config.PLATFORM_FEE_WALLET;
}

export interface PayoutWallet {
  address: string;
  key: string; // ENCRYPTED — sendTransaction decrypts it (never store plain)
  source: 'database' | 'dedicated-env' | 'operator-fallback';
}

const PAYOUT_WALLET_CONFIG_KEY = 'payout_wallet';
const PAYOUT_WALLET_CACHE_KEY = 'payout_wallet:cfg';
const PAYOUT_WALLET_CACHE_TTL = 60;

interface StoredPayoutWallet {
  address: string;
  encryptedKey: string;
}

async function getStoredPayoutWallet(): Promise<StoredPayoutWallet | null> {
  try {
    const cached = await redis.get(PAYOUT_WALLET_CACHE_KEY);
    if (cached) return JSON.parse(cached) as StoredPayoutWallet;
  } catch {}
  try {
    const row = await prisma.systemConfig.findUnique({ where: { key: PAYOUT_WALLET_CONFIG_KEY } });
    if (row?.value && typeof row.value === 'object') {
      const v = row.value as StoredPayoutWallet;
      if (typeof v.address === 'string' && typeof v.encryptedKey === 'string') {
        try {
          await redis.setex(PAYOUT_WALLET_CACHE_KEY, PAYOUT_WALLET_CACHE_TTL, JSON.stringify(v));
        } catch {}
        return v;
      }
    }
  } catch {}
  return null;
}

/**
 * The wallet that SIGNS giveaway payouts in platform mode.
 * Priority: DB (set from the admin panel) → PAYOUT_WALLET_* env →
 * OPERATOR_WALLET_KEY legacy fallback. `key` is ALWAYS the encrypted key.
 */
export async function getPayoutWallet(): Promise<PayoutWallet> {
  const stored = await getStoredPayoutWallet();
  if (stored) return { address: stored.address, key: stored.encryptedKey, source: 'database' };

  if (config.PAYOUT_WALLET_KEY) {
    if (!config.PAYOUT_WALLET_ADDRESS) {
      throw new Error('PAYOUT_WALLET_KEY is set but PAYOUT_WALLET_ADDRESS is missing');
    }
    return { address: config.PAYOUT_WALLET_ADDRESS, key: config.PAYOUT_WALLET_KEY, source: 'dedicated-env' };
  }
  if (config.OPERATOR_WALLET_KEY) {
    return { address: config.PLATFORM_FEE_WALLET, key: config.OPERATOR_WALLET_KEY, source: 'operator-fallback' };
  }
  throw new Error(
    'PAYOUT_ORIGIN=platform but no payout wallet configured. ' +
    'Set it in Admin → Treasury → Set Payout Wallet, or configure PAYOUT_WALLET_ADDRESS + PAYOUT_WALLET_KEY (encrypted).'
  );
}

/**
 * Admin panel: set/rotate the payout wallet. Accepts the PLAIN key, verifies
 * it actually controls the address, encrypts it with WALLET_ENCRYPTION_KEY,
 * persists in SystemConfig and invalidates the cache. Audit-logged.
 */
export async function setPayoutWallet(
  adminTelegramId: string,
  address: string,
  plainPrivateKey: string
): Promise<void> {
  const { normalizeAddress } = await import('../utils/validation');
  const { encrypt } = await import('../utils/encryption');
  const { ethers } = await import('ethers');

  const normalized = normalizeAddress(address);
  const derived = normalizeAddress(new ethers.Wallet(plainPrivateKey.trim()).address);
  if (derived !== normalized) {
    throw new Error(`Key mismatch: that private key controls ${derived}, not ${normalized}`);
  }

  const value = { address: normalized, encryptedKey: encrypt(plainPrivateKey.trim()) };
  await prisma.systemConfig.upsert({
    where: { key: PAYOUT_WALLET_CONFIG_KEY },
    create: { key: PAYOUT_WALLET_CONFIG_KEY, value },
    update: { value },
  });
  try {
    await redis.del(PAYOUT_WALLET_CACHE_KEY);
  } catch {}

  await prisma.auditLog.create({
    data: {
      adminId: adminTelegramId,
      action: 'PAYOUT_WALLET_SET',
      entityType: 'system_config',
      entityId: PAYOUT_WALLET_CONFIG_KEY,
      newValue: { address: normalized },
    },
  });
  logger.info(`Payout wallet set to ${normalized} by admin ${adminTelegramId}`);
}

interface TreasuryThresholds {
  minBnb: number;
  minUsdt: number;
  maxPendingPayouts: number;
}

const DEFAULT_THRESHOLDS: TreasuryThresholds = {
  minBnb: 0.0000005,
  minUsdt: 0.15,
  maxPendingPayouts: 500,
};

async function getThresholds(): Promise<TreasuryThresholds> {
  try {
    const row = await prisma.systemConfig.findUnique({ where: { key: 'treasury_thresholds' } });
    if (row?.value && typeof row.value === 'object') {
      const v = row.value as Partial<TreasuryThresholds>;
      return {
        minBnb: typeof v.minBnb === 'number' && v.minBnb >= 0 ? v.minBnb : DEFAULT_THRESHOLDS.minBnb,
        minUsdt: typeof v.minUsdt === 'number' && v.minUsdt >= 0 ? v.minUsdt : DEFAULT_THRESHOLDS.minUsdt,
        maxPendingPayouts:
          typeof v.maxPendingPayouts === 'number' && v.maxPendingPayouts >= 1
            ? v.maxPendingPayouts
            : DEFAULT_THRESHOLDS.maxPendingPayouts,
      };
    }
  } catch {}
  return DEFAULT_THRESHOLDS;
}

export interface TreasuryStatus {
  address: string;
  payoutAddress: string;
  payoutOrigin: 'creator' | 'platform';
  legacyMonitorEnabled: boolean;
  bnb: number;
  usdt: number;
  companyWalletsActive: number;
  depositSessionsAwaiting: number;
  pendingPayouts: number | null;
}

class TreasuryMonitor {
  private onAlert: ((message: string) => void) | null = null;

  start(alertHandler: (message: string) => void): void {
    this.onAlert = alertHandler;
    cron.schedule('*/5 * * * *', () => void this.check());
    logger.info('Treasury monitor started (every 5 min, debounced alerts)');
  }

  async getStatus(): Promise<TreasuryStatus> {
    const [bnbRaw, usdtRaw, companyWalletsActive, depositSessionsAwaiting] = await Promise.all([
      blockchain.getBalance(config.PLATFORM_FEE_WALLET, 'BNB').catch(() => 0n),
      blockchain.getBalance(config.PLATFORM_FEE_WALLET, 'USDT').catch(() => 0n),
      prisma.companyDepositWallet.count({ where: { status: 'ACTIVE' } }).catch(() => 0),
      prisma.depositSession.count({ where: { status: { in: ['AWAITING', 'DETECTED'] } } }).catch(() => 0),
    ]);

    let pendingPayouts: number | null = null;
    try {
      const { payoutQueue } = await import('../queues');
      pendingPayouts = await payoutQueue.getWaitingCount();
    } catch {}

    return {
      address: config.PLATFORM_FEE_WALLET,
      payoutAddress:
        getPayoutOrigin() === 'platform' ? (await getPayoutWallet()).address : config.PLATFORM_FEE_WALLET,
      payoutOrigin: getPayoutOrigin(),
      legacyMonitorEnabled: config.ENABLE_LEGACY_DEPOSIT_MONITOR,
      bnb: Number(bnbRaw) / 1e18,
      usdt: Number(usdtRaw) / 1e18,
      companyWalletsActive,
      depositSessionsAwaiting,
      pendingPayouts,
    };
  }

  private async maybeAlert(kind: string, message: string): Promise<void> {
    if (!this.onAlert) return;
    const key = `treasury:alert:${kind}`;
    try {
      const set = await redis.set(key, '1', 'EX', 3600, 'NX');
      if (set !== 'OK') return;
      this.onAlert(message);
    } catch {
      this.onAlert(message);
    }
  }

  async check(): Promise<void> {
    try {
      const [status, thresholds] = await Promise.all([this.getStatus(), getThresholds()]);

      // Gas lives on the PAYOUT wallet in platform mode (it signs the txs).
      const gasAddress =
        getPayoutOrigin() === 'platform' ? (await getPayoutWallet()).address : config.PLATFORM_FEE_WALLET;
      const gasBnb = Number(await blockchain.getBalance(gasAddress, 'BNB').catch(() => 0n)) / 1e18;
      if (gasBnb < thresholds.minBnb) {
        await this.maybeAlert(
          'low_bnb',
          `⚠️ <b>PAYOUT WALLET LOW ON GAS</b>\n\nPayout wallet <code>${gasAddress}</code> holds ` +
            `<b>${gasBnb.toFixed(6)} BNB</b> (threshold ${thresholds.minBnb}).\n` +
            `Payouts and forwarding may stall until topped up.`
        );
      }

      if (status.usdt < thresholds.minUsdt) {
        await this.maybeAlert(
          'low_usdt',
          `⚠️ <b>TREASURY LOW ON USDT</b>\n\nTreasury holds <b>${status.usdt.toFixed(2)} USDT</b> ` +
            `(threshold ${thresholds.minUsdt}).`
        );
      }

      if (status.pendingPayouts !== null && status.pendingPayouts > thresholds.maxPendingPayouts) {
        await this.maybeAlert(
          'queue_depth',
          `⚠️ <b>PAYOUT QUEUE BACKLOG</b>\n\n${status.pendingPayouts} payouts waiting (threshold ` +
            `${thresholds.maxPendingPayouts}). Check RPC health and payout-wallet BNB.`
        );
      }

      if (status.companyWalletsActive === 0) {
        await this.maybeAlert(
          'no_deposit_wallets',
          `⚠️ <b>NO ACTIVE COMPANY DEPOSIT ADDRESSES</b>\n\nNew deposit sessions cannot be created. Add one from Admin → Treasury.`
        );
      }
    } catch (err) {
      logger.error(`Treasury check failed: ${(err as Error).message}`);
    }
  }
}

export const treasuryMonitor = new TreasuryMonitor();
  
