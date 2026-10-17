import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clients as createClients } from "./provider.js";
import { TradeState } from "./state.js";
import { createPublisher, readConnectedFeed } from "@lsports/feed-store";
import { createApp } from "../../api/src/app.js";
test("real SDK snapshot array preserves fixtures through state, atomic projection and API, including unpriced/unknown sports", async () => {
  const rows = [
    {
      FixtureId: 101,
      Fixture: {
        Sport: { Id: 6046, Name: "Football" },
        Status: 1,
        Participants: [{ Name: "Test A" }],
      },
      Markets: [
        {
          Id: 1,
          Name: "Winner",
          Status: 1,
          Bets: [{ Id: "1001", Name: "1", Price: "2.1", Status: 1 }],
        },
      ],
    },
    {
      FixtureId: 102,
      Fixture: { Sport: { Name: "Unmapped test sport" }, Status: 3 },
      Markets: [],
    },
  ];
  let responseBody: unknown = rows;
  const supplier = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ Header: { HttpStatusCode: 200 }, Body: responseBody }),
    );
  });
  await new Promise<void>((r) => supplier.listen(0, "127.0.0.1", r));
  const dir = await mkdtemp(join(tmpdir(), "trade-coverage-"));
  let api: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
  try {
    const address = supplier.address();
    assert(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const provider = clients(
      {
        lane: "prematch",
        packageId: 4511,
        username: randomUUID(),
        password: randomUUID(),
        hostname: "unused",
        vhost: "StmPreMatch",
        queue: "_4511_",
        port: 5672,
        tls: false,
      },
      { snapshotUrl: url, customersUrl: url },
    );
    const decoded = await provider.snapshot();
    assert.equal(decoded.length, 2);
    assert.deepEqual(provider.snapshotAudit?.(), {
      bodyShape: "array",
      providerRows: 2,
      sdkRows: 2,
      acceptedRows: 2,
      filters: "none",
    });
    const state = new TradeState();
    state.replace("prematch", decoded, Date.now(), provider.snapshotAudit?.());
    state.set("prematch", { phase: "connected" });
    const path = join(dir, "feed.json");
    await createPublisher(path)(state.feed());
    api = createApp({ getEvents: () => readConnectedFeed(path) }).listen(
      0,
      "127.0.0.1",
    );
    await new Promise<void>((r) => api!.once("listening", r));
    const aa = api.address();
    assert(aa && typeof aa !== "string");
    const feed = await (
      await fetch(`http://127.0.0.1:${aa.port}/api/events`)
    ).json();
    assert.equal(feed.events.length, 2);
    assert.equal(feed.events[1].sport, "otros");
    assert.equal(feed.coverage.prematch.rowsPublished, 2);
    assert.equal(feed.coverage.prematch.eventsWithSelectableOdds, 1);
    const health = await (
      await fetch(`http://127.0.0.1:${aa.port}/api/health`)
    ).json();
    assert.equal(health.apiEventCount, 2);
    responseBody = { Events: rows };
    await assert.rejects(() => provider.snapshot(), /snapshot.events/);
  } finally {
    if (api) await new Promise<void>((r) => api!.close(() => r()));
    await new Promise<void>((r) => supplier.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
test("coverage separates controls, missing fixture metadata, and deliberate prematch/inplay duplicate removal", () => {
  const s = new TradeState();
  s.recordMessage("inplay", 32, 0, false);
  s.recordMessage("inplay", 31, 0, false, 3);
  s.apply(
    "inplay",
    [{ fixtureId: 7, markets: [{ id: 1, bets: [] }] }],
    Date.now(),
  );
  let feed = s.feed();
  assert.equal(feed.events.length, 0);
  assert.equal(feed.coverage?.inplay.messages, 2);
  assert.equal(feed.coverage?.inplay.eventUpdatesReceived, 0);
  assert.equal(feed.coverage?.inplay.rowsWithoutFixture, 1);
  assert.equal(feed.coverage?.inplay.keepAliveActiveEvents, 3);
  s.apply(
    "inplay",
    [{ fixtureId: 7, fixture: { sport: { name: "Football" }, status: 2 } }],
    Date.now(),
  );
  s.apply(
    "prematch",
    [{ fixtureId: 7, fixture: { sport: { name: "Football" }, status: 1 } }],
    Date.now(),
  );
  feed = s.feed();
  assert.equal(feed.events.length, 1);
  assert.equal(feed.coverage?.inplay.rowsWithoutFixture, 0);
  assert.equal(feed.coverage?.prematch.rowsHiddenAsDuplicate, 1);
  assert.equal(feed.coverage?.inplay.rowsPublished, 1);
});
test("subscription, quota and schedule diagnostics use SDK read routes without filters or subscription writes", async () => {
  const paths: string[] = [];
  const supplier = createServer(async (req, res) => {
    paths.push(req.url!);
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.deepEqual(Object.keys(JSON.parse(body)).sort(), [
      "packageId",
      "password",
      "username",
    ]);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        Header: { HttpStatusCode: 200 },
        Body:
          req.url === "/package/GetPackageQuota"
            ? { CreditLimit: 10, CreditRemaining: 0, UsedCredit: 10 }
            : { Fixtures: [] },
      }),
    );
  });
  await new Promise<void>((r) => supplier.listen(0, "127.0.0.1", r));
  try {
    const a = supplier.address();
    assert(a && typeof a !== "string");
    const url = `http://127.0.0.1:${a.port}`;
    const provider = clients(
      {
        lane: "inplay",
        packageId: 4510,
        username: randomUUID(),
        password: randomUUID(),
        hostname: "unused",
        vhost: "StmInPlay",
        queue: "_4510_",
        port: 5672,
        tls: false,
      },
      { snapshotUrl: url, customersUrl: url },
    );
    assert.deepEqual(await provider.subscriptions?.(), { fixtures: 0 });
    assert.deepEqual(await provider.quota?.(), {
      creditLimit: 10,
      creditRemaining: 0,
      usedCredit: 10,
    });
    assert.deepEqual(await provider.schedule?.(), { fixtures: 0 });
    assert.deepEqual(paths, [
      "/Fixtures/Get",
      "/package/GetPackageQuota",
      "/Fixtures/InPlaySchedule",
    ]);
  } finally {
    await new Promise<void>((r) => supplier.close(() => r()));
  }
});

// Protocol tests isolate scheduling; cross-process coordination is exercised separately.
const clients = (pkg: Parameters<typeof createClients>[0], urls: Parameters<typeof createClients>[1]) =>
  createClients(pkg, urls, { run: (_operation, action) => action() });
