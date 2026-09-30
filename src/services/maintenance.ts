import { Prisma } from '@prisma/client';
import { prisma } from '../database';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  MAINTENANCE_KEY,
  MaintenanceAuditEntry,
  MaintenanceState,
  MaintenanceStore,
  createMaintenanceService,
  parseState,
} from './maintenance-core';

export { MaintenanceError, NotAuthorizedError } from './maintenance-core';
export type { MaintenanceState } from './maintenance-core';

/**
 * Postgres-backed store. State lives in the existing `SystemConfig` table
 * (no schema change / no migration) and every change writes an `AuditLog`
 * row in the same transaction.
 */
const prismaStore: MaintenanceStore = {
  async read() {
    const row = await prisma.systemConfig.findUnique({ where: { key: MAINTENANCE_KEY } });
    return row ? parseState(row.value, config.MAINTENANCE_MODE) : null;
  },

  async update(compute) {
    return prisma.$transaction(async (tx) => {
      const row = await tx.systemConfig.findUnique({ where: { key: MAINTENANCE_KEY } });
      const previous: MaintenanceState | null = row ? parseState(row.value, config.MAINTENANCE_MODE) : null;

      const { next, audit }: { next: MaintenanceState; audit: MaintenanceAuditEntry } = compute(previous);

      await tx.systemConfig.upsert({
        where: { key: MAINTENANCE_KEY },
        create: { key: MAINTENANCE_KEY, value: next as unknown as Prisma.InputJsonValue, updatedBy: audit.adminId },
        update: { value: next as unknown as Prisma.InputJsonValue, updatedBy: audit.adminId },
      });

      await tx.auditLog.create({
        data: {
          adminId: audit.adminId,
          action: audit.action,
          entityType: 'SystemConfig',
          entityId: MAINTENANCE_KEY,
          oldValue: audit.oldValue as unknown as Prisma.InputJsonValue,
          newValue: audit.newValue as unknown as Prisma.InputJsonValue,
        },
      });

      return { previous, current: next };
    });
  },
};

/**
 * Single shared instance. MAINTENANCE_MODE in the environment is now only the
 * initial default used before the first admin toggle writes a DB row.
 */
export const maintenance = createMaintenanceService({
  store: prismaStore,
  fallbackEnabled: config.MAINTENANCE_MODE,
  adminIds: config.ADMIN_TELEGRAM_IDS,
  ttlMs: 2000,
  onError: (message, err) => logger.error(`${message}: ${(err as Error)?.message ?? err}`),
});

/**
 * Service-layer guard for code that only knows the internal user id.
 * Throws MaintenanceError (user-safe message) if maintenance is ON and the
 * user is not an admin. Costs nothing while maintenance is OFF (cached flag),
 * and only touches the DB for the user lookup while it is ON.
 *
 * Call this BEFORE any financial mutation.
 */
export async function assertUserOperational(userId: string): Promise<void> {
  if (!(await maintenance.isEnabled())) return;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { telegramId: true } });
  await maintenance.assertOperationalFor(user?.telegramId);
}
