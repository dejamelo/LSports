import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.js";
test("demo feed identifies fictional data and has unique usable selections", async () => {
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const feed = await (await fetch(`${base}/api/events`)).json();
    assert.equal(feed.mode, "demo");
    assert(feed.events.length > 0);
    const ids: string[] = [];
    for (const event of feed.events) {
      assert(event.selections.length > 1);
      for (const selection of event.selections) {
        assert(selection.odds > 1);
        ids.push(selection.id);
      }
    }
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(
      (await fetch(`${base}/api/bets`, { method: "POST" })).status,
      404,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
test("connected API returns an empty unavailable feed without demo fallback", async () => {
  const source = {
    async getEvents() {
      return {
        mode: "connected" as const,
        health: "unavailable" as const,
        notice: "Worker sin conexión",
        events: [],
      };
    },
  };
  const server = createApp(source).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const feed = await (await fetch(`${base}/api/events`)).json();
    assert.equal(feed.mode, "connected");
    assert.deepEqual(feed.events, []);
    assert.equal((await fetch(`${base}/api/health`)).status, 503);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('fixture diagnostic route exposes actual projected outright market counters and no invented observations', async () => {
  const { TradeState } = await import('../../worker/src/state.js');
  const { decodeMessage } = await import('../../worker/src/messages.js');
  const state = new TradeState();
  const at = Date.now();
  const decoded = decodeMessage(Buffer.from(JSON.stringify({ Header: { Type: 41, MsgGuid: 'api-test', ServerTimestamp: at },
    Body: { Competition: { Id: 90, Events: [{ FixtureId: 20540377, Markets: [{ Id: 160, Status: 1,
      Bets: [{ Id: '1', Price: '3.25', Status: 1 }] }] }] } } })));
  state.apply('prematch', decoded.events, decoded.at);
  const server = createApp({ async getEvents() { return state.feed(); } }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const diagnostic = await (await fetch(`${base}/api/diagnostics/outright/20540377`)).json();
    assert.equal(diagnostic.observation, 'observed');
    assert.equal(diagnostic.matches[0].hasFixture, false);
    assert.equal(diagnostic.matches[0].messagesByType['41'], 1);
    assert.equal(diagnostic.matches[0].storedSelections, 1);
    assert.equal((await (await fetch(`${base}/api/diagnostics/outright/123`)).json()).observation, 'not_observed_in_current_projection');
    assert.equal((await fetch(`${base}/api/diagnostics/outright/invalid`)).status, 400);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

test('local open-event search excludes settled, suspended, restored and inactive candidates without supplier calls', async () => {
  const { TradeState } = await import('../../worker/src/state.js');
  const state = new TradeState();
  state.set('prematch', { phase: 'connected' });
  for (const [fixtureId, marketStatus, fixtureStatus] of [[101, 1, 1], [102, 3, 1], [103, 2, 1], [104, 1, 3], [105, 1, 1]]) {
    state.apply('prematch', [{ fixtureId, outright: { competitionId: 90, fixture: { sport: { name: 'Horse Racing' }, status: fixtureStatus } },
      markets: [{ id: 160, status: marketStatus, bets: [{ id: '1', status: 1, price: '3.25', isChanged: 0 }] }] }], Date.now());
  }
  state.rows.prematch.get('outright:90:105')!.restored = true;
  const server = createApp({ async getEvents() { return state.feed(); } }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  try {
    const address = server.address(); assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const report = await (await fetch(`${base}/api/diagnostics/open-events`)).json();
    assert.equal(report.observation, 'candidates_available');
    assert.deepEqual(report.candidates.map((e: {fixtureId: number}) => e.fixtureId), [101]);
    assert.equal(report.candidates[0].markets[0].selections[0].odds, 3.25);
    assert.equal((await fetch(`${base}/api/diagnostics/open-events?sport=invalid`)).status, 400);
    state.set('prematch', { phase: 'error' });
    assert.equal((await (await fetch(`${base}/api/diagnostics/open-events?sport=all`)).json()).observation, 'no_selectable_events_in_current_projection');
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
