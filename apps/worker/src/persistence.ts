import { validTrace, validMarketEvidence } from "./settlement-evidence.js";
import { constants } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import type { EventFeed, Lane } from '@lsports/contracts';
import type { Fixture, Market } from 'trade360-nodejs-sdk';
import { TradeState, type Row } from './state.js';

const validId = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const tuples = (v: unknown): v is [string, unknown][] => Array.isArray(v) && v.every(e => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string');
export function checkpoint(state: TradeState) {
  return { version: 1, outright: (['prematch', 'inplay'] as const).flatMap(lane =>
    [...state.rows[lane]].filter(([, row]) => row.outright).map(([key, row]) => ({
      lane, fixtureId: Number(String(key).split(':').at(-1)),
      fixture: row.fixture, outright: row.outright, livescore: row.livescore, outrightScore: row.outrightScore, marketReceipt: row.marketReceipt,
      deferredTimestampBets: row.deferredTimestampBets ? [...row.deferredTimestampBets] : undefined,
      timestampRecovery: row.timestampRecovery ? [...row.timestampRecovery] : undefined,
      settlementAudit: row.settlementAudit ? [...row.settlementAudit] : undefined,
      settlementMarkets: row.settlementMarkets ? [...row.settlementMarkets] : undefined,
      betOrder: row.betOrder ? [...row.betOrder] : undefined,
      markets: [...row.markets], marketAt: [...row.marketAt], betAt: [...row.betAt],
    }))) };
}

// Read directly: API freshness protection must not prevent recovery after downtime.
// Never restore connection status from disk or infer current availability from a saved feed.
export async function restore(state: TradeState, path: string) {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { source: 'missing', rows: 0 }; throw error; }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Invalid saved TRADE state; original file preserved'); }
  if (!object(value) || value.mode !== 'connected' || !Array.isArray(value.events))
    throw new Error('Invalid saved TRADE state; original file preserved');
  const recovered = new TradeState();
  let rows = 0;
  if (value.workerCheckpoint !== undefined) {
    const saved = value.workerCheckpoint;
    if (!object(saved) || saved.version !== 1 || !Array.isArray(saved.outright))
      throw new Error('Unsupported TRADE checkpoint; original file preserved');
    for (const entry of saved.outright) {
      if (!object(entry) || !['prematch', 'inplay'].includes(String(entry.lane)) || !validId(entry.fixtureId) ||
          !object(entry.outright) || !validId(entry.outright.competitionId) ||
          !tuples(entry.markets) || !tuples(entry.marketAt) || !tuples(entry.betAt) ||
          entry.markets.some(([, m]) => !object(m) || !validId(m.id) || (m.bets !== undefined && !Array.isArray(m.bets))) ||
          [...entry.marketAt, ...entry.betAt].some(([, t]) => typeof t !== 'number' || !Number.isFinite(t)) ||
          (entry.fixture !== undefined && (!object(entry.fixture) || !object(entry.fixture.value) || typeof entry.fixture.at !== 'number' || !Number.isFinite(entry.fixture.at))))
        throw new Error('Invalid outright checkpoint; original file preserved');
      if ((entry.deferredTimestampBets !== undefined && (!tuples(entry.deferredTimestampBets) || entry.deferredTimestampBets.some(([, r]) => !object(r) || !validId(r.marketId) || typeof r.selectionId!=="string" || !object(r.bet) || !object(r.inspection) || typeof r.receivedAt!=="string"))) ||
          (entry.timestampRecovery !== undefined && (!tuples(entry.timestampRecovery) || entry.timestampRecovery.some(([, r]) => !object(r) || !["awaiting_fresh_amqp","validated_amqp","awaiting_settlement_replay","settlement_replayed"].includes(String(r.status)) || ![r.previousVersion,r.baselineVersion,r.preparedAt].every(v=>typeof v==="string"&&Number.isFinite(Date.parse(v)))))))
        throw new Error('Invalid timestamp quarantine; original preserved');
      if ((entry.settlementAudit !== undefined && (!tuples(entry.settlementAudit) || entry.settlementAudit.some(([, trace]) => !validTrace(trace)))) ||
          (entry.settlementMarkets !== undefined && (!tuples(entry.settlementMarkets) || entry.settlementMarkets.some(([, evidence]) => !validMarketEvidence(evidence)))))
        throw new Error('Invalid saved settlement evidence; original file preserved');
      if (entry.outrightScore !== undefined) {
        const score = entry.outrightScore;
        if (!object(score) || typeof score.at !== 'number' || !Number.isFinite(score.at) || !object(score.value) ||
            (score.value.status !== undefined && (!Number.isInteger(score.value.status) || Number(score.value.status) < 0)) ||
            (score.value.participantResults !== undefined && (!Array.isArray(score.value.participantResults) || score.value.participantResults.some((p: unknown) =>
              !object(p) || (p.participantId !== undefined && (!Number.isSafeInteger(p.participantId) || Number(p.participantId) <= 0)) ||
              (p.name !== undefined && typeof p.name !== 'string') ||
              (p.result !== undefined && (typeof p.result !== 'number' || !Number.isFinite(p.result)))))))
          throw new Error('Invalid saved outright score; original file preserved');
      }
      if (entry.marketReceipt !== undefined && (!object(entry.marketReceipt) ||
          !object(entry.marketReceipt.messagesByType) ||
          Object.values(entry.marketReceipt.messagesByType).some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0) ||
          ['marketUpdates', 'betUpdates', 'providerMarketUpdates', 'providerBetUpdates', 'staleBetUpdates'].some(k =>
            typeof (entry.marketReceipt as Record<string, unknown>)[k] !== 'number' || !Number.isFinite((entry.marketReceipt as Record<string, number>)[k]))))
        throw new Error('Invalid saved market counters; original file preserved');
      if(entry.betOrder !== undefined && (!tuples(entry.betOrder) || entry.betOrder.some(([,v])=>typeof v!=='string'||!/^[-]?[0-9]{1,25}$/.test(v))))throw new Error('Invalid precise timestamp ordering; original preserved');
      const lane = entry.lane as Lane;
      const key = `outright:${entry.outright.competitionId}:${entry.fixtureId}`;
      if (recovered.rows[lane].has(key)) throw new Error('Duplicate outright checkpoint identity');
      recovered.rows[lane].set(key, {
        deferredTimestampBets: entry.deferredTimestampBets === undefined ? undefined : new Map(entry.deferredTimestampBets as [string, unknown][]) as Row["deferredTimestampBets"],
        timestampRecovery: entry.timestampRecovery === undefined ? undefined : new Map(entry.timestampRecovery as [string, unknown][]) as Row["timestampRecovery"],
        settlementAudit: entry.settlementAudit === undefined ? undefined : new Map(entry.settlementAudit as [string, unknown][]) as Row["settlementAudit"],
        settlementMarkets: entry.settlementMarkets === undefined ? undefined : new Map(entry.settlementMarkets as [string, unknown][]) as Row["settlementMarkets"],
        outrightScore: entry.outrightScore as unknown as Row["outrightScore"],
        fixture: entry.fixture as unknown as Row["fixture"], outright: entry.outright as unknown as Row["outright"],
        livescore: entry.livescore as unknown as Row["livescore"], marketReceipt: entry.marketReceipt as unknown as Row["marketReceipt"],
        betOrder: entry.betOrder === undefined ? undefined : new Map(entry.betOrder as [string,string][]),
        markets: new Map(entry.markets) as Map<string, Market>,
        marketAt: new Map(entry.marketAt) as Map<string, number>, betAt: new Map(entry.betAt) as Map<string, number>,
      });
      rows++;
    }
  } else {
    // Migrate the previous UI-only projection. Preserve all participants and exposed markets;
    // provider-specific data absent from that old format cannot be reconstructed.
    for (const event of value.events as EventFeed['events']) {
      if (!object(event) || event.kind !== 'outright') continue;
      const match = typeof event.id === 'string' && /^(prematch|inplay):outright:(\d+):(\d+)$/.exec(event.id);
      if (!match || !validId(Number(match[2])) || !validId(Number(match[3])))
        throw new Error('Invalid legacy outright identity; original file preserved');
      const lane = match[1] as Lane;
      const at = Date.parse(event.updatedAt || '');
      if (!Number.isFinite(at) || (event.participants !== undefined && !Array.isArray(event.participants)))
        throw new Error('Invalid legacy outright metadata; original file preserved');
      const markets = (event.markets || []).map(m => {
        const prefix = `${event.id}:`;
        if (!m.id.startsWith(prefix) || !validId(Number(m.id.slice(prefix.length))))
          throw new Error('Invalid legacy market identity');
        return { id: Number(m.id.slice(prefix.length)), name: m.name, status: m.status,
          bets: m.selections.map(s => {
            if (!s.id.startsWith(`${m.id}:`) || !s.id.slice(m.id.length + 1)) throw new Error('Invalid legacy selection identity');
            return { id: s.id.slice(m.id.length + 1), name: s.line && s.label.endsWith(` (${s.line})`) ? s.label.slice(0, -(` (${s.line})`.length)) : s.label, line: s.line, price: String(s.odds),
              status: s.status, participantId: s.participantId, settlement: s.settlement, isChanged: -1 };
          }) } as Market;
      });
      recovered.apply(lane, [{ fixtureId: Number(match[3]), outright: {
        competitionId: Number(match[2]), competitionName: event.competition?.name,
        competitionType: event.competition?.type,
        fixture: { fixtureName: event.home, sport: { name: ({ hipica: 'Horse Racing', futbol: 'Football', tenis: 'Tennis', basquet: 'Basketball', otros: 'Other' })[event.sport] },
          status: event.status, participants: event.participants } as Fixture,
      }, markets }], at);
      if (event.marketDiagnostic) {
        const d = event.marketDiagnostic;
        const row = recovered.rows[lane].get(`outright:${match[2]}:${match[3]}`)!;
        if (!object(d.messagesByType) || Object.values(d.messagesByType).some(v => typeof v !== 'number' || !Number.isFinite(v)) ||
            [d.marketUpdates, d.betUpdates, d.providerMarketUpdates, d.providerBetUpdates, d.staleBetUpdates].some(v => typeof v !== 'number' || !Number.isFinite(v)))
          throw new Error('Invalid legacy market counters; original file preserved');
        row.marketReceipt = { messagesByType: d.messagesByType, marketUpdates: d.marketUpdates,
          betUpdates: d.betUpdates, providerMarketUpdates: d.providerMarketUpdates,
          providerBetUpdates: d.providerBetUpdates, staleBetUpdates: d.staleBetUpdates,
          lastMarketMessageAt: d.lastMarketMessageAt };
      }
      rows++;
    }
    // Preserve the original projection before its one-way migration. No overwrite of an older backup.
    try { await copyFile(path, `${path}.pre-checkpoint.bak`, constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  // Commit only after the whole file has been validated. Restored prices stay blocked pending updates.
  state.rows = recovered.rows;
  for (const lane of ['prematch', 'inplay'] as const)
    for (const row of state.rows[lane].values()) row.restored = true;
  return { source: value.workerCheckpoint === undefined ? 'legacy_projection' : 'checkpoint', rows };
}
