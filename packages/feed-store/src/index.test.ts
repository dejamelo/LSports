import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublisher, readConnectedFeed, unavailable } from "./index.js";
test("connected mode never falls back to demo when state missing, stale or invalid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trade-store-"));
  const path = join(dir, "feed.json");
  try {
    assert.deepEqual((await readConnectedFeed(path)).events, []);
    const publish = createPublisher(path);
    const feed = {
      ...unavailable("Test"),
      updatedAt: new Date().toISOString(),
    };
    await Promise.all([publish(feed), publish({ ...feed, notice: "latest" })]);
    assert.equal((await readConnectedFeed(path)).notice, "latest");
    assert.equal(
      (await readConnectedFeed(path, Date.now() + 21000)).health,
      "unavailable",
    );
    assert.deepEqual(
      (await readConnectedFeed(path, Date.now() + 21000)).events,
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
