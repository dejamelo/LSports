import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { RequestListener } from "node:http";
import { randomUUID } from "node:crypto";
import { clients as createClients } from "./provider.js";
import { OperationError, describeFailure, sdkAxios } from "./diagnostics.js";
import { diagnosePackage } from "./diagnose-runner.js";
import { loadPackageConfig } from "./config.js";
import type { PackageConfig } from "./config.js";
import type amqp from "amqplib";
const config = (): PackageConfig => ({
  lane: "prematch",
  packageId: 4511,
  username: randomUUID(),
  password: randomUUID(),
  hostname: "stm-prematch.lsports.eu",
  vhost: "StmPreMatch",
  port: 5672,
  tls: false,
  queue: "_4511_",
});
async function httpFixture(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
test("SDK failures keep operation, HTTP and envelope codes; supplier secret text never escapes", async () => {
  const pkg = config();
  const raw = `${pkg.username} ${pkg.password} Bearer ${randomUUID()} https://${pkg.username}:${pkg.password}@example.com/?token=hidden`;
  const server = await httpFixture(async (req, res) => {
    let input = "";
    for await (const chunk of req) input += chunk;
    const body = JSON.parse(input);
    assert.equal(body.packageId, 4511);
    assert.equal(body.username, pkg.username);
    assert.equal(body.password, pkg.password);
    assert.equal(req.headers.authorization, undefined);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/Package/GetDistributionStatus") {
      res.statusCode = 401;
      res.end(
        JSON.stringify({
          Header: {
            HttpStatusCode: 401,
            Errors: [
              {
                Message: `Incorrect user name or password for requested package ${raw}`,
              },
            ],
          },
        }),
      );
    } else if (req.url === "/Prematch/GetEvents") {
      assert.deepEqual(Object.keys(body).sort(), [
        "packageId",
        "password",
        "username",
      ]);
      res.statusCode = 403;
      res.end(JSON.stringify({ error: raw }));
    } else
      res.end(
        JSON.stringify({
          Header: { HttpStatusCode: 401, Errors: [{ Message: raw }] },
          Body: [],
        }),
      );
  });
  try {
    const api = clients(pkg, {
      snapshotUrl: server.url,
      customersUrl: server.url,
    });
    for (const [name, action, http, provider, category] of [
      [
        "distribution.status",
        () => api.distributionStatus(),
        401,
        401,
        "authentication_rejected",
      ],
      [
        "snapshot.events",
        () => api.snapshot(),
        403,
        undefined,
        "permission_denied",
      ],
      [
        "metadata.sports",
        () => api.catalog(),
        200,
        401,
        "authentication_rejected",
      ],
    ] as const) {
      await assert.rejects(action, (error) => {
        assert(error instanceof OperationError);
        assert.equal(error.diagnostic.operation, name);
        assert.equal(error.diagnostic.httpStatus, http);
        assert.equal(error.diagnostic.providerStatus, provider);
        assert.equal(error.diagnostic.category, category);
        const output = JSON.stringify(error);
        for (const value of [
          pkg.username,
          pkg.password,
          "Bearer",
          "https://",
          "hidden",
        ])
          assert(!output.includes(value));
        return true;
      });
    }
  } finally {
    await server.close();
  }
});
test("distribution start rejection is distinguished from successful status; no snapshot implied", async () => {
  const pkg = config();
  const requests: string[] = [];
  const server = await httpFixture(async (req, res) => {
    requests.push(req.url || "");
    for await (const _ of req) {
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/Package/GetDistributionStatus")
      res.end(
        JSON.stringify({
          Header: { HttpStatusCode: 200 },
          Body: { IsDistributionOn: false },
        }),
      );
    else {
      res.statusCode = 403;
      res.end(
        JSON.stringify({
          Header: { HttpStatusCode: 403, Errors: [{ Message: "denied" }] },
        }),
      );
    }
  });
  try {
    await assert.rejects(
      () =>
        clients(pkg, {
          snapshotUrl: server.url,
          customersUrl: server.url,
        }).startDistribution(),
      (error) => {
        assert(error instanceof OperationError);
        assert.equal(error.diagnostic.operation, "distribution.start");
        assert.equal(error.diagnostic.httpStatus, 403);
        return true;
      },
    );
    assert.deepEqual(requests, [
      "/Package/GetDistributionStatus",
      "/Distribution/Start",
    ]);
  } finally {
    await server.close();
  }
});
test("AMQP distinguishes login/vhost refusal, missing queue and network without disclosing reply text", () => {
  const secret = randomUUID();
  const login = describeFailure(
    new Error(
      `Handshake terminated by server: 403 (ACCESS-REFUSED) ${secret} amqp://u:p@host`,
    ),
    "amqp.connect",
    "amqp",
  );
  assert.equal(login.amqpCode, 403);
  assert.equal(login.category, "authentication_or_permission");
  assert(!JSON.stringify(login).includes(secret));
  const queue = describeFailure(
    Object.assign(new Error(secret), { code: 404 }),
    "amqp.queue",
    "amqp",
  );
  assert.equal(queue.category, "not_found");
  assert.equal(queue.amqpCode, 404);
  const network = describeFailure(
    Object.assign(new Error(`HTTP 401 is unrelated text ${secret}`), {
      code: "ECONNREFUSED",
    }),
    "amqp.connect",
    "amqp",
  );
  assert.equal(network.category, "network");
  assert.equal(network.networkCode, "ECONNREFUSED");
});
test("read-only diagnostic probes snapshot and AMQP even after distribution rejects; never consumes or starts", async () => {
  const pkg = config();
  const reports: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const fake: ReturnType<typeof clients> = {
    async distributionStatus() {
      calls.push("status");
      throw new OperationError({
        operation: "distribution.status",
        protocol: "http",
        category: "permission_denied",
        httpStatus: 403,
        message: "Acceso denegado.",
      });
    },
    async startDistribution() {
      assert.fail("Diagnostic must not start distribution");
    },
    async snapshot() {
      calls.push("snapshot");
      return [];
    },
    async catalog() {
      calls.push("catalog");
      return [];
    },
  };
  const healthy = await diagnosePackage(
    pkg,
    {
      snapshotUrl: "https://stm-snapshot.lsports.eu",
      customersUrl: "https://stm-api.lsports.eu",
    },
    (r) => reports.push(r),
    {
      clientFactory: () => fake,
      connect: (async (options: amqp.Options.Connect | string) => {
        calls.push("amqp");
        assert.equal((options as amqp.Options.Connect).vhost, "StmPreMatch");
        throw new Error(
          `Handshake terminated by server: 403 (ACCESS-REFUSED) ${pkg.password}`,
        );
      }) as typeof amqp.connect,
    },
  );
  assert.equal(healthy, false);
  assert.deepEqual(calls, ["status", "snapshot", "catalog", "amqp"]);
  assert(
    reports.some((r) => r.operation === "snapshot.events" && r.status === "ok"),
  );
  assert(
    reports.some((r) => r.operation === "amqp.connect" && r.amqpCode === 403),
  );
  assert(!JSON.stringify(reports).includes(pkg.password));
  assert(!JSON.stringify(reports).includes(pkg.username));
});
test("missing credentials name exact fields; optional MQ credentials do not silently override HTTP credentials", () => {
  const names = [
    "LSPORTS_PREMATCH_USERNAME",
    "LSPORTS_PREMATCH_PASSWORD",
    "LSPORTS_PREMATCH_MQ_USERNAME",
    "LSPORTS_PREMATCH_MQ_PASSWORD",
    "LSPORTS_PREMATCH_VHOST",
  ];
  const before = names.map((n) => process.env[n]);
  try {
    names.forEach((n) => delete process.env[n]);
    assert.throws(
      () => loadPackageConfig("prematch"),
      (e) => {
        assert(e instanceof OperationError);
        assert.equal(e.diagnostic.category, "missing_credentials");
        assert.deepEqual(e.diagnostic.fields, names.slice(0, 2));
        return true;
      },
    );
    process.env[names[0]] = randomUUID();
    process.env[names[1]] = randomUUID();
    process.env[names[2]] = randomUUID();
    assert.throws(
      () => loadPackageConfig("prematch"),
      (e) => {
        assert(e instanceof OperationError);
        assert.deepEqual(e.diagnostic.fields, [names[3]]);
        return true;
      },
    );
    process.env[names[3]] = randomUUID();
    process.env[names[4]] = "ProviderAssignedVhost";
    assert.equal(loadPackageConfig("prematch").vhost, "ProviderAssignedVhost");
    assert.notEqual(
      loadPackageConfig("prematch").username,
      loadPackageConfig("prematch").mqUsername,
    );
  } finally {
    names.forEach((n, i) => {
      if (before[i] === undefined) delete process.env[n];
      else process.env[n] = before[i];
    });
  }
});
test("successful diagnostic checks existing queue passively and uses explicit MQ pair without printing it", async () => {
  const { EventEmitter } = await import("node:events");
  const pkg = {
    ...config(),
    mqUsername: randomUUID(),
    mqPassword: randomUUID(),
  };
  const reports: Record<string, unknown>[] = [];
  let passive = false;
  const channel = Object.assign(new EventEmitter(), {
    async checkQueue(queue: string) {
      assert.equal(queue, "_4511_");
      passive = true;
      return { queue, messageCount: 0, consumerCount: 1 };
    },
    async close() {},
    async consume() {
      assert.fail("Diagnostic must not consume");
    },
  });
  const connection = Object.assign(new EventEmitter(), {
    async createChannel() {
      return channel;
    },
    async close() {},
  });
  const fake: ReturnType<typeof clients> = {
    async distributionStatus() {
      return {
        isDistributionOn: true,
        consumers: [],
        numberMessagesInQueue: 0,
        messagesPerSecond: 0,
      };
    },
    async snapshot() {
      return [];
    },
    async catalog() {
      return [];
    },
    async startDistribution() {
      assert.fail("Must not start");
    },
  };
  assert.equal(
    await diagnosePackage(
      pkg,
      {
        snapshotUrl: "https://stm-snapshot.lsports.eu",
        customersUrl: "https://stm-api.lsports.eu",
      },
      (r) => reports.push(r),
      {
        clientFactory: () => fake,
        connect: (async (options: amqp.Options.Connect | string) => {
          const opts = options as amqp.Options.Connect;
          assert.equal(opts.username, pkg.mqUsername);
          assert.equal(opts.password, pkg.mqPassword);
          return connection;
        }) as unknown as typeof amqp.connect,
      },
    ),
    true,
  );
  assert(passive);
  const amqpSummary = reports[0].amqp as Record<string, unknown>;
  assert.equal(amqpSummary.host, pkg.hostname);
  assert.equal(amqpSummary.vhost, "StmPreMatch");
  assert.equal(amqpSummary.queue, "_4511_");
  assert.equal(amqpSummary.sdkDefaultQueue, "_4511_");

  for (const secret of [
    pkg.username,
    pkg.password,
    pkg.mqUsername,
    pkg.mqPassword,
  ])
    assert(!JSON.stringify(reports).includes(secret));
});
test("PreMatch oversized snapshot preserves client error and response limit through SDK wrapping without secrets", async () => {
  const pkg = config();
  const server = await httpFixture(async (req, res) => {
    for await (const _ of req) {
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        Header: { HttpStatusCode: 200 },
        Body: [],
        padding: pkg.password.repeat(80000),
      }),
    );
  });
  const previous = process.env.LSPORTS_SNAPSHOT_MAX_RESPONSE_MB;
  try {
    process.env.LSPORTS_SNAPSHOT_MAX_RESPONSE_MB = "1";
    const api = clients(pkg, {
      snapshotUrl: server.url,
      customersUrl: server.url,
    });
    await assert.rejects(
      () => api.snapshot(),
      (error) => {
        assert(error instanceof OperationError);
        const d = error.diagnostic;
        assert.equal(d.operation, "snapshot.events");
        assert.equal(d.category, "response_limit");
        assert.equal(d.reason, "response_size_limit");
        assert.equal(d.clientCode, "ERR_BAD_RESPONSE");
        assert.equal(d.responseLimitBytes, 1024*1024);
        assert(typeof d.elapsedMs === "number");
        assert(!JSON.stringify(d).includes(pkg.password));
        return true;
      },
    );
  } finally {
    if(previous===undefined)delete process.env.LSPORTS_SNAPSHOT_MAX_RESPONSE_MB;else process.env.LSPORTS_SNAPSHOT_MAX_RESPONSE_MB=previous;
    await server.close();
  }
});
test("PreMatch timeout survives SDK wrapping with exact configured deadline and no invented HTTP status", async () => {
  const pkg = config();
  const server = await httpFixture(async (req, res) => {
    for await (const _ of req) {
    }
    setTimeout(() => res.end("{}"), 150);
  });
  const previous = sdkAxios.defaults.timeout;
  try {
    sdkAxios.defaults.timeout = 25;
    const api = clients(pkg, {
      snapshotUrl: server.url,
      customersUrl: server.url,
    });
    sdkAxios.defaults.timeout = previous;
    await assert.rejects(
      () => api.snapshot(),
      (error) => {
        assert(error instanceof OperationError);
        const d = error.diagnostic;
        assert.equal(d.reason, "timeout");
        assert.equal(d.category, "network");
        assert.equal(d.timeoutMs, 25);
        assert.equal(d.clientCode, "ECONNABORTED");
        assert.equal(d.httpStatus, undefined);
        assert.equal(d.stage, "request");
        return true;
      },
    );
  } finally {
    sdkAxios.defaults.timeout = previous;
    await server.close();
  }
});
test("SDK conversion failure is classified instead of unexpected without disclosing invalid payload IDs", async () => {
  const pkg = config();
  const server = await httpFixture(async (req, res) => {
    for await (const _ of req) {
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        Header: { HttpStatusCode: 200 },
        Body: [
          {
            FixtureId: 123,
            Fixture: { Status: 1 },
            Markets: [
              { Id: 1, Bets: [{ Id: pkg.password, Price: "2.1", Status: 1 }] },
            ],
          },
        ],
      }),
    );
  });
  try {
    await assert.rejects(
      () =>
        clients(pkg, {
          snapshotUrl: server.url,
          customersUrl: server.url,
        }).snapshot(),
      (error) => {
        assert(error instanceof OperationError);
        const d = error.diagnostic;
        assert.equal(d.httpStatus, 200);
        assert.equal(d.category, "sdk_error");
        assert.equal(d.reason, "sdk_conversion");
        assert.equal(d.stage, "sdk");
        assert(!JSON.stringify(d).includes(pkg.password));
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

// Protocol tests isolate scheduling; cross-process coordination is exercised separately.
const clients = (pkg: Parameters<typeof createClients>[0], urls: Parameters<typeof createClients>[1]) =>
  createClients(pkg, urls, { run: (_operation, action) => action() });

test('distribution still off after a successful start response is explicit without extra polling or accepting a connection',async()=>{
 const requests:string[]=[];
 const server=await httpFixture(async(req,res)=>{
  for await(const _ of req){}requests.push(req.url||'');res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:req.url==='/Package/GetDistributionStatus'?{IsDistributionOn:false}:{}}));
 });
 try{
  await assert.rejects(()=>clients(config(),{snapshotUrl:server.url,customersUrl:server.url}).startDistribution(),e=>{
   assert(e instanceof OperationError);assert.equal(e.diagnostic.reason,'distribution_still_off');assert.deepEqual(e.diagnostic.distributionInspection,{before:false,startRequested:true,after:false});return true;
  });assert.deepEqual(requests,['/Package/GetDistributionStatus','/Distribution/Start','/Package/GetDistributionStatus']);
 }finally{await server.close();}
});

test('exclusive-consumer conflicts are distinguished from passwords and never expose raw replies', () => {
  const error = Object.assign(new Error('ACCESS_REFUSED - queue private-user:secret@broker in exclusive use'), {code:403});
  const diagnostic = describeFailure(error, 'amqp.consume', 'amqp');
  assert.equal(diagnostic.reason, 'consumer_conflict');
  assert.equal(diagnostic.category, 'configuration');
  assert.equal(diagnostic.amqpCode,403);
  assert(!JSON.stringify(diagnostic).includes('private-user'));
  assert(!JSON.stringify(diagnostic).includes('secret@'));
});
