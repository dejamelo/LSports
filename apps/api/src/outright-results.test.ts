import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { TradeState } from '../../worker/src/state.js';
import { checkpoint, restore } from '../../worker/src/persistence.js';
import { decodeMessage } from '../../worker/src/messages.js';
import { createPublisher, readConnectedFeed } from '@lsports/feed-store';
import { SettlementType } from 'trade360-nodejs-sdk';

test('individual settlements survive local restart and HTTP diagnostics: nine losers, one winner, provider names and unknown codes', async () => {
  assert.equal(SettlementType.Loser, 1); assert.equal(SettlementType.Winner, 2);
  const dir = await mkdtemp(join(tmpdir(), 'adl-results-')); const path = join(dir, 'feed.json');
  const state = new TradeState(); const at = Date.now();
  // Isolated synthetic case. This is not the actual result of fixture 20540195.
  // Vegas Vickie is deliberately a loser in this test to ensure names cannot imply winners.
  const bets = Array.from({ length: 10 }, (_, i) => ({ Id: String(i + 1), ParticipantId: i + 1, Name: i === 0 ? 'Vegas Vickie' : `Synthetic runner ${i + 1}`,
    Price: '3.25', Status: 3, Settlement: i === 9 ? 2 : 1 }));
  for (const [type, body] of [
    [37, { Competition: { Id: 11144, Events: [{ FixtureId: 20540195, OutrightFixture: { Status: 3, Sport: { Name: 'Horse Racing' }, Participants: [{ Id: 1, Name: 'Vegas Vickie' }] } }] } }],
    [42, { Competition: { Id: 11144, Events: [{ FixtureId: 20540195, Markets: [{ Id: 160, Name: 'Race Winner', Status: 3, Bets: bets }] }] } }],
  ] as const) {
    const decoded = decodeMessage(Buffer.from(JSON.stringify({ Header: { Type: type, MsgGuid: `synthetic-${type}`, ServerTimestamp: at }, Body: body })));
    state.apply('prematch', decoded.events, decoded.at);
  }
  // Other feed, same fixture: keep separate results, including unnamed and unmapped settlements.
  state.apply('inplay', [{ fixtureId: 20540195, outright: { competitionId: 11144 }, markets: [{ id: 160, status: 3, bets: [
    { id: '9223372036854775807', settlement: 77 as SettlementType, status: 3, isChanged: 0 },
    { id: 'missing', isChanged: 0 }, { id: 'refund', settlement: 3, isChanged: 0 },
  ] }] }], at);
  try {
    await createPublisher(path)(state.feed(), checkpoint(state));
    const restarted = new TradeState(); await restore(restarted, path);
    await createPublisher(path)(restarted.feed(), checkpoint(restarted));
    let reads = 0;
    const server = createApp({ async getEvents() { reads++; return readConnectedFeed(path); } }).listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    try {
      const address = server.address(); assert(address && typeof address !== 'string');
      const result = await (await fetch(`http://127.0.0.1:${address.port}/api/diagnostics/outright/20540195`)).json();
      assert.equal(reads, 1); assert.equal(result.matches.length, 2);
      const prematch = result.matches.find((m: {lane: string}) => m.lane === 'prematch');
      assert.equal(prematch.fixtureStatusLabel, 'Finalizado');
      assert.deepEqual(prematch.market160.settlementCounts, { '1': 9, '2': 1 });
      const market = prematch.markets[0];
      assert.equal(market.id, 160); assert.equal(market.name, 'Race Winner'); assert.equal(market.statusLabel, 'Liquidado');
      assert.equal(market.selections.length, 10);
      const winner = market.selections.filter((s: {settlement: number}) => s.settlement === 2);
      assert.equal(winner.length, 1); assert.equal(winner[0].id, '10'); assert.equal(winner[0].name, 'Synthetic runner 10');
      assert.equal(winner[0].resultDescription, 'Ganadora');
      const vegas = market.selections.find((s: {name: string}) => s.name === 'Vegas Vickie');
      assert.equal(vegas.settlement, 1); assert.equal(vegas.resultDescription, 'Perdedora'); assert.equal(vegas.participantName, 'Vegas Vickie');
      assert.equal(vegas.providerStatus, 3);
      const inplay = result.matches.find((m: {lane: string}) => m.lane === 'inplay');
      assert.equal(inplay.hasFixture, false); // Results remain observable without metadata or visible sportsbook row.
      const unknown = inplay.markets[0].selections[0];
      assert.equal(unknown.id, '9223372036854775807'); assert.equal(unknown.name, null);
      assert.equal(unknown.settlement, 77); assert.equal(unknown.resultKnown, false); assert.equal(unknown.resultDescription, 'Código de liquidación desconocido');
      assert.equal(inplay.markets[0].selections[1].settlement, null);
      assert.equal(inplay.markets[0].selections[1].resultDescription, 'Liquidación no informada');
      assert.equal(inplay.markets[0].selections[2].resultDescription, 'Reembolso');
      assert.equal(prematch.market160.selectableSelections, 0);
    } finally { await new Promise<void>(r => server.close(() => r())); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
