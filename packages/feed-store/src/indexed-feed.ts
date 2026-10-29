import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { EventFeed, Lane, SportEvent } from "@lsports/contracts";

export interface IndexedFeedPage {
  feed: Omit<EventFeed, "events">;
  events: SportEvent[];
  page: { revision: number; limit: number; nextCursor?: string; hasMore: boolean };
}
export interface IndexedFeedFilter {
  lane?: Lane;
  sport?: SportEvent["sport"];
  competitionId?: number;
  eventId?: string;
  marketId?: string;
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = (value: string) => JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { revision: number; lastUpdatedAt: number; lastId: string; scope: string };

/** Durable, per-event public materialization. A committed transaction is the only visible revision. */
export class IndexedFeedStore {
  private db: DatabaseSync;
  constructor(readonly path: string, readOnly = false) {
    if (!readOnly) mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path, readOnly ? { readOnly: true } : {});
    this.db.exec("PRAGMA busy_timeout=5000;");
    if (readOnly) this.db.exec("PRAGMA query_only=ON;");
    if (!readOnly) this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    if (!readOnly) this.db.exec(`CREATE TABLE IF NOT EXISTS feed_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feed_events (id TEXT PRIMARY KEY, lane TEXT NOT NULL, sport TEXT NOT NULL, competition_id INTEGER, live INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feed_markets (event_id TEXT NOT NULL REFERENCES feed_events(id) ON DELETE CASCADE, market_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(event_id,market_id));
      CREATE INDEX IF NOT EXISTS feed_events_lane_id ON feed_events(lane,id);
      CREATE INDEX IF NOT EXISTS feed_events_sport_lane_id ON feed_events(sport,lane,id);
      CREATE INDEX IF NOT EXISTS feed_events_competition_lane_id ON feed_events(competition_id,lane,id);
      CREATE INDEX IF NOT EXISTS feed_events_updated ON feed_events(updated_at_ms);`);
    if (!readOnly) this.db.exec("CREATE INDEX IF NOT EXISTS feed_markets_market_event ON feed_markets(market_id,event_id);");
    if (!readOnly) chmodSync(path, 0o600);
  }
  close() { this.db.close(); }
  /** Initial recovery: replace the materialization atomically from the recovered checkpoint. */
  rebuild(events: Iterable<SportEvent>, metadata: Omit<EventFeed, "events">) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM feed_events");
      const put = this.db.prepare("INSERT INTO feed_events(id,lane,sport,competition_id,live,updated_at_ms,body) VALUES(?,?,?,?,?,?,?)");
      const putMarket = this.db.prepare("INSERT INTO feed_markets(event_id,market_id,body) VALUES(?,?,?)");
      for (const event of events) this.put(put, putMarket, event);
      this.commitMetadata(metadata);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** Apply only rows changed since the last successful private checkpoint. */
  applyDelta(upserts: Iterable<SportEvent>, deletedIds: Iterable<string>, metadata: Omit<EventFeed, "events">) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const remove = this.db.prepare("DELETE FROM feed_events WHERE id=?");
      let changed = false;
      for (const id of deletedIds) { remove.run(id); changed = true; }
      const put = this.db.prepare("INSERT INTO feed_events(id,lane,sport,competition_id,live,updated_at_ms,body) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET lane=excluded.lane,sport=excluded.sport,competition_id=excluded.competition_id,live=excluded.live,updated_at_ms=excluded.updated_at_ms,body=excluded.body");
      const existingMarkets = this.db.prepare("SELECT market_id FROM feed_markets WHERE event_id=?");
      const removeMarket = this.db.prepare("DELETE FROM feed_markets WHERE event_id=? AND market_id=?");
      const putMarket = this.db.prepare("INSERT INTO feed_markets(event_id,market_id,body) VALUES(?,?,?) ON CONFLICT(event_id,market_id) DO UPDATE SET body=excluded.body WHERE feed_markets.body IS NOT excluded.body");
      for (const event of upserts) { this.put(put, existingMarkets, removeMarket, putMarket, event); changed = true; }
      this.commitMetadata(metadata, changed);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /**
   * Keep one atomic SQLite revision while yielding between bounded slices.
   * Large validated snapshots can contain thousands of changed events; doing
   * their synchronous SQLite writes in one event-loop turn starves AMQP and
   * durable inbox processing even though WAL readers remain safe.
   */
  async applyDeltaBatched(
    upserts: Iterable<SportEvent>,
    deletedIds: Iterable<string>,
    metadata: Omit<EventFeed, "events">,
    options: { maxSliceMs?: number; yieldEveryRows?: number; yieldTurn?: () => Promise<void>; partialEventIds?: ReadonlySet<string> } = {},
  ) {
    const maxSliceMs = options.maxSliceMs ?? 8;
    const yieldEveryRows = options.yieldEveryRows ?? 32;
    if (!Number.isFinite(maxSliceMs) || maxSliceMs < 1 || maxSliceMs > 1000 || !Number.isSafeInteger(yieldEveryRows) || yieldEveryRows < 1 || yieldEveryRows > 10000) throw Error("INVALID_INDEX_DELTA_SLICE");
    const yieldTurn = options.yieldTurn ?? (() => new Promise<void>(resolve => setImmediate(resolve)));
    const started = performance.now(); let sliceStarted = started, maxSliceObservedMs = 0, yieldCount = 0, upsertRows = 0, deletedRows = 0, sliceRows = 0;
    const phase={beginMs:0,prepareStatementsMs:0,eventSerializeMs:0,eventWriteMs:0,eventDeleteMs:0,marketLookupMs:0,marketSerializeMs:0,marketWriteMs:0,marketDeleteMs:0,metadataMs:0,yieldAwaitMs:0};
    const yieldIfDue = async () => {
      sliceRows++;
      const elapsed = performance.now() - sliceStarted;
      if (elapsed < maxSliceMs && sliceRows < yieldEveryRows) return;
      maxSliceObservedMs = Math.max(maxSliceObservedMs, elapsed); yieldCount++;const yielded=performance.now();await yieldTurn();phase.yieldAwaitMs+=performance.now()-yielded;sliceStarted = performance.now();
      sliceRows = 0;
    };
    let measured=performance.now();this.db.exec("BEGIN IMMEDIATE");phase.beginMs=performance.now()-measured;
    try {
      measured=performance.now();
      const remove = this.db.prepare("DELETE FROM feed_events WHERE id=?");
      const put = this.db.prepare("INSERT INTO feed_events(id,lane,sport,competition_id,live,updated_at_ms,body) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET lane=excluded.lane,sport=excluded.sport,competition_id=excluded.competition_id,live=excluded.live,updated_at_ms=excluded.updated_at_ms,body=excluded.body");
      const existingMarkets = this.db.prepare("SELECT market_id FROM feed_markets WHERE event_id=?");
      const removeMarket = this.db.prepare("DELETE FROM feed_markets WHERE event_id=? AND market_id=?");
      const putMarket = this.db.prepare("INSERT INTO feed_markets(event_id,market_id,body) VALUES(?,?,?) ON CONFLICT(event_id,market_id) DO UPDATE SET body=excluded.body WHERE feed_markets.body IS NOT excluded.body");
      phase.prepareStatementsMs=performance.now()-measured;
      let changed = false;
      for (const id of deletedIds) { measured=performance.now();remove.run(id);phase.eventDeleteMs+=performance.now()-measured;deletedRows++; changed = true; await yieldIfDue(); }
      for (const event of upserts) {
        const lane = event.source;
        if (lane !== "prematch" && lane !== "inplay") throw Error("INDEX_EVENT_WITHOUT_LANE");
        const { markets = [], marketDiagnostic: _diagnostic, ...rest } = event;
        measured=performance.now();const eventBody=JSON.stringify({ ...rest, markets: [], selections: [] });phase.eventSerializeMs+=performance.now()-measured;
        measured=performance.now();
        put.run(event.id, lane, event.sport, event.competition?.id ?? null, event.live ? 1 : 0,
          Date.parse(event.updatedAt || "") || 0, eventBody);phase.eventWriteMs+=performance.now()-measured;
        upsertRows++; changed = true; await yieldIfDue();
        if(!options.partialEventIds?.has(event.id)){
          const keep = new Set(markets.map(market => market.id));
          measured=performance.now();const current = existingMarkets.all(event.id) as { market_id: string }[];phase.marketLookupMs+=performance.now()-measured;
          for (const row of current) {
            if (!keep.has(row.market_id)) { measured=performance.now();removeMarket.run(event.id, row.market_id);phase.marketDeleteMs+=performance.now()-measured;await yieldIfDue(); }
          }
        }
        for (const market of markets) {
          measured=performance.now();const marketBody=JSON.stringify(market);phase.marketSerializeMs+=performance.now()-measured;
          measured=performance.now();putMarket.run(event.id, market.id, marketBody);phase.marketWriteMs+=performance.now()-measured;
          await yieldIfDue();
        }
      }
      measured=performance.now();this.commitMetadata(metadata, changed);phase.metadataMs=performance.now()-measured;
      const beforeCommit = performance.now(); maxSliceObservedMs = Math.max(maxSliceObservedMs, beforeCommit - sliceStarted);
      this.db.exec("COMMIT"); const commitMs = Math.ceil(performance.now() - beforeCommit); maxSliceObservedMs = Math.max(maxSliceObservedMs, commitMs);
      const elapsedMs = Math.ceil(performance.now() - started);
      const sqlWriteMs=phase.eventDeleteMs+phase.eventWriteMs+phase.marketDeleteMs+phase.marketWriteMs+phase.metadataMs;
      return { upsertRows, deletedRows, yieldCount, maxSliceMs: Math.ceil(maxSliceObservedMs), commitMs, elapsedMs,
        ...Object.fromEntries(Object.entries(phase).map(([key,value])=>[key,Math.ceil(value)])),sqlWriteMs:Math.ceil(sqlWriteMs),
        indexMaintenanceIncludedInSqlMs:true,indexedTables:"feed_events,feed_markets" };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private put(stmt: ReturnType<DatabaseSync["prepare"]>, putMarket: ReturnType<DatabaseSync["prepare"]>, event: SportEvent): void;
  private put(stmt: ReturnType<DatabaseSync["prepare"]>, existingMarkets: ReturnType<DatabaseSync["prepare"]>, removeMarket: ReturnType<DatabaseSync["prepare"]>, putMarket: ReturnType<DatabaseSync["prepare"]>, event: SportEvent): void;
  private put(stmt: ReturnType<DatabaseSync["prepare"]>, existingOrMarketPut: ReturnType<DatabaseSync["prepare"]>, removeOrEvent: ReturnType<DatabaseSync["prepare"]> | SportEvent, marketPutOrEvent?: ReturnType<DatabaseSync["prepare"]> | SportEvent, maybeEvent?: SportEvent) {
    const event = maybeEvent || (removeOrEvent as SportEvent);
    const lane = event.source;
    if (lane !== "prematch" && lane !== "inplay") throw Error("INDEX_EVENT_WITHOUT_LANE");
    const { markets = [], marketDiagnostic: _diagnostic, ...rest } = event;
    stmt.run(event.id, lane, event.sport, event.competition?.id ?? null, event.live ? 1 : 0,
      Date.parse(event.updatedAt || "") || 0, JSON.stringify({ ...rest, markets: [], selections: [] }));
    if (maybeEvent) {
      const keep = new Set(markets.map(market => market.id));
      const current = existingOrMarketPut.all(event.id) as { market_id: string }[];
      const removeMarket = removeOrEvent as ReturnType<DatabaseSync["prepare"]>;
      for (const row of current) if (!keep.has(row.market_id)) removeMarket.run(event.id, row.market_id);
      const putMarket = marketPutOrEvent as ReturnType<DatabaseSync["prepare"]>;
      for (const market of markets) putMarket.run(event.id, market.id, JSON.stringify(market));
    } else {
      const putMarket = existingOrMarketPut;
      for (const market of markets) putMarket.run(event.id, market.id, JSON.stringify(market));
    }
  }
  private commitMetadata(metadata: Omit<EventFeed, "events">, increment = true) {
    const body = JSON.stringify(metadata);
    const row = this.db.prepare("SELECT revision,body FROM feed_meta WHERE id=1").get() as { revision?: number; body?: string } | undefined;
    const revision = Number(row?.revision || 0) + (increment || !row || row.body !== body ? 1 : 0);
    this.db.prepare("INSERT INTO feed_meta(id,revision,body) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body")
      .run(revision, body);
  }
  page(input: { limit?: number; cursor?: string; filter?: IndexedFeedFilter; scope: string; now?: number }): IndexedFeedPage {
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit || 100)));
    const row = this.db.prepare("SELECT revision,body FROM feed_meta WHERE id=1").get() as { revision: number; body: string } | undefined;
    if (!row) throw Error("INDEX_NOT_READY");
    let lastUpdatedAt: number | undefined;
    let lastId = "";
    if (input.cursor) {
      const cursor = decode(input.cursor);
      if (cursor.revision !== row.revision || cursor.scope !== input.scope || !Number.isSafeInteger(cursor.lastUpdatedAt) || typeof cursor.lastId !== "string") throw Error("INDEX_CURSOR_STALE");
      lastUpdatedAt = cursor.lastUpdatedAt;
      lastId = cursor.lastId;
    }
    const metadata = JSON.parse(row.body) as Omit<EventFeed, "events">;
    const feedAge = input.now === undefined ? 0 : input.now - Date.parse(metadata.updatedAt || "");
    // A global stale/unavailable feed suppresses the entire result set. Return
    // that fact before building a candidate page so hasMore/cursor never claim
    // there are results beyond rows that the freshness gate just removed.
    if ((input.now !== undefined && (!Number.isFinite(feedAge) || feedAge > 20000 || feedAge < -5000)) || metadata.health === "unavailable") {
      return { feed: metadata, events: [], page: { revision: row.revision, limit, hasMore: false } };
    }
    const filter = input.filter || {};
    // Start with the most recently changed source events so the first bounded
    // page contains current fixtures instead of an ID-ordered set of old rows.
    // The timestamp comes from event.updatedAt (provider data), never receipt time.
    // IDs are the deterministic tie-breaker and the cursor is revision-bound.
    const clauses = ["NOT (lane='prematch' AND EXISTS (SELECT 1 FROM feed_events ip WHERE ip.id='inplay:' || substr(feed_events.id,10) AND ip.live=1))"];
    const args: (string | number)[] = [];
    if (input.cursor) {
      clauses.push("(updated_at_ms < ? OR (updated_at_ms = ? AND id > ?))");
      args.push(lastUpdatedAt!, lastUpdatedAt!, lastId);
    }
    if (filter.lane) { clauses.push("lane = ?"); args.push(filter.lane); }
    if (filter.sport) { clauses.push("sport = ?"); args.push(filter.sport); }
    if (filter.competitionId !== undefined) { clauses.push("competition_id = ?"); args.push(filter.competitionId); }
    if (filter.eventId) { clauses.push("id = ?"); args.push(filter.eventId); }
    if (filter.marketId) { clauses.push("EXISTS(SELECT 1 FROM feed_markets fm WHERE fm.event_id=feed_events.id AND fm.market_id=?)"); args.push(filter.marketId); }
    args.push(limit + 1);
    const marketBytes=filter.marketId?"(SELECT COALESCE(sum(length(CAST(fm.body AS BLOB))),0) FROM feed_markets fm WHERE fm.event_id=feed_events.id AND fm.market_id=?)":"(SELECT COALESCE(sum(length(CAST(fm.body AS BLOB))),0) FROM feed_markets fm WHERE fm.event_id=feed_events.id)";
    const candidateArgs=filter.marketId?[filter.marketId,...args]:args;
    const candidates = this.db.prepare(`SELECT id,updated_at_ms,length(CAST(body AS BLOB))+${marketBytes} AS bytes FROM feed_events WHERE ${clauses.join(" AND ")} ORDER BY updated_at_ms DESC,id ASC LIMIT ?`).all(...candidateArgs) as { id: string; updated_at_ms: number; bytes: number }[];
    // Bound the complete HTTP response well below the historical 8 MiB read/heap safety ceiling.
    const pageBudget = 4 * 1024 * 1024;
    const ids: string[] = []; let bytes = 0;
    for (const candidate of candidates.slice(0, limit)) {
      if (candidate.bytes > pageBudget || bytes + candidate.bytes > pageBudget) break;
      ids.push(candidate.id); bytes += candidate.bytes;
    }
    if (!ids.length && candidates.length) throw Error("INDEX_EVENT_EXCEEDS_PAGE_LIMIT");
    const hasMore = candidates.length > ids.length;
    const visibleRows = ids.length ? this.db.prepare(`SELECT id,body FROM feed_events WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: string; body: string }[] : [];
    const visibleById=new Map(visibleRows.map(record=>[record.id,record]));
    const visible=ids.map(id=>visibleById.get(id)!).filter(Boolean);
    const markets=ids.length?this.db.prepare(`SELECT event_id,market_id,body FROM feed_markets WHERE event_id IN (${ids.map(()=>'?').join(',')})${filter.marketId?' AND market_id=?':''} ORDER BY event_id,market_id`).all(...(filter.marketId?[...ids,filter.marketId]:ids)) as {event_id:string;market_id:string;body:string}[]:[];
    const byEvent=new Map<string, SportEvent['markets']>();
    for(const row of markets){let list=byEvent.get(row.event_id);if(!list){list=[];byEvent.set(row.event_id,list);}list.push(JSON.parse(row.body) as NonNullable<SportEvent['markets']>[number]);}
    // The global health flag is aggregate across both feeds. A recovering InPlay
    // lane must not hide a ready PreMatch lane; readiness is checked per event
    // below. A stale global market heartbeat still suppresses all odds.
    const events = visible.map(record => {
        const base=JSON.parse(record.body) as SportEvent, eventMarkets=byEvent.get(record.id)||[];
        const primary=eventMarkets.find(m=>m.selections.some(s=>s.available))||eventMarkets[0];
        return {...base,markets:eventMarkets,selections:primary?.selections||[],market:primary?.name||'Sin mercados disponibles'};
      });
    const safeEvents = events.map(event => {
      const connection = event.source ? metadata.connections?.[event.source] : undefined;
      const reasons: ('feed_disconnected'|'processing_backlog'|'stale_odds')[] = [];
      const progress = connection?.ingressProgress;
      if (connection?.phase !== 'connected') reasons.push('feed_disconnected');
      if (progress && (progress.processingBacklog ?? progress.backlog) > 0 && (progress.oldestProcessingAgeMs ?? progress.oldestAgeMs) > 5000) reasons.push('processing_backlog');
      const eventAge = input.now === undefined ? 0 : input.now - Date.parse(event.updatedAt || '');
      if (!Number.isFinite(eventAge) || eventAge < -5000 || eventAge > 20000) reasons.push('stale_odds');
      const transient = new Set(['feed_disconnected', 'processing_backlog', 'stale_odds']);
      const eligibleEventStatus = [1, 2, 9].includes(event.status ?? 0);
      const eligibleEvent = connection?.phase === 'connected' && !reasons.length && eligibleEventStatus;
      const normalizeSelection = (selection: SportEvent['selections'][number], marketOpen: boolean) => {
        const prior = selection.unavailableReasons || [];
        const retained = prior.filter(reason => !transient.has(reason));
        const onlyHadTransientBlocks = selection.available !== true && prior.length > 0 && retained.length === 0;
        const statusOpen = selection.status === 1;
        const settled = selection.settlement !== undefined && selection.settlement !== null && selection.settlement !== 0;
        const priceValid = Number.isFinite(selection.odds) && selection.odds > 1;
        const staticReasons = [
          ...(!eligibleEventStatus ? ['event_inactive'] : []),
          ...(!marketOpen ? ['market_not_open'] : []),
          ...(!statusOpen ? ['selection_not_open'] : []),
          ...(settled ? ['selection_settled'] : []),
          ...(!priceValid ? ['invalid_price'] : []),
        ];
        const unavailableReasons = [...new Set([...retained, ...staticReasons, ...reasons])];
        // Reopen only selections whose stored projection was blocked solely by
        // transient lane/backlog/freshness state, and only after every current
        // feed, event, status, settlement, price and freshness guard passes.
        const previouslyEligible = selection.available === true || onlyHadTransientBlocks;
        const available = previouslyEligible && eligibleEvent && marketOpen && statusOpen && !settled && priceValid && unavailableReasons.length === 0;
        return { ...selection, available, unavailableReasons };
      };
      const markets = event.markets?.map(market => ({
        ...market,
        selections: market.selections.map(selection => normalizeSelection(selection, market.status === 1)),
      }));
      const selections = event.selections.map(selection => {
        const market = event.markets?.find(candidate => candidate.selections.includes(selection));
        return normalizeSelection(selection, market?.status === 1);
      });
      const primary = event.markets?.findIndex(market => market.selections === event.selections) ?? -1;
      return { ...event, available: eligibleEvent, selections: primary >= 0 ? markets![primary].selections : selections, markets };
    });
    return { feed: metadata, events: safeEvents, page: { revision: row.revision, limit,
      ...(hasMore && visible.length ? { nextCursor: encode({ revision: row.revision, lastUpdatedAt: candidates[ids.length-1].updated_at_ms, lastId: visible.at(-1)!.id, scope: input.scope }) } : {}), hasMore } };
  }
  eventsByIds(ids: string[], scope: string, now = Date.now()): EventFeed {
    if (ids.length > 12 || new Set(ids).size !== ids.length) throw Error("INDEX_EVENT_ID_LIMIT");
    let metadata: Omit<EventFeed, "events"> | undefined;
    const events: SportEvent[] = [];
    for (const id of ids) {
      const page = this.page({ filter: { eventId: id }, scope, limit: 1, now });
      metadata = page.feed;
      events.push(...page.events);
    }
    if (!metadata) {
      const row = this.db.prepare("SELECT body FROM feed_meta WHERE id=1").get() as { body: string } | undefined;
      if (!row) return { mode: "connected", health: "unavailable", notice: "Índice de cuotas no disponible.", events: [] };
      metadata = JSON.parse(row.body) as Omit<EventFeed, "events">;
    }
    return { ...metadata, events };
  }
  summary(now = Date.now()) {
    const row = this.db.prepare("SELECT revision,body FROM feed_meta WHERE id=1").get() as { revision: number; body: string } | undefined;
    if (!row) throw Error("INDEX_NOT_READY");
    const counts = this.db.prepare("SELECT lane,count(*) events FROM feed_events GROUP BY lane").all() as { lane: string; events: number }[];
    return { revision: row.revision, metadata: JSON.parse(row.body) as Omit<EventFeed, "events">, counts, now };
  }
}

export const indexedFeedPath = (stateFile: string) => resolve(dirname(stateFile), "trade-feed.public.sqlite");
