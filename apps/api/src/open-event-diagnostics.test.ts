import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import type { SportEvent } from '@lsports/contracts';
test('explains fourteen excluded local events with IDs/counts while preserving the previous candidate predicate and source data', async () => {
  const base: SportEvent = { id: 'prematch:1', source: 'prematch', sport: 'hipica', league: 'Synthetic', home: 'Synthetic race', away: '',
    time: 'Test', live: false, market: 'Test', selections: [], available: true, status: 1,
    markets: [{ id: 'market', status: 1, name: 'Test', selections: [{ id: 'selection', odds: 3.25, available: true, label: 'Test' }] }] };
  const events: SportEvent[] = Array.from({ length: 14 }, (_, i) => ({ ...structuredClone(base), id: `prematch:${i + 1}` }));
  events[0].status = 3;
  events[1].status = undefined;
  events[2].available = false;
  events[3].available = undefined;
  events[4].markets = [];
  events[5].markets = undefined;
  events[5].selections = [{ id: 'primary-only-selection', odds: 3.25, available: true, label: 'Test' }];
  events[6].markets![0].status = 3;
  events[6].markets![0].selections[0].available = false;
  events[6].markets![0].selections[0].unavailableReasons = ['market_settled'];
  events[7].markets![0].status = 2;
  events[8].markets![0].selections = [];
  events[9].markets![0].selections[0].odds = 0;
  events[10].markets![0].selections[0].available = false;
  events[10].markets![0].selections[0].unavailableReasons = ['awaiting_update'];
  events[11].markets![0].selections[0].available = undefined;
  events[12].markets![0].status = undefined;
  events[13].markets![0].selections[0].available = false;
  const snapshot = structuredClone(events); let reads = 0;
  const server = createApp({ async getEvents() { reads++; return { mode: 'connected', health: 'ok', notice: 'Synthetic protocol test only', events }; } }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  try {
    const address = server.address(); assert(address && typeof address !== 'string');
    const report = await (await fetch(`http://127.0.0.1:${address.port}/api/diagnostics/open-events?sport=all`)).json();
    assert.equal(reads, 1); assert.equal(report.observedEvents, 14); assert.deepEqual(report.candidates, []);
    assert.equal(report.exclusions.summary.excludedEvents, 14);
    assert.equal(report.exclusions.excludedEvents.length, 14);
    const byId = (id: number) => report.exclusions.excludedEvents.find((e: {fixtureId: number}) => e.fixtureId === id);
    assert(byId(1).exclusionReasons.includes('fixture_not_active'));
    assert(byId(2).exclusionReasons.includes('fixture_status_missing'));
    assert(byId(3).exclusionReasons.includes('event_not_available'));
    assert(byId(4).exclusionReasons.includes('event_availability_missing'));
    assert.equal(byId(5).counts.markets, 0); assert.equal(byId(6).marketsField, 'missing');
    assert.equal(byId(6).counts.primarySelections, 1);
    assert(byId(6).exclusionReasons.includes('primary_selections_without_markets'));
    assert.equal(byId(7).marketStatusCounts['3'], 1);
    assert.equal(byId(7).markets[0].selectionBlockingReasonCounts.market_settled, 1);
    assert.deepEqual(byId(7).markets[0].examples.byBlockingReason.market_settled, ['selection']);
    assert(byId(9).exclusionReasons.includes('selections_missing'));
    assert(byId(10).exclusionReasons.includes('no_valid_prices'));
    assert.equal(byId(11).markets[0].selectionBlockingReasonCounts.awaiting_update, 1);
    assert(byId(12).exclusionReasons.includes('selection_availability_missing'));
    assert.equal(byId(13).marketStatusCounts.missing, 1);
    assert.equal(byId(14).markets[0].selectionBlockingReasonCounts.not_reported_by_projection, 1);
    assert(report.exclusions.summary.reasons.every((r: {eventCount: number; examples: unknown[]}) => r.eventCount > 0 && r.examples.length > 0));
    assert.deepEqual(events, snapshot);
    // Compare with the original endpoint predicate, including an inconsistent available flag.
    const candidate = structuredClone(base); candidate.id = 'prematch:15';
    candidate.markets![0].selections[0].settlement = 2;
    candidate.markets![0].selections[0].unavailableReasons = ['selection_settled'];
    events.push(candidate); // Existing predicate trusts available=true; diagnostics must not silently change that.
    const second = await (await fetch(`http://127.0.0.1:${address.port}/api/diagnostics/open-events?sport=all`)).json();
    assert.deepEqual(second.candidates.map((e: {fixtureId: number}) => e.fixtureId), [15]);
    assert.equal(second.exclusions.summary.excludedEvents, 14);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
