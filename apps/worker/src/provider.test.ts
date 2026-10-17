import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { clients, decodeMessage, safeFailure } from "./provider.js";
import { loadConfig } from "./config.js";
const headers = {
  MessageGuid: "test-guid",
  MessageType: "3",
  timestamp_in_ms: 1700000000000,
};
test("official SDK decodes raw envelope and preserves oversized bet IDs and heartbeat interruption", () => {
  const raw =
    '{"Header":{"Type":3,"MsgGuid":"test-guid"},"Body":{"Events":[{"FixtureId":100,"Markets":[{"Id":1,"Status":1,"Bets":[{"Id":9223372036854775807,"Name":"1","Price":"2.1","Status":1}]}]}]}}';
  const result = decodeMessage(Buffer.from(raw), headers);
  assert.equal(
    result.events[0].markets?.[0].bets?.[0].id,
    "9223372036854775807",
  );
  const heartbeat = decodeMessage(
    Buffer.from(
      JSON.stringify({
        Header: { Type: 32, MsgGuid: "beat" },
        Body: { FeedInterrupted: [1] },
      }),
    ),
    headers,
  );
  assert.equal(heartbeat.interrupted, true);
  assert.throws(() => decodeMessage(Buffer.from(raw), {}));
});
test("SDK uses documented package snapshot routes with credentials only in server request body", async () => {
  const secret = randomUUID();
  const user = randomUUID();
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    requests.push({ url: req.url || "", body: JSON.parse(text) });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ Header: { HttpStatusCode: 200 }, Body: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    for (const lane of ["prematch", "inplay"] as const) {
      const client = clients(
        {
          lane,
          packageId: lane === "prematch" ? 4511 : 4510,
          username: user,
          password: secret,
          hostname: "unused",
          port: 5672,
          vhost: lane === "prematch" ? "StmPreMatch" : "StmInPlay",
          tls: false,
          queue: "unused",
        },
        { snapshotUrl: url, customersUrl: url },
      );
      assert.deepEqual(await client.snapshot(), []);
    }
    assert.deepEqual(
      requests.map((r) => r.url),
      ["/Prematch/GetEvents", "/Inplay/GetEvents"],
    );
    for (const request of requests) {
      assert.equal(request.body.password, secret);
      assert.equal(request.body.username, user);
      assert(!request.url.includes(secret));
    }
    assert(
      !JSON.stringify(safeFailure(new Error(`401 ${secret}`))).includes(secret),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("connected config requires credentials; no invented or demo credentials", () => {
  const names = [
    "LSPORTS_PREMATCH_USERNAME",
    "LSPORTS_PREMATCH_PASSWORD",
    "LSPORTS_INPLAY_USERNAME",
    "LSPORTS_INPLAY_PASSWORD",
  ];
  const previous = names.map((n) => process.env[n]);
  try {
    for (const n of names) delete process.env[n];
    assert.throws(() => loadConfig(), /Missing LSPORTS_PREMATCH_USERNAME/);
  } finally {
    names.forEach((n, i) => {
      if (previous[i] === undefined) delete process.env[n];
      else process.env[n] = previous[i];
    });
  }
});
