import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import amqp from 'amqplib';
import { clients as createClients } from './provider.js';
import { session } from './connected.js';
import { TradeState } from './state.js';
import { checkpoint, restore } from './persistence.js';
import { createPublisher, readConnectedFeed } from '@lsports/feed-store';
import type { PackageConfig } from './config.js';
const pkg: PackageConfig = { lane: 'prematch', packageId: 4511, username: 'synthetic-user', password: 'synthetic-secret', hostname: 'unused', vhost: 'StmPreMatch', queue: '_4511_', port: 5672, tls: false };
// Synthetic HTTP responses only; no live supplier observations or demo fallback.
const fixtures = { Id: 90, Name: 'Synthetic meeting', Type: 1, Events: [{ FixtureId: 20540377,
  OutrightFixture: { FixtureName: 'Synthetic race', Sport: { Name: 'Horse Racing' }, Status: 1,
    Participants: Array.from({ length: 9 }, (_, i) => ({ Id: i + 1, Name: `Test runner ${i + 1}`, Position: String(i + 1), IsActive: 1, Form: '123' })) } }] };
const markets = { Id: 90, Events: [{ FixtureId: 20540377, Markets: [{ Id: 160, Name: 'Race Winner', Status: 1,
  Bets: [{ Id: '9223372036854775807', ParticipantId: 1, Status: 1, Price: '3.25' }] }] }] };
test('official SDK initial outright fixture/market snapshots restore an empty installation without new AMQP messages, persist, and survive restart', { timeout: 10000 }, async () => {
  const routes: string[] = [];
  let fixtureBody: unknown = fixtures;
  let marketBody: unknown = markets;
  let marketStatus = 200;
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const request = JSON.parse(text);
    assert.equal(req.method, 'POST');
    assert.equal(request.packageId, 4511);
    assert.equal(request.username, pkg.username);
    assert.equal(request.password, pkg.password);
    assert.deepEqual(Object.keys(request).sort(), ['packageId', 'password', 'username']); // no invented filters or unsubscribe
    routes.push(req.url!);
    const body = req.url === '/Prematch/GetOutrightFixture' ? fixtureBody : req.url === '/Prematch/GetOutrightFixtureMarkets' ? marketBody : [];
    res.statusCode = req.url === '/Prematch/GetOutrightFixtureMarkets' ? marketStatus : 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ Header: { HttpStatusCode: res.statusCode }, Body: body }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const dir = await mkdtemp(join(tmpdir(), 'adl-outright-api-'));
  try {
    const address = server.address(); assert(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    const api = clients(pkg, { snapshotUrl: url, customersUrl: url });
    const state = new TradeState();
    const channel = Object.assign(new EventEmitter(), { async prefetch() {}, async consume() { return { consumerTag: 'test' }; }, ack() { assert.fail('No deliveries needed'); } });
    const connection = Object.assign(new EventEmitter(), { async createChannel() { return channel; }, async close() { connection.emit('close'); } });
    const abort = new AbortController();
    const path = join(dir, 'feed.json'); const publish = createPublisher(path);
    await session(pkg, { packages: [pkg], snapshotUrl: url, customersUrl: url, recoveryMs: 300000, staleMs: 90000 }, state,
      async () => { await publish(state.feed(), checkpoint(state)); if (state.connections.prematch.phase === 'connected') abort.abort(); },
      abort.signal, { connect: (async () => connection) as unknown as typeof amqp.connect,
        clientFactory: () => ({ ...api, async startDistribution() {}, async catalog() { return []; } }) });
    assert.deepEqual(routes, ['/Prematch/GetEvents', '/Prematch/GetOutrightFixture', '/Prematch/GetOutrightFixtureMarkets']);
    assert.equal(state.connections.prematch.outrightRecovery?.status, 'ok');
    const race = state.feed().events[0];
    assert.equal(race.participants?.length, 9);
    assert.equal(race.participants?.[8].form, '123');
    assert.equal(race.selections[0].odds, 3.25);
    assert.equal(race.markets?.[0].status, 1); // snapshot DTO drops status: official Market conversion must retain it
    assert(race.selections[0].id.endsWith(':9223372036854775807'));
    assert.equal(race.marketDiagnostic?.snapshotMarketUpdates, 1);
    assert.deepEqual(race.marketDiagnostic?.messagesByType, {}); // snapshots are not AMQP deliveries
    const restarted = new TradeState(); await restore(restarted, path);
    restarted.replace('prematch', [], Date.now());
    assert.equal(restarted.feed().events[0].participants?.length, 9);
    assert.equal(restarted.feed().events[0].selections[0].odds, 3.25);
    assert.equal((await readConnectedFeed(path)).events[0].marketDiagnostic?.fixtureId, 20540377);
    fixtureBody = [fixtures, { Id: 91, Events: [] }];
    assert.equal((await api.outrightFixtures!()).length, 1);
    marketBody = [markets]; assert.equal((await api.outrightMarkets!()).length, 1);
    fixtureBody = []; assert.deepEqual(await api.outrightFixtures!(), []);
    fixtureBody = { Id: 90 }; await assert.rejects(() => api.outrightFixtures!());
    marketBody = []; assert.deepEqual(await api.outrightMarkets!(), []);
    marketStatus = 403;
    await assert.rejects(() => api.outrightMarkets!(), error => {
      const output = JSON.stringify(error);
      assert(output.includes('snapshot.outright.markets')); assert(output.includes('403'));
      assert(!output.includes(pkg.password)); return true;
    });
    const inplay = clients({ ...pkg, lane: 'inplay', packageId: 4510 }, { snapshotUrl: url, customersUrl: url });
    assert.equal(inplay.outrightFixtures, undefined); assert.equal(inplay.outrightMarkets, undefined);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true }); }
});

for (const failure of [false, true]) {
  test(`empty/denied outright recovery preserves durable rows and football (denied=${failure})`, { timeout: 8000 }, async () => {
    const { OperationError } = await import('./diagnostics.js');
    const state = new TradeState();
    state.apply('prematch', [{ fixtureId: 20540377, outright: { competitionId: 90, fixture: { sport: { name: 'Horse Racing' }, status: 1,
      participants: [{ id: 1, name: 'Synthetic persisted participant' }] } }, markets: [{ id: 160, status: 1,
      bets: [{ id: '1', price: '3.25', status: 1, isChanged: 0 }] }] }], Date.now() - 10000);
    state.set('inplay', { phase: 'connected' });
    const channel = Object.assign(new EventEmitter(), { async prefetch() {}, async consume() { return { consumerTag: 'test' }; } });
    const connection = Object.assign(new EventEmitter(), { async createChannel() { return channel; }, async close() { connection.emit('close'); } });
    const abort = new AbortController();
    let observedHealth = '';
    await session(pkg, { packages: [pkg], snapshotUrl: 'https://stm-snapshot.lsports.eu', customersUrl: 'https://stm-api.lsports.eu', recoveryMs: 300000, staleMs: 90000 }, state,
      async () => { if (state.connections.prematch.phase === 'connected') { observedHealth = state.feed().health!; abort.abort(); } }, abort.signal,
      { connect: (async () => connection) as unknown as typeof amqp.connect, clientFactory: () => ({
        async startDistribution() {}, async distributionStatus() { return { isDistributionOn: true, consumers: [], numberMessagesInQueue: 0, messagesPerSecond: 0 }; },
        async catalog() { return []; }, async snapshot() { return [{ fixtureId: 100, fixture: { sport: { name: 'Football' }, status: 1 } }]; },
        async outrightFixtures() { if (failure) throw new OperationError({ operation: 'snapshot.outright.fixtures', protocol: 'http', category: 'permission_denied', httpStatus: 403, message: 'Acceso denegado.' }); return []; },
        async outrightMarkets() { return []; },
      }) });
    assert.equal(state.feed().events.find(e => e.kind === 'outright')?.selections[0].odds, 3.25);
    assert.equal(state.feed().events.find(e => e.sport === 'futbol')?.id, 'prematch:100');
    assert.equal(state.connections.prematch.outrightRecovery?.status, failure ? 'partial' : 'ok');
    assert.equal(observedHealth, failure ? 'degraded' : 'ok');
    if (failure) assert.equal(state.connections.prematch.outrightRecovery?.diagnostics?.[0].httpStatus, 403);
  });
}

// Protocol tests isolate scheduling; cross-process coordination is exercised separately.
const clients = (pkg: Parameters<typeof createClients>[0], urls: Parameters<typeof createClients>[1]) =>
  createClients(pkg, urls, { run: (_operation, action) => action() });

test('429 keeps checkpoint rows and AMQP message processing active without waiting for Retry-After or closing feed', { timeout: 8000 }, async () => {
  const { OperationError } = await import('./diagnostics.js');
  const state = new TradeState();
  state.apply('prematch', [{ fixtureId: 20540377, outright: { competitionId: 90, fixture: { sport: { name: 'Horse Racing' }, status: 1,
    participants: [{ id: 1, name: 'Persisted runner' }] } }, markets: [{ id: 160, status: 1, bets: [{ id: '1', price: '3.25', status: 1, isChanged: 0 }] }] }], Date.now() - 10000);
  let callback: (message: import('amqplib').ConsumeMessage) => void = () => {};
  let acks = 0;
  const channel = Object.assign(new EventEmitter(), { async prefetch() {}, async consume(_queue: string, cb: typeof callback) { callback = cb; return { consumerTag: 'test' }; }, ack() { acks++; } });
  const connection = Object.assign(new EventEmitter(), { async createChannel() { return channel; }, async close() { connection.emit('close'); } });
  const abort = new AbortController();
  const limit = (operation: 'snapshot.events' | 'snapshot.outright.fixtures' | 'snapshot.outright.markets') => new OperationError({ operation, protocol: 'http', category: 'rate_limited', httpStatus: 429, retryAfterMs: 3600000, retryAt: new Date(Date.now() + 3600000).toISOString(), message: 'Esperando al proveedor.' });
  await session(pkg, { packages: [pkg], snapshotUrl: 'https://stm-snapshot.lsports.eu', customersUrl: 'https://stm-api.lsports.eu', recoveryMs: 10000, staleMs: 90000 }, state,
    async () => {
      if (state.connections.prematch.phase === 'connected') {
        assert.equal(acks, 1);
        assert.equal(state.connections.prematch.outrightRecovery?.status, 'rate_limited');
        assert.equal(state.connections.prematch.diagnostic?.httpStatus, 429);
        assert.equal(state.feed().events[0].selections[0].odds, 3.25);
        abort.abort();
      }
    }, abort.signal, { connect: (async () => connection) as unknown as typeof amqp.connect, clientFactory: () => ({
      async startDistribution() {}, async distributionStatus() { return { isDistributionOn: true, consumers: [], numberMessagesInQueue: 0, messagesPerSecond: 0 }; }, async catalog() { return []; },
      async snapshot() {
        callback({ content: Buffer.from(JSON.stringify({ Header: { Type: 31 }, Body: {} })), properties: {}, fields: {} } as import('amqplib').ConsumeMessage);
        throw limit('snapshot.events');
      },
      async outrightFixtures() { throw limit('snapshot.outright.fixtures'); },
      async outrightMarkets() { throw limit('snapshot.outright.markets'); },
    }) });
  assert.equal(state.feed().events[0].participants?.length, 1);
});
