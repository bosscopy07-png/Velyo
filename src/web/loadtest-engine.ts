import { randomBytes } from 'node:crypto';

/**
 * Traffic simulator for a giveaway claim page. Each virtual visitor:
 *   phase A: opens the page + loads the giveaway + registers the visit (all at once, like a browser)
 *   phase B: after EVERYONE has loaded, all submit a random wallet to get a claim code at the same instant
 *   phase C: the codes that were issued are verified, and the giveaway is re-read
 * Pure HTTP (global fetch) — no database access — so it exercises the same path real visitors use.
 */
export interface LoadTestOptions {
  baseUrl: string;
  slug: string;
  users: number;
  secret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Max simultaneous HTTP connections the simulator opens (protects the server it runs inside). */
  concurrency?: number;
  /** Stop the test if this process's memory passes this many MB. */
  memoryGuardMb?: number;
  rssMb?: () => number;
}

export interface EndpointStats { count: number; statuses: Record<string, number>; p50: number; p95: number; p99: number; max: number }
export type CheckResult = 'pass' | 'warn' | 'fail';
export interface LoadTestReport {
  users: number;
  durationMs: number;
  capacity: number | null;
  endpoints: Record<string, EndpointStats>;
  claim: { issued: number; full: number; busy: number; rateLimited: number; otherRejected: number; serverErrors: number; networkErrors: number };
  errorSamples: { message: string; count: number }[];
  checks: { name: string; result: CheckResult; detail: string }[];
  verdict: 'PASS' | 'WARN' | 'FAIL';
}

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : 0);

export async function runLoadTest(o: LoadTestOptions): Promise<LoadTestReport> {
  const f = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 20_000;
  const cap = o.concurrency ?? 150;
  const rssMb = o.rssMb ?? (() => process.memoryUsage().rss / 1048576);
  const guardMb = o.memoryGuardMb ?? 400;
  let aborted: number | null = null;
  let active = 0, peak = 0;
  const waiters: (() => void)[] = [];
  const guard = setInterval(() => { const m = rssMb(); if (aborted === null && m > guardMb) aborted = Math.round(m); }, 100);
  const take = async () => { if (active >= cap) await new Promise<void>((r) => waiters.push(r)); active++; peak = Math.max(peak, active); };
  const give = () => { active--; waiters.shift()?.(); };
  const lat: Record<string, number[]> = {};
  const statuses: Record<string, Record<string, number>> = {};
  const errors = new Map<string, number>();
  const claim = { issued: 0, full: 0, busy: 0, rateLimited: 0, otherRejected: 0, serverErrors: 0, networkErrors: 0 };
  const note = (m: string) => errors.set(m, (errors.get(m) ?? 0) + 1);

  async function call(name: string, path: string, headers: Record<string, string>, method = 'GET', body?: unknown) {
    await take();
    if (aborted !== null) { give(); return { status: 0, json: null }; }
    const t0 = performance.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await f(o.baseUrl + path, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
      let json: any = null;
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('json')) { try { json = await res.json(); } catch { /* ignore */ } } else { await res.arrayBuffer().catch(() => {}); }
      (lat[name] ??= []).push(performance.now() - t0);
      const sc = (statuses[name] ??= {}); sc[res.status] = (sc[res.status] ?? 0) + 1;
      if (res.status >= 500 && !(name === 'claim' && res.status === 503)) { note(`${name}: HTTP ${res.status}`); }
      return { status: res.status, json };
    } catch (err) {
      (lat[name] ??= []).push(performance.now() - t0);
      const e = err as { name?: string; cause?: { code?: string } };
      const why = e.name === 'AbortError' ? `timeout after ${Math.round(timeoutMs / 1000)}s` : e.cause?.code ?? e.name ?? 'network error';
      note(`${name}: ${why}`);
      (statuses[name] ??= {})['network'] = ((statuses[name] ??= {})['network'] ?? 0) + 1;
      return { status: 0, json: null };
    } finally {
      clearTimeout(timer);
      give();
    }
  }

  const users = Array.from({ length: o.users }, (_, i) => ({
    headers: {
      'x-veylo-loadtest': o.secret,
      'x-veylo-test-ip': `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${(i & 255) || 1}`,
      'x-veylo-device': randomBytes(18).toString('base64url'),
      'user-agent': 'VeyloLoadTest/1.0',
    } as Record<string, string>,
    address: '0x' + randomBytes(20).toString('hex'),
    code: null as string | null,
  }));

  const started = performance.now();
  const probe = await call('giveaway', `/api/v1/giveaways/${o.slug}`, users[0].headers);
  const capacity: number | null = probe.json?.giveaway?.claimable ? Number(probe.json.giveaway.availableSlots) : probe.json?.giveaway ? 0 : null;

  // Phase A — everyone loads the page at once
  await Promise.all(users.map((u) => Promise.all([
    call('page', `/g/${o.slug}`, u.headers),
    call('giveaway', `/api/v1/giveaways/${o.slug}`, u.headers),
    call('view', `/api/v1/giveaways/${o.slug}/view`, u.headers, 'POST', {}),
  ])));

  // Phase B — everyone asks for a code at the same instant
  await Promise.all(users.map(async (u) => {
    const r = await call('claim', `/api/v1/giveaways/${o.slug}/claim-code`, u.headers, 'POST', { address: u.address });
    if (r.status === 200 && r.json?.code) { claim.issued++; u.code = r.json.code; }
    else if (r.status === 409 && r.json?.error === 'FULL') claim.full++;
    else if (r.status === 503) { claim.busy++; }
    else if (r.status === 429) claim.rateLimited++;
    else if (r.status >= 500) claim.serverErrors++;
    else if (r.status === 0) claim.networkErrors++;
    else { claim.otherRejected++; note(`claim: unexpected ${r.status} ${r.json?.error ?? ''}`.trim()); }
  }));

  // Phase C — verify issued codes + final state
  const issued = users.filter((u) => u.code);
  const verified = await Promise.all(issued.map((u) => call('verify', '/api/v1/code-status', u.headers, 'POST', { code: u.code })));
  const verifiedActive = verified.filter((v) => v.json?.state === 'ACTIVE').length;
  const readAvail = async () => {
    const r = await call('giveaway', `/api/v1/giveaways/${o.slug}`, users[0].headers);
    return r.json?.giveaway ? Number(r.json.giveaway.availableSlots) : null;
  };
  let finalAvail = await readAvail();
  const expectedAvail = capacity == null ? null : Math.max(0, capacity - claim.issued);
  if (expectedAvail != null && finalAvail !== expectedAvail) { // the page may cache for a moment: look once more
    await new Promise((r) => setTimeout(r, 2500));
    finalAvail = await readAvail();
  }
  clearInterval(guard);
  const durationMs = Math.round(performance.now() - started);

  const endpoints: Record<string, EndpointStats> = {};
  for (const [name, arr] of Object.entries(lat)) {
    const s = [...arr].sort((a, b) => a - b);
    endpoints[name] = { count: s.length, statuses: statuses[name] ?? {}, p50: Math.round(pct(s, 0.5)), p95: Math.round(pct(s, 0.95)), p99: Math.round(pct(s, 0.99)), max: Math.round(s[s.length - 1] ?? 0) };
  }

  const checks: LoadTestReport['checks'] = [];
  const add = (name: string, result: CheckResult, detail: string) => checks.push({ name, result, detail });
  if (capacity == null) add('Giveaway reachable', 'fail', 'Could not read the giveaway — check the link.');
  else if (capacity === 0) add('Giveaway has free slots', 'fail', 'The giveaway is not open for claims, so nothing could be tested.');
  else {
    add('Never issued more codes than slots', claim.issued <= capacity ? 'pass' : 'fail', `${claim.issued} codes for ${capacity} slots`);
    const expected = Math.min(capacity, o.users);
    add('Every free slot was filled', claim.issued === expected ? 'pass' : claim.busy > 0 || claim.serverErrors > 0 || claim.networkErrors > 0 ? 'fail' : 'warn', `${claim.issued} of ${expected} expected codes issued`);
  }
  const hardErrors = claim.serverErrors + claim.networkErrors + Object.entries(statuses).reduce((n, [k, v]) => n + (k === 'claim' ? 0 : (v['network'] ?? 0)), 0);
  add('No crashes or timeouts', hardErrors === 0 && !([...errors.keys()].some((k) => /HTTP 5|timeout|ECONN/.test(k))) ? 'pass' : 'fail', hardErrors === 0 && errors.size === 0 ? 'zero errors' : `${errors.size} kinds of error (see below)`);
  if (aborted !== null) add('Test ran to the end', 'fail', `Stopped early: server memory reached ${aborted} MB. Use fewer visitors, or a bigger server.`);
  add('No "busy" replies', claim.busy === 0 ? 'pass' : 'fail', claim.busy === 0 ? 'none' : `${claim.busy} visitors were told "busy, try again" — this should never happen`);
  add('Rate limiter did not interfere', claim.rateLimited === 0 ? 'pass' : 'warn', claim.rateLimited === 0 ? 'none blocked' : `${claim.rateLimited} test visitors were rate-limited (results may be less reliable)`);
  if (issued.length) add('Issued codes are valid', verifiedActive === issued.length ? 'pass' : 'fail', `${verifiedActive}/${issued.length} verified ACTIVE`);
  const page = endpoints.page, cl = endpoints.claim;
  if (page) add('Page loads quickly (p95 ≤ 3s)', page.p95 <= 3000 ? 'pass' : 'warn', `p95 ${page.p95} ms, slowest ${page.max} ms`);
  if (cl) add('Code request is quick (p95 ≤ 5s)', cl.p95 <= 5000 ? 'pass' : 'warn', `p95 ${cl.p95} ms, slowest ${cl.max} ms`);
  if (finalAvail != null && capacity) add('Slots show as taken afterwards', finalAvail === Math.max(0, capacity - claim.issued) ? 'pass' : 'warn', `${finalAvail} slots left on the page`);

  const verdict = checks.some((c) => c.result === 'fail') ? 'FAIL' : checks.some((c) => c.result === 'warn') ? 'WARN' : 'PASS';
  return {
    users: o.users, durationMs, capacity, endpoints, claim, verdict, checks,
    errorSamples: [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([message, count]) => ({ message, count })),
  };
}

export function formatLoadTest(r: LoadTestReport): string {
  const icon = { pass: '✅', warn: '⚠️', fail: '❌' } as const;
  const ep = (n: string, label: string) => (r.endpoints[n] ? `${label}: median ${r.endpoints[n].p50} ms · p95 ${r.endpoints[n].p95} ms · slowest ${r.endpoints[n].max} ms` : null);
  return [
    `<b>TRAFFIC TEST — ${r.verdict === 'PASS' ? '✅ PASSED' : r.verdict === 'WARN' ? '⚠️ PASSED WITH WARNINGS' : '❌ FAILED'}</b>`,
    `${r.users} visitors at once · ${(r.durationMs / 1000).toFixed(1)}s total · ${r.capacity ?? '?'} slots`,
    '',
    `Codes issued: <b>${r.claim.issued}</b> · "full" replies: ${r.claim.full} · busy: ${r.claim.busy} · rate-limited: ${r.claim.rateLimited}`,
    '',
    ep('page', 'Page load'), ep('giveaway', 'Giveaway data'), ep('claim', 'Get code'),
    '',
    ...r.checks.map((c) => `${icon[c.result]} ${c.name} — ${c.detail}`),
    '',
    '<i>Note: the test runs from inside your own server, so speeds shown are a little slower than real visitors would see.</i>',
    '',
    r.errorSamples.length ? '<b>Errors seen:</b>\n' + r.errorSamples.map((e) => `• ${e.message} ×${e.count}`).join('\n') : 'No errors were seen.',
  ].filter((x) => x !== null).join('\n');
}
  
