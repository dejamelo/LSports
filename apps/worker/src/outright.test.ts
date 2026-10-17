import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeMessage } from './messages.js';
import { TradeState } from './state.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublisher, readConnectedFeed } from '@lsports/feed-store';
const at = 1700000000000;
function message(fixture: object) {
  return decodeMessage(Buffer.from(JSON.stringify({
    Header: { Type: 37, MsgGuid: 'race', ServerTimestamp: at },
    Body: { Competition: { Id: 90, Name: 'Meeting', Type: 1,
      Events: [{ FixtureId: 100, OutrightFixture: fixture }] } },
  })));
}
test('official type 37 preserves all participant metadata through projection, partial/stale updates and regular snapshot recovery', async () => {
  const participants = Array.from({ length: 15 }, (_, i) => ({ Id: i + 1, Name: `Runner ${i + 1}`, Position: String(i + 1), IsActive: i % 2,
    RotationId: 20 + i, Form: '123', ExtraData: [{ Name: 'Weight', Value: '55' }] }));
  const decoded = message({ FixtureName: 'Race 1', Sport: { Name: 'Horse Racing' }, Participants: participants, Status: 1 });
  assert.equal(decoded.metadata.messageTypeName, 'OutrightFixtureUpdate');
  assert.equal(decoded.metadata.eventCount, 1);
  const state = new TradeState();
  state.apply('prematch', decoded.events, at);
  state.apply('prematch', message({ Status: 2 }).events, at + 10);
  state.apply('prematch', message({ Participants: [] }).events, at - 10);
  state.replace('prematch', [{ fixtureId: 100, fixture: { sport: { name: 'Football' }, status: 1 } }], at + 20);
  state.set('prematch', { phase: 'connected' });
  const feed = state.feed();
  assert.equal(feed.events.length, 2);
  const race = feed.events.find(e => e.kind === 'outright')!;
  assert.equal(race.id, 'prematch:outright:90:100');
  assert.equal(race.sport, 'hipica');
  assert.equal(race.home, 'Race 1');
  assert.equal(race.participants?.length, 15);
  assert.equal(race.participants?.[14].name, 'Runner 15');
  assert.equal(race.participants?.[14].form, '123');
  assert.equal(race.selections.length, 0);
  assert.equal(race.status, 2);
  const dir = await mkdtemp(join(tmpdir(), 'adl-race-'));
  try {
    const path = join(dir, 'feed.json');
    await createPublisher(path)(feed);
    assert.deepEqual((await readConnectedFeed(path)).events.find(e => e.kind === 'outright')?.participants, race.participants);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Synthetic protocol fixtures, not supplier observations or production fallback.
function marketMessage(type: number, markets: unknown[], when = at + 10, competitionId = 90) {
  return decodeMessage(Buffer.from(JSON.stringify({
    Header: { Type: type, MsgGuid: `markets-${type}-${when}`, ServerTimestamp: when },
    Body: { Competition: { Id: competitionId, Name: 'Meeting', Events: [{ FixtureId: 100, Markets: markets }] } },
  })));
}
const raceWinner = { Id: 160, Name: 'Race Winner', Status: 1, Bets: [
  { Id: '9223372036854775807', ParticipantId: 1, Price: '3.25', Status: 1 },
  { Id: '200', Name: 'Runner 2', ParticipantId: 2, Price: '5.5', BetStatusId: 1 },
] };
for (const lane of ['prematch', 'inplay'] as const) {
  test(`type 41 joins type 37 in ${lane}, preserves participants, isolates soccer and survives regular snapshot`, async () => {
    const state = new TradeState();
    const metadata = message({ FixtureName: 'Synthetic race', Sport: { Name: 'Horse Racing' }, Status: 1,
      Participants: Array.from({ length: 9 }, (_, i) => ({ Id: i + 1, Name: `Runner ${i + 1}` })) });
    // Markets may arrive before metadata. Keep them observable, without inventing a fixture.
    const decoded = marketMessage(41, [raceWinner]);
    assert.equal(decoded.metadata.messageTypeName, 'OutrightFixtureMarketUpdate');
    assert.equal(decoded.metadata.marketCount, 1);
    assert.equal(decoded.metadata.betCount, 2);
    state.apply(lane, decoded.events, decoded.at);
    assert.equal(state.feed().events.length, 0);
    assert.equal(state.feed().outrightDiagnostics?.[0].hasFixture, false);
    assert.equal(state.feed().coverage?.[lane].outrightMarketRowsWithoutFixture, 1);
    state.apply(lane, metadata.events, metadata.at);
    state.replace(lane, [{ fixtureId: 100, fixture: { sport: { name: 'Football' }, status: 1 },
      markets: [{ id: 160, name: 'Soccer market', status: 1, bets: [{ id: 'soccer', price: '2', status: 1, isChanged: 0 }] }] }], at + 20);
    state.set(lane, { phase: 'connected' });
    const race = state.feed().events.find(e => e.kind === 'outright')!;
    assert.equal(race.participants?.length, 9);
    assert.equal(race.market, 'Race Winner');
    assert.equal(race.selections[0].odds, 3.25);
    assert.equal(race.selections[0].label, 'Runner 1');
    assert.equal(race.selections[0].participantId, 1);
    assert(race.selections[0].id.endsWith(':9223372036854775807'));
    assert(race.selections.every(s => s.available));
    assert.equal(race.marketDiagnostic?.market160?.pricedSelections, 2);
    assert.equal(state.feed().events.find(e => e.kind === 'fixture')?.market, 'Soccer market');
    const dir = await mkdtemp(join(tmpdir(), 'adl-market-'));
    try {
      const path = join(dir, 'feed.json');
      await createPublisher(path)(state.feed());
      assert.deepEqual((await readConnectedFeed(path)).events.find(e => e.kind === 'outright')?.selections, JSON.parse(JSON.stringify(race.selections)));
    } finally { await rm(dir, { recursive: true, force: true }); }
    // A later type 37 update does not clear market data.
    state.apply(lane, message({ Status: 2 }).events, at + 30);
    assert.equal(state.feed().events.find(e => e.kind === 'outright')?.selections[0].odds, 3.25);
  });
}
test('42 settles selections; stale 41 cannot reopen them, and other competitions do not collide', () => {
  const state = new TradeState();
  state.set('prematch', { phase: 'connected' });
  state.apply('prematch', message({ Sport: { Name: 'Horse Racing' }, Status: 1, Participants: [{ Id: 1, Name: 'Runner 1' }] }).events, at);
  state.apply('prematch', marketMessage(41, [raceWinner]).events, at + 10);
  const settled = marketMessage(42, [{ Id: 160, Status: 3, Bets: [{ Id: '9223372036854775807', Status: 3, Settlement: 1 }] }], at + 30);
  assert.equal(settled.metadata.messageTypeName, 'OutrightSettlementsUpdate');
  state.apply('prematch', settled.events, settled.at);
  state.apply('prematch', marketMessage(41, [raceWinner]).events, at + 10);
  const race = state.feed().events[0];
  assert.equal(race.selections[0].available, false);
  assert.equal(race.selections[0].settlement, 1);
  assert.equal(race.selections[0].odds, 3.25);
  assert.equal(race.marketDiagnostic?.staleBetUpdates, 1);
  state.apply('prematch', marketMessage(41, [raceWinner], at + 40, 91).events, at + 40);
  assert.equal(state.feed().outrightDiagnostics?.length, 2);
  assert.equal(state.feed().outrightDiagnostics?.find(d => d.competitionId === 91)?.hasFixture, false);
});
test('diagnostic distinguishes no market messages, empty markets, provider-only prices and blocked selections', () => {
  const state = new TradeState();
  state.apply('prematch', message({ Sport: { Name: 'Horse Racing' }, Status: 1 }).events, at);
  assert.equal(state.feed().events[0].marketDiagnostic?.lastMarketMessageAt, undefined);
  state.apply('prematch', marketMessage(41, []).events, at + 10);
  assert(state.feed().events[0].marketDiagnostic?.lastMarketMessageAt);
  assert.equal(state.feed().events[0].marketDiagnostic?.storedMarkets, 0);
  state.apply('prematch', marketMessage(41, [{ Id: 160, ProviderMarkets: [{ Id: 7, Bets: [{ Id: '1', Price: '3' }] }] }]).events, at + 20);
  assert.equal(state.feed().events[0].marketDiagnostic?.providerMarketUpdates, 1);
  assert.equal(state.feed().events[0].marketDiagnostic?.providerBetUpdates, 1);
  assert.equal(state.feed().events[0].marketDiagnostic?.storedSelections, 0);
  state.apply('prematch', marketMessage(41, [raceWinner]).events, at + 30);
  assert.equal(state.feed().events[0].marketDiagnostic?.storedSelections, 2);
  assert.equal(state.feed().events[0].marketDiagnostic?.selectableSelections, 0); // connection blocked
});
test('malformed markets and unknown outright types fail explicitly without raw payload disclosure', () => {
  for (const [type, markets] of [[41, [{ Name: 'private name' }]], [42, [{ Id: 160, Bets: [{ Price: '2' }] }]], [40, []], [43, []]] as const) {
    assert.throws(() => marketMessage(type, [...markets]), (error: unknown) => {
      const text = JSON.stringify(error);
      assert(!text.includes('private name'));
      assert(!text.includes('Price'));
      return true;
    });
  }
});
