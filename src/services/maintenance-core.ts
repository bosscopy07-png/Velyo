/**
 * Maintenance mode — core logic.
 *
 * Dependency-free on purpose (no config / prisma / logger imports) so it can
 * be unit-tested with an in-memory store. The real wiring (Prisma store,
 * env fallback, admin list) lives in ./maintenance.ts.
 *
 * Source of truth: the `SystemConfig` row with key `maintenance_mode`.
 * A short per-process cache avoids a DB query on every Telegram update; it is
 * refreshed on every toggle made by this process and expires after `ttlMs`
 * so other bot instances converge within a couple of seconds.
 */

export const MAINTENANCE_KEY = 'maintenance_mode';

export interface MaintenanceState {
  enabled: boolean;
  /** Optional operator note (never shown to users). */
  reason: string | null;
  /** ISO timestamp of the last change (null when never toggled via the DB). */
  changedAt: string | null;
  /** Telegram ID of the admin who made the last change. */
  changedBy: string | null;
  /** ISO timestamp of when maintenance was last switched ON. */
  enabledAt: string | null;
  /** Telegram ID of the admin who last switched maintenance ON. */
  enabledBy: string | null;
}

export interface MaintenanceAuditEntry {
  adminId: string;
  action: 'MAINTENANCE_ENABLED' | 'MAINTENANCE_DISABLED';
  oldValue: MaintenanceState;
  newValue: MaintenanceState;
}

export interface MaintenanceStore {
  /** Fresh read from the source of truth. `null` = never written. */
  read(): Promise<MaintenanceState | null>;
  /**
   * Atomically: read previous → compute next → persist next → write audit log.
   * Must be a single transaction so state and audit can never diverge.
   */
  update(
    compute: (previous: MaintenanceState | null) => { next: MaintenanceState; audit: MaintenanceAuditEntry },
  ): Promise<{ previous: MaintenanceState | null; current: MaintenanceState }>;
}

export class MaintenanceError extends Error {
  readonly code = 'MAINTENANCE_ACTIVE';
  constructor(message = 'VEYLO is under maintenance. Please try again later.') {
    super(message);
    this.name = 'MaintenanceError';
  }
}

export class NotAuthorizedError extends Error {
  readonly code = 'NOT_AUTHORIZED';
  constructor() {
    super('Not authorized.');
    this.name = 'NotAuthorizedError';
  }
}

export interface MaintenanceServiceOptions {
  store: MaintenanceStore;
  /** Used only when no DB row exists yet (e.g. first deploy). */
  fallbackEnabled: boolean;
  adminIds: readonly string[];
  /** Cache lifetime. Default 2s. */
  ttlMs?: number;
  now?: () => number;
  onError?: (message: string, err: unknown) => void;
}

export function defaultState(enabled: boolean): MaintenanceState {
  return { enabled, reason: null, changedAt: null, changedBy: null, enabledAt: null, enabledBy: null };
}

/** Defensive parse of the JSON stored in SystemConfig.value. */
export function parseState(raw: unknown, fallbackEnabled: boolean): MaintenanceState {
  if (!raw || typeof raw !== 'object') return defaultState(fallbackEnabled);
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

  // Accept real booleans, and tolerate legacy string values.
  let enabled: boolean;
  if (typeof o.enabled === 'boolean') enabled = o.enabled;
  else if (o.enabled === 'true') enabled = true;
  else if (o.enabled === 'false') enabled = false;
  else enabled = fallbackEnabled;

  return {
    enabled,
    reason: str(o.reason),
    changedAt: str(o.changedAt),
    changedBy: str(o.changedBy),
    enabledAt: str(o.enabledAt),
    enabledBy: str(o.enabledBy),
  };
}

export function createMaintenanceService(opts: MaintenanceServiceOptions) {
  const { store, fallbackEnabled } = opts;
  const adminIds = new Set(opts.adminIds);
  const ttlMs = opts.ttlMs ?? 2000;
  const now = opts.now ?? (() => Date.now());
  const onError = opts.onError ?? (() => undefined);

  let cached: { state: MaintenanceState; at: number } | null = null;
  // Bumped on every local write so a slow in-flight read can't overwrite a
  // newer toggle with an older value.
  let epoch = 0;

  function isAdminId(telegramId: string | number | undefined | null): boolean {
    if (telegramId === undefined || telegramId === null) return false;
    return adminIds.has(String(telegramId));
  }

  async function getState(opts2?: { force?: boolean }): Promise<MaintenanceState> {
    const force = opts2?.force === true;
    if (!force && cached && now() - cached.at < ttlMs) return cached.state;

    const startEpoch = epoch;
    try {
      const row = await store.read();
      const state = row ? parseState(row, fallbackEnabled) : defaultState(fallbackEnabled);
      if (startEpoch === epoch) cached = { state, at: now() };
      return startEpoch === epoch ? state : (cached?.state ?? state);
    } catch (err) {
      // Never swallow silently. Fail to the last known state, otherwise the
      // env default — so a DB blip neither unlocks nor locks the bot by accident
      // beyond what was last known.
      onError('Maintenance state read failed; using last known state', err);
      return cached?.state ?? defaultState(fallbackEnabled);
    }
  }

  async function isEnabled(): Promise<boolean> {
    return (await getState()).enabled;
  }

  /**
   * Throws MaintenanceError when maintenance is ON and the actor is not an
   * admin. Call BEFORE any financial mutation.
   */
  async function assertOperationalFor(telegramId: string | number | undefined | null): Promise<void> {
    if (isAdminId(telegramId)) return;
    if (await isEnabled()) throw new MaintenanceError();
  }

  /**
   * Admin-only. Persists + audits in one transaction, then re-reads from the
   * database (bypassing the cache) to confirm the write really landed.
   */
  async function setEnabled(
    enabled: boolean,
    adminTelegramId: string | number,
    reason?: string | null,
  ): Promise<{ previous: MaintenanceState; current: MaintenanceState; changed: boolean }> {
    const adminId = String(adminTelegramId);
    if (!isAdminId(adminId)) throw new NotAuthorizedError();

    const stamp = new Date(now()).toISOString();

    const { previous, current } = await store.update((prevRow) => {
      const prev = prevRow ? parseState(prevRow, fallbackEnabled) : defaultState(fallbackEnabled);
      const next: MaintenanceState = {
        enabled,
        reason: enabled ? (reason ?? null) : null,
        changedAt: stamp,
        changedBy: adminId,
        enabledAt: enabled ? stamp : prev.enabledAt,
        enabledBy: enabled ? adminId : prev.enabledBy,
      };
      return {
        next,
        audit: {
          adminId,
          action: enabled ? 'MAINTENANCE_ENABLED' : 'MAINTENANCE_DISABLED',
          oldValue: prev,
          newValue: next,
        },
      };
    });

    // Confirm the write succeeded — read straight from the store.
    const verified = await store.read();
    if (!verified || parseState(verified, fallbackEnabled).enabled !== enabled) {
      throw new Error('Maintenance state write could not be verified');
    }

    epoch++;
    const prevState = previous ? parseState(previous, fallbackEnabled) : defaultState(fallbackEnabled);
    cached = { state: current, at: now() };
    return { previous: prevState, current, changed: prevState.enabled !== enabled };
  }

  /** Drop the cache (tests / manual invalidation). */
  function invalidate(): void {
    epoch++;
    cached = null;
  }

  return { getState, isEnabled, isAdminId, assertOperationalFor, setEnabled, invalidate };
}

export type MaintenanceService = ReturnType<typeof createMaintenanceService>;
    
