import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import amqp from "amqplib";
import type { ConsumeMessage } from "amqplib";
import { session } from "./connected.js";
import { TradeState } from "./state.js";
import type { PackageConfig } from "./config.js";
import { clients } from "./provider.js";
test("worker connects to configured queue, buffers deltas during snapshot, persists before ack and gates on shutdown", async () => {
  const state = new TradeState();
  const abort = new AbortController();
  let onMessage: (m: ConsumeMessage | null) => void = () => {};
  let acks = 0;
  let persistedOdds = 0;
  let finalOdds = 0;
  const channel = Object.assign(new EventEmitter(), {
    async prefetch(n: number) {
      assert.equal(n, 100);
    },
    async consume(
      queue: string,
      callback: typeof onMessage,
      options: { noAck: boolean },
    ) {
      assert.equal(queue, "_4511_");
      assert.equal(options.noAck, false);
      onMessage = callback;
      return { consumerTag: "test" };
    },
    ack() {
      assert.equal(persistedOdds, 2.8);
      acks++;
    },
    nack() {
      assert.fail("Valid delta must not be rejected");
    },
  });
  const conn = Object.assign(new EventEmitter(), {
    async createChannel() {
      return channel;
    },
    async close() {
      conn.emit("close");
    },
  });
  const pkg: PackageConfig = {
    lane: "prematch",
    packageId: 4511,
    username: "test-only",
    password: "",
    hostname: "stm-prematch.lsports.eu",
    vhost: "StmPreMatch",
    port: 5672,
    tls: false,
    queue: "_4511_",
  };
  const fakeClients: ReturnType<typeof clients> = {
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
      const msg = {
        content: Buffer.from(
          JSON.stringify({
            Header: { Type: 3, MsgGuid: "delta" },
            Body: {
              Events: [
                {
                  FixtureId: 100,
                  Markets: [
                    {
                      Id: 1,
                      Status: 1,
                      Bets: [{ Id: "123", Price: "2.8", Status: 1 }],
                    },
                  ],
                },
              ],
            },
          }),
        ),
        properties: {
          headers: {
            MessageGuid: "delta",
            MessageType: "3",
            timestamp_in_ms: Date.now() + 100,
          },
        },
      } as unknown as ConsumeMessage;
      onMessage(msg);
      onMessage(msg);
      return [
        {
          fixtureId: 100,
          fixture: { sport: { name: "Football" }, status: 1 },
          markets: [
            {
              id: 1,
              name: "Winner",
              status: 1,
              bets: [{ id: "123", price: "2", status: 1, isChanged: 0 }],
            },
          ],
        },
      ];
    },
  };
  await session(
    pkg,
    {
      packages: [pkg],
      snapshotUrl: "https://stm-snapshot.lsports.eu",
      customersUrl: "https://stm-api.lsports.eu",
      recoveryMs: 300000,
      staleMs: 90000,
    },
    state,
    async () => {
      persistedOdds = state.feed().events[0]?.selections[0]?.odds || 0;
      if (state.connections.prematch.phase === "connected") {
        finalOdds = persistedOdds;
        abort.abort();
      }
    },
    abort.signal,
    {
      connect: (async (options: amqp.Options.Connect) => {
        assert.equal(options.vhost, "StmPreMatch");
        assert.equal(options.hostname, pkg.hostname);
        return conn;
      }) as unknown as typeof amqp.connect,
      clientFactory: () => fakeClients,
    },
  );
  assert.equal(acks, 2);
  assert.equal(finalOdds, 2.8);
  assert.equal(state.connections.prematch.phase, "stopped");
  assert.equal(state.feed().events[0].selections[0].available, false);
});
test("snapshot HTTP failure remains identified after AMQP cleanup instead of becoming generic authentication or close error", async () => {
  const { OperationError } = await import("./diagnostics.js");
  const state = new TradeState();
  const abort = new AbortController();
  const channel = Object.assign(new EventEmitter(), {
    async prefetch() {},
    async consume() {
      return { consumerTag: "test" };
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
    username: "test-only",
    password: "",
    hostname: "stm-prematch.lsports.eu",
    vhost: "StmPreMatch",
    port: 5672,
    tls: false,
    queue: "_4511_",
  };
  const diagnostic = {
    operation: "snapshot.events" as const,
    protocol: "http" as const,
    category: "permission_denied" as const,
    httpStatus: 403,
    message: "Acceso denegado en snapshot.",
  };
  const fake: ReturnType<typeof clients> = {
    async distributionStatus() {
      return {
        isDistributionOn: true,
        consumers: [],
        numberMessagesInQueue: 0,
        messagesPerSecond: 0,
      };
    },
    async startDistribution() {},
    async snapshot() {
      throw new OperationError(diagnostic);
    },
    async catalog() {
      assert.fail("Snapshot failed first");
    },
  };
  await assert.rejects(
    () =>
      session(
        pkg,
        {
          packages: [pkg],
          snapshotUrl: "https://stm-snapshot.lsports.eu",
          customersUrl: "https://stm-api.lsports.eu",
          recoveryMs: 300000,
          staleMs: 90000,
        },
        state,
        async () => {},
        abort.signal,
        {
          clientFactory: () => fake,
          connect: (async () => connection) as unknown as typeof amqp.connect,
        },
      ),
    OperationError,
  );
  assert.deepEqual(state.connections.prematch.diagnostic, diagnostic);
  assert(
    state.connections.prematch.message.includes("snapshot.events [HTTP 403]"),
  );
});
