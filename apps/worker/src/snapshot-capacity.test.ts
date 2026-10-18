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
  const maximum={LSPORTS_SNAPSHOT_MAX_RESPONSE_MB:"256"};
  assert.equal(snapshotCapacity(maximum,2112*MiB).budgetBytes,2112*MiB);
  assert.equal(snapshotCapacity(maximum,2112*MiB).allowed,true);
  assert.equal(snapshotCapacity(maximum,2112*MiB-1).allowed,false);
  assert.equal(snapshotCapacity(maximum,2112*MiB).limitBytes,268435456);
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

test('per-lane caps isolate InPlay from legacy global 256 and expose heap vs physical constraints including zero available RAM',()=>{
 const env={LSPORTS_SNAPSHOT_MAX_RESPONSE_MB:'256',LSPORTS_PREMATCH_SNAPSHOT_MAX_RESPONSE_MB:'256',LSPORTS_INPLAY_SNAPSHOT_MAX_RESPONSE_MB:'128'};
 const sample={heapLimitBytes:2048*MiB,heapUsedBytes:185*MiB,availableMemoryBytes:5000*MiB};
 const prematch=snapshotCapacity(env,sample,'prematch');const inplay=snapshotCapacity(env,sample,'inplay');
 assert.equal(prematch.allowed,false);assert.equal(prematch.memory.limitingFactor,'heap');assert.equal(inplay.allowed,true);assert.equal(inplay.limitBytes,128*MiB);
 assert.equal(snapshotCapacity({LSPORTS_SNAPSHOT_MAX_RESPONSE_MB:'256'},sample,'inplay').limitBytes,128*MiB);
 assert.equal(snapshotCapacity(env,{...sample,heapLimitBytes:4096*MiB,availableMemoryBytes:1800*MiB},'prematch').memory.limitingFactor,'available_memory');
 assert.equal(snapshotCapacity(env,{...sample,availableMemoryBytes:0},'inplay').allowed,false);
 assert.equal(snapshotCapacity(env,{...sample,heapLimitBytes:4096*MiB},'prematch').allowed,true);
});

test('actual HTTP adapter refuses zero available memory without issuing HTTP or inventing a status',async()=>{
 let calls=0;const original=process.availableMemory;
 const server=createServer((_req,res)=>{calls++;res.end('{}');});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  const address=server.address();assert(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}`;
  const api=clients({lane:'prematch',packageId:4511,username:'isolated',password:'',hostname:'unused',vhost:'StmPreMatch',queue:'_4511_',port:5672,tls:false},{snapshotUrl:url,customersUrl:url},{run:async(_name,action)=>action()});
  process.availableMemory=()=>0;
  await assert.rejects(()=>api.snapshot(),e=>{
   assert(e instanceof OperationError);assert.equal(e.diagnostic.reason,'memory_budget_exceeded');assert.equal(e.diagnostic.protocol,'local');assert.equal(e.diagnostic.httpStatus,undefined);assert.equal(e.diagnostic.snapshotMemory?.availableMemoryBytes,0);assert.equal(e.diagnostic.snapshotMemory?.limitingFactor,'available_memory');return true;
  });assert.equal(calls,0);
 }finally{process.availableMemory=original;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('official clients use lane context: global 256 is refused at 1800 MiB while InPlay completes under independent 128',async()=>{
 const keys=['LSPORTS_SNAPSHOT_MAX_RESPONSE_MB','LSPORTS_PREMATCH_SNAPSHOT_MAX_RESPONSE_MB','LSPORTS_INPLAY_SNAPSHOT_MAX_RESPONSE_MB'];
 const saved=keys.map(k=>process.env[k]);const original=process.availableMemory;let calls=0;
 const server=createServer(async(req,res)=>{for await(const _ of req){}calls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:[]}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  process.env.LSPORTS_SNAPSHOT_MAX_RESPONSE_MB='256';delete process.env.LSPORTS_PREMATCH_SNAPSHOT_MAX_RESPONSE_MB;delete process.env.LSPORTS_INPLAY_SNAPSHOT_MAX_RESPONSE_MB;process.availableMemory=()=>1800*MiB;
  const address=server.address();assert(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}`;
  const make=(lane:'prematch'|'inplay')=>clients({lane,packageId:lane==='prematch'?4511:4510,username:'isolated',password:'',hostname:'unused',vhost:'unused',queue:'unused',port:5672,tls:false},{snapshotUrl:url,customersUrl:url},{run:async(_name,action)=>action()});
  const inplay=make('inplay');assert.deepEqual(await inplay.snapshot(),[]);assert.equal(inplay.snapshotAudit?.()?.transport?.responseLimitBytes,128*MiB);
  await assert.rejects(()=>make('prematch').snapshot(),e=>e instanceof OperationError&&e.diagnostic.reason==='memory_budget_exceeded'&&e.diagnostic.responseLimitBytes===256*MiB);
  assert.equal(calls,1);
 }finally{process.availableMemory=original;keys.forEach((k,i)=>{if(saved[i]===undefined)delete process.env[k];else process.env[k]=saved[i];});server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
