/** Isolated integration: loopback HTTP + fake AMQP transport, real recovery/state/durable files. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { session, coalescedPersistence } from './connected.js';
import { fullSnapshot } from './full-snapshot.js';
import { TradeState } from './state.js';
import { checkpoint, persistRegularCheckpoint, restore } from './persistence.js';
import { createPublisher } from '@lsports/feed-store';
import type { clients } from './provider.js';
import type { ConsumeMessage } from 'amqplib';
test('offline recovery: bounded full download, cancel during validation/application, restore, replay and eligible-only release', { timeout: 600000 }, async () => {
    const volume = Number(process.env.ADL_OFFLINE_SNAPSHOT_BYTES || 8 * 1024 * 1024), count = volume > 100 * 1024 * 1024 ? 6000 : 100;
    if (process.env.ADL_OFFLINE_REQUIRE_4G === '1')
        assert.equal(Number(await readFile('/sys/fs/cgroup/memory.max', 'utf8')), 4294967296);
    assert.ok(volume <= 516000000 && volume >= 1024 * 1024);
    const root = await mkdtemp(join(tmpdir(), 'adl-offline-recovery-')), path = join(root, 'feed.json'), document = join(root, 'synthetic.private.json');
    const version = new Date(Date.now() - 10000).toISOString();
    const raw = (id: number) => ({ FixtureId: id, Fixture: { Status: id === 2 ? 3 : 1, StartDate: new Date(Date.now() + 86400000).toISOString(), LastUpdate: version, Sport: { Id: 6046, Name: 'Football' }, Participants: [{ Id: 1, Position: '1', Name: 'A' }, { Id: 2, Position: '2', Name: 'B' }] }, Markets: id === 6 || id === 8 ? null : Array.from({ length: 4 }, (_, m) => ({ Id: m + 1, Name: 'Mercado ' + m, Status: id === 3 ? 2 : 1, LastUpdate: version, Bets: id === 7 ? null : Array.from({ length: 4 }, (_, b) => ({ Id: String(b + 1), Name: 'Selección ' + b, Price: id === 5 ? undefined : '2.10', Status: id === 4 ? 2 : 1, IsChanged: 1, LastUpdate: version })) })), Padding: '' });
    const fd = await open(document, 'wx', 0o600);
    let written = 0;
    const write = async (s: string) => { await fd.write(s); written += Buffer.byteLength(s); };
    await write('{"Header":{"HttpStatusCode":200},"Body":[');
    for (let i = 1; i <= count; i++) {
        const row = raw(i), base = JSON.stringify(row), remaining = count - i + 1;
        row.Padding = 'x'.repeat(Math.max(0, Math.floor((volume - written - 2) / remaining) - Buffer.byteLength(base) - (i > 1 ? 1 : 0)));
        await write((i > 1 ? ',' : '') + JSON.stringify(row));
    }
    await write(']}');
    await fd.close();
    assert.equal(written, volume);
    let downloads = 0, distributionOn = false, stopCalls = 0;
    const server = createServer(async (req, res) => { assert.equal(req.url, '/Prematch/GetEvents'); const chunks = []; for await (const b of req)
        chunks.push(b); const body = JSON.parse(Buffer.concat(chunks).toString()); assert.deepEqual(Object.keys(body).sort(), ['packageId', 'password', 'username']); downloads++; res.setHeader('Content-Type', 'application/json'); try {
        await pipeline(createReadStream(document), res);
    }
    catch { } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + (server.address() as {
        port: number;
    }).port;
    let state = new TradeState(), writes = 0, acks = 0, nacks = 0, ackProofs = 0, stableSelections = 0;
    let stablePhase = false, pendingAcked = 0;
    const pkg = { lane: 'prematch' as const, packageId: 4511, username: 'synthetic-only', password: 'not-a-credential', hostname: 'unused', vhost: 'unused', queue: 'isolated', port: 5672, tls: false };
    // Historical disk-only prices must never become current if snapshot omits/rejects their quote.
    state.apply('prematch', [8, 9].map(fixtureId => ({ fixtureId, fixture: { status: 1, sport: { name: 'Football' } }, markets: [{ id: 1, status: 1, bets: [{ id: '1', price: '4.0', status: 1 }] }] })), Date.now() + 1000);
    const publish = createPublisher(path);
    const save = coalescedPersistence(async () => {
        const feed = state.feed(), { regular, ...saved } = checkpoint(state);
        if (state.connections.prematch.phase !== 'connected')
            assert.ok(feed.events.every(e => e.markets?.every(m => m.selections.every(s => !s.available))), 'incomplete recovery released odds');
        await persistRegularCheckpoint(path, regular);
        await publish(feed, { ...saved, regularExternal: true });
        writes++;
        if (stablePhase && state.connections.prematch.phase === 'connected') {
            const rows = feed.events;
            assert.equal(rows.length, count);
            assert.equal(new Set(rows.map(e => e.id)).size, count);
            const event = (id: number) => rows.find(e => e.id === 'prematch:' + id)!;
            assert.equal(event(1).markets![0].selections[0].odds, 3.2);
            for (const id of [2, 3, 4, 5, 8])
                assert.ok(event(id).markets!.every(m => m.selections.every(s => !s.available)), `ineligible ${id} released`);
            const stale = event(9).markets![0].selections.find(s => s.id.endsWith(':1'))!;
            assert.equal(stale.available, false);
            assert.equal(stale.odds, 4);
            for (const id of [6, 7])
                assert.equal(event(id).markets?.flatMap(m => m.selections).length || 0, 0);
            stableSelections = rows.flatMap(e => e.markets || []).flatMap(m => m.selections).filter(s => s.available).length;
            assert.ok(stableSelections > 0);
        }
    });
    const liveTime = Date.now() + 2000;
    const live = { content: Buffer.from(JSON.stringify({ Header: { Type: 3, MsgGuid: 'offline-live-one', ServerTimestamp: liveTime }, Body: { Events: [{ FixtureId: 1, Markets: [{ Id: 1, Status: 1, Bets: [{ Id: '1', Price: '2.80', Status: 1 }] }] }] } })), properties: { headers: {} }, fields: { redelivered: false } } as ConsumeMessage;
    const pending = { ...live, content: Buffer.from(JSON.stringify({ Header: { Type: 3, MsgGuid: 'offline-unacked-redelivery', ServerTimestamp: liveTime + 4000 }, Body: { Events: [{ FixtureId: 1, Markets: [{ Id: 1, Status: 1, Bets: [{ Id: '1', Price: '3.20', Status: 1 }] }] }] } })), fields: { redelivered: true } } as ConsumeMessage;
    const phases = [];
    let timer: ReturnType<typeof setInterval> | undefined, background: Promise<void> | undefined;
    try {
        await save();
        state = new TradeState();
        await restore(state, path);
        for (const mode of ['cancel_validate', 'cancel_apply', 'stable'] as const) {
            stablePhase = mode === 'stable';
            const abort = new AbortController();
            let delivery: (m: ConsumeMessage) => void = () => { }, triggered = false, delivered = false, baseline = false;
            const channel = Object.assign(new EventEmitter(), { async prefetch(n: number) { assert.equal(n, 100); }, async consume(_q: string, cb: typeof delivery, opts: {
                    exclusive: boolean;
                }) { assert.equal(distributionOn, true); assert.equal(opts.exclusive, true); delivery = cb; return { consumerTag: 'offline' }; }, ack(msg: ConsumeMessage) { const expected = JSON.parse(msg.content.toString()); const persisted = JSON.parse(requireRead(path + '.regular-checkpoint.json', 'utf8')); const row = persisted.regular.find((r: any) => r.fixtureId === 1); assert.ok(Number(row.markets[0][1].bets[0].price) >= Number(expected.Body.Events[0].Markets[0].Bets[0].Price)); if (expected.Header.MsgGuid === 'offline-unacked-redelivery')
                    pendingAcked++; const projection = JSON.parse(requireRead(path, 'utf8')); const published = projection.events.find((e: any) => e.id === 'prematch:1'); if(published)assert.ok(published.markets[0].selections[0].odds >= Number(expected.Body.Events[0].Markets[0].Bets[0].Price));else assert.equal(row.fixture,undefined,'metadata-less market state is durable privately, not invented publicly'); assert.equal(projection.workerCheckpoint.regularExternal, true); ackProofs++; acks++; }, nack() { nacks++; } });
            const connection = Object.assign(new EventEmitter(), { async createChannel() { return channel; }, async close() { connection.emit('close'); } });
            const disconnect = () => { triggered = true; connection.emit('error', Object.assign(Error('ISOLATED CONNECTION_FORCED'), { code: 320 })); };
            const api: ReturnType<typeof clients> = { async startDistribution() { distributionOn = true; }, async stopDistribution() { distributionOn = false; stopCalls++; }, async distributionStatus() { return { isDistributionOn: distributionOn, consumers: [], numberMessagesInQueue: 0, messagesPerSecond: 0 }; }, async snapshot() { assert.fail('spooled recovery required'); }, async catalog() { return []; }, async snapshotFull(sink) { return fullSnapshot({ url, credentials: { packageId: 4511, username: 'synthetic-only', password: 'not-a-credential' }, directory: root, ...sink, progress: p => { sink.progress?.(p); if (!delivered && p.stage === 'validate') {
                        delivered = true;
                        delivery(live);
                        delivery(live);
                        if (mode === 'stable') {
                            delivery(pending);
                            delivery(pending);
                        }
                    } if (!triggered && mode === 'cancel_validate' && p.validatedRows >= 100 && p.stage === 'validate')
                        disconnect(); if (!triggered && mode === 'cancel_apply' && p.appliedRows >= 100 && p.stage === 'apply') {
                        delivery(pending);
                        disconnect();
                    } } }); } };
            const durableSave = async () => { await save(); if (stablePhase && state.connections.prematch.phase === 'connected') {
                baseline = true;
                abort.abort();
            } };
            timer = setInterval(() => { if (!background)
                background = save().finally(() => { background = undefined; }); }, 5000);
            let failed = false;
            try {
                await session(pkg, { packages: [pkg], staleMs: 90000, recoveryMs: 300000, snapshotUrl: url, customersUrl: url }, state, durableSave, abort.signal, { clientFactory: () => api, connect: (async () => connection) as any });
            }
            catch (error) {
                failed = true;
                if (mode === 'stable'||!triggered)
                    throw error;
                assert.equal(triggered, true);
            }
            finally {
                clearInterval(timer);
                if (background)
                    await background;
            }
            if (mode !== 'stable') {
                assert.equal(failed, true);
                assert.equal(state.connections.prematch.lastSnapshotAt, undefined);
                assert.ok(state.feed().events.every(e => e.markets?.every(m => m.selections.every(s => !s.available))));
            }
            else {
                assert.equal(baseline, true);
                assert.equal(pendingAcked, 2);
            }
            if (mode === 'cancel_apply')
                assert.equal(pendingAcked, 0, 'unprocessed delivery must not be ACKed');
            phases.push({ mode, cancelled: triggered, baselineVerified: baseline, acks, writes, storedFixtures: state.rows.prematch.size });
            assert.equal((await readdir(root)).filter(n => n.startsWith('.full-snapshot-')).length, 0);
            const restored = new TradeState();
            await restore(restored, path);
            assert.equal(restored.rows.prematch.size, state.rows.prematch.size);
            assert.ok(restored.feed().events.every(e => e.markets?.every(m => m.selections.every(s => !s.available))));
            state = restored;
        }
        assert.equal(downloads, 3);
        assert.ok(acks > 0);
        assert.equal(ackProofs, acks);
        assert.equal(nacks, 0);
        assert.ok(stopCalls >= 1);
        const memoryPeak = process.env.ADL_OFFLINE_REQUIRE_4G==='1'?await readFile('/sys/fs/cgroup/memory.peak', 'utf8').then(v => Number(v.trim())).catch(() => null):null;
        console.log(JSON.stringify({ operation: 'offline.prematch_recovery', memoryPeakBytes: memoryPeak, maxRSSBytes: process.resourceUsage().maxRSS * 1024, unackedRedeliveryVerified: pendingAcked === 2, snapshotBytes: written, fixtures: count, downloads, phases, persistBeforeAckVerified: true, eligibleSelectionsBeforePlannedStop: stableSelections, restoredOddsBlocked: true, supplierRequests: 0, realAmqpConnection: false }));
    }
    finally {
        if (timer)
            clearInterval(timer);
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
    }
});
import { readFileSync as requireRead } from 'node:fs';
