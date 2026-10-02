import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../database';
import { redis } from './redis';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * SINGLE SOURCE OF TRUTH for all configurable business percentages/fees.
 *
 * Defaults come from env (config.*). Admins can override at runtime; the
 * overrides are persisted in SystemConfig ('fee_config', JSON) and every
 * change is written to the audit log. All other modules MUST read fees via
 * feeConfig.getFees() — never read config.PLATFORM_FEE_PERCENT directly.
 *
 * Cache: Redis 'fees:config' for 60s. Cache invalidation happens on every
 * setFeeConfig() write.
 */

export interface FeeConfig {
  platformFeePercent: number;
  creatorCashbackPercent: number;
  referralRewardPercent: number;
  depositFlatFeeUSD: number;
  depositFlatFeeSmallUSD: number;
  depositFlatFeeTierUSD: number;
  minAmountUSD: number;
  enableFees: boolean;
}

const DEFAULTS: FeeConfig = {
  platformFeePercent: config.PLATFORM_FEE_PERCENT,
  creatorCashbackPercent: config.REWARD_CREATOR_PERCENT,
  referralRewardPercent: config.REWARD_REFERRAL_PERCENT,
  depositFlatFeeUSD: config.DEPOSIT_FLAT_FEE_USD,
  depositFlatFeeSmallUSD: config.DEPOSIT_FLAT_FEE_SMALL_USD,
  depositFlatFeeTierUSD: config.DEPOSIT_FLAT_FEE_TIER_USD,
  minAmountUSD: config.MINIMUM_AMOUNT_USD,
  enableFees: config.ENABLE_FEES,
};

// Bounds: percentages 0–100, flat fees >= 0 (max $100 sanity cap).
const patchSchema = z
  .object({
    platformFeePercent: z.number().min(0).max(100),
    creatorCashbackPercent: z.number().min(0).max(100),
    referralRewardPercent: z.number().min(0).max(100),
    depositFlatFeeUSD: z.number().min(0).max(100),
    depositFlatFeeSmallUSD: z.number().min(0).max(100),
    depositFlatFeeTierUSD: z.number().min(0).max(100),
    minAmountUSD: z.number().min(0).max(10000),
    enableFees: z.boolean(),
  })
  .partial();

const CACHE_KEY = 'fees:config';
const CACHE_TTL_SEC = 60;
const CONFIG_ROW_KEY = 'fee_config';

class FeeConfigService {
  async getFees(): Promise<FeeConfig> {
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) return { ...DEFAULTS, ...(JSON.parse(cached) as Partial<FeeConfig>) };
    } catch {
      // cache miss / redis down → fall through to DB
    }

    let overrides: Partial<FeeConfig> = {};
    try {
      const row = await prisma.systemConfig.findUnique({ where: { key: CONFIG_ROW_KEY } });
      if (row) {
        const parsed = patchSchema.safeParse(row.value);
        if (parsed.success) overrides = parsed.data;
        else logger.warn(`fee_config row failed validation, using defaults: ${JSON.stringify(parsed.error.issues)}`);
      }
    } catch (err) {
      logger.error(`fee_config DB read failed, using defaults: ${(err as Error).message}`);
    }

    const merged = { ...DEFAULTS, ...overrides };
    try {
      await redis.setex(CACHE_KEY, CACHE_TTL_SEC, JSON.stringify(overrides));
    } catch {}
    return merged;
  }

  /**
   * Admin runtime override. Validates, persists, audits, invalidates cache.
   * @returns the merged config after the change.
   * @throws ZodError on invalid values; Error on DB failure.
   */
  async setFees(adminTelegramId: string, patch: Record<string, unknown>): Promise<FeeConfig> {
    const current = await this.getFees();
    const parsed = patchSchema.parse(patch); // throws on invalid
    const next: FeeConfig = { ...current, ...parsed };

    // Prisma Json fields need InputJsonValue — a JSON round-trip both
    // validates serializability and satisfies the type.
    const jsonValue = JSON.parse(JSON.stringify(next)) as Prisma.InputJsonObject;
    await prisma.systemConfig.upsert({
      where: { key: CONFIG_ROW_KEY },
      create: { key: CONFIG_ROW_KEY, value: jsonValue, updatedBy: adminTelegramId },
      update: { value: jsonValue, updatedBy: adminTelegramId },
    });

    // Audit the diff only (not the whole config) — old/new per touched key.
    const touched = Object.keys(parsed);
    await prisma.auditLog.create({
      data: {
        adminId: adminTelegramId,
        action: 'FEE_CONFIG_CHANGE',
        entityType: 'system_config',
        entityId: CONFIG_ROW_KEY,
        oldValue: JSON.parse(
          JSON.stringify(Object.fromEntries(touched.map((k) => [k, (current as unknown as Record<string, unknown>)[k]])))
        ) as Prisma.InputJsonObject,
        newValue: JSON.parse(JSON.stringify(parsed)) as Prisma.InputJsonObject,
      },
    });

    try {
      await redis.del(CACHE_KEY);
    } catch {}

    logger.info(`Fee config changed by ${adminTelegramId}: ${JSON.stringify(parsed)}`);
    return next;
  }

  /**
   * percent of amount, rounded to 8dp — never chain floats beyond this.
   * Mirrors the codebase convention (see estimateCreationCost) but in ONE place.
   */
  percentOf(amount: number, percent: number): number {
    if (!(amount > 0) || !(percent > 0)) return 0;
    return Number(((amount * percent) / 100).toFixed(8));
  }

  /** Tiered deposit flat fee (USD), same rules as the legacy flatFeeFor. */
  depositFlatFeeUSD(amountUSD: number, fees: FeeConfig): number {
    if (!fees.enableFees) return 0;
    return amountUSD < fees.depositFlatFeeTierUSD ? fees.depositFlatFeeSmallUSD : fees.depositFlatFeeUSD;
  }
}

export const feeConfig = new FeeConfigService();
