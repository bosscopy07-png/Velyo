import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runLoadTest, formatLoadTest } from '../src/web/loadtest-engine';
import { parseTestInput } from '../src/admin/loadtest-parse';

/** A stand-in for the website with switchable faults, so we can prove the tester catches them. */
function fakeSite(o: { capacity: number; overissue?: boolean; failEvery?: number; missing?: boolean; delayMs?: number }) {
  let issued = 0, n = 0;
  const codes = new Set<string>();
  const seenIps = new Set<string>();
  const server = http.createServer((req, res) => {
    const send = (c: number, b: unknown, type = 'application/json') => { res.writeHead(c, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(b) : String(b)); };
    let body = ''; req.on('data', (d) => (body += d));
    req.on('end', () => setTimeout(() => {
      seenIps.add(String(req.headers['x-veylo-test-ip']));
      const url = req.url ?? '';
      if (o.missing && url.includes('/api/')) return send(404, { error: 'NOT_FOUND' });
      if (req.method === 'GET' && url.startsWith('/g/')) return send(200, '<html>page</html>', 'text/html');
      if (req.method === 'GET' && url.startsWith('/api/v1/giveaways/')) return send(200, { giveaway: { claimable: issued < o.capacity, availableSlots: Math.max(0, o.capacity - issued) } });
      if (url.endsWith('/view')) return send(200, { ok: true });
      if (url.endsWith('/claim-code')) {
        n++;
        if (o.failEvery && n % o.failEvery === 0) return send(500, { error: 'SERVER_ERROR' });
        if (!/^0x[0-9a-f]{40}$/.test(JSON.parse(body || '{}').address ?? '')) return send(400, { error: 'INVALID_ADDRESS' });
        if (issued >= o.capacity && !o.overissue) return send(409, { error: 'FULL', mayReopen: true });
        issued++; const code = `VEYLO-${String(issued).padStart(4, '0')}-AAAA-BBBB`; codes.add(code);
        return send(200, { code });
      }
      if (url.endsWith('/code-status')) return send(200, { state: codes.has(JSON.parse(body).code) ? 'ACTIVE' : 'INVALID' });
      send(404, {});
    }, o.delayMs ?? 0));
  });
  return new Promise<{ url: string; close: () => void; ips: Set<string> }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close(), ips: seenIps })));
}

test('healthy site: 1,000 visitors / 20 slots → PASS, exactly 20 codes, 980 polite "full" replies', async () => {
  const s = await fakeSite({ capacity: 20, delayMs: 5 });
  const r = await runLoadTest({ baseUrl: s.url, slug: 'abc123', users: 1000, secret: 'x'.repeat(30) });
  s.close();
  // The simulator and the fake site share one CPU here, so latency warnings are legitimate; correctness must be perfect.
  assert.notEqual(r.verdict, 'FAIL', JSON.stringify(r.checks.filter((c) => c.result === 'fail')));
  assert.ok(r.checks.filter((c) => c.result !== 'pass').every((c) => /quickly|quick/.test(c.name)), JSON.stringify(r.checks.filter((c) => c.result !== 'pass')));
  assert.equal(r.claim.issued, 20); assert.equal(r.claim.full, 980);
  assert.equal(r.errorSamples.length, 0);
  assert.ok(s.ips.size > 900, 'each simulated visitor presented its own virtual IP');
  assert.ok(r.endpoints.page.count === 1000 && r.endpoints.claim.count === 1000);
});

test('detects over-issuing (more codes than slots) as a FAIL', async () => {
  const s = await fakeSite({ capacity: 20, overissue: true });
  const r = await runLoadTest({ baseUrl: s.url, slug: 'abc123', users: 100, secret: 'x'.repeat(30) });
  s.close();
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r.checks.some((c) => c.name.startsWith('Never issued more') && c.result === 'fail'));
});

test('detects server errors and lists them', async () => {
  const s = await fakeSite({ capacity: 20, failEvery: 10 });
  const r = await runLoadTest({ baseUrl: s.url, slug: 'abc123', users: 200, secret: 'x'.repeat(30) });
  s.close();
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r.errorSamples.some((e) => /claim: HTTP 500/.test(e.message)));
  assert.ok(formatLoadTest(r).includes('FAILED'));
});

test('unreachable giveaway and dead server are reported, not hidden', async () => {
  const s = await fakeSite({ capacity: 20, missing: true });
  const r = await runLoadTest({ baseUrl: s.url, slug: 'nope12', users: 20, secret: 'x'.repeat(30) });
  s.close();
  assert.equal(r.verdict, 'FAIL');
  const dead = await runLoadTest({ baseUrl: 'http://127.0.0.1:1', slug: 'abc123', users: 20, secret: 'x'.repeat(30), timeoutMs: 2000 });
  assert.equal(dead.verdict, 'FAIL');
  assert.ok(dead.errorSamples.length > 0);
});

test('report fits in one Telegram message', async () => {
  const s = await fakeSite({ capacity: 20 });
  const r = await runLoadTest({ baseUrl: s.url, slug: 'abc123', users: 300, secret: 'x'.repeat(30) });
  s.close();
  const txt = formatLoadTest(r);
  assert.ok(txt.length < 3500, String(txt.length)); assert.match(txt, /PASSED|WARNINGS/); assert.match(txt, /Codes issued: <b>20<\/b>/);
});

test('link parser: slug, default 50 users, clamps 10..2000', () => {
  assert.deepEqual(parseTestInput('https://veyloapp.com.ng/g/k3mcypk2cr'), { slug: 'k3mcypk2cr', users: 50 });
  assert.deepEqual(parseTestInput('https://veyloapp.com.ng/g/k3mcypk2cr 1000'), { slug: 'k3mcypk2cr', users: 1000 });
  assert.equal(parseTestInput('https://x.ng/g/k3mcypk2cr 99999')!.users, 2000);
  assert.equal(parseTestInput('https://x.ng/g/k3mcypk2cr 3')!.users, 10);
  assert.equal(parseTestInput('hello'), null);
});
      
