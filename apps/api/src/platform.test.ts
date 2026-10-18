import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformStore, platformEnabled } from "@lsports/feed-store/platform";
import { TenantTickets } from "@lsports/feed-store/tenant-tickets";
import { createApp } from "./app.js";
import type { EventFeed } from "@lsports/contracts";
const origin = "http://localhost:3001";
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "adl-platform-test-"));
  const platform = new PlatformStore(directory);
  await platform.bootstrap(
    "platform@test.example",
    "isolated-password-platform",
  );
  const feed = {
    mode: "connected",
    health: "ok",
    updatedAt: new Date().toISOString(),
    connections: { prematch: { phase: "connected" } },
    events: [
      {
        id: "prematch:9001",
        source: "prematch",
        sport: "hipica",
        available: true,
        status: 1,
        home: "ISOLATED TEST",
        markets: [
          {
            id: "160",
            name: "Race Winner",
            status: 1,
            selections: [
              {
                id: "runner",
                label: "TEST ONLY",
                available: true,
                status: 1,
                odds: 2.6233,
              },
            ],
          },
        ],
      },
    ],
  } as EventFeed;
  const app = createApp(
    {
      async getEvents() {
        return structuredClone(feed);
      },
    },
    { platform: true, platformStore: platform, publicOrigin: origin },
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  type Session = { cookie: string; csrf: string };
  const request = async (
    path: string,
    method = "GET",
    data?: unknown,
    session?: Session,
    bearer?: string,
    extra: Record<string, string> = {},
  ) => {
    if (
      method === "POST" &&
      path === "/api/integration/v1/embed-sessions" &&
      bearer
    )
      data = { ...platform.integration(bearer), ...(data as object) };
    const response = await fetch(base + path, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(session
          ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf }
          : {}),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...extra,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return {
      status: response.status,
      headers: response.headers,
      data: await response.json(),
    };
  };
  const login = async (email: string, password: string): Promise<Session> => {
    const result = await request("/api/control/login", "POST", {
      email,
      password,
    });
    assert.equal(result.status, 200);
    return {
      cookie: result.headers.get("set-cookie")!.split(";")[0],
      csrf: result.data.csrf,
    };
  };
  const admin = await login(
    "platform@test.example",
    "isolated-password-platform",
  );
  const create = async (name: string) => {
    const result = await request(
      "/api/control/clients",
      "POST",
      {
        name,
        adminEmail: `${name}@test.example`,
        adminPassword: "isolated-client-password",
        domains: [`https://${name}.example`],
      },
      admin,
    );
    assert.equal(result.status, 201);
    const op = await request(
      `/api/control/clients/${result.data.id}/operations`,
      "POST",
      {
        name: `${name} ARS`,
        country: "AR",
        currency: "ARS",
        clientMayEditLimits: true,
      },
      admin,
    );
    assert.equal(op.status, 201);
    return { ...result.data, operation: op.data };
  };
  const key = async (clientId: string, operationId?: string) => {
    const operation = operationId
      ? platform.operation(operationId)!
      : platform.operations(
          platform.session(admin.cookie.split("=")[1])!.admin,
          clientId,
        )[0];
    const result = await request(
      `/api/control/clients/${clientId}/operations/${operation.id}/credentials`,
      "POST",
      { name: "Test server" },
      admin,
    );
    assert.equal(result.status, 201);
    const value = await readFile(
      join(directory, "credentials", `${result.data.id}.key`),
      "utf8",
    );
    assert(!JSON.stringify(result.data).includes(value));
    return { id: result.data.id, value };
  };
  return {
    directory,
    platform,
    feed,
    request,
    login,
    admin,
    create,
    key,
    base,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      app.locals.closeTickets();
      platform.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test("administrative roles, tenant isolation, CSRF, exact iframe origins, credential rotation/revocation and secret-free audit", async () => {
  const s = await setup();
  try {
    const a = await s.create("alpha"),
      b = await s.create("beta");
    const client = await s.login(
      "alpha@test.example",
      "isolated-client-password",
    );
    const list = await s.request(
      "/api/control/clients",
      "GET",
      undefined,
      client,
    );
    assert.deepEqual(
      list.data.clients.map((c: { id: string }) => c.id),
      [a.id],
    );
    for (const path of [
      `/api/control/clients/${b.id}/operations/${b.operation.id}/credentials`,
      `/api/control/clients/${b.id}/operations/${b.operation.id}/diagnostics`,
      `/api/control/audit?clientId=${b.id}`,
      "/api/control/audit",
    ])
      assert.equal(
        (await s.request(path, "GET", undefined, client)).status,
        403,
      );
    assert.equal(
      (
        await s.request(
          "/api/control/clients",
          "POST",
          { name: "attack" },
          client,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await s.request(
          `/api/control/clients/${b.id}`,
          "PATCH",
          { status: "suspended" },
          client,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await s.request(
          `/api/control/clients/${a.id}`,
          "PATCH",
          { status: "suspended" },
          client,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await s.request(
          `/api/control/clients/${a.id}`,
          "PATCH",
          { domains: ["https://*.example"] },
          client,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await s.request(
          `/api/control/clients/${a.id}`,
          "PATCH",
          { domains: ["https://alpha.example/path"] },
          client,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await s.request(
          `/api/control/clients/${a.id}`,
          "PATCH",
          { domains: [] },
          { ...client, csrf: "invalid" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await s.request(
          `/api/control/clients/${a.id}`,
          "PATCH",
          { domains: [] },
          client,
          undefined,
          { Origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (await s.request("/api/control/session", "GET", undefined, client)).data
        .csrf,
      client.csrf,
    );
    for (const path of [
      "/api/tickets",
      "/api/events",
      "/api/diagnostics/open-events",
      "/api/posnet/test/print-jobs",
    ])
      assert.equal((await s.request(path)).status, 401);
    const k = await s.key(a.id);
    assert.equal(
      (await stat(join(s.directory, "credentials", `${k.id}.key`))).mode &
        0o777,
      0o600,
    );
    assert.equal(
      (
        await s.request(
          "/api/integration/v1/context",
          "GET",
          undefined,
          undefined,
          k.value,
        )
      ).status,
      200,
    );
    const html = await fetch(
      `${s.base}/embed/${a.id}/${a.operation.id}/sportsbook`,
    );
    assert.match(
      html.headers.get("content-security-policy")!,
      /frame-ancestors https:\/\/alpha.example;/,
    );
    assert(
      !html.headers.get("content-security-policy")!.includes("beta.example"),
    );
    const control = await fetch(`${s.base}/control`);
    assert.match(
      control.headers.get("content-security-policy")!,
      /frame-ancestors 'none'/,
    );
    assert.equal(control.headers.get("x-frame-options"), "DENY");
    assert.equal(
      (
        await s.request(
          "/api/integration/v1/embed-sessions",
          "POST",
          { playerId: "one", parentOrigin: "https://evil.example" },
          undefined,
          k.value,
        )
      ).status,
      403,
    );
    const embedded = await s.request(
      "/api/integration/v1/embed-sessions",
      "POST",
      { playerId: "one", parentOrigin: "https://alpha.example" },
      undefined,
      k.value,
    );
    assert.equal(embedded.status, 201);
    const code = new URL(embedded.data.iframeUrl).hash.slice(6);
    const exchanged = await s.request(
      "/api/integration/v1/embed-exchange",
      "POST",
      { clientId: a.id, operationId: a.operation.id, code },
    );
    assert.equal(exchanged.status, 200);
    assert.equal(
      (
        await s.request("/api/integration/v1/embed-exchange", "POST", {
          clientId: a.id,
          operationId: a.operation.id,
          code,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await s.request(
          "/api/integration/v1/embed-sessions",
          "POST",
          { playerId: "two", parentOrigin: "https://alpha.example" },
          undefined,
          exchanged.data.accessToken,
        )
      ).status,
      403,
    );
    const rotated = await s.request(
      `/api/control/clients/${a.id}/operations/${a.operation.id}/credentials/${k.id}/rotate`,
      "POST",
      { name: "Rotated" },
      client,
    );
    assert.equal(rotated.status, 201);
    assert.equal(
      (
        await s.request(
          "/api/integration/v1/context",
          "GET",
          undefined,
          undefined,
          k.value,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await s.request(
          "/api/integration/v1/context",
          "GET",
          undefined,
          undefined,
          exchanged.data.accessToken,
        )
      ).status,
      401,
    );
    const newKey = await readFile(
      join(s.directory, "credentials", `${rotated.data.id}.key`),
      "utf8",
    );
    assert.equal(
      (
        await s.request(
          "/api/integration/v1/context",
          "GET",
          undefined,
          undefined,
          newKey,
        )
      ).status,
      200,
    );
    await s.request(
      `/api/control/clients/${a.id}/operations/${a.operation.id}/credentials/${rotated.data.id}/revoke`,
      "POST",
      {},
      client,
    );
    assert.equal(
      (
        await s.request(
          "/api/integration/v1/context",
          "GET",
          undefined,
          undefined,
          newKey,
        )
      ).status,
      401,
    );
    const audit = await s.request(
      "/api/control/audit",
      "GET",
      undefined,
      s.admin,
    );
    const json = JSON.stringify(audit.data);
    assert(!json.includes(k.value));
    assert(!json.includes(newKey));
    assert(!json.includes("isolated-client-password"));
    assert.match(json, /credential.rotated/);
    assert.match(json, /credential.revoked/);
  } finally {
    await s.close();
  }
});
test("player/client ticket isolation, simulation-only wallet, suspension keeps settlement/correction active and durable restart preserves accepted odds", async () => {
  const s = await setup();
  try {
    const a = await s.create("alpha"),
      b = await s.create("beta"),
      ka = await s.key(a.id),
      kb = await s.key(b.id);
    const input = {
      clientId: a.id,
      operationId: a.operation.id,
      currency: "ARS",
      playerId: "one",
      stakeMinor: "1000",
      selections: [
        {
          eventId: "prematch:9001",
          marketId: "160",
          selectionId: "runner",
          expectedOdds: 2.6233,
        },
      ],
    };
    const create = () =>
      s.request(
        "/api/integration/v1/tickets",
        "POST",
        input,
        undefined,
        ka.value,
        { "Idempotency-Key": "ticket-isolation-01" },
      );
    const original = await create();
    assert.equal(original.status, 201);
    assert.equal(original.data.testOnly, true);
    assert.equal(original.data.currency, "ARS");
    const existing = await create();
    assert.equal(existing.data.id, original.data.id);
    const ticketId = original.data.id;
    assert.equal(
      (
        await s.request(
          `/api/integration/v1/tickets/${ticketId}?playerId=two`,
          "GET",
          undefined,
          undefined,
          ka.value,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await s.request(
          `/api/integration/v1/tickets/${ticketId}?playerId=one`,
          "GET",
          undefined,
          undefined,
          kb.value,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await s.request(
          "/api/integration/v1/tickets?playerId=one",
          "GET",
          undefined,
          undefined,
          kb.value,
        )
      ).data.total,
      0,
    );
    assert.equal(
      (
        await s.request(
          "/api/integration/v1/tickets",
          "POST",
          { ...input, financialMode: "external" },
          undefined,
          ka.value,
          { "Idempotency-Key": "ticket-real-money" },
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await s.request(
          "/api/integration/v1/wallet/debit",
          "POST",
          { amount: 100 },
          undefined,
          ka.value,
        )
      ).status,
      501,
    );
    s.feed.events[0].markets![0].status = 2;
    assert.equal(
      (
        await s.request(
          "/api/integration/v1/tickets",
          "POST",
          input,
          undefined,
          ka.value,
          { "Idempotency-Key": "ticket-suspended-market" },
        )
      ).data.code,
      "MARKET_NOT_OPEN",
    );
    s.feed.events[0].markets![0].status = 1;
    await s.request(
      `/api/control/clients/${a.id}`,
      "PATCH",
      { status: "suspended" },
      s.admin,
    );
    assert.equal(
      (
        await s.request(
          "/api/integration/v1/tickets",
          "POST",
          input,
          undefined,
          ka.value,
          { "Idempotency-Key": "ticket-client-paused" },
        )
      ).data.code,
      "ACCEPTANCE_PAUSED",
    );
    assert.equal((await create()).data.id, ticketId); // Replay isn't a new bet.
    s.feed.ticketOutcomes = [
      {
        eventId: "prematch:9001",
        marketId: "160",
        selectionId: "runner",
        settlement: 1,
        updatedAt: new Date().toISOString(),
      },
    ];
    const workerRegistry = new PlatformStore(s.directory, true);
    const workerTickets = new TenantTickets(workerRegistry);
    workerTickets.reconcile(s.feed);
    workerTickets.reconcile(s.feed);
    workerTickets.close();
    workerRegistry.close();
    let ticket = (
      await s.request(
        `/api/integration/v1/tickets/${ticketId}?playerId=one`,
        "GET",
        undefined,
        undefined,
        ka.value,
      )
    ).data;
    assert.equal(ticket.status, "LOST");
    assert.equal(ticket.revision, 1);
    assert.equal(ticket.selections[0].acceptedOdds, 2.6233);
    const reopened = new PlatformStore(s.directory, true);
    const restoredTickets = new TenantTickets(reopened);
    assert.deepEqual(
      restoredTickets.store(a.operation.id).get(ticketId),
      ticket,
    );
    s.feed.ticketOutcomes[0] = {
      ...s.feed.ticketOutcomes[0],
      settlement: 2,
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    };
    restoredTickets.reconcile(s.feed);
    restoredTickets.reconcile(s.feed);
    ticket = restoredTickets.store(a.operation.id).get(ticketId);
    assert.equal(ticket.status, "WON");
    assert.equal(ticket.revision, 2);
    assert.equal(ticket.selections[0].acceptedOdds, 2.6233);
    restoredTickets.close();
    reopened.close();
  } finally {
    await s.close();
  }
});
test("persistent session expiry, one-use embed expiration and revoked origins never reopen an old player session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adl-expiration-"));
  let now = 1700000000000;
  let p = new PlatformStore(directory, false, () => now);
  try {
    await p.bootstrap("admin@test.example", "isolated-password-platform");
    const login = await p.login(
      "admin@test.example",
      "isolated-password-platform",
      "local",
    );
    const c = await p.createClient(login.admin, {
      name: "Client",
      adminEmail: "client@test.example",
      adminPassword: "isolated-client-password",
      domains: ["https://casino.example"],
    });
    const op = p.createOperation(login.admin, c.id, {
      name: "ARS",
      country: "AR",
      currency: "ARS",
    });
    const key = p.issueCredential(login.admin, c.id, op.id, "Server");
    const secret = await readFile(
      join(directory, "credentials", `${key.id}.key`),
      "utf8",
    );
    const auth = p.integration(secret)!;
    const code = p.createEmbed(auth, {
      ...auth,
      playerId: "player",
      parentOrigin: "https://casino.example",
    });
    p.close();
    p = new PlatformStore(directory, false, () => now);
    assert(p.session(login.value));
    now += 61000;
    assert.throws(
      () =>
        p.exchangeEmbed({
          code: code.code,
          clientId: c.id,
          operationId: op.id,
        }),
      { code: "INVALID_SESSION" },
    );
    const session = p.exchangeEmbed({
      code: p.createEmbed(auth, {
        ...auth,
        playerId: "player",
        parentOrigin: "https://casino.example",
      }).code,
      clientId: c.id,
      operationId: op.id,
    });
    assert(p.integration(session.accessToken));
    p.updateClient(login.admin, c.id, {
      domains: ["https://casino.example"],
      settings: {
        acceptingTickets: false,
        displayName: "Client",
        locale: "es-AR",
      },
    });
    assert(
      p.integration(session.accessToken),
      "Pausing without a domain change must preserve history access",
    );
    p.updateClient(login.admin, c.id, { domains: [] });
    assert.equal(p.integration(session.accessToken), undefined);
    now += 8 * 3600000;
    assert.equal(p.session(login.value), undefined);
  } finally {
    p.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid platform mode fails closed instead of exposing anonymous legacy routes", () => {
  const previous = process.env.PLATFORM_ENABLED;
  try {
    process.env.PLATFORM_ENABLED = "TRUE";
    assert.throws(() => platformEnabled(), /PLATFORM_ENABLED/);
  } finally {
    if (previous === undefined) delete process.env.PLATFORM_ENABLED;
    else process.env.PLATFORM_ENABLED = previous;
  }
});
test("new platform registry and tenant settlement leave two legacy tickets, checkpoint, config and backup bytes untouched", async () => {
  const { TicketStore } = await import("@lsports/feed-store/tickets");
  const directory = await mkdtemp(join(tmpdir(), "adl-legacy-preservation-"));
  const legacyPath = join(directory, "existing-tickets.sqlite");
  const paths = [".env", "trade-feed.json", "backup-existing.json"].map(
    (name) => join(directory, name),
  );
  let platform: PlatformStore | undefined;
  try {
    for (const path of paths)
      await writeFile(path, "ISOLATED SENTINEL — preserve unchanged");
    const feed = {
      mode: "connected",
      updatedAt: new Date().toISOString(),
      connections: { prematch: { phase: "connected" } },
      events: [
        {
          id: "prematch:9001",
          source: "prematch",
          available: true,
          status: 1,
          markets: [
            {
              id: "160",
              name: "Test race",
              status: 1,
              selections: [
                {
                  id: "runner",
                  label: "ISOLATED",
                  available: true,
                  status: 1,
                  odds: 2.6233,
                },
              ],
            },
          ],
        },
      ],
    } as EventFeed;
    const legacy = new TicketStore(legacyPath);
    for (let i = 0; i < 2; i++)
      legacy.create(
        {
          stakeMinor: 1000,
          selections: [
            {
              eventId: "prematch:9001",
              marketId: "160",
              selectionId: "runner",
              expectedOdds: 2.6233,
            },
          ],
        },
        `legacy-preserved-${i}`,
        () => feed,
      );
    feed.ticketOutcomes = [
      {
        eventId: "prematch:9001",
        marketId: "160",
        selectionId: "runner",
        settlement: 1,
        updatedAt: new Date().toISOString(),
      },
    ];
    legacy.reconcile(feed);
    const before = legacy.list();
    assert.equal(before.total, 2);
    assert(
      before.tickets.every(
        (t) =>
          t.status === "LOST" &&
          t.revision === 1 &&
          t.payoutMinor === 0 &&
          t.selections[0].acceptedOdds === 2.6233,
      ),
    );
    legacy.close();
    const bytes = await readFile(legacyPath);
    platform = new PlatformStore(join(directory, "new-platform"));
    await platform.bootstrap(
      "admin@test.example",
      "isolated-password-platform",
    );
    const admin = (
      await platform.login(
        "admin@test.example",
        "isolated-password-platform",
        "test",
      )
    ).admin;
    const client = await platform.createClient(admin, {
      name: "New client",
      adminEmail: "new@test.example",
      adminPassword: "isolated-client-password",
      domains: [],
    });
    const op = platform.createOperation(admin, client.id, {
      name: "New operation",
      country: "CL",
      currency: "CLP",
    });
    const tenants = new TenantTickets(platform);
    tenants.reconcile(feed);
    assert.equal(tenants.store(op.id).list().total, 0);
    tenants.close();
    assert.deepEqual(await readFile(legacyPath), bytes);
    for (const path of paths)
      assert.equal(
        await readFile(path, "utf8"),
        "ISOLATED SENTINEL — preserve unchanged",
      );
    const restored = new TicketStore(legacyPath);
    assert.deepEqual(restored.list(), before);
    restored.close();
  } finally {
    platform?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("currency/operation bindings reject browser tampering, preserve same-currency operation isolation and exact minor amounts", async () => {
  const s = await setup();
  try {
    const a = await s.create("alpha"),
      b = await s.create("beta");
    const createOp = async (code: string, name: string) =>
      (
        await s.request(
          `/api/control/clients/${a.id}/operations`,
          "POST",
          { name, country: "AR", currency: code },
          s.admin,
        )
      ).data;
    const second = await createOp("ARS", "Second ARS"),
      usd = await createOp("USD", "USD in AR");
    assert.equal(usd.country, "AR");
    const k = await s.key(a.id),
      ks = await s.key(a.id, second.id),
      ku = await s.key(a.id, usd.id);
    const payload = {
      clientId: a.id,
      operationId: a.operation.id,
      currency: "ARS",
      playerId: "stable-player",
      channel: "web",
      stakeMinor: "101",
      selections: [
        {
          eventId: "prematch:9001",
          marketId: "160",
          selectionId: "runner",
          expectedOdds: 2.6233,
        },
      ],
    };
    const send = (data: object, bearer = k.value, key = "currency-test-key") =>
      s.request(
        "/api/integration/v1/tickets",
        "POST",
        data,
        undefined,
        bearer,
        { "Idempotency-Key": key },
      );
    for (const changed of [
      { currency: "USD" },
      { clientId: b.id },
      { operationId: second.id },
    ])
      assert.equal(
        (await send({ ...payload, ...changed })).data.code,
        "SCOPE_MISMATCH",
      );
    assert.equal(
      (await send({ ...payload, stakeMinor: 101 })).data.code,
      "INVALID_MINOR_AMOUNT",
    );
    const first = await send(payload);
    assert.equal(first.status, 201);
    assert.equal(first.data.stakeMinor, "101");
    assert.equal(first.data.currency, "ARS");
    assert.equal(
      (await send({ ...payload, operationId: second.id }, ks.value)).status,
      201,
    );
    assert.equal(
      (
        await send(
          { ...payload, operationId: usd.id, currency: "USD" },
          ku.value,
        )
      ).status,
      201,
    );
    assert.equal(
      (
        await s.request(
          `/api/control/clients/${a.id}/operations/${second.id}/report`,
          "GET",
          undefined,
          s.admin,
        )
      ).data.acceptedStakeMinor,
      "101",
    );
    assert.equal(
      (
        await s.request(
          `/api/control/clients/${a.id}/operations/${usd.id}`,
          "PATCH",
          { currency: "ARS" },
          s.admin,
        )
      ).data.code,
      "OPERATION_CURRENCY_IMMUTABLE",
    );
    const session = await s.request(
      "/api/integration/v1/embed-sessions",
      "POST",
      {
        clientId: a.id,
        operationId: a.operation.id,
        currency: "ARS",
        playerId: "stable-player",
        parentOrigin: "https://alpha.example",
        channel: "pos",
        terminalId: "POS-0001",
      },
      undefined,
      k.value,
    );
    assert.equal(session.status, 201);
    const code = new URL(session.data.iframeUrl).hash.slice(6);
    assert.equal(
      (
        await s.request("/api/integration/v1/embed-exchange", "POST", {
          clientId: a.id,
          operationId: a.operation.id,
          code,
          currency: "USD",
        })
      ).data.code,
      "SCOPE_MISMATCH",
    );
    const exchanged = await s.request(
      "/api/integration/v1/embed-exchange",
      "POST",
      { clientId: a.id, operationId: a.operation.id, code },
    );
    assert.equal(exchanged.status, 200);
    assert.equal(
      (
        await send(
          {
            ...payload,
            channel: "pos",
            terminalId: "POS-0001",
            currency: "USD",
          },
          exchanged.data.accessToken,
          "tamper-currency",
        )
      ).data.code,
      "SCOPE_MISMATCH",
    );
    assert.equal(
      (
        await send(
          {
            ...payload,
            playerId: "other",
            channel: "pos",
            terminalId: "POS-0001",
          },
          exchanged.data.accessToken,
          "tamper-player",
        )
      ).data.code,
      "PLAYER_MISMATCH",
    );
    assert.equal(
      (
        await send(
          { ...payload, channel: "mobile" },
          exchanged.data.accessToken,
          "tamper-channel",
        )
      ).data.code,
      "CHANNEL_MISMATCH",
    );
    const pos = await send(
      { ...payload, channel: "pos", terminalId: "POS-0001" },
      exchanged.data.accessToken,
      "valid-pos-key",
    );
    assert.equal(pos.status, 201);
    assert.equal(pos.data.terminalId, "POS-0001");
    await s.request(
      `/api/control/clients/${a.id}/operations/${a.operation.id}`,
      "PATCH",
      { status: "suspended" },
      s.admin,
    );
    assert.equal(
      (
        await send(
          { ...payload, channel: "pos", terminalId: "POS-0001" },
          exchanged.data.accessToken,
          "suspended-pos",
        )
      ).data.code,
      "ACCEPTANCE_PAUSED",
    );
    assert.equal(
      (
        await send(
          { ...payload, operationId: second.id },
          ks.value,
          "other-operation",
        )
      ).status,
      201,
    );
  } finally {
    await s.close();
  }
});
test("platform-authorized limits, tenant edit permissions, repeated bets, accumulated stakes, every multiple event and immutable accepted reservations", async () => {
  const s = await setup();
  try {
    const a = await s.create("alpha"),
      k = await s.key(a.id),
      client = await s.login("alpha@test.example", "isolated-client-password");
    const path = `/api/control/clients/${a.id}/operations/${a.operation.id}`;
    const limits = {
      minStakeMinor: "100",
      maxStakeMinor: "800",
      maxReturnMinor: "100000",
      allowRepeatedTickets: true,
      maxTicketsPerPlayerEvent: 2,
      maxStakePerPlayerEventMinor: "900",
      sameEventMultiples: "blocked",
    };
    assert.equal(
      (await s.request(path, "PATCH", { limits }, client)).data.code,
      "LIMIT_EDIT_FORBIDDEN",
    );
    assert.equal(
      (
        await s.request(
          `/api/control/clients/${a.id}/limit-policies/ARS`,
          "PATCH",
          { ...limits, clientMayEdit: true },
          client,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await s.request(
          `/api/control/clients/${a.id}/limit-policies/ARS`,
          "PATCH",
          {
            ...limits,
            maxStakeMinor: "1000",
            maxStakePerPlayerEventMinor: "1000",
            clientMayEdit: true,
          },
          s.admin,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await s.request(
          path,
          "PATCH",
          { limits: { ...limits, maxStakeMinor: "1001" } },
          client,
        )
      ).data.code,
      "LIMIT_POLICY_EXCEEDED",
    );
    assert.equal(
      (
        await s.request(
          path,
          "PATCH",
          { limits: { ...limits, minStakeMinor: "900" } },
          s.admin,
        )
      ).data.code,
      "INVALID_LIMITS",
    );
    assert.equal(
      (
        await s.request(
          path,
          "PATCH",
          { limits: { ...limits, sameEventMultiples: "allowed" } },
          s.admin,
        )
      ).data.code,
      "CORRELATED_SELECTIONS_UNSUPPORTED",
    );
    assert.equal(
      (await s.request(path, "PATCH", { limits }, client)).status,
      200,
    );
    const input = {
      clientId: a.id,
      operationId: a.operation.id,
      currency: "ARS",
      playerId: "stable",
      channel: "web",
      stakeMinor: "600",
      selections: [
        {
          eventId: "prematch:9001",
          marketId: "160",
          selectionId: "runner",
          expectedOdds: 2.6233,
        },
      ],
    };
    const send = (key: string, data: object = input) =>
      s.request(
        "/api/integration/v1/tickets",
        "POST",
        data,
        undefined,
        k.value,
        { "Idempotency-Key": key },
      );
    assert.equal(
      (await send("below-minimum", { ...input, stakeMinor: "99" })).data.code,
      "STAKE_BELOW_MINIMUM",
    );
    assert.equal(
      (await send("above-maximum", { ...input, stakeMinor: "801" })).data.code,
      "STAKE_ABOVE_MAXIMUM",
    );
    const accepted = await send("accepted-first");
    assert.equal(accepted.status, 201);
    assert.equal((await send("accepted-first")).data.id, accepted.data.id);
    assert.equal(
      (await send("mobile-attempt", { ...input, channel: "mobile" })).data.code,
      "PLAYER_EVENT_AMOUNT_LIMIT",
    );
    const other = structuredClone(s.feed.events[0]);
    other.id = "prematch:9002";
    s.feed.events.push(other);
    assert.equal(
      (
        await send("multiple-attempt", {
          ...input,
          channel: "pos",
          terminalId: "POS-0001",
          selections: [
            ...input.selections,
            { ...input.selections[0], eventId: "prematch:9002" },
          ],
        })
      ).data.code,
      "PLAYER_EVENT_AMOUNT_LIMIT",
    );
    const store = new TenantTickets(s.platform);
    assert.equal(store.store(a.operation.id).report().acceptedTickets, 1);
    store.close();
    assert.equal(
      (
        await send("count-first", {
          ...input,
          playerId: "quantity",
          stakeMinor: "100",
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await send("count-second", {
          ...input,
          playerId: "quantity",
          stakeMinor: "100",
          channel: "mobile",
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await send("count-third", {
          ...input,
          playerId: "quantity",
          stakeMinor: "100",
          channel: "pos",
          terminalId: "POS-0001",
        })
      ).data.code,
      "PLAYER_EVENT_TICKET_LIMIT",
    );
    const duplicate = structuredClone(s.feed.events[0]);
    duplicate.id = "inplay:9001";
    duplicate.source = "inplay";
    s.feed.events.push(duplicate);
    s.feed.connections!.inplay = {
      phase: "connected",
      message: "Isolated test",
    };
    assert.equal(
      (
        await send("same-event-correlation", {
          ...input,
          playerId: "correlated",
          stakeMinor: "100",
          selections: [
            ...input.selections,
            { ...input.selections[0], eventId: "inplay:9001" },
          ],
        })
      ).data.code,
      "CORRELATED_SELECTIONS_UNSUPPORTED",
    );
    s.feed.ticketOutcomes = [
      {
        eventId: "prematch:9001",
        marketId: "160",
        selectionId: "runner",
        settlement: -1,
        updatedAt: new Date().toISOString(),
      },
    ];
    assert.equal(
      (
        await s.request(
          `/api/integration/v1/tickets/${accepted.data.id}?playerId=stable`,
          "GET",
          undefined,
          undefined,
          k.value,
        )
      ).data.status,
      "REFUNDED",
    );
    // Cancellation/refund does not silently release lifetime player/event limits.
    assert.equal(
      (
        await send("after-refund", {
          ...input,
          channel: "pos",
          terminalId: "POS-0001",
        })
      ).data.code,
      "RESULT_ALREADY_RECEIVED",
    );
    await s.request(
      path,
      "PATCH",
      { limits: { ...limits, allowRepeatedTickets: false } },
      client,
    );
    s.feed.ticketOutcomes = [
      {
        eventId: "prematch:9001",
        marketId: "160",
        selectionId: "runner",
        settlement: 0,
        updatedAt: new Date(Date.now() + 1000).toISOString(),
      },
    ]; // Explicit reopening still does not release an accepted reservation.
    assert.equal(
      (
        await send("repeat-denied", {
          ...input,
          channel: "mobile",
          stakeMinor: "100",
        })
      ).data.code,
      "REPEATED_EVENT_BLOCKED",
    );
    const audit = await s.request(
      `/api/control/audit?clientId=${a.id}`,
      "GET",
      undefined,
      client,
    );
    assert.match(JSON.stringify(audit.data), /previous/);
    assert.match(JSON.stringify(audit.data), /limits.policy.updated/);
  } finally {
    await s.close();
  }
});
test("risk dashboard, global view, review and target suspensions enforce tenant permissions and do not stop accepted settlement", async () => {
  const s = await setup();
  try {
    const a = await s.create("alpha"),
      b = await s.create("beta"),
      key = await s.key(a.id),
      client = await s.login("alpha@test.example", "isolated-client-password");
    const path = `/api/control/clients/${a.id}/operations/${a.operation.id}/risk`,
      other = `/api/control/clients/${b.id}/operations/${b.operation.id}/risk`;
    assert.equal(
      (await s.request(other, "GET", undefined, client)).status,
      403,
    );
    assert.equal(
      (await s.request("/api/control/risk", "GET", undefined, client)).status,
      403,
    );
    const initial = await s.request(path, "GET", undefined, client);
    const config = initial.data.config;
    config.rules.largeStake = {
      ...config.rules.largeStake,
      enabled: true,
      action: "alert",
      thresholdMinor: "50",
      severity: "high",
    };
    assert.equal(
      (await s.request(`${path}/config`, "PUT", config, client)).status,
      200,
    );
    assert.equal(
      (await s.request(`${other}/config`, "PUT", config, client)).status,
      403,
    );
    const input = {
      clientId: a.id,
      operationId: a.operation.id,
      currency: "ARS",
      playerId: "stable",
      channel: "pos",
      terminalId: "POS-0001",
      stakeMinor: "100",
      selections: [
        {
          eventId: "prematch:9001",
          marketId: "160",
          selectionId: "runner",
          expectedOdds: 2.6233,
        },
      ],
    };
    const first = await s.request(
      "/api/integration/v1/tickets",
      "POST",
      input,
      undefined,
      key.value,
      { "Idempotency-Key": "risk-api-accepted" },
    );
    assert.equal(first.status, 201);
    const alerts = (
      await s.request(
        `${path}?playerId=stable&severity=high`,
        "GET",
        undefined,
        client,
      )
    ).data.alerts;
    assert.equal(alerts.length, 1);
    assert.equal(
      (
        await s.request(
          `${path}/alerts/${alerts[0].id}`,
          "PATCH",
          {
            status: "review",
            assignee: "operator",
            note: "Revisión sin cancelar.",
          },
          client,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await s.request(
          `${path}/suspensions`,
          "POST",
          {
            kind: "market",
            eventId: "9001",
            marketId: "160",
            active: true,
            reason: "Control manual",
          },
          client,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await s.request(
          "/api/integration/v1/tickets",
          "POST",
          input,
          undefined,
          key.value,
          { "Idempotency-Key": "risk-api-pos-denied" },
        )
      ).data.code,
      "RISK_TARGET_SUSPENDED",
    );
    const projected = (
      await s.request(
        "/api/integration/v1/events",
        "GET",
        undefined,
        undefined,
        key.value,
      )
    ).data;
    assert.equal(projected.events[0].markets[0].selections[0].available, false);
    s.feed.ticketOutcomes = [
      {
        eventId: "prematch:9001",
        marketId: "160",
        selectionId: "runner",
        settlement: 1,
        updatedAt: new Date().toISOString(),
      },
    ];
    const ticket = (
      await s.request(
        `/api/integration/v1/tickets/${first.data.id}?playerId=stable`,
        "GET",
        undefined,
        undefined,
        key.value,
      )
    ).data;
    assert.equal(ticket.status, "LOST");
    assert.equal(ticket.selections[0].acceptedOdds, 2.6233);
    const audit = await s.request(
      `/api/control/audit?clientId=${a.id}`,
      "GET",
      undefined,
      client,
    );
    assert.match(JSON.stringify(audit.data), /risk.alert.updated/);
    assert.match(JSON.stringify(audit.data), /risk.suspension.updated/);
    const global = await s.request(
      "/api/control/risk",
      "GET",
      undefined,
      s.admin,
    );
    assert.equal(global.status, 200);
    assert.equal(
      global.data.aggregation,
      "separate_operation_currency_no_financial_sum",
    );
    assert.equal(global.data.operations.length, 2);
  } finally {
    await s.close();
  }
});
