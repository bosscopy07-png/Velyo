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
 *   PAYOUT_WALLET   → signs giveaway payouts; = OPERATOR_WALLET_KEY wallet
 *                     when PAYOUT_ORIGIN=platform, else the creator wallet
 *
 * Alerting: low BNB / low USDT / large pending payout queue / empty deposit
 * pool. Debounced in Redis (one alert per kind per hour) — never spams.
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

interface TreasuryThresholds {
  minBnb: number; // alert when treasury BNB < this
  minUsdt: number; // alert when treasury USDT < this
  maxPendingPayouts: number; // alert when payout queue deeper than this
}

const DEFAULT_THRESHOLDS: TreasuryThresholds = {
  minBnb: 0.05,
  minUsdt: 25,
  maxPendingPayouts: 50,
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
  payoutOrigin: 'creator' | 'platform';
  legacyMonitorEnabled: boolean;
  bnb: number;
  usdt: number;
  companyWalletsActive: number;
  depositSessionsAwaiting: number;
  pendingPayouts: number | null; // null when the queue is unreachable
}

class TreasuryMonitor {
  private onAlert: ((message: string) => void) | null = null;

  /**
   * @param alertHandler wired by bot/index.ts to Telegram admin messages.
   */
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
    } catch {
      // Queue unreachable — non-fatal for a status view.
    }

    return {
      address: config.PLATFORM_FEE_WALLET,
      payoutOrigin: getPayoutOrigin(),
      legacyMonitorEnabled: config.ENABLE_LEGACY_DEPOSIT_MONITOR,
      bnb: Number(bnbRaw) / 1e18,
      usdt: Number(usdtRaw) / 1e18,
      companyWalletsActive,
      depositSessionsAwaiting,
      pendingPayouts,
    };
  }

  /** One debounced alert per kind per hour (spec §34). */
  private async maybeAlert(kind: string, message: string): Promise<void> {
    if (!this.onAlert) return;
    const key = `treasury:alert:${kind}`;
    try {
      const set = await redis.set(key, '1', 'EX', 3600, 'NX');
      if (set !== 'OK') return; // already alerted recently
      this.onAlert(message);
    } catch {
      // Redis down → deliver anyway (better than missing a funds alert).
      this.onAlert(message);
    }
  }

  async check(): Promise<void> {
    try {
      const [status, thresholds] = await Promise.all([this.getStatus(), getThresholds()]);

      if (status.bnb < thresholds.minBnb) {
        await this.maybeAlert(
          'low_bnb',
          `⚠️ <b>TREASURY LOW ON GAS</b>\n\nPayout/treasury wallet <code>${status.address}</code> holds ` +
            `<b>${status.bnb.toFixed(6)} BNB</b> (threshold ${thresholds.minBnb}).\n` +
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
            `${thresholds.maxPendingPayouts}). Check RPC health and treasury BNB.`
        );
      }

      if (status.companyWalletsActive === 0) {
        await this.maybeAlert(
          'no_deposit_wallets',
          `⚠️ <b>NO ACTIVE COMPANY DEPOSIT ADDRESSES</b>\n\nNew deposit sessions cannot be created. Add one from Admin → Treasury.`
        );
      }
    } catch (err) {
      // A monitor failure must never crash the bot process.
      logger.error(`Treasury check failed: ${(err as Error).message}`);
    }
  }
}

export const treasuryMonitor = new TreasuryMonitor();
          
