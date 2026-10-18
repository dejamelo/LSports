import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { snapshotCapacity, MiB } from "./snapshot-capacity.js";
import { clients } from "./provider.js";
import { OperationError } from "./diagnostics.js";

test("capacity has a finite default, rejects unlimited/invalid caps and requires conversion headroom", () => {
  assert.equal(snapshotCapacity({}, 2 * 1024 * MiB).limitBytes, 128 * MiB);
  assert.equal(snapshotCapacity({}, 2 * 1024 * MiB).allowed, true);
  assert.equal(snapshotCapacity({}, 128 * MiB).allowed, false);
  for (const value of ["-1", "0", "257", "1.5", "NaN", "Infinity"])
    assert.throws(() =>
      snapshotCapacity({ LSPORTS_SNAPSHOT_MAX_RESPONSE_MB: value }),
    );
});

test(
  "official SDK completes a >50 MiB snapshot with bounded cap, original timestamps/IDs and evidence; smaller cap still rejects HTTP 200",
  { timeout: 60000 },
  async () => {
    const previous = process.env.LSPORTS_SNAPSHOT_MAX_RESPONSE_MB;
    let requests = 0;
    const chunk = "x".repeat(MiB);
    const body = {
      Header: { HttpStatusCode: 200 },
      Body: [
        {
          FixtureId: 900555,
          Fixture: {
            Sport: { Id: 1, Name: "Football" },
            Status: 1,
            LastUpdate: "2026-10-18T14:39:04.0173136",
          },
          Markets: [
            {
              Id: 1,
              Status: 1,
              Bets: [
                {
                  Id: "316061192054056499",
                  Name: "ISOLATED",
                  Price: "2.63",
                  Status: 1,
                  LastUpdate: "2026-10-18T14:39:04.0173136",
                },
              ],
            },
          ],
        },
      ],
    };
    const prefix = JSON.stringify(body).slice(0, -1) + ',"Padding":"';
    const server = createServer(async (req, res) => {
      for await (const _ of req) {
      }
      requests++;
      res.on("error", () => {});
      res.setHeader("Content-Type", "application/json");
      res.write(prefix);
      // Server sends chunks to avoid creating a second giant fixture string.
      for (let i = 0; i < 51 && !res.destroyed; i++) {
        if (!res.write(chunk))
          await new Promise<void>((resolve) => {
            const done = () => {
              res.off("drain", done);
              res.off("close", done);
              resolve();
            };
            res.once("drain", done);
            res.once("close", done);
          });
      }
      if (!res.destroyed) res.end('"}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const address = server.address();
      assert(address && typeof address !== "string");
      const url = `http://127.0.0.1:${address.port}`;
      const api = clients(
        {
          lane: "prematch",
          packageId: 4511,
          username: "isolated",
          password: "never-log-this",
          hostname: "unused",
          vhost: "StmPreMatch",
          queue: "_4511_",
          port: 5672,
          tls: false,
        },
        { snapshotUrl: url, customersUrl: url },
        { run: async (_name, action) => action() },
      );
      process.env.LSPORTS_SNAPSHOT_MAX_RESPONSE_MB = "50";
      await assert.rejects(
        () => api.snapshot(),
        (e) => {
          assert(e instanceof OperationError);
          assert.equal(e.diagnostic.category, "response_limit");
          assert.equal(e.diagnostic.reason, "response_size_limit");
          assert.equal(e.diagnostic.responseLimitBytes, 50 * MiB);
          assert(!JSON.stringify(e).includes("never-log-this"));
          return true;
        },
      );
      process.env.LSPORTS_SNAPSHOT_MAX_RESPONSE_MB = "128";
      const rows = await api.snapshot();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].fixtureId, 900555);
      assert.equal(rows[0].markets?.[0].bets?.[0].id, "316061192054056499");
      assert.equal(
        rows[0].markets?.[0].bets?.[0].lastUpdate?.toISOString(),
        "2026-10-18T14:39:04.017Z",
      );
      const audit = api.snapshotAudit?.();
      assert.equal(audit?.acceptedRows, 1);
      assert(audit?.transport?.receivedBytes! > 50 * MiB);
      assert.equal(audit?.transport?.responseLimitBytes, 128 * MiB);
      assert.equal(audit?.transport?.timeoutMs, 20000);
      assert.equal(requests, 2);
    } finally {
      if (previous === undefined)
        delete process.env.LSPORTS_SNAPSHOT_MAX_RESPONSE_MB;
      else process.env.LSPORTS_SNAPSHOT_MAX_RESPONSE_MB = previous;
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);

test("full response evidence is released after success and failure even if an async resource retains the operation context", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const { operation, sdkAxios, snapshotResponsePayload } = await import(
    "./diagnostics.js"
  );
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ Header: { HttpStatusCode: 200 }, Body: [] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    for (const fail of [false, true]) {
      let retained: () => unknown = () => undefined;
      const run = () =>
        operation("snapshot.events", "http", async () => {
          await sdkAxios.post(url, {});
          assert(snapshotResponsePayload());
          retained = AsyncLocalStorage.bind(snapshotResponsePayload);
          if (fail) throw new Error("isolated failure");
        });
      if (fail) await assert.rejects(run, OperationError);
      else await run();
      assert.equal(retained(), undefined);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
