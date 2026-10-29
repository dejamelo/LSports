import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EventFeed, SportEvent } from "@lsports/contracts";
import { IndexedFeedStore } from "./indexed-feed.js";

const metadata = (at: number): Omit<EventFeed, "events"> => ({ mode: "connected", health: "ok", notice: "test", updatedAt: new Date(at).toISOString(),
  connections: { prematch: { phase: "connected", message: "ok" }, inplay: { phase: "connected", message: "ok" } } });
const event = (id: string, updatedAt: number, odds = 1.8): SportEvent => ({ id, sport: "futbol", source: id.startsWith("inplay:") ? "inplay" : "prematch", league: "league", home: "A", away: "B", time: "now", live: id.startsWith("inplay:"), market: "winner", status: 1, available: true, updatedAt: new Date(updatedAt).toISOString(), selections: [{ id: `${id}:1:1`, label: "A", odds, available: true }], markets: [{ id: `${id}:1`, name: "winner", status: 1, selections: [{ id: `${id}:1:1`, label: "A", odds, available: true }] }] });

test("indexed feed atomically pages committed revisions and rejects cross-scope/stale cursors", () => {
  const dir = mkdtempSync(join(tmpdir(), "adl-indexed-feed-")), path = join(dir, "public.sqlite"), now = Date.now();
  const writer = new IndexedFeedStore(path);
  try {
    writer.rebuild([event("prematch:1", now), event("prematch:2", now), event("inplay:1", now)], metadata(now));
    const first = writer.page({ limit: 1, scope: "client-a", now });
    assert.equal(first.events.length, 1);
    assert.ok(first.page.nextCursor);
    assert.throws(() => writer.page({ limit: 1, cursor: first.page.nextCursor, scope: "client-b", now }), /INDEX_CURSOR_STALE/);
    const legacyCursor=Buffer.from(JSON.stringify({revision:first.page.revision,lastId:"prematch:1",scope:"client-a"})).toString("base64url");
    assert.throws(() => writer.page({ limit: 1, cursor: legacyCursor, scope: "client-a", now }), /INDEX_CURSOR_STALE/);
    const second = writer.page({ limit: 1, cursor: first.page.nextCursor, scope: "client-a", now });
    assert.equal(second.events.length, 1);
    const oldCursor = second.page.nextCursor;
    writer.applyDelta([event("prematch:2", now, 2.1)], [], metadata(now));
    if (oldCursor) assert.throws(() => writer.page({ limit: 1, cursor: oldCursor, scope: "client-a", now }), /INDEX_CURSOR_STALE/);
    const metaCursor = writer.page({ limit: 1, scope: "meta", now });
    writer.applyDelta([], [], { ...metadata(now), notice: "health metadata changed" });
    if (metaCursor.page.nextCursor) assert.throws(() => writer.page({ limit: 1, cursor: metaCursor.page.nextCursor, scope: "meta", now }), /INDEX_CURSOR_STALE/);
    const stale = writer.page({ limit: 20, scope: "client-a", now: now + 21_000 });
    assert.equal(stale.events.length, 0);
    const masked = writer.page({ limit: 20, scope: "client-a", now });
    assert.equal(masked.events.filter(e => e.id === "inplay:1").length, 1);
    // PM is hidden only when a live InPlay fixture with the same provider ID exists.
    assert.equal(masked.events.some(e => e.id === "prematch:1"), false);
    const marketOnly=writer.page({limit:5,scope:"market",now,filter:{eventId:"prematch:2",marketId:"prematch:2:1"}});
    assert.equal(marketOnly.events[0].markets?.length,1);
    assert.equal(marketOnly.events[0].selections[0].id,"prematch:2:1:1");
  } finally { writer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("newest provider-updated fixtures lead the first page without relaxing stale or market guards", () => {
  const dir=mkdtempSync(join(tmpdir(),"adl-indexed-fresh-first-")),path=join(dir,"public.sqlite"),now=Date.now(),writer=new IndexedFeedStore(path);
  try {
    const old=event("prematch:1",now-60_000),fresh=event("prematch:99999999",now-2_000),closed=event("prematch:99999998",now-1_000);
    for(const row of [old,fresh,closed]){row.markets![0].selections[0].status=1;row.selections[0].status=1;}
    closed.markets![0].status=2;closed.markets![0].selections[0].available=false;closed.markets![0].selections[0].unavailableReasons=["market_not_open"];
    closed.selections=closed.markets![0].selections;
    writer.rebuild([old,fresh,closed],metadata(now));
    const first=writer.page({filter:{lane:"prematch"},limit:1,scope:"fresh-first",now});
    assert.deepEqual(first.events.map(row=>row.id),["prematch:99999998"]);
    assert.equal(first.events[0].markets![0].selections[0].available,false,"closed markets stay blocked even when updated recently");
    assert.ok(first.page.nextCursor);
    const second=writer.page({filter:{lane:"prematch"},limit:1,cursor:first.page.nextCursor,scope:"fresh-first",now});
    assert.deepEqual(second.events.map(row=>row.id),["prematch:99999999"]);
    assert.equal(second.events[0].markets![0].selections[0].available,true,"fresh open odds remain available");
    const third=writer.page({filter:{lane:"prematch"},limit:1,cursor:second.page.nextCursor,scope:"fresh-first",now});
    assert.deepEqual(third.events.map(row=>row.id),["prematch:1"]);
    assert.equal(third.events[0].markets![0].selections[0].available,false,"old provider data remains stale");
  } finally { writer.close();rmSync(dir,{recursive:true,force:true}); }
});

test("re-evaluates only transient blocks per lane after recovery and keeps quote/status guards", () => {
  const dir = mkdtempSync(join(tmpdir(), "adl-indexed-lane-recovery-")), path = join(dir, "public.sqlite"), now = Date.now();
  const writer = new IndexedFeedStore(path);
  try {
    const recovered = event("prematch:recovered", now);
    recovered.available = false;
    recovered.markets![0].selections[0].status = 1;
    recovered.markets![0].selections[0].available = false;
    recovered.markets![0].selections[0].unavailableReasons = ["feed_disconnected", "processing_backlog"];
    recovered.selections[0].status = 1;
    recovered.selections[0].available = false;
    recovered.selections[0].unavailableReasons = ["feed_disconnected", "processing_backlog"];

    const awaiting = event("prematch:awaiting", now);
    awaiting.available = false;
    awaiting.markets![0].selections[0].status = 1;
    awaiting.markets![0].selections[0].available = false;
    awaiting.markets![0].selections[0].unavailableReasons = ["feed_disconnected", "awaiting_update"];
    awaiting.selections[0].status = 1;
    awaiting.selections[0].available = false;
    awaiting.selections[0].unavailableReasons = ["feed_disconnected", "awaiting_update"];

    const closed = event("prematch:closed", now);
    closed.available = false;
    closed.markets![0].status = 3;
    closed.markets![0].selections[0].status = 1;
    closed.markets![0].selections[0].available = false;
    closed.markets![0].selections[0].unavailableReasons = ["feed_disconnected"];
    closed.selections[0].status = 1;
    closed.selections[0].available = false;
    closed.selections[0].unavailableReasons = ["feed_disconnected"];

    const meta = { ...metadata(now), health: "degraded" as const,
      connections: { prematch: { phase: "connected", message: "ready", ingressProgress: { backlog: 0, processingBacklog: 0, oldestProcessingAgeMs: 0 } },
        inplay: { phase: "recovering", message: "waiting for baseline" } } };
    writer.rebuild([recovered, awaiting, closed], meta);
    const page = writer.page({ lane: "prematch", limit: 10, scope: "facundo-ars", now });
    const marketEvent = (id: string) => page.events.find(row => row.id === id)!;
    const reopened = marketEvent("prematch:recovered");
    assert.equal(reopened.available, true);
    assert.equal(reopened.markets![0].selections[0].available, true);
    assert.deepEqual(reopened.markets![0].selections[0].unavailableReasons, []);

    const stillAwaiting = marketEvent("prematch:awaiting");
    assert.equal(stillAwaiting.available, true, "fixture readiness is independent of quote readiness");
    assert.equal(stillAwaiting.markets![0].selections[0].available, false);
    assert.deepEqual(stillAwaiting.markets![0].selections[0].unavailableReasons, ["awaiting_update"]);

    const stillClosed = marketEvent("prematch:closed");
    assert.equal(stillClosed.markets![0].selections[0].available, false);
    assert.deepEqual(stillClosed.markets![0].selections[0].unavailableReasons, ["market_not_open"]);

    writer.applyDelta([], [], { ...meta, health: "degraded",
      connections: { prematch: { phase: "recovering", message: "recovering" }, inplay: { phase: "connected", message: "ready" } } });
    const recovering = writer.page({ lane: "prematch", limit: 10, scope: "facundo-ars", now }).events.find(row => row.id === "prematch:recovered")!;
    assert.equal(recovering.available, false);
    assert.equal(recovering.markets![0].selections[0].available, false);
    assert.ok(recovering.markets![0].selections[0].unavailableReasons?.includes("feed_disconnected"));

    writer.applyDelta([], [], { ...meta,
      connections: { prematch: { phase: "connected", message: "ready", ingressProgress: { backlog: 1, processingBacklog: 1, oldestProcessingAgeMs: 5001 } },
        inplay: { phase: "recovering", message: "waiting for baseline" } } });
    const backlogged = writer.page({ lane: "prematch", limit: 10, scope: "facundo-ars", now }).events.find(row => row.id === "prematch:recovered")!;
    assert.equal(backlogged.available, false);
    assert.equal(backlogged.markets![0].selections[0].available, false);
    assert.ok(backlogged.markets![0].selections[0].unavailableReasons?.includes("processing_backlog"));
  } finally { writer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("page budget counts UTF-8 bytes so a multibyte market cannot exceed the HTTP response ceiling", () => {
  const dir = mkdtempSync(join(tmpdir(), "adl-indexed-bytes-")), path = join(dir, "public.sqlite"), now = Date.now();
  const writer = new IndexedFeedStore(path);
  try {
    const large = event("prematch:1", now);
    large.markets![0].selections[0].label = "😀".repeat(1_100_000);
    writer.rebuild([large], metadata(now));
    assert.throws(() => writer.page({ limit: 1, scope: "utf8", now }), /INDEX_EVENT_EXCEEDS_PAGE_LIMIT/);
  } finally { writer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("an interrupted delta rolls back rows and revision; the last committed page remains recoverable", () => {
  const dir = mkdtempSync(join(tmpdir(), "adl-indexed-recovery-")), path = join(dir, "public.sqlite"), now = Date.now();
  let writer = new IndexedFeedStore(path);
  try {
    writer.rebuild([event("prematch:1", now)], metadata(now));
    const committed = writer.page({ limit: 10, scope: "test", now });
    function* interrupted() { yield event("prematch:2", now); throw Error("simulated_process_interruption"); }
    assert.throws(() => writer.applyDelta(interrupted(), [], metadata(now)), /simulated_process_interruption/);
    writer.close();
    writer = new IndexedFeedStore(path, true);
    const recovered = writer.page({ limit: 10, scope: "test", now });
    assert.equal(recovered.page.revision, committed.page.revision);
    assert.deepEqual(recovered.events.map(item => item.id), ["prematch:1"]);
  } finally { writer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("market deltas reuse identities, update changed bodies and remove only markets absent from the new event", () => {
  const dir = mkdtempSync(join(tmpdir(), "adl-indexed-market-delta-")), path = join(dir, "public.sqlite"), now = Date.now();
  const writer = new IndexedFeedStore(path);
  try {
    const original = event("prematch:1", now);
    original.markets!.push({ id: "prematch:1:2", name: "total", status: 1, selections: [{ id: "prematch:1:2:1", label: "over", odds: 1.9, available: true }] });
    writer.rebuild([original], metadata(now));
    const changed = event("prematch:1", now + 1, 2.2);
    writer.applyDelta([changed], [], metadata(now + 1));
    const page = writer.page({ limit: 10, scope: "market-delta", now: now + 1 });
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0].markets?.length, 1, "the removed market must be deleted");
    assert.equal(page.events[0].selections[0].odds, 2.2, "changed market bodies must replace the committed value");
    const sql = new DatabaseSync(path, { readOnly: true });
    try { assert.equal((sql.prepare("SELECT count(*) AS n FROM feed_markets WHERE event_id=?").get("prematch:1") as { n: number }).n, 1); }
    finally { sql.close(); }
  } finally { writer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("read-only API sees the last committed revision while the worker has an open WAL transaction", () => {
  const dir = mkdtempSync(join(tmpdir(), "adl-indexed-wal-reader-")), path = join(dir, "public.sqlite"), now = Date.now();
  const writer = new IndexedFeedStore(path);
  let reader: IndexedFeedStore | undefined;
  try {
    writer.rebuild([event("prematch:1", now)], metadata(now));
    reader = new IndexedFeedStore(path, true);
    const before = reader.page({ limit: 10, scope: "api", now });
    assert.deepEqual(before.events.map(row => row.id), ["prematch:1"]);

    // A committed WAL write remains readable without blocking the API. A
    // subsequent uncommitted transaction must remain invisible to the reader.
    writer.applyDelta([event("prematch:2", now)], [], metadata(now));
    assert.deepEqual(reader.page({ limit: 10, scope: "api", now }).events.map(row => row.id), ["prematch:1", "prematch:2"]);
    const activeWriter = new DatabaseSync(path);
    activeWriter.exec("BEGIN IMMEDIATE");
    activeWriter.prepare("UPDATE feed_meta SET revision=revision+1 WHERE id=1").run();
    assert.deepEqual(reader.page({ limit: 10, scope: "api", now }).events.map(row => row.id), ["prematch:1", "prematch:2"]);
    activeWriter.exec("ROLLBACK");
    activeWriter.close();
  } finally { reader?.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("batched snapshot deltas yield to live work and stay invisible until atomic commit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adl-indexed-batched-")), path = join(dir, "public.sqlite"), now = Date.now();
  const writer = new IndexedFeedStore(path), reader = new IndexedFeedStore(path, true);
  try {
    writer.rebuild([event("prematch:1", now)], metadata(now));
    const before = reader.page({ limit: 20, scope: "snapshot", now });
    let entered!: () => void, release!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let yields = 0;
    const work = writer.applyDeltaBatched([event("prematch:2", now), event("prematch:3", now)], [], metadata(now), {
      yieldEveryRows: 1,
      yieldTurn: async () => { if (++yields === 1) { entered(); await gate; } },
    });
    await paused;
    const during = reader.page({ limit: 20, scope: "snapshot", now });
    assert.equal(during.page.revision, before.page.revision);
    assert.deepEqual(during.events.map(row => row.id), ["prematch:1"], "readers must see the previous committed revision while the snapshot is staged");
    release();
    const metrics = await work;
    assert.equal(metrics.upsertRows, 2);
    assert.equal(metrics.yieldCount, 4, "each event and its market row must yield within the atomic delta");
    const after = reader.page({ limit: 20, scope: "snapshot", now });
    assert.equal(after.page.revision, before.page.revision + 1);
    assert.deepEqual(after.events.map(row => row.id), ["prematch:1", "prematch:2", "prematch:3"]);
  } finally { reader.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("partial market commits preserve untouched markets while a full snapshot can replace them", async () => {
  const dir=mkdtempSync(join(tmpdir(),"adl-indexed-partial-market-")),path=join(dir,"public.sqlite"),now=Date.now(),writer=new IndexedFeedStore(path);
  try{
    const initial=event("prematch:partial",now);
    initial.markets=[
      {id:"m1",name:"one",status:1,selections:[{id:"s1",label:"A",odds:1.8,available:true}]},
      {id:"m2",name:"two",status:1,selections:[{id:"s2",label:"B",odds:2.2,available:true}]},
    ];
    writer.rebuild([initial],metadata(now));
    const changed={...initial,updatedAt:new Date(now+1000).toISOString(),markets:[{id:"m1",name:"one",status:1,selections:[{id:"s1",label:"A",odds:2.1,available:true}]}]};
    await writer.applyDeltaBatched([changed],[],metadata(now+1000),{partialEventIds:new Set(["prematch:partial"])});
    let page=writer.page({limit:10,scope:"partial",now:now+1000});
    assert.equal(page.events[0].markets?.find(m=>m.id==="m1")?.selections[0].odds,2.1);
    assert.equal(page.events[0].markets?.find(m=>m.id==="m2")?.selections[0].odds,2.2,"markets absent from the delta stay intact");
    await writer.applyDeltaBatched([changed],[],metadata(now+2000));
    page=writer.page({limit:10,scope:"full",now:now+2000});
    assert.deepEqual(page.events[0].markets?.map(m=>m.id),["m1"],"a complete replacement removes markets absent from the full snapshot");
  }finally{writer.close();rmSync(dir,{recursive:true,force:true});}
});

test("an interrupted batched delta rolls back cleanly on reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adl-indexed-batched-rollback-")), path = join(dir, "public.sqlite"), now = Date.now();
  const writer = new IndexedFeedStore(path);
  writer.rebuild([event("prematch:1", now)], metadata(now));
  try {
    const partial = event("prematch:2", now);
    for (let i = 2; i <= 256; i++) partial.markets!.push({ id: `prematch:2:${i}`, name: `market-${i}`, status: 1,
      selections: [{ id: `prematch:2:${i}:1`, label: "A", odds: 1.8, available: true }] });
    let yields = 0;
    await assert.rejects(writer.applyDeltaBatched([partial, event("prematch:3", now)], [], metadata(now), {
      yieldEveryRows: 1,
      yieldTurn: async () => { if (++yields === 4) throw Error("simulated_interruption"); },
    }), /simulated_interruption/);
  } finally { writer.close(); }
  const restored = new IndexedFeedStore(path, true);
  try {
    const page = restored.page({ limit: 20, scope: "restored", now });
    assert.deepEqual(page.events.map(row => row.id), ["prematch:1"]);
    assert.equal(page.page.revision, 1);
    const sql = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal((sql.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
      assert.equal((sql.prepare("SELECT count(*) AS n FROM feed_events WHERE id='prematch:2'").get() as { n: number }).n, 0,
        "an interruption during market writes must roll back the event and every partial market row");
    }
    finally { sql.close(); }
  } finally { restored.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("representative snapshot-sized delta yields event-loop turns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adl-indexed-batched-volume-")), path = join(dir, "public.sqlite"), now = Date.now();
  const writer = new IndexedFeedStore(path);
  try {
    writer.rebuild([], metadata(now));
    function* snapshotRows() {
      for (let i = 1; i <= 11_892; i++) {
        const row = event(`prematch:${i}`, now);
        for (let market = 2; market <= 24; market++) row.markets!.push({ id: `${row.id}:${market}`, name: `market-${market}`, status: 1,
          selections: [{ id: `${row.id}:${market}:1`, label: "A", odds: 1.8, available: true }] });
        yield row;
      }
    }
    let liveTurns = 0;
    const result = await writer.applyDeltaBatched(snapshotRows(), [], metadata(now), {
      yieldEveryRows: 32,
      yieldTurn: async () => { await new Promise<void>(resolve => setImmediate(resolve)); liveTurns++; },
    });
    assert.equal(result.upsertRows, 11_892);
    assert.ok(result.yieldCount >= 8_000, "yield count must include markets, not only event headers");
    assert.equal(liveTurns, result.yieldCount);
    const page = writer.page({ limit: 100, scope: "snapshot-volume", now });
    assert.equal(page.events.length, 100);
    assert.equal(page.page.hasMore, true);
  } finally { writer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("40,864 representative fixtures are indexed and paged with live-duplicate suppression", () => {
  const dir = mkdtempSync(join(tmpdir(), "adl-indexed-volume-")), path = join(dir, "public.sqlite"), now = Date.now();
  const writer = new IndexedFeedStore(path);
  try {
    function* fixtures() {
      for (let i = 1; i <= 40_864; i++) yield event(`prematch:${i}`, now);
      for (let i = 1; i <= 4_096; i++) yield event(`inplay:${i}`, now);
    }
    writer.rebuild(fixtures(), metadata(now));
    let cursor: string | undefined, total = 0, pages = 0;
    do {
      const result = writer.page({ limit: 200, cursor, scope: "volume", now });
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 8 * 1024 * 1024);
      total += result.events.length; pages++;
      cursor = result.page.nextCursor;
      if (!result.page.hasMore) break;
      assert.ok(cursor);
    } while (pages < 300);
    assert.equal(total, 40_864);
    assert.ok(pages > 200);
  } finally { writer.close(); rmSync(dir, { recursive: true, force: true }); }
});
