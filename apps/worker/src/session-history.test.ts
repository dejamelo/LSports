import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import amqp from "amqplib";
import { session } from "./connected.js";
import { TradeState } from "./state.js";
import { OperationError } from "./diagnostics.js";
import { feedEvidence } from "../../api/src/feed-evidence.js";
import type { PackageConfig } from "./config.js";

for (const rootClose of [false, true])
  test(
    `${rootClose ? "broker close" : "channel close"}: new session after channel closure resets readiness; cooldown is a consequence and does not erase the terminal cause`,
    { timeout: 10000 },
    async () => {
      const expectedReason = rootClose ? "connection_closed" : "channel_closed";
      const state = new TradeState();
      const first = new AbortController(),
        second = new AbortController();
      let calls = 0;
      let reconnected = false;
      let firstId = "";
      const pkg: PackageConfig = {
        lane: "inplay",
        packageId: 4510,
        username: "isolated",
        password: "",
        hostname: "unused",
        vhost: "StmInPlay",
        queue: "_4510_",
        port: 5672,
        tls: false,
      };
      const config = {
        packages: [pkg],
        snapshotUrl: "https://unused.invalid",
        customersUrl: "https://unused.invalid",
        recoveryMs: 300000,
        staleMs: 90000,
      };
      const make = () => {
        const channel = Object.assign(new EventEmitter(), {
          async prefetch() {},
          async consume() {
            return { consumerTag: "existing" };
          },
          ack() {},
          nack() {},
        });
        const connection = Object.assign(new EventEmitter(), {
          async createChannel() {
            return channel;
          },
          async close() {
            connection.emit("close");
          },
        });
        return { channel, connection };
      };
      const one = make();
      const clientFactory = () => ({
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
          calls++;
          if (calls > 1)
            throw new OperationError({
              operation: "snapshot.events",
              protocol: "http",
              category: "rate_limited",
              deferred: true,
              rateLimitSource: "local_operation_cooldown",
              retryAt: new Date(Date.now() + 300000).toISOString(),
              message: "isolated cooldown",
            });
          return [];
        },
      });
      await assert.rejects(
        () =>
          session(
            pkg,
            config,
            state,
            async () => {
              if (state.connections.inplay.phase === "connected") {
                firstId = state.connections.inplay.session!.id;
                assert.equal(
                  state.connections.inplay.recoveryProgress
                    ?.regularSnapshotReady,
                  true,
                );
                one.channel.emit("close");
                if (rootClose)
                  one.connection.emit(
                    "close",
                    Object.assign(new Error("private broker text"), {
                      code: 320,
                    }),
                  );
              }
            },
            first.signal,
            {
              connect: (async () =>
                one.connection) as unknown as typeof amqp.connect,
              clientFactory,
            },
          ),
        (e) =>
          e instanceof OperationError && e.diagnostic.reason === expectedReason,
      );
      assert(state.connections.inplay.lastSnapshotAt);
      assert.equal(state.connections.inplay.sessionEnds?.length, 1);
      assert.equal(
        state.connections.inplay.sessionEnds?.[0].diagnostic.reason,
        expectedReason,
      );
      const two = make();
      await session(
        pkg,
        config,
        state,
        async () => {
          const c = state.connections.inplay;
          if (
            c.recoveryProgress?.stage === "waiting_retry" &&
            !second.signal.aborted
          ) {
            reconnected = true;
            assert.notEqual(c.session?.id, firstId);
            assert.equal(c.recoveryProgress.regularSnapshotReady, false);
            assert.equal(c.phase, "recovering");
            assert.equal(
              c.diagnostic?.rateLimitSource,
              "local_operation_cooldown",
            );
            const report = feedEvidence(state.feed()).lanes.find(
              (l) => l.lane === "inplay",
            )!;
            assert.equal(
              report.sessionEnds[0].diagnostic?.reason,
              expectedReason,
            );
            assert.equal(
              report.sessionEnds[0].diagnostic?.operation,
              rootClose ? "amqp.connection" : "amqp.channel",
            );
            if (rootClose)
              assert.equal(report.sessionEnds[0].diagnostic?.amqpCode, 320);
            assert(!JSON.stringify(report).includes("private broker text"));
            assert.equal(report.sessionEnds[0].id, firstId);
            assert(state.feed().events.every((e) => !e.available));
            second.abort();
          }
        },
        second.signal,
        {
          connect: (async () =>
            two.connection) as unknown as typeof amqp.connect,
          clientFactory,
        },
      );
      assert(reconnected);
      assert.equal(calls, 2);
      assert.equal(
        state.connections.inplay.sessionEnds?.[0].diagnostic.reason,
        expectedReason,
      );
      assert.equal(
        state.connections.inplay.sessionEnds?.[1].diagnostic.reason,
        "worker_stopped",
      );
    },
  );
