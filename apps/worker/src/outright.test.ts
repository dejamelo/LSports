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
