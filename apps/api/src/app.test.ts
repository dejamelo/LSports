import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.js";
test("demo feed identifies fictional data and has unique usable selections", async () => {
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const feed = await (await fetch(`${base}/api/events`)).json();
    assert.equal(feed.mode, "demo");
    assert(feed.events.length > 0);
    const ids: string[] = [];
    for (const event of feed.events) {
      assert(event.selections.length > 1);
      for (const selection of event.selections) {
        assert(selection.odds > 1);
        ids.push(selection.id);
      }
    }
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(
      (await fetch(`${base}/api/bets`, { method: "POST" })).status,
      404,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
test("connected API returns an empty unavailable feed without demo fallback", async () => {
  const source = {
    async getEvents() {
      return {
        mode: "connected" as const,
        health: "unavailable" as const,
        notice: "Worker sin conexión",
        events: [],
      };
    },
  };
  const server = createApp(source).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const feed = await (await fetch(`${base}/api/events`)).json();
    assert.equal(feed.mode, "connected");
    assert.deepEqual(feed.events, []);
    assert.equal((await fetch(`${base}/api/health`)).status, 503);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
