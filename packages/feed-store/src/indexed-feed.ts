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
const decode = (value: string) => JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { revision: number; lastId: string; scope: string };

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
    const yieldIfDue = async () => {
      sliceRows++;
      const elapsed = performance.now() - sliceStarted;
      if (elapsed < maxSliceMs && sliceRows < yieldEveryRows) return;
      maxSliceObservedMs = Math.max(maxSliceObservedMs, elapsed); yieldCount++; await yieldTurn(); sliceStarted = performance.now();
      sliceRows = 0;
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const remove = this.db.prepare("DELETE FROM feed_events WHERE id=?");
      let changed = false;
      for (const id of deletedIds) { remove.run(id); deletedRows++; changed = true; await yieldIfDue(); }
      const put = this.db.prepare("INSERT INTO feed_events(id,lane,sport,competition_id,live,updated_at_ms,body) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET lane=excluded.lane,sport=excluded.sport,competition_id=excluded.competition_id,live=excluded.live,updated_at_ms=excluded.updated_at_ms,body=excluded.body");
      const existingMarkets = this.db.prepare("SELECT market_id FROM feed_markets WHERE event_id=?");
      const removeMarket = this.db.prepare("DELETE FROM feed_markets WHERE event_id=? AND market_id=?");
      const putMarket = this.db.prepare("INSERT INTO feed_markets(event_id,market_id,body) VALUES(?,?,?) ON CONFLICT(event_id,market_id) DO UPDATE SET body=excluded.body WHERE feed_markets.body IS NOT excluded.body");
      for (const event of upserts) {
        const lane = event.source;
        if (lane !== "prematch" && lane !== "inplay") throw Error("INDEX_EVENT_WITHOUT_LANE");
        const { markets = [], marketDiagnostic: _diagnostic, ...rest } = event;
        put.run(event.id, lane, event.sport, event.competition?.id ?? null, event.live ? 1 : 0,
          Date.parse(event.updatedAt || "") || 0, JSON.stringify({ ...rest, markets: [], selections: [] }));
        upsertRows++; changed = true; await yieldIfDue();
        if(!options.partialEventIds?.has(event.id)){
          const keep = new Set(markets.map(market => market.id));
          const current = existingMarkets.all(event.id) as { market_id: string }[];
          for (const row of current) {
            if (!keep.has(row.market_id)) { removeMarket.run(event.id, row.market_id); await yieldIfDue(); }
          }
        }
        for (const market of markets) {
          putMarket.run(event.id, market.id, JSON.stringify(market));
          await yieldIfDue();
        }
      }
      this.commitMetadata(metadata, changed);
      const beforeCommit = performance.now(); maxSliceObservedMs = Math.max(maxSliceObservedMs, beforeCommit - sliceStarted);
      this.db.exec("COMMIT"); const commitMs = Math.ceil(performance.now() - beforeCommit); maxSliceObservedMs = Math.max(maxSliceObservedMs, commitMs);
      const elapsedMs = Math.ceil(performance.now() - started);
      return { upsertRows, deletedRows, yieldCount, maxSliceMs: Math.ceil(maxSliceObservedMs), commitMs, elapsedMs };
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
    let lastId = "";
    if (input.cursor) {
      const cursor = decode(input.cursor);
      if (cursor.revision !== row.revision || cursor.scope !== input.scope) throw Error("INDEX_CURSOR_STALE");
      lastId = cursor.lastId;
    }
    const filter = input.filter || {};
    // IDs are stored as lane:<provider fixture id>; this exact primary-key
    // lookup avoids a correlated scan of the full InPlay index per PreMatch row.
    const clauses = ["id > ?", "NOT (lane='prematch' AND EXISTS (SELECT 1 FROM feed_events ip WHERE ip.id='inplay:' || substr(feed_events.id,10) AND ip.live=1))"];
    const args: (string | number)[] = [lastId];
    if (filter.lane) { clauses.push("lane = ?"); args.push(filter.lane); }
    if (filter.sport) { clauses.push("sport = ?"); args.push(filter.sport); }
    if (filter.competitionId !== undefined) { clauses.push("competition_id = ?"); args.push(filter.competitionId); }
    if (filter.eventId) { clauses.push("id = ?"); args.push(filter.eventId); }
    if (filter.marketId) { clauses.push("EXISTS(SELECT 1 FROM feed_markets fm WHERE fm.event_id=feed_events.id AND fm.market_id=?)"); args.push(filter.marketId); }
    args.push(limit + 1);
    const marketBytes=filter.marketId?"(SELECT COALESCE(sum(length(CAST(fm.body AS BLOB))),0) FROM feed_markets fm WHERE fm.event_id=feed_events.id AND fm.market_id=?)":"(SELECT COALESCE(sum(length(CAST(fm.body AS BLOB))),0) FROM feed_markets fm WHERE fm.event_id=feed_events.id)";
    const candidateArgs=filter.marketId?[filter.marketId,...args]:args;
    const candidates = this.db.prepare(`SELECT id,length(CAST(body AS BLOB))+${marketBytes} AS bytes FROM feed_events WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`).all(...candidateArgs) as { id: string; bytes: number }[];
    // Bound the complete HTTP response well below the historical 8 MiB read/heap safety ceiling.
    const pageBudget = 4 * 1024 * 1024;
    const ids: string[] = []; let bytes = 0;
    for (const candidate of candidates.slice(0, limit)) {
      if (candidate.bytes > pageBudget || bytes + candidate.bytes > pageBudget) break;
      ids.push(candidate.id); bytes += candidate.bytes;
    }
    if (!ids.length && candidates.length) throw Error("INDEX_EVENT_EXCEEDS_PAGE_LIMIT");
    const hasMore = candidates.length > ids.length;
    const visible = ids.length ? this.db.prepare(`SELECT id,body FROM feed_events WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids) as { id: string; body: string }[] : [];
    const markets=ids.length?this.db.prepare(`SELECT event_id,market_id,body FROM feed_markets WHERE event_id IN (${ids.map(()=>'?').join(',')})${filter.marketId?' AND market_id=?':''} ORDER BY event_id,market_id`).all(...(filter.marketId?[...ids,filter.marketId]:ids)) as {event_id:string;market_id:string;body:string}[]:[];
    const byEvent=new Map<string, SportEvent['markets']>();
    for(const row of markets){let list=byEvent.get(row.event_id);if(!list){list=[];byEvent.set(row.event_id,list);}list.push(JSON.parse(row.body) as NonNullable<SportEvent['markets']>[number]);}
    const metadata = JSON.parse(row.body) as Omit<EventFeed, "events">;
    const age = input.now === undefined ? 0 : input.now - Date.parse(metadata.updatedAt || "");
    // Stale or unhealthy sources never return selectable odds, even if rows remain indexed.
    const events = age > 20000 || age < -5000 || metadata.health === "unavailable"
      ? [] : visible.map(record => {
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
      if (!reasons.length) return event;
      const selections = event.selections.map(selection => ({ ...selection, available: false, unavailableReasons: [...new Set([...(selection.unavailableReasons || []), ...reasons])] }));
      const markets = event.markets?.map(market => ({ ...market, selections: market.selections.map(selection => ({ ...selection, available: false, unavailableReasons: [...new Set([...(selection.unavailableReasons || []), ...reasons])] })) }));
      const primary = event.markets?.findIndex(market => market.selections === event.selections) ?? -1;
      return { ...event, available: false, selections: primary >= 0 ? markets![primary].selections : selections, markets };
    });
    return { feed: metadata, events: safeEvents, page: { revision: row.revision, limit,
      ...(hasMore && visible.length ? { nextCursor: encode({ revision: row.revision, lastId: visible.at(-1)!.id, scope: input.scope }) } : {}), hasMore } };
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
