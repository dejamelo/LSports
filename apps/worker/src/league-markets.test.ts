import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownEntityKeys } from "trade360-nodejs-sdk";
import amqp, { type ConsumeMessage } from "amqplib";
import { createPublisher } from "@lsports/feed-store";
import { TradeState } from "./state.js";
import { decodeMessage } from "./messages.js";
import { OperationError } from "./diagnostics.js";
import { checkpoint, restore } from "./persistence.js";
import { session } from "./connected.js";
import type { PackageConfig } from "./config.js";
// Isolated sample following SDK 3.10.10 nested-event-transform/type40 tests.
// Not captured supplier data; never published by the application outside these tests.
const at = Date.parse("2026-10-18T20:00:00Z");
function body(price = "2.50", stamp = "2026-10-18T20:00:00.0173136") {
  return {
    Competition: {
      Id: 900067,
      Name: "ISOLATED league",
      Type: 3,
      NextFixtureStartTime: "2026-10-19T20:00:00Z",
      Competitions: [
        {
          Id: 902029,
          Name: "ISOLATED season",
          Type: 4,
          Events: [
            {
              FixtureId: 926721036,
              FixtureName: "ISOLATED winner",
              Markets: [
                {
                  Id: 274,
                  Name: "Outright Winner",
                  Status: 1,
                  Bets: [
                    {
                      Id: 926556346,
                      Name: "ISOLATED selection",
                      Status: 1,
                      Price: price,
                      LastUpdate: stamp,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}
function wire(value: unknown = body(), guid = "type40", time = at + 1000) {
  return Buffer.from(
    JSON.stringify({
      Header: { Type: 40, MsgGuid: guid, ServerTimestamp: time },
      Body: value,
    }),
  );
}
const key = "outright:900067:926721036";
test("official type 40 uses nested seasons, string IDs and precise UTC ordering, preserves existing participants/results, and survives checkpoint restore", async () => {
  assert.equal(knownEntityKeys.get(40), "OutrightLeagueMarketUpdate");
  const multiple = body();
  const other = structuredClone(multiple.Competition.Competitions[0]);
  other.Id++;
  other.Events[0].FixtureId++;
  multiple.Competition.Competitions.push(other);
  const nested = decodeMessage(wire(multiple));
  assert.equal(nested.events.length, 2);
  assert.deepEqual(
    nested.events.map((e) => e.outright?.leagueSeason?.id),
    [902029, 902030],
  );
  assert.deepEqual(
    nested.events.map((e) => e.fixtureId),
    [926721036, 926721037],
  );
  const active = new TradeState();
  active.apply(
    "prematch",
    [
      {
        fixtureId: 926721036,
        outright: {
          competitionId: 900067,
          fixture: { status: 1, sport: { name: "Football" } },
        },
      },
    ],
    at - 1000,
  );
  active.apply("prematch", nested.events, nested.at);
  active.set("prematch", { phase: "connected" });
  assert.equal(
    active.feed().events[0].markets?.[0].selections[0].priceOrderingSafe,
    true,
  );

  const state = new TradeState();
  state.apply(
    "prematch",
    [
      {
        fixtureId: 926721036,
        outright: {
          competitionId: 900067,
          fixture: {
            status: 3,
            participants: [{ id: 1, name: "existing participant" }],
          },
        },
        markets: [
          {
            id: 274,
            status: 3,
            bets: [{ id: "926556346", settlement: 1, price: "2.1", status: 1, isChanged: 0 }],
          },
        ],
      },
    ],
    at - 1000,
  );
  const decoded = decodeMessage(wire(), {}, {}, true);
  assert.equal(decoded.type, 40);
  assert.equal(decoded.events[0].marketMessageType, 40);
  assert.deepEqual(decoded.events[0].outright?.leagueSeason, {
    id: 902029,
    name: "ISOLATED season",
    type: 4,
  });
  assert.equal(decoded.events[0].markets?.[0].bets?.[0].id, "926556346");
  state.apply("prematch", decoded.events, decoded.at);
  // Older message arrives later, but must not replace the nanosecond ordering key.
  const older = decodeMessage(
    wire(body("8.0", "2026-10-18T20:00:00.0173135Z"), "old", at + 2000),
  );
  state.apply("prematch", older.events, older.at);
  const row = state.rows.prematch.get(key)!;
  assert.equal(row.markets.get("274")?.bets?.[0].price, "2.50");
  assert.equal(row.markets.get("274")?.bets?.[0].settlement, 1);
  assert.equal(row.fixture?.value.participants?.length, 1);
  assert.equal(row.fixture?.value.status, 3);
  assert.equal(row.marketReceipt?.messagesByType["40"], 2);
  assert.equal(
    row.settlementAudit?.get("274:926556346")?.last40?.source,
    "amqp.40",
  );
  assert(state.feed().events.every((e) => !e.available));
  const dir = await mkdtemp(join(tmpdir(), "adl-league-restore-"));
  try {
    const path = join(dir, "feed.json");
    await createPublisher(path)(state.feed(), checkpoint(state));
    const restarted = new TradeState();
    await restore(restarted, path);
    assert.deepEqual(
      restarted.rows.prematch.get(key)?.outright?.leagueSeason,
      row.outright?.leagueSeason,
    );
    assert.equal(
      restarted.rows.prematch.get(key)?.markets.get("274")?.bets?.[0]
        .settlement,
      1,
    );
    assert.deepEqual(restarted.rows.prematch.get(key)?.betOrder, row.betOrder);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("type 40 rejects flat type-41 shape, malformed nesting and invalid times without reporting a successful empty update", () => {
  const base = body();
  for (const value of [
    null,
    { Competition: { Id: 1, Events: [] } },
    {
      Competition: {
        Id: 1,
        Competitions: [
          {
            Id: 2,
            Events: [{ FixtureId: 3, Markets: [{ Id: 4, Bets: [null] }] }],
          },
        ],
      },
    },
    body("2.5", "2026-02-30T20:00:00Z"),
  ]) {
    assert.throws(
      () => decodeMessage(wire(value)),
      (e) =>
        e instanceof OperationError &&
        e.diagnostic.messageMetadata?.messageType === 40 &&
        ["invalid_event_body", "invalid_timestamp"].includes(
          e.diagnostic.reason!,
        ),
    );
  }
  const flat = {
    Competition: {
      Id: base.Competition.Id,
      Events: base.Competition.Competitions[0].Events,
    },
  };
  assert.throws(
    () => decodeMessage(wire(flat)),
    (e) =>
      e instanceof OperationError &&
      e.diagnostic.messageMetadata?.entityShape?.flatEventsPresent === true,
  );
});
test(
  "redelivered type 40 persists before ACK, deduplicates and hands off to the next football update",
  { timeout: 10000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "adl-league-consumer-"));
    const path = join(dir, "feed.json");
    const state = new TradeState();
    const abort = new AbortController();
    let callback: (m: ConsumeMessage) => void = () => {};
    let saved: any;
    let acks = 0;
    let connected = false;
    const league = {
      content: wire(),
      properties: {},
      fields: { redelivered: true },
    } as ConsumeMessage;
    const football = {
      content: Buffer.from(
        JSON.stringify({
          Header: { Type: 3, MsgGuid: "football", ServerTimestamp: at + 2000 },
          Body: {
            Events: [
              {
                FixtureId: 900111,
                Markets: [
                  {
                    Id: 1,
                    Status: 1,
                    Bets: [{ Id: 900112, Price: "2.2", Status: 1 }],
                  },
                ],
              },
            ],
          },
        }),
      ),
      properties: {},
      fields: { redelivered: false },
    } as ConsumeMessage;
    const channel = Object.assign(new EventEmitter(), {
      async prefetch() {},
      async consume(_q: string, cb: typeof callback) {
        callback = cb;
        return { consumerTag: "existing-queue" };
      },
      ack(msg: ConsumeMessage) {
        const row = saved.workerCheckpoint.outright.find(
          (r: any) => r.fixtureId === 926721036,
        );
        assert.equal(row.markets[0][1].bets[0].price, "2.50");
        if (msg === football)
          assert(
            saved.events.some(
              (e: any) =>
                e.id === "prematch:900111" &&
                e.markets[0].selections[0].odds === 2.2,
            ),
          );
        acks++;
      },
      nack() {
        assert.fail("valid type 40 must not be discarded");
      },
    });
    const connection = Object.assign(new EventEmitter(), {
      async createChannel() {
        return channel;
      },
      async close() {
        connection.emit("close");
      },
    });
    const pkg: PackageConfig = {
      lane: "prematch",
      packageId: 4511,
      username: "isolated",
      password: "",
      hostname: "unused",
      vhost: "StmPreMatch",
      queue: "_4511_",
      port: 5672,
      tls: false,
    };
    const publish = createPublisher(path);
    try {
      await session(
        pkg,
        {
          packages: [pkg],
          snapshotUrl: "https://unused.invalid",
          customersUrl: "https://unused.invalid",
          recoveryMs: 300000,
          staleMs: 90000,
        },
        state,
        async () => {
          await publish(state.feed(), checkpoint(state));
          saved = JSON.parse(await readFile(path, "utf8"));
          if (state.connections.prematch.phase === "connected") {
            connected = true;
            assert.equal(acks, 3);
            abort.abort();
          }
        },
        abort.signal,
        {
          connect: (async () => connection) as unknown as typeof amqp.connect,
          clientFactory: () => ({
            async startDistribution() {},
            async distributionStatus() {
              return {
                isDistributionOn: true,
                consumers: [],
                numberMessagesInQueue: 0,
                messagesPerSecond: 0,
              };
            },
            async catalog() {
              return [];
            },
            async snapshot() {
              callback(league);
              callback(league);
              callback(football);
              return [
                {
                  fixtureId: 900111,
                  fixture: { status: 1, sport: { name: "Football" } },
                },
              ];
            },
          }),
        },
      );
      assert(connected);
      assert.equal(
        state.rows.prematch.get(key)?.marketReceipt?.messagesByType["40"],
        1,
      );
      assert.equal(state.rows.prematch.get(key)?.fixture, undefined); // No invented league fixture metadata.
      const restarted = new TradeState();
      await restore(restarted, path);
      assert.equal(restarted.rows.prematch.get(key)?.markets.size, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "type 40 storage failure requests requeue without ACK or continuing with football",
  { timeout: 10000 },
  async () => {
    const state = new TradeState();
    const abort = new AbortController();
    let callback: (m: ConsumeMessage) => void = () => {};
    let nacks = 0;
    const channel = Object.assign(new EventEmitter(), {
      async prefetch() {},
      async consume(_q: string, cb: typeof callback) {
        callback = cb;
        return { consumerTag: "existing" };
      },
      ack() {
        assert.fail("No ACK before durable storage");
      },
      nack(_m: ConsumeMessage, all: boolean, requeue: boolean) {
        assert.equal(all, false);
        assert.equal(requeue, true);
        nacks++;
      },
    });
    const connection = Object.assign(new EventEmitter(), {
      async createChannel() {
        return channel;
      },
      async close() {
        connection.emit("close");
      },
    });
    const pkg: PackageConfig = {
      lane: "prematch",
      packageId: 4511,
      username: "isolated",
      password: "",
      hostname: "unused",
      vhost: "StmPreMatch",
      queue: "_4511_",
      port: 5672,
      tls: false,
    };
    await assert.rejects(
      () =>
        session(
          pkg,
          {
            packages: [pkg],
            snapshotUrl: "https://unused.invalid",
            customersUrl: "https://unused.invalid",
            recoveryMs: 300000,
            staleMs: 90000,
          },
          state,
          async () => {
            if (state.rows.prematch.get(key)?.markets.size)
              throw new OperationError({
                operation: "file.persist",
                protocol: "local",
                category: "unexpected",
                message: "isolated write failure",
              });
          },
          abort.signal,
          {
            connect: (async () => connection) as unknown as typeof amqp.connect,
            clientFactory: () => ({
              async startDistribution() {},
              async distributionStatus() {
                return {
                  isDistributionOn: true,
                  consumers: [],
                  numberMessagesInQueue: 0,
                  messagesPerSecond: 0,
                };
              },
              async catalog() {
                return [];
              },
              async snapshot() {
                callback({
                  content: wire(),
                  properties: {},
                  fields: { redelivered: true },
                } as ConsumeMessage);
                return [];
              },
            }),
          },
        ),
      OperationError,
    );
    assert.equal(nacks, 1);
    assert.equal(state.connections.prematch.phase, "error");
    assert.equal(
      state.connections.prematch.diagnostic?.messageMetadata?.messageType,
      40,
    );
  },
);
