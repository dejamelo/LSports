import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TradeState } from './state.js';
import { decodeMessage } from './messages.js';
import { MarketStatus, BetStatusId, SettlementType, FixtureStatus } from 'trade360-nodejs-sdk';

test('official market status 3 blocks all nine priced selections; market settlement does not invent fixture completion', () => {
  assert.equal(MarketStatus.Settled, 3);
  assert.equal(BetStatusId.Settled, 3);
  assert.equal(SettlementType.Refund, 3); // distinct domain: never call this Settled
  assert.equal(FixtureStatus.Finished, 3);
  const state = new TradeState(); const at = Date.now();
  state.apply('prematch', [{ fixtureId: 20540377, outright: { competitionId: 11144, fixture: { sport: { name: 'Horse Racing' }, status: 1,
    participants: Array.from({ length: 9 }, (_, i) => ({ id: i + 1, name: `Synthetic runner ${i + 1}` })) } } }], at);
  const apply = (type: number, body: object, time: number) => {
    const decoded = decodeMessage(Buffer.from(JSON.stringify({ Header: { Type: type, MsgGuid: `synthetic-${type}`, ServerTimestamp: time }, Body: body })));
    state.apply('prematch', decoded.events, decoded.at);
  };
  apply(41, { Competition: { Id: 11144, Events: [{ FixtureId: 20540377, Markets: [{ Id: 160, Status: 1,
    Bets: Array.from({ length: 9 }, (_, i) => ({ Id: String(i + 1), ParticipantId: i + 1, Price: '3.25', Status: 1 })) }] }] } }, at + 10);
  state.set('prematch', { phase: 'connected' });
  assert.equal(state.feed().events[0].marketDiagnostic?.market160?.selectableSelections, 9);
  apply(42, { Competition: { Id: 11144, Events: [{ FixtureId: 20540377, Markets: [{ Id: 160, Status: 3 }] }] } }, at + 20);
  const race = state.feed().events[0];
  assert.equal(race.status, 1); // market liquidated is known; event Finished not received yet
  assert.equal(race.participants?.length, 9);
  assert(race.selections.every(s => s.available === false && s.unavailableReasons?.includes('market_settled')));
  assert.equal(race.marketDiagnostic?.market160?.pricedSelections, 9);
  assert.equal(race.marketDiagnostic?.market160?.selectableSelections, 0);
  assert.equal(race.marketDiagnostic?.market160?.blockedReasonCounts?.market_settled, 9);
  assert.equal(race.marketDiagnostic?.market160?.statusLabel, 'Liquidado');
  apply(37, { Competition: { Id: 11144, Events: [{ FixtureId: 20540377, OutrightFixture: { Status: 3 } }] } }, at + 30);
  assert.equal(state.feed().events[0].marketDiagnostic?.fixtureStatusLabel, 'Finalizado');
});
