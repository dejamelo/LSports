import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startSyntheticDemo } from "../../../scripts/synthetic-demo.js";
test("synthetic runner persists independently, settles/replays normally, rejects cross-origin control and restores settled tickets on restart", async () => {
  const parent = await mkdtemp(join(tmpdir(), "adl-synthetic-unit-")),
    directory = join(parent, "isolated");
  const sentinel = join(parent, "existing.env");
  await writeFile(sentinel, "preserve-me");
  let demo = await startSyntheticDemo({ directory, apiPort: 0, parentPort: 0 });
  try {
    const key = await readFile(
      join(
        demo.platform.directory,
        "credentials",
        demo.manifest.credentialId + ".key",
      ),
      "utf8",
    );
    const event = demo.getEvents().events[0],
      market = event.markets![0],
      selection = market.selections[0];
    const input = {
      clientId: demo.manifest.clientId,
      operationId: demo.manifest.operationId,
      currency: "ARS",
      playerId: "test-player",
      channel: "web",
      stakeMinor: "1000",
      selections: [
        {
          eventId: event.id,
          marketId: market.id,
          selectionId: selection.id,
          expectedOdds: selection.odds,
        },
      ],
    };
    const response = await fetch(
      demo.apiOrigin + "/api/integration/v1/tickets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "synthetic-restart-ticket",
        },
        body: JSON.stringify(input),
      },
    );
    assert.equal(response.status, 201);
    const ticket = await response.json();
    const action = async (action: string, origin = demo.parentOrigin) =>
      fetch(demo.parentOrigin + "/synthetic/action", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
    assert.equal((await action("win", "https://external.example")).status, 403);
    assert.equal((await action("suspend")).status, 200);
    assert.equal((await action("win")).status, 200);
    const read = async () => {
      const r = await fetch(
        demo.apiOrigin +
          `/api/integration/v1/tickets/${ticket.id}?playerId=test-player`,
        { headers: { Authorization: `Bearer ${key}` } },
      );
      assert.equal(r.status, 200);
      return r.json();
    };
    const settled = await read();
    assert.equal(settled.status, "WON");
    assert.equal(settled.revision, 1);
    assert.equal((await action("repeat")).status, 200);
    assert.deepEqual(await read(), settled);
    const apiPort = Number(new URL(demo.apiOrigin).port),
      parentPort = Number(new URL(demo.parentOrigin).port);
    await demo.close();
    demo = await startSyntheticDemo({ directory, apiPort, parentPort });
    assert.deepEqual(await read(), settled);
    assert.equal(await readFile(sentinel, "utf8"), "preserve-me");
    assert.equal((await action("loss")).status, 200);
    const correction = await read();
    assert.equal(correction.status, "LOST");
    assert.equal(correction.revision, 2);
    assert.deepEqual(
      correction.selections.map((s: any) => s.acceptedOdds),
      settled.selections.map((s: any) => s.acceptedOdds),
    );
    assert.equal((await action("new")).status, 200);
    assert.equal(demo.getEvents().events.length, 2);
    assert.deepEqual(await read(), correction);
  } finally {
    await demo.close();
    await rm(parent, { recursive: true, force: true });
  }
});
test("synthetic runner never initializes an existing unmarked directory or starts in production", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adl-not-synthetic-"));
  await writeFile(join(directory, "untouched"), "original");
  try {
    await assert.rejects(
      startSyntheticDemo({ directory, apiPort: 0, parentPort: 0 }),
      /NOT_MARKED/,
    );
    assert.equal(
      await readFile(join(directory, "untouched"), "utf8"),
      "original",
    );
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await assert.rejects(
        startSyntheticDemo({ directory, apiPort: 0, parentPort: 0 }),
        /DEVELOPMENT_ONLY/,
      );
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("synthetic origin repair is exact, scoped and idempotent on restart, preserving credentials and manifest", async () => {
  const { syntheticLogin } = await import("../../../scripts/synthetic-demo.js");
  const parent = await mkdtemp(join(tmpdir(), "adl-synthetic-origins-")),
    directory = join(parent, "isolated");
  let demo = await startSyntheticDemo({ directory, apiPort: 0, parentPort: 0 });
  try {
    assert.deepEqual(
      new Set(demo.platform.client(demo.manifest.clientId)!.domains),
      new Set([demo.apiOrigin, demo.parentOrigin]),
    );
    const actor = (
      await demo.platform.login(
        syntheticLogin.email,
        syntheticLogin.password,
        "isolated-origin-test",
      )
    ).admin;
    const keyPath = join(
        demo.platform.directory,
        "credentials",
        demo.manifest.credentialId + ".key",
      ),
      before = await readFile(keyPath, "utf8"),
      manifest = await readFile(join(directory, "manifest.json"), "utf8");
    // Reproduce persisted pre-fix demo, which authorized only the casino parent.
    demo.platform.updateClient(actor, demo.manifest.clientId, {
      domains: [demo.parentOrigin],
    });
    const cookieLogin = async () => {
      const response = await fetch(demo.apiOrigin + "/api/control/login", {
        method: "POST",
        headers: { Origin: demo.apiOrigin, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: syntheticLogin.email,
          password: syntheticLogin.password,
        }),
      });
      assert.equal(response.status, 200);
      return {
        cookie: response.headers.get("set-cookie")!.split(";")[0],
        csrf: (await response.json()).csrf,
      };
    };
    const preview = async (
      session: { cookie: string; csrf: string },
      origin = demo.apiOrigin,
    ) =>
      fetch(
        demo.apiOrigin +
          `/api/control/clients/${demo.manifest.clientId}/operations/${demo.manifest.operationId}/preview`,
        {
          method: "POST",
          headers: {
            Origin: origin,
            Cookie: session.cookie,
            "X-CSRF-Token": session.csrf,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ channel: "web" }),
        },
      );
    const rejected = await preview(await cookieLogin());
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).code, "DOMAIN_NOT_ALLOWED");
    const apiPort = Number(new URL(demo.apiOrigin).port),
      parentPort = Number(new URL(demo.parentOrigin).port);
    await demo.close();
    demo = await startSyntheticDemo({ directory, apiPort, parentPort });
    assert.deepEqual(
      new Set(demo.platform.client(demo.manifest.clientId)!.domains),
      new Set([demo.apiOrigin, demo.parentOrigin]),
    );
    assert.equal(await readFile(keyPath, "utf8"), before);
    assert.equal(
      await readFile(join(directory, "manifest.json"), "utf8"),
      manifest,
    );
    const session = await cookieLogin();
    assert.equal((await preview(session)).status, 201);
    assert.equal(
      (await preview(session, "https://unauthorized.example")).status,
      403,
    );
    const calls = demo.platform.auditEntries(actor, demo.manifest.clientId);
    const repairs = calls.filter(
      (e: any) => e.action === "client.updated",
    ).length;
    await demo.close();
    demo = await startSyntheticDemo({ directory, apiPort, parentPort });
    assert.equal(
      demo.platform
        .auditEntries(actor, demo.manifest.clientId)
        .filter((e: any) => e.action === "client.updated").length,
      repairs,
    );
  } finally {
    await demo.close();
    await rm(parent, { recursive: true, force: true });
  }
});
