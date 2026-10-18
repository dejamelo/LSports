import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import type amqp from "amqplib";
import type { ConsumeMessage } from "amqplib";
import type { EventFeed } from "@lsports/contracts";
import { TradeState, type TradeEvent } from "./state.js";
import type { PackageConfig } from "./config.js";
import type { ProviderClients } from "./provider.js";
import { OperationError } from "./diagnostics.js";
const { session } = await import(
  process.env.RECOVERY_SESSION_MODULE || "./connected.js"
);
const pkg: PackageConfig = {
  lane: "prematch",
  packageId: 4511,
  username: "isolated-test",
  password: "",
  hostname: "unused-test-host",
  vhost: "StmPreMatch",
  queue: "_4511_",
  port: 5672,
  tls: false,
};
const fixtureId = 20572565;
const wire = (type: number, body: object, guid: string): ConsumeMessage =>
  ({
    content: Buffer.from(
      JSON.stringify({
        Header: { Type: type, MsgGuid: guid, ServerTimestamp: Date.now() },
        Body: body,
      }),
    ),
    properties: { headers: {} },
    fields: { redelivered: false },
  }) as ConsumeMessage;
const fixtureMessage = () =>
  wire(
    1,
    {
      Events: [
        {
          FixtureId: fixtureId,
          Fixture: {
            Sport: { Name: "Football" },
            Status: 1,
            Participants: [{ Name: "ISOLATED A" }, { Name: "ISOLATED B" }],
          },
        },
      ],
    },
    "fixture-prefix",
  );
const marketMessage = (n: number) =>
  wire(
    3,
    {
      Events: [
        {
          FixtureId: fixtureId,
          Markets: [
            {
              Id: 1,
              Name: "TEST 1X2",
              Status: 1,
              Bets: [
                {
                  Id: "1",
                  Name: "1",
                  Status: 1,
                  Price: (2.1 + (n % 10) / 100).toFixed(2),
                },
                { Id: "2", Name: "X", Status: 1, Price: "3.5" },
                { Id: "3", Name: "2", Status: 1, Price: "4.2" },
              ],
            },
          ],
        },
      ],
    },
    `market-${n}`,
  );
const closedFixture: TradeEvent = {
  fixtureId: 20549719,
  fixture: { sport: { name: "Football" }, status: 3 },
  markets: [
    {
      id: 1,
      status: 3,
      bets: [
        {
          id: "closed",
          price: "9.99",
          status: 3,
          settlement: 2,
          isChanged: -1,
        },
      ],
    },
  ],
};
async function harness(flood: boolean, memoryRefusal=false) {
  const state = new TradeState(),
    abort = new AbortController();
  let receive: (m: ConsumeMessage) => void = () => {};
  let sequence = 0,
    acks = 0,
    attempts = 0,
    retryAt = 0,
    earlyCalls = 0,
    savedPrice = "",
    waitingObserved = false,
    connected: EventFeed | undefined;
  const attemptsAt: number[] = [];
  state.apply(
    "prematch",
    [
      {
        fixtureId: 777,
        outright: {
          competitionId: 77,
          fixture: { sport: { name: "Horse Racing" }, status: 1 },
        },
        markets: [
          {
            id: 160,
            status: 1,
            bets: [{ id: "old", price: "8.00", status: 1, isChanged: -1 }],
          },
        ],
      },
    ],
    Date.now() - 86400000,
  );
  state.rows.prematch.get("outright:77:777")!.restored = true;
  state.set("prematch",{lastSnapshotAt:new Date(Date.now()-300000).toISOString()});
  const currentPrice = () =>
    state.rows.prematch.get(fixtureId)?.markets.get("1")?.bets?.[0]?.price;
  const channel = Object.assign(new EventEmitter(), {
    async prefetch() {},
    async consume(_queue: string, callback: typeof receive) {
      receive = callback;
      return { consumerTag: "isolated" };
    },
    ack() {
      acks++;
      assert.equal(currentPrice(), savedPrice || undefined);
      if (!abort.signal.aborted && flood) receive(marketMessage(++sequence));
    },
    nack() {
      assert.fail("Valid messages must not be discarded or requeued");
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
  const api: ProviderClients = {
    async distributionStatus() {
      return {
        isDistributionOn: true,
        consumers: [],
        numberMessagesInQueue: 0,
        messagesPerSecond: 0,
      };
    },
    async startDistribution() {},
    async catalog() {
      return [];
    },
    async snapshot() {
      attempts++;
      attemptsAt.push(Date.now());
      if (attempts === 1) {
        receive(fixtureMessage());
        receive(marketMessage(++sequence));
        retryAt = Date.now() + 1200;
        throw new OperationError({
          operation: "snapshot.events",
          protocol: "http",
          category: memoryRefusal?"response_limit":"rate_limited",
          ...(memoryRefusal?{reason:"memory_budget_exceeded" as const}:{}),
          deferred: true,
          retryAt: new Date(retryAt).toISOString(),
          retryAfterMs: 1200,
          message: "ISOLATED scheduler deferral",
        });
      }
      if (Date.now() < retryAt) earlyCalls++;
      return [
        {
          fixtureId,
          fixture: { sport: { name: "Football" }, status: 1 },
          markets: [
            {
              id: 1,
              status: 1,
              bets: [
                { id: "1", price: "2.1", status: 1, isChanged: -1 },
                { id: "2", price: "3.5", status: 1, isChanged: -1 },
                { id: "3", price: "4.2", status: 1, isChanged: -1 },
              ],
            },
          ],
        },
        closedFixture,
      ];
    },
    async outrightFixtures() {
      throw new OperationError({
        operation: "snapshot.outright.fixtures",
        protocol: "http",
        category: "rate_limited",
        deferred: true,
        retryAt: new Date(Date.now() + 600000).toISOString(),
        message: "ISOLATED independent Outright deferral",
      });
    },
  };
  const timer = setTimeout(() => abort.abort(), 8000);
  const controls = !flood
    ? setInterval(
        () =>
          receive(wire(32, { FeedInterrupted: [] }, `control-${++sequence}`)),
        20,
      )
    : undefined;
  let sessionError: unknown;
  try {
    await session(
      pkg,
      {
        packages: [pkg],
        snapshotUrl: "https://unused.test",
        customersUrl: "https://unused.test",
        recoveryMs: 300000,
        staleMs: 90000,
      },
      state,
      async () => {
        // Yield to actual I/O/timers, as persistence does in production.
        await pause(1);
        savedPrice = currentPrice() || "";
        const c = state.connections.prematch;
        if (c.recoveryProgress?.stage === "waiting_retry") {
          waitingObserved = true;
          assert.equal(c.phase, "recovering");
          assert.equal(c.recoveryProgress.regularSnapshotReady, false);
          assert.equal(c.recoveryProgress.processedAtHandoff,c.recoveryProgress.queuedAtHandoff);
          assert(c.recoveryProgress.lastProgressAt);
          assert.equal(c.lastSnapshotDiagnostic?.operation,"snapshot.events");
          assert(state.feed().events.every((e) => e.available === false));
        }
        if (c.phase === "connected" && attempts >= 2 && !abort.signal.aborted) {
          connected = state.feed();
          abort.abort();
        }
      },
      abort.signal,
      {
        connect: (async () => connection) as unknown as typeof amqp.connect,
        clientFactory: () => api,
      },
    );
  } catch (error) {
    sessionError = error;
  } finally {
    clearTimeout(timer);
    if (controls) clearInterval(controls);
    abort.abort();
  }
  assert.equal(
    attempts,
    2,
    "Continuous AMQP traffic must not starve the scheduled snapshot retry",
  );
  if (sessionError) throw sessionError;
  assert.equal(earlyCalls, 0);
  assert(attemptsAt[1] >= retryAt);
  assert(waitingObserved);
  assert(connected);
  const event = connected.events.find((e) => e.id === `prematch:${fixtureId}`)!;
  assert.equal(event.available, true);
  assert.equal(event.selections.filter((s) => s.available).length, 3);
  assert.equal(
    connected.events.find((e) => e.id === "prematch:20549719")!.available,
    false,
  );
  const restored = connected.events.find(
    (e) => e.id === "prematch:outright:77:777",
  )!;
  assert.equal(restored.selections[0].available, false);
  assert(
    restored.selections[0].unavailableReasons?.includes("awaiting_update"),
  );
  assert.equal(
    connected.connections!.prematch.outrightRecovery!.status,
    "rate_limited",
  );
  assert.equal(
    connected.connections!.prematch.recoveryProgress!.regularSnapshotReady,
    true,
  );
  assert(
    Date.parse(connected.connections!.prematch.lastSnapshotAttemptAt!) >=
      retryAt,
  );
  assert.equal(state.connections.prematch.phase, "stopped");
  assert(acks >= 2);
  return { state, connected, acks, attempts };
}
test("continuous valid AMQP markets cannot starve recovery handoff/retry; initial recovery, closed and unconfirmed stored quotes remain gated", async () => {
  const result = await harness(true);
  assert(result.acks > 2);
});
test("keepalives do not complete the initial recovery; scheduled retry can complete without AMQP data replenishment", async () => {
  const { connected } = await harness(false);
  assert(
    connected.coverage!.prematch.activity!.lastControlDecodedAt! >
      connected.coverage!.prematch.activity!.lastDataDecodedAt!,
  );
});

test("memory refusal keeps AMQP session alive, ACKs only persisted messages and waits for retry before completing the baseline",async()=>{await harness(true,true);});
