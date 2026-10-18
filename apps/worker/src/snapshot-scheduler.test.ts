import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { SnapshotScheduler } from './snapshot-scheduler.js';
import { OperationError } from './diagnostics.js';
import { clients } from './provider.js';
const limited = (retryAfterMs?: number) => new OperationError({ operation: 'snapshot.outright.fixtures', protocol: 'http', category: 'rate_limited', httpStatus: 429, message: 'Limitado.', retryAfterMs });
test('persistent host cooldown and exponential backoff suppress HTTP across instances/packages and survive restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adl-rate-'));
  let now = 1700000000000; let calls = 0;
  const options = { root: join(dir, 'feed'), now: () => now, random: () => 0, spacingMs: 5000, refreshMs: 300000 };
  const first = new SnapshotScheduler('https://stm-snapshot.lsports.eu', 4511, options);
  try {
    await assert.rejects(() => first.run('snapshot.outright.fixtures', async () => { calls++; throw limited(); }), e => {
      assert(e instanceof OperationError); assert.equal(e.diagnostic.retryAfterMs, 60000); assert.equal(e.diagnostic.attempts, 1); assert.equal(e.diagnostic.rateLimitSource, "supplier_http"); return true;
    });
    const second = new SnapshotScheduler('https://stm-snapshot.lsports.eu', 4510, options);
    await assert.rejects(() => second.run('snapshot.events', async () => { calls++; }), e => {
      assert(e instanceof OperationError); assert.equal(e.diagnostic.deferred, true); assert.equal(e.diagnostic.httpStatus, undefined); assert.equal(e.diagnostic.rateLimitSource, "local_host_cooldown"); assert.equal(e.diagnostic.coordinator?.packageId, 4511); assert.equal(e.diagnostic.coordinator?.operation, "snapshot.outright.fixtures"); assert.equal(e.diagnostic.coordinator?.outcome, "rate_limited"); return true;
    });
    assert.equal(calls, 1);
    now += 60000;
    await assert.rejects(() => new SnapshotScheduler('https://stm-snapshot.lsports.eu', 4511, options).run('snapshot.outright.fixtures', async () => { calls++; throw limited(); }), e => {
      assert(e instanceof OperationError); assert.equal(e.diagnostic.retryAfterMs, 120000); assert.equal(e.diagnostic.attempts, 2); return true;
    });
    now += 120000;
    assert.equal(await first.run('snapshot.outright.fixtures', async () => 'recovered'), 'recovered');
    await assert.rejects(() => first.run('snapshot.outright.fixtures', async () => assert.fail('Repeated query')), e => { assert(e instanceof OperationError); assert.equal(e.diagnostic.rateLimitSource, 'local_operation_cooldown'); return true; });
    now += 5000;
    assert.equal(await first.run('snapshot.outright.markets', async () => 'markets'), 'markets');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('official SDK preserves Retry-After seconds/date in sanitized 429 diagnostics; next operation sends no HTTP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adl-retry-after-'));
  let now = Date.now(); let calls = 0; let header = '2'; let limitedResponse = true;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {} calls++;
    res.statusCode = limitedResponse ? 429 : 200;
    res.setHeader('Content-Type', 'application/json');
    if (limitedResponse) res.setHeader('Retry-After', header);
    res.end(JSON.stringify({ Header: { HttpStatusCode: res.statusCode }, Body: [] }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const address = server.address(); assert(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    const scheduling = new SnapshotScheduler(url, 4511, { root: join(dir, 'feed'), now: () => now, spacingMs: 0, refreshMs: 0 });
    const api = clients({ lane: 'prematch', packageId: 4511, username: 'synthetic-user', password: 'synthetic-secret', hostname: 'unused', vhost: 'StmPreMatch', queue: '_4511_', port: 5672, tls: false }, { snapshotUrl: url, customersUrl: url }, scheduling);
    await assert.rejects(() => api.outrightFixtures!(), e => {
      assert(e instanceof OperationError); assert.equal(e.diagnostic.retryAfterMs, 2000); assert.equal(e.diagnostic.httpStatus, 429);
      assert(!JSON.stringify(e).includes('synthetic-secret')); return true;
    });
    await assert.rejects(() => api.outrightMarkets!()); assert.equal(calls, 1);
    now += 2000; limitedResponse = false; assert.deepEqual(await api.outrightMarkets!(), []);
    limitedResponse = true; header = new Date(Date.now() + 90000).toUTCString();
    await assert.rejects(() => api.outrightFixtures!(), e => {
      assert(e instanceof OperationError); assert(e.diagnostic.retryAfterMs! >= 88000 && e.diagnostic.retryAfterMs! <= 90000); return true;
    });
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true }); }
});

test('separate worker/diagnose processes cannot send simultaneous or duplicate snapshot requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adl-rate-process-'));
  try {
    const script = `import { SnapshotScheduler } from ${JSON.stringify(new URL('./snapshot-scheduler.ts', import.meta.url).href)};
      import { appendFile } from 'node:fs/promises';
      const scheduler = new SnapshotScheduler('https://stm-snapshot.lsports.eu', 4511, {root: ${JSON.stringify(join(dir, 'feed'))}});
      try { await scheduler.run('snapshot.outright.fixtures', async () => {
        await appendFile(${JSON.stringify(join(dir, 'requests'))}, 'request');
        await new Promise(r => setTimeout(r, 100));
      }); process.stdout.write('requested'); }
      catch (e) { if (!e.diagnostic?.deferred) throw e; process.stdout.write('deferred'); }`;
    const run = () => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd() });
    const results = await Promise.all([run(), run()]);
    assert.deepEqual(results.map(r => r.stdout).sort(), ['deferred', 'requested']);
    assert.equal((await readFile(join(dir, 'requests'), 'utf8')).trim(), 'request');
    assert.equal((await run()).stdout, 'deferred');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
