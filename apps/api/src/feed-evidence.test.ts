import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { root } from "@lsports/feed-store";
import type { EventFeed } from "@lsports/contracts";
import { TradeState } from "../../worker/src/state.js";
import { feedEvidence } from "./feed-evidence.js";
import { serverConfig } from "./server-config.js";
test("evidence explains 19 API rows / 12 football rows without date filtering, partial Outright and settled prices; does not expose raw exceptions", () => {
  const now = Date.parse("2026-10-18T18:00:00Z"),
    events = Array.from({ length: 19 }, (_, i) => ({
      id: `prematch:${i + 1}`,
      sport: i < 12 ? "futbol" : "tenis",
      source: "prematch",
      status: 3,
      live: false,
      available: false,
      home: "TEST A",
      away: "TEST B",
      league: "ISOLATED",
      time: "17/10",
      market: "1X2",
      startsAt: "2026-10-17T14:00:00Z",
      updatedAt: "2026-10-17T16:00:00Z",
      markets: [
        {
          id: "1",
          name: "1X2",
          status: 3,
          selections: [
            {
              id: "a",
              label: "A",
              odds: 2.1,
              available: false,
              unavailableReasons: ["market_not_open"],
            },
          ],
        },
      ],
      selections: [],
    })) as EventFeed["events"];
  const feed = {
    mode: "connected",
    health: "degraded",
    updatedAt: new Date(now).toISOString(),
    events,
    connections: {
      prematch: {
        phase: "connected",
        message: "secret-exception-must-not-escape",
        outrightRecovery: {
          status: "rate_limited",
          checkedAt: new Date(now).toISOString(),
          diagnostics: [
            {
              operation: "snapshot.outright.markets",
              protocol: "http",
              category: "rate_limited",
              httpStatus: 429,
              message: "secret-provider-body",
              retryAt: "2026-10-18T18:05:00Z",
            },
          ],
        },
      },
      inplay: { phase: "connected", message: "OK" },
    },
  } as EventFeed;
  const before = JSON.stringify(feed),
    result = feedEvidence(feed, now);
  assert.equal(result.observedEvents, 19);
  assert.equal(result.ui.footballPreMatchNoSearch, 12);
  assert.equal(result.ui.dateFilter, false);
  assert.equal(result.candidateEvents, 0);
  assert.equal(result.exclusions.summary.excludedEvents, 19);
  assert(
    result.degradedReasons.some((r) => r.component === "outright_recovery"),
  );
  assert.equal(
    result.lanes[0].outrightRecovery?.diagnostics[0]?.httpStatus,
    429,
  );
  assert(!JSON.stringify(result).includes("secret-"));
  assert.equal(result.events[0].evidence, "unknown_older_diagnostic_version");
  assert.equal(JSON.stringify(feed), before);
});
test("keepalive and duplicates cannot masquerade as new event/quote activity; snapshot and AMQP observations remain distinct", () => {
  const state = new TradeState(),
    at = Date.parse("2026-10-18T14:00:00Z");
  state.recordMessage("prematch", 3, 1, false, undefined, at);
  state.recordMessage("prematch", 31, 0, false, 0, at + 60000);
  state.recordMessage("prematch", 32, 0, false, undefined, at + 120000);
  state.recordMessage("prematch", 3, 1, true, undefined, at + 130000);
  const activity = state.feed().coverage!.prematch.activity!;
  assert.equal(activity.lastMarketDecodedAt, new Date(at).toISOString());
  assert.equal(activity.lastDataDecodedAt, new Date(at).toISOString());
  assert.equal(
    activity.lastControlDecodedAt,
    new Date(at + 120000).toISOString(),
  );
  assert.equal(
    activity.lastDuplicateDecodedAt,
    new Date(at + 130000).toISOString(),
  );
  state.apply(
    "prematch",
    [
      {
        fixtureId: 1,
        fixture: { sport: { name: "Football" }, status: 1 },
        markets: [
          {
            id: 1,
            status: 1,
            bets: [{ id: "1", price: "2.1", status: 1, isChanged: -1 }],
          },
        ],
      },
    ],
    at,
    { source: "snapshot", receivedAt: at + 1000 },
  );
  state.apply(
    "prematch",
    [
      {
        fixtureId: 1,
        markets: [{ id: 1, bets: [{ id: "1", price: "2.2", isChanged: -1 }] }],
      },
    ],
    at + 3000,
    { source: "amqp", receivedAt: at + 4000 },
  );
  const observation = state.feed().events[0].observation!;
  assert.equal(
    observation.snapshotReceivedAt,
    new Date(at + 1000).toISOString(),
  );
  assert.equal(
    observation.amqpMarketReceivedAt,
    new Date(at + 4000).toISOString(),
  );
});
test("local feed evidence command reads once without provider calls, checkpoint/ticket modifications or raw body printing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adl-feed-evidence-")),
    path = join(directory, "feed.json"),
    ticket = join(directory, "tickets.sqlite");
  const body = JSON.stringify({
    mode: "connected",
    events: [],
    updatedAt: new Date().toISOString(),
    workerCheckpoint: { private: "do-not-print-checkpoint" },
  });
  await writeFile(path, body);
  await writeFile(ticket, "preserve-ticket");
  try {
    const output = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "scripts/diagnose-feed.ts"],
      { cwd: root, env: { ...process.env, LSPORTS_STATE_FILE: path } },
    );
    const result = JSON.parse(output.stdout);
    assert.equal(result.readOnly, true);
    assert.equal(result.writes, 0);
    assert.equal(result.supplierRequests, 0);
    assert(!output.stdout.includes("do-not-print-checkpoint"));
    assert.equal(await readFile(path, "utf8"), body);
    assert.equal(await readFile(ticket, "utf8"), "preserve-ticket");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("production API startup requires HTTPS origin, platform authentication and connected mode", () => {
  assert.throws(() => serverConfig({ NODE_ENV: "production" }));
  assert.throws(() =>
    serverConfig({
      NODE_ENV: "production",
      PLATFORM_ENABLED: "true",
      DATA_MODE: "connected",
      PLATFORM_PUBLIC_ORIGIN: "http://localhost:3001",
    }),
  );
  assert.throws(() =>
    serverConfig({
      NODE_ENV: "production",
      PLATFORM_ENABLED: "true",
      DATA_MODE: "demo",
      PLATFORM_PUBLIC_ORIGIN: "https://stage.example",
    }),
  );
  assert.deepEqual(
    serverConfig({
      NODE_ENV: "production",
      PLATFORM_ENABLED: "true",
      DATA_MODE: "connected",
      PLATFORM_PUBLIC_ORIGIN: "https://stage.example",
      HOST: "0.0.0.0",
    }),
    { port: 3001, host: "0.0.0.0" },
  );
});

test("partial Outright recovery does not hide a current open football fixture; restored lineage is not mistaken for absence of new observations", () => {
  const state = new TradeState(),
    at = Date.now();
  state.apply(
    "prematch",
    [
      {
        fixtureId: 900123,
        fixture: {
          sport: { name: "Football" },
          status: 1,
          startDate: new Date(at + 3600000),
        },
        markets: [
          {
            id: 1,
            status: 1,
            bets: [{ id: "1", price: "2.1", status: 1, isChanged: -1 }],
          },
        ],
      },
    ],
    at,
    { source: "snapshot", receivedAt: at },
  );
  state.rows.prematch.get(900123)!.restored = true;
  state.apply(
    "prematch",
    [
      {
        fixtureId: 900123,
        markets: [
          {
            id: 1,
            status: 1,
            bets: [{ id: "1", price: "2.2", status: 1, isChanged: -1 }],
          },
        ],
      },
    ],
    at + 1,
    { source: "amqp", receivedAt: at + 1 },
  );
  state.set("prematch", {
    phase: "connected",
    outrightRecovery: {
      status: "partial",
      checkedAt: new Date(at).toISOString(),
    },
  });
  const report = feedEvidence(state.feed(), at + 1);
  assert.equal(report.health, "degraded");
  assert.equal(report.candidateEvents, 1);
  assert.equal(report.events[0].restoredLineage, true);
  assert.equal(report.events[0].evidence, "observed_in_current_worker_session");
  assert.equal(report.ui.footballPreMatchNoSearch, 1);
});
