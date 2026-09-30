import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MaintenanceAuditEntry,
  MaintenanceError,
  MaintenanceState,
  MaintenanceStore,
  NotAuthorizedError,
  createMaintenanceService,
  parseState,
} from '../src/services/maintenance-core';
import { isBlockedDuringMaintenance, shouldClearSessionOnBlock } from '../src/services/maintenance-policy';

/** In-memory "database" that survives service re-creation (= process restart). */
function makeDb() {
  const db = { row: null as MaintenanceState | null, audit: [] as MaintenanceAuditEntry[], failWrites: false, failReads: false };
  const store: MaintenanceStore = {
    async read() {
      if (db.failReads) throw new Error('db down');
      return db.row ? structuredClone(db.row) : null;
    },
    async update(compute) {
      if (db.failWrites) throw new Error('write failed');
      const previous = db.row ? structuredClone(db.row) : null;
      const { next, audit } = compute(previous);
      db.row = structuredClone(next);
      db.audit.push(audit);
      return { previous, current: next };
    },
  };
  return { db, store };
}

const ADMIN = '111';
const USER = '222';
const svc = (store: MaintenanceStore, extra: object = {}) =>
  createMaintenanceService({ store, fallbackEnabled: false, adminIds: [ADMIN], ttlMs: 0, ...extra });

test('A: OFF → user allowed', async () => {
  const { store } = makeDb();
  await svc(store).assertOperationalFor(USER);
});

test('B: ON → user blocked with MaintenanceError', async () => {
  const { store } = makeDb();
  const m = svc(store);
  await m.setEnabled(true, ADMIN);
  await assert.rejects(m.assertOperationalFor(USER), MaintenanceError);
});

test('C: ON → admin allowed', async () => {
  const { store } = makeDb();
  const m = svc(store);
  await m.setEnabled(true, ADMIN);
  await m.assertOperationalFor(ADMIN);
});

test('non-admin cannot toggle, and nothing is written', async () => {
  const { db, store } = makeDb();
  await assert.rejects(svc(store).setEnabled(true, USER), NotAuthorizedError);
  assert.equal(db.row, null);
  assert.equal(db.audit.length, 0);
});

test('F/G: state survives restart (new service instance, same DB), ON and OFF', async () => {
  const { store } = makeDb();
  await svc(store).setEnabled(true, ADMIN);
  assert.equal(await svc(store).isEnabled(), true); // restart #1
  await svc(store).setEnabled(false, ADMIN);
  assert.equal(await svc(store).isEnabled(), false); // restart #2
});

test('multiple instances converge via DB (cache TTL)', async () => {
  const { store } = makeDb();
  let t = 0;
  const a = svc(store, { ttlMs: 2000, now: () => t });
  const b = svc(store, { ttlMs: 2000, now: () => t });
  assert.equal(await b.isEnabled(), false); // b caches OFF
  await a.setEnabled(true, ADMIN);
  assert.equal(await a.isEnabled(), true); // writer sees it immediately
  t += 2001; // b's cache expires
  assert.equal(await b.isEnabled(), true);
});

test('I: rapid ON → OFF → ON stays consistent, audit has 3 ordered entries', async () => {
  const { db, store } = makeDb();
  const m = svc(store, { ttlMs: 60_000 });
  await m.setEnabled(true, ADMIN);
  await m.setEnabled(false, ADMIN);
  await m.setEnabled(true, ADMIN);
  assert.equal(db.row!.enabled, true);
  assert.equal(await m.isEnabled(), true);
  assert.deepEqual(db.audit.map((a) => a.action), ['MAINTENANCE_ENABLED', 'MAINTENANCE_DISABLED', 'MAINTENANCE_ENABLED']);
  assert.equal(db.audit[1].oldValue.enabled, true);
  assert.equal(db.audit[1].newValue.enabled, false);
  assert.equal(db.audit[0].adminId, ADMIN);
});

test('audit records previous and new state + admin + timestamp', async () => {
  const { db, store } = makeDb();
  await svc(store).setEnabled(true, ADMIN, 'upgrade');
  const a = db.audit[0];
  assert.equal(a.oldValue.enabled, false);
  assert.equal(a.newValue.enabled, true);
  assert.equal(a.newValue.reason, 'upgrade');
  assert.ok(a.newValue.changedAt);
  assert.equal(a.newValue.enabledBy, ADMIN);
});

test('failed write: error surfaces, state unchanged, no audit', async () => {
  const { db, store } = makeDb();
  const m = svc(store);
  db.failWrites = true;
  await assert.rejects(m.setEnabled(true, ADMIN));
  assert.equal(db.row, null);
  assert.equal(await m.isEnabled(), false);
});

test('DB read failure: fail to last known state, error is reported (not swallowed)', async () => {
  const { db, store } = makeDb();
  const errors: string[] = [];
  const m = svc(store, { onError: (msg: string) => errors.push(msg) });
  await m.setEnabled(true, ADMIN);
  db.failReads = true;
  m.invalidate();
  assert.equal(await m.isEnabled(), false); // nothing cached after invalidate → env default
  assert.equal(errors.length, 1);
  db.failReads = false;
  assert.equal(await m.isEnabled(), true);
  db.failReads = true;
  assert.equal(await m.isEnabled(), true); // last known state retained
});

test('env fallback is used only until a DB row exists', async () => {
  const { store } = makeDb();
  const m = createMaintenanceService({ store, fallbackEnabled: true, adminIds: [ADMIN], ttlMs: 0 });
  assert.equal(await m.isEnabled(), true);
  await m.setEnabled(false, ADMIN);
  assert.equal(await m.isEnabled(), false); // DB wins over env
});

test('parseState tolerates junk and legacy strings', () => {
  assert.equal(parseState(null, true).enabled, true);
  assert.equal(parseState({ enabled: 'false' }, true).enabled, false);
  assert.equal(parseState({ enabled: 'true' }, false).enabled, true);
  assert.equal(parseState({ enabled: 1 }, false).enabled, false);
});

// ─── policy: D (old callbacks) / E (old workflows) / H (no mutation path) ───

test('D: stale money-moving callbacks are blocked', () => {
  const blocked = [
    'wallet:deposit', 'deposit:USDT', 'deposit:BNB',
    'giveaway:single', 'giveaway:multiple', 'gws:USDT', 'gwm:BNB',
    'giveaway:confirm:single|USDT|10|1|', 'giveaway:cancel:abc', 'giveaway:expiry:24',
    'payout:confirm:abc', 'payout:change:abc',
    'admin', 'admin:maintenance', 'admin:users', 'admin:sweep', 'admin:broadcast',
    'some:future:action', '',
  ];
  for (const data of blocked) assert.equal(isBlockedDuringMaintenance({ type: 'callback', data }), true, data);
});

test('read-only callbacks stay available', () => {
  const allowed = [
    'main', 'wallet', 'wallet:refresh', 'wallet:history', 'history', 'account', 'help',
    'giveaway', 'giveaway:mine', 'giveaway:stats:xyz', 'wallet:check:USDT', 'wallet:copy:BNB', 'payout:cancel:abc',
  ];
  for (const data of allowed) assert.equal(isBlockedDuringMaintenance({ type: 'callback', data }), false, data);
});

test('E: old wizard/session text is blocked; idle text is ignored silently', () => {
  for (const s of ['giveaway_single_amount', 'giveaway_multi_claimers', 'redeem_code', 'awaiting_payout_address', 'awaiting_payout_confirm'])
    assert.equal(isBlockedDuringMaintenance({ type: 'text', text: '10', sessionState: s }), true, s);
  assert.equal(isBlockedDuringMaintenance({ type: 'text', text: 'hello', sessionState: null }), false);
});

test('commands: /start ok, giveaway deep link + /claim blocked', () => {
  const t = (text: string) => isBlockedDuringMaintenance({ type: 'text', text, sessionState: null });
  assert.equal(t('/start'), false);
  assert.equal(t('/start@VeyloBot'), false);
  assert.equal(t('/start giveaway_abc123'), true);
  assert.equal(t('/claim abc123'), true);
});

test('session clearing: wizards cleared, reserved claim kept', () => {
  assert.equal(shouldClearSessionOnBlock('giveaway_single_amount'), true);
  assert.equal(shouldClearSessionOnBlock('redeem_code'), true);
  assert.equal(shouldClearSessionOnBlock('awaiting_payout_address'), false);
  assert.equal(shouldClearSessionOnBlock(null), false);
});
