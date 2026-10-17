import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolveConsumeQueueName } from "trade360-nodejs-sdk";
import { loadPackageConfig } from "./config.js";
import { diagnosePackage } from "./diagnose-runner.js";
import type { clients } from "./provider.js";
import type amqp from "amqplib";
test("official SDK defaults include both underscores and correct vhosts; explicit bare ID is warned, never rewritten or declared", async () => {
  const names = [
    "LSPORTS_PREMATCH_USERNAME",
    "LSPORTS_PREMATCH_PASSWORD",
    "LSPORTS_INPLAY_USERNAME",
    "LSPORTS_INPLAY_PASSWORD",
    "LSPORTS_PREMATCH_PACKAGE_ID",
    "LSPORTS_INPLAY_PACKAGE_ID",
    "LSPORTS_PREMATCH_QUEUE",
    "LSPORTS_INPLAY_QUEUE",
    "LSPORTS_PREMATCH_VHOST",
    "LSPORTS_INPLAY_VHOST",
  ];
  const before = names.map((n) => process.env[n]);
  try {
    names.forEach((n) => delete process.env[n]);
    for (const name of names.slice(0, 4)) process.env[name] = randomUUID();
    for (const [lane, id, vhost] of [
      ["prematch", 4511, "StmPreMatch"],
      ["inplay", 4510, "StmInPlay"],
    ] as const) {
      const pkg = loadPackageConfig(lane);
      assert.equal(pkg.queue, `_${id}_`);
      assert.equal(pkg.queue, resolveConsumeQueueName({ packageId: id }));
      assert.equal(pkg.vhost, vhost);
      assert.equal(pkg.queueSource, "sdk_default");
    }
    process.env.LSPORTS_INPLAY_QUEUE = " 4510 ";
    const pkg = loadPackageConfig("inplay");
    assert.equal(pkg.queue, "4510");
    assert.equal(pkg.defaultQueue, "_4510_");
    assert.equal(pkg.queueSource, "environment_override");
    const api: ReturnType<typeof clients> = {
      async distributionStatus() {
        return {
          isDistributionOn: true,
          consumers: [],
          numberMessagesInQueue: 0,
          messagesPerSecond: 0,
        };
      },
      async startDistribution() {
        assert.fail("Must not change provider");
      },
      async snapshot() {
        return [];
      },
      async catalog() {
        return [];
      },
    };
    const records: Record<string, unknown>[] = [];
    await diagnosePackage(
      pkg,
      {
        snapshotUrl: "https://stm-snapshot.lsports.eu",
        customersUrl: "https://stm-api.lsports.eu",
      },
      (r) => records.push(r),
      {
        clientFactory: () => api,
        connect: (async () => {
          throw Object.assign(new Error("unreachable"), {
            code: "ECONNREFUSED",
          });
        }) as typeof amqp.connect,
      },
    );
    const summary = records[0].amqp as Record<string, unknown>;
    assert.equal(summary.queue, "4510");
    assert.equal(summary.sdkDefaultQueue, "_4510_");
    assert.equal(summary.queueVariable, "LSPORTS_INPLAY_QUEUE");
    assert((records[0].warnings as string[]).some((w) => w.includes("_4510_")));
    process.env.LSPORTS_INPLAY_QUEUE = "";
    assert.equal(loadPackageConfig("inplay").queue, "_4510_");
    process.env.LSPORTS_PREMATCH_QUEUE = "provider-assigned";
    assert.equal(loadPackageConfig("prematch").queue, "provider-assigned");
  } finally {
    names.forEach((name, i) => {
      if (before[i] === undefined) delete process.env[name];
      else process.env[name] = before[i];
    });
  }
});
