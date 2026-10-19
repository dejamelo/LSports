import { gzipSync } from "node:zlib";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import amqp from "amqplib";
import type { ConsumeMessage } from "amqplib";
import { session } from "./connected.js";
import { TradeState } from "./state.js";
import type { PackageConfig } from "./config.js";
import { clients } from "./provider.js";
test("worker connects to configured queue, buffers deltas during snapshot, persists before ack and gates on shutdown", async () => {
  const state = new TradeState();
  const abort = new AbortController();
  let onMessage: (m: ConsumeMessage | null) => void = () => {};
  let acks = 0;
  let persistedOdds = 0;
  let finalOdds = 0;
  const channel = Object.assign(new EventEmitter(), {
    async prefetch(n: number) {
      assert.equal(n, 100);
    },
    async consume(
      queue: string,
      callback: typeof onMessage,
      options: { noAck: boolean; exclusive: boolean },
    ) {
      assert.equal(queue, "_4511_");
      assert.equal(options.noAck, false);
      assert.equal(options.exclusive, true);
      onMessage = callback;
      return { consumerTag: "test" };
    },
    ack() {
      assert.equal(persistedOdds, 2.8);
      acks++;
    },
    nack() {
      assert.fail("Valid delta must not be rejected");
    },
  });
  const conn = Object.assign(new EventEmitter(), {
    async createChannel() {
      return channel;
    },
    async close() {
      conn.emit("close");
    },
  });
  const pkg: PackageConfig = {
    lane: "prematch",
    packageId: 4511,
    username: "test-only",
    password: "",
    hostname: "stm-prematch.lsports.eu",
    vhost: "StmPreMatch",
    port: 5672,
    tls: false,
    queue: "_4511_",
  };
  const fakeClients: ReturnType<typeof clients> = {
    async distributionStatus() {
      return {
        isDistributionOn: true,
        consumers: [],
        numberMessagesInQueue: 0,
        messagesPerSecond: 0,
      };
    },
    async startDistribution() {},
    async catalog() {
      return [];
    },
    async snapshot() {
      const msg = {
        content: gzipSync(
          JSON.stringify({
            Header: { Type: 3, MsgGuid: "delta" },
            Body: {
              Events: [
                {
                  FixtureId: 100,
                  Markets: [
                    {
                      Id: 1,
                      Status: 1,
                      Bets: [{ Id: "123", Price: "2.8", Status: 1 }],
                    },
                  ],
                },
              ],
            },
          }),
        ),
        properties: {
          contentType: "application/octet-stream",
          contentEncoding: "gzip",
          headers: {
            MessageGuid: "delta",
            MessageType: "3",
            timestamp_in_ms: Date.now() + 100,
          },
        },
      } as unknown as ConsumeMessage;
      onMessage(msg);
      onMessage(msg);
      return [
        {
          fixtureId: 100,
          fixture: { sport: { name: "Football" }, status: 1 },
          markets: [
            {
              id: 1,
              name: "Winner",
              status: 1,
              bets: [{ id: "123", price: "2", status: 1, isChanged: 0 }],
            },
          ],
        },
      ];
    },
  };
  await session(
    pkg,
    {
      packages: [pkg],
      snapshotUrl: "https://stm-snapshot.lsports.eu",
      customersUrl: "https://stm-api.lsports.eu",
      recoveryMs: 300000,
      staleMs: 90000,
    },
    state,
    async () => {
      persistedOdds = state.feed().events[0]?.selections[0]?.odds || 0;
      if (state.connections.prematch.phase === "connected") {
        finalOdds = persistedOdds;
        abort.abort();
      }
    },
    abort.signal,
    {
      connect: (async (options: amqp.Options.Connect) => {
        assert.equal(options.vhost, "StmPreMatch");
        assert.equal(options.hostname, pkg.hostname);
        return conn;
      }) as unknown as typeof amqp.connect,
      clientFactory: () => fakeClients,
    },
  );
  assert.equal(acks, 2);
  assert.equal(finalOdds, 2.8);
  assert.equal(state.connections.prematch.phase, "stopped");
  assert.equal(state.feed().events[0].selections[0].available, false);
});
test("snapshot HTTP failure remains identified after AMQP cleanup instead of becoming generic authentication or close error", async () => {
  const { OperationError } = await import("./diagnostics.js");
  const state = new TradeState();
  const abort = new AbortController();
  const channel = Object.assign(new EventEmitter(), {
    async prefetch() {},
    async consume() {
      return { consumerTag: "test" };
    },
  });
  const connection = Object.assign(new EventEmitter(), {
    async createChannel() {
      return channel;
    },
    async close() {
      connection.emit("close");
    },
  });
  const pkg: PackageConfig = {
    lane: "prematch",
    packageId: 4511,
    username: "test-only",
    password: "",
    hostname: "stm-prematch.lsports.eu",
    vhost: "StmPreMatch",
    port: 5672,
    tls: false,
    queue: "_4511_",
  };
  const diagnostic = {
    operation: "snapshot.events" as const,
    protocol: "http" as const,
    category: "permission_denied" as const,
    httpStatus: 403,
    message: "Acceso denegado en snapshot.",
  };
  const fake: ReturnType<typeof clients> = {
    async distributionStatus() {
      return {
        isDistributionOn: true,
        consumers: [],
        numberMessagesInQueue: 0,
        messagesPerSecond: 0,
      };
    },
    async startDistribution() {},
    async snapshot() {
      throw new OperationError(diagnostic);
    },
    async catalog() {
      assert.fail("Snapshot failed first");
    },
  };
  await assert.rejects(
    () =>
      session(
        pkg,
        {
          packages: [pkg],
          snapshotUrl: "https://stm-snapshot.lsports.eu",
          customersUrl: "https://stm-api.lsports.eu",
          recoveryMs: 300000,
          staleMs: 90000,
        },
        state,
        async () => {},
        abort.signal,
        {
          clientFactory: () => fake,
          connect: (async () => connection) as unknown as typeof amqp.connect,
        },
      ),
    OperationError,
  );
  assert.deepEqual(state.connections.prematch.diagnostic, diagnostic);
  assert(
    state.connections.prematch.message.includes("snapshot.events [HTTP 403]"),
  );
});
test("malformed and unsupported messages are not ACKed or discarded: NACK requests requeue and closes the session", async () => {
  const { OperationError } = await import("./diagnostics.js");
  for (const [content, reason] of [
    [Buffer.from("invalid private payload"), "invalid_json"],
    [Buffer.from(JSON.stringify({ Header: { Type: 41, MsgGuid: "ambiguous-clock" }, Body: { Competition: { Id: 90, Events: [{ FixtureId: 100, Markets: [{ Id: 160, Bets: [{ Id: "1", Price: "2.63", LastUpdate: "2026-02-30T14:02:17.025" }] }] }] } } })), "invalid_timestamp"],
    [Buffer.from(JSON.stringify({ Header: { Type: 39, MsgGuid: "bad-score" }, Body: { Competition: { Id: 90, Events: [{ FixtureId: 100, OutrightScore: { ParticipantResults: "invalid" } }] } } })), "invalid_event_body"],
    [Buffer.from(JSON.stringify({Header:{Type:40,MsgGuid:"invalid-league"},Body:{Competition:{Id:90,Events:[]}}})), "invalid_event_body"],
    [Buffer.from(JSON.stringify({ Header: { Type: 37, MsgGuid: "bad-race" }, Body: { Competition: { Id: 90, Events: [{ FixtureId: 100 }] } } })), "invalid_event_body"],
    [
      Buffer.from(
        JSON.stringify({ Header: { Type: 999, MsgGuid: "test" }, Body: {} }),
      ),
      "unsupported_message_type",
    ],
  ] as const) {
    const state = new TradeState();
    const abort = new AbortController();
    let callback: (msg: ConsumeMessage | null) => void = () => {};
    let nacks = 0;
    let closed = false;
    const channel = Object.assign(new EventEmitter(), {
      async prefetch() {},
      async consume(_queue: string, cb: typeof callback) {
        callback = cb;
        return { consumerTag: "test" };
      },
      ack() {
        assert.fail("Failed message must not be ACKed");
      },
      nack(_msg: ConsumeMessage, all: boolean, requeue: boolean) {
        assert.equal(all, false);
        assert.equal(requeue, true);
        nacks++;
      },
    });
    const connection = Object.assign(new EventEmitter(), {
      async createChannel() {
        return channel;
      },
      async close() {
        closed = true;
        connection.emit("close");
      },
    });
    const pkg: PackageConfig = {
      lane: "prematch",
      packageId: 4511,
      username: "test-only",
      password: "",
      hostname: "stm-prematch.lsports.eu",
      vhost: "StmPreMatch",
      port: 5672,
      tls: false,
      queue: "_4511_",
    };
    const fake: ReturnType<typeof clients> = {
      async distributionStatus() {
        return {
          isDistributionOn: true,
          consumers: [],
          numberMessagesInQueue: 0,
          messagesPerSecond: 0,
        };
      },
      async startDistribution() {},
      async catalog() {
        return [];
      },
      async snapshot() {
        callback({
          content,
          properties: {
            contentType: "application/json",
            headers: { timestamp_in_ms: Date.now() },
          },
          fields: { redelivered: true },
        } as unknown as ConsumeMessage);
        return [];
      },
    };
    await assert.rejects(
      () =>
        session(
          pkg,
          {
            packages: [pkg],
            snapshotUrl: "https://stm-snapshot.lsports.eu",
            customersUrl: "https://stm-api.lsports.eu",
            recoveryMs: 300000,
            staleMs: 90000,
          },
          state,
          async () => {},
          abort.signal,
          {
            clientFactory: () => fake,
            connect: (async () => connection) as unknown as typeof amqp.connect,
          },
        ),
      OperationError,
    );
    assert.equal(nacks, 1);
    assert(closed);
    assert.equal(state.connections.prematch.diagnostic?.reason, reason);
    assert.equal(
      state.connections.prematch.diagnostic?.deliveryDisposition,
      "requeue_requested",
    );
    assert.equal(
      state.connections.prematch.diagnostic?.messageMetadata?.redelivered,
      true,
    );
    assert(
      !JSON.stringify(state.connections.prematch).includes("private payload"),
    );
  }
});
test(
  "provider interruption heartbeat is processed and ACKed after blocked state instead of becoming a poison message",
  { timeout: 5000 },
  async () => {
    const { OperationError } = await import("./diagnostics.js");
    const state = new TradeState();
    const abort = new AbortController();
    let callback: (msg: ConsumeMessage | null) => void = () => {};
    let acks = 0;
    let persisted = false;
    const channel = Object.assign(new EventEmitter(), {
      async prefetch() {},
      async consume(_queue: string, cb: typeof callback) {
        callback = cb;
        return { consumerTag: "test" };
      },
      ack() {
        assert(persisted);
        acks++;
      },
      nack() {
        assert.fail("Processed control must not be redelivered");
      },
    });
    const connection = Object.assign(new EventEmitter(), {
      async createChannel() {
        return channel;
      },
      async close() {
        connection.emit("close");
      },
    });
    const pkg: PackageConfig = {
      lane: "inplay",
      packageId: 4510,
      username: "test-only",
      password: "",
      hostname: "stm-inplay.lsports.eu",
      vhost: "StmInPlay",
      port: 5672,
      tls: false,
      queue: "_4510_",
    };
    const fake: ReturnType<typeof clients> = {
      async distributionStatus() {
        return {
          isDistributionOn: true,
          consumers: [],
          numberMessagesInQueue: 0,
          messagesPerSecond: 0,
        };
      },
      async startDistribution() {},
      async catalog() {
        return [];
      },
      async snapshot() {
        callback({
          content: Buffer.from(
            JSON.stringify({
              Header: { Type: 32 },
              Body: { FeedInterrupted: [1] },
            }),
          ),
          properties: {},
        } as unknown as ConsumeMessage);
        return [];
      },
    };
    await assert.rejects(
      () =>
        session(
          pkg,
          {
            packages: [pkg],
            snapshotUrl: "https://stm-snapshot.lsports.eu",
            customersUrl: "https://stm-api.lsports.eu",
            recoveryMs: 300000,
            staleMs: 90000,
          },
          state,
          async () => {
            if (
              state.connections.inplay.diagnostic?.reason ===
              "provider_interrupted"
            )
              persisted = true;
          },
          abort.signal,
          {
            clientFactory: () => fake,
            connect: (async () => connection) as unknown as typeof amqp.connect,
          },
        ),
      OperationError,
    );
    assert.equal(acks, 1);
    assert.equal(
      state.connections.inplay.diagnostic?.reason,
      "provider_interrupted",
    );
    assert.equal(state.connections.inplay.phase, "error");
  },
);

test("type 37 preserves every participant and persists before ACK, including duplicate delivery", async () => {
  const state = new TradeState();
  const abort = new AbortController();
  let onMessage: (m: ConsumeMessage | null) => void = () => {};
  let acks = 0;
  let persistedOdds = 0;
  let finalOdds = 0;
  const channel = Object.assign(new EventEmitter(), {
    async prefetch(n: number) {
      assert.equal(n, 100);
    },
    async consume(
      queue: string,
      callback: typeof onMessage,
      options: { noAck: boolean; exclusive: boolean },
    ) {
      assert.equal(queue, "_4511_");
      assert.equal(options.noAck, false);
      assert.equal(options.exclusive, true);
      onMessage = callback;
      return { consumerTag: "test" };
    },
    ack() {
      assert.equal(persistedOdds, 12);
      acks++;
    },
    nack() {
      assert.fail("Valid delta must not be rejected");
    },
  });
  const conn = Object.assign(new EventEmitter(), {
    async createChannel() {
      return channel;
    },
    async close() {
      conn.emit("close");
    },
  });
  const pkg: PackageConfig = {
    lane: "prematch",
    packageId: 4511,
    username: "test-only",
    password: "",
    hostname: "stm-prematch.lsports.eu",
    vhost: "StmPreMatch",
    port: 5672,
    tls: false,
    queue: "_4511_",
  };
  const fakeClients: ReturnType<typeof clients> = {
    async distributionStatus() {
      return {
        isDistributionOn: true,
        consumers: [],
        numberMessagesInQueue: 0,
        messagesPerSecond: 0,
      };
    },
    async startDistribution() {},
    async catalog() {
      return [];
    },
    async snapshot() {
      const msg = {
        content: Buffer.from(JSON.stringify({
          Header: { Type: 37, MsgGuid: "race" },
          Body: { Competition: { Id: 90, Name: "Race meeting", Events: [{ FixtureId: 100,
            OutrightFixture: { FixtureName: "Race 1", Sport: { Name: "Horse Racing" }, Status: 1,
              Participants: Array.from({length: 12}, (_, i) => ({ Id: i + 1, Name: `Horse ${i + 1}`, Position: String(i + 1), IsActive: 1 })) }
          }] } }
        })),
        properties: { headers: { timestamp_in_ms: Date.now() + 100 } },
        fields: { redelivered: true },
      } as unknown as ConsumeMessage;
      onMessage(msg);
      onMessage(msg);
      return [
        {
          fixtureId: 100,
          fixture: { sport: { name: "Football" }, status: 1 },
          markets: [
            {
              id: 1,
              name: "Winner",
              status: 1,
              bets: [{ id: "123", price: "2", status: 1, isChanged: 0 }],
            },
          ],
        },
      ];
    },
  };
  await session(
    pkg,
    {
      packages: [pkg],
      snapshotUrl: "https://stm-snapshot.lsports.eu",
      customersUrl: "https://stm-api.lsports.eu",
      recoveryMs: 300000,
      staleMs: 90000,
    },
    state,
    async () => {
      persistedOdds = state.feed().events.find(e => e.kind === "outright")?.participants?.length || 0;
      if (state.connections.prematch.phase === "connected") {
        finalOdds = persistedOdds;
        abort.abort();
      }
    },
    abort.signal,
    {
      connect: (async (options: amqp.Options.Connect) => {
        assert.equal(options.vhost, "StmPreMatch");
        assert.equal(options.hostname, pkg.hostname);
        return conn;
      }) as unknown as typeof amqp.connect,
      clientFactory: () => fakeClients,
    },
  );
  assert.equal(acks, 2);
  assert.equal(finalOdds, 12);
  assert.equal(state.connections.prematch.phase, "stopped");
  assert.equal(state.feed().events.find(e => e.kind === "outright")?.participants?.[11].name, "Horse 12");
});

test("type 37 publication failure requests requeue without ACK", async () => {
  const state = new TradeState();
  const abort = new AbortController();
  let onMessage: (m: ConsumeMessage | null) => void = () => {};
  let acks = 0;
  let persistedOdds = 0;
  let finalOdds = 0;
  const channel = Object.assign(new EventEmitter(), {
    async prefetch(n: number) {
      assert.equal(n, 100);
    },
    async consume(
      queue: string,
      callback: typeof onMessage,
      options: { noAck: boolean; exclusive: boolean },
    ) {
      assert.equal(queue, "_4511_");
      assert.equal(options.noAck, false);
      assert.equal(options.exclusive, true);
      onMessage = callback;
      return { consumerTag: "test" };
    },
    ack() {
      assert.fail("Unpersisted race must not be ACKed");
    },
    nack(_msg: ConsumeMessage, all: boolean, requeue: boolean) {
      assert.equal(all, false);
      assert.equal(requeue, true);
      acks++;
    },
  });
  const conn = Object.assign(new EventEmitter(), {
    async createChannel() {
      return channel;
    },
    async close() {
      conn.emit("close");
    },
  });
  const pkg: PackageConfig = {
    lane: "prematch",
    packageId: 4511,
    username: "test-only",
    password: "",
    hostname: "stm-prematch.lsports.eu",
    vhost: "StmPreMatch",
    port: 5672,
    tls: false,
    queue: "_4511_",
  };
  const fakeClients: ReturnType<typeof clients> = {
    async distributionStatus() {
      return {
        isDistributionOn: true,
        consumers: [],
        numberMessagesInQueue: 0,
        messagesPerSecond: 0,
      };
    },
    async startDistribution() {},
    async catalog() {
      return [];
    },
    async snapshot() {
      const msg = {
        content: Buffer.from(JSON.stringify({
          Header: { Type: 37, MsgGuid: "race" },
          Body: { Competition: { Id: 90, Name: "Race meeting", Events: [{ FixtureId: 100,
            OutrightFixture: { FixtureName: "Race 1", Sport: { Name: "Horse Racing" }, Status: 1,
              Participants: Array.from({length: 12}, (_, i) => ({ Id: i + 1, Name: `Horse ${i + 1}`, Position: String(i + 1), IsActive: 1 })) }
          }] } }
        })),
        properties: { headers: { timestamp_in_ms: Date.now() + 100 } },
        fields: { redelivered: true },
      } as unknown as ConsumeMessage;
      onMessage(msg);
      onMessage(msg);
      return [
        {
          fixtureId: 100,
          fixture: { sport: { name: "Football" }, status: 1 },
          markets: [
            {
              id: 1,
              name: "Winner",
              status: 1,
              bets: [{ id: "123", price: "2", status: 1, isChanged: 0 }],
            },
          ],
        },
      ];
    },
  };
  await assert.rejects(() => session(
    pkg,
    {
      packages: [pkg],
      snapshotUrl: "https://stm-snapshot.lsports.eu",
      customersUrl: "https://stm-api.lsports.eu",
      recoveryMs: 300000,
      staleMs: 90000,
    },
    state,
    async () => {
      persistedOdds = state.feed().events.find(e => e.kind === "outright")?.participants?.length || 0;
      if (persistedOdds === 12 && !state.connections.prematch.diagnostic) {
        throw new Error("test persistence failure");
      }
      if (state.connections.prematch.phase === "connected") {
        finalOdds = persistedOdds;
        abort.abort();
      }
    },
    abort.signal,
    {
      connect: (async (options: amqp.Options.Connect) => {
        assert.equal(options.vhost, "StmPreMatch");
        assert.equal(options.hostname, pkg.hostname);
        return conn;
      }) as unknown as typeof amqp.connect,
      clientFactory: () => fakeClients,
    },
  ));
  assert.equal(acks, 1);

  assert.equal(state.connections.prematch.diagnostic?.deliveryDisposition, "requeue_requested");
  assert.equal(state.feed().events.find(e => e.kind === "outright")?.participants?.[11].name, "Horse 12");
});


test('inventory wait processes and persists AMQP before begin(ids); rejected inventory preserves AMQP consumption and HTTP diagnostic without another distribution start',{timeout:10000},async()=>{
 const {OperationError}=await import('./diagnostics.js');const state=new TradeState(),abort=new AbortController();let closed=0,starts=0,persisted=0,acks=0,marketPersisted=false;let deliver:((msg:ConsumeMessage)=>void)|undefined;let resolveAck:()=>void=()=>{};const acked=new Promise<void>(resolve=>{resolveAck=resolve;});
 const channel=Object.assign(new EventEmitter(),{async prefetch(){},async consume(_queue:string,callback:(msg:ConsumeMessage)=>void){deliver=callback;return{consumerTag:'isolated'};},ack(){assert.equal(marketPersisted,true);assert.equal(closed,0);acks++;resolveAck();},nack(){assert.fail('A valid delta must persist before ACK while the invalid HTTP baseline remains blocked');}});
 const connection=Object.assign(new EventEmitter(),{async createChannel(){return channel;},async close(){closed++;connection.emit('close');}});
 const pkg:PackageConfig={lane:'prematch',packageId:4511,username:'isolated',password:'',hostname:'unused',vhost:'StmPreMatch',port:5672,tls:false,queue:'_4511_'};
 const fake:ReturnType<typeof clients>={async distributionStatus(){return{isDistributionOn:true,consumers:[],numberMessagesInQueue:0,messagesPerSecond:0};},async startDistribution(){starts++;},async snapshot(){assert.fail('Partitioned recovery only');},async snapshotPartitioned(){deliver!({content:Buffer.from(JSON.stringify({Header:{Type:3,MsgGuid:'isolated-inventory-market',ServerTimestamp:Date.now()},Body:{Events:[{FixtureId:123,Markets:[{Id:1,Status:1,Bets:[{Id:'123',Price:'2.4',Status:1}]}]}]}})),properties:{headers:{}},fields:{redelivered:false}} as ConsumeMessage);await acked;assert.equal(state.connections.prematch.phase,'recovering');throw new OperationError({operation:'subscriptions.list',protocol:'http',category:'invalid_response',reason:'invalid_snapshot',httpStatus:200,snapshotValidation:{phase:'inventory',code:'inventory_invalid_ids',attribution:'provider_contract',rawCount:2,invalidCount:1,itemTypes:{number:1,string:1}},message:'ISOLATED invalid inventory'});},async catalog(){return[];}};
 const work=session(pkg,{packages:[pkg],snapshotUrl:'https://snapshot.invalid',customersUrl:'https://customers.invalid',recoveryMs:300000,staleMs:90000},state,async()=>{if(state.feed().coverage?.prematch.messages===1)marketPersisted=true;if(state.connections.prematch.phase==='recovering'&&state.connections.prematch.recoveryProgress?.stage==='waiting_retry'){persisted++;assert.equal(closed,0);assert.equal(state.connections.prematch.lastSnapshotDiagnostic?.snapshotValidation?.code,'inventory_invalid_ids');assert.equal(state.connections.prematch.recoveryProgress.regularSnapshotReady,false);abort.abort();}},abort.signal,{clientFactory:()=>fake,connect:(async()=>connection) as unknown as typeof amqp.connect});
 await work;assert.ok(persisted>0);assert.equal(starts,1);assert.equal(closed,1);assert.equal(acks,1);assert.equal(state.feed().events.flatMap(e=>e.selections).some(s=>s.available),false);
});


test('distribution observations persist before propagating a failed Start without opening AMQP',async()=>{
 const{OperationError}=await import('./diagnostics.js');const state=new TradeState(),abort=new AbortController();let saved=false;
 const observations=[{stage:'after_propagation' as const,observedAtUTC:'2026-10-19T14:00:03Z',bodyIsDistributionOn:false,sdkIsDistributionOn:false,elapsedSinceStartMs:2002,propagationDelayMs:2000}];
 const pkg:PackageConfig={lane:'prematch',packageId:4511,username:'isolated',password:'',hostname:'unused',vhost:'unused',port:5672,tls:false,queue:'_4511_'};
 const fake:ReturnType<typeof clients>={async snapshot(){assert.fail('Snapshot cannot run before activation');},async catalog(){return[];},async distributionStatus(){assert.fail('Unused status stub');},distributionObservations:()=>observations,async startDistribution(){throw new OperationError({operation:'distribution.start',protocol:'http',category:'invalid_response',reason:'distribution_still_off',message:'ISOLATED'});}};
 await assert.rejects(session(pkg,{packages:[pkg],snapshotUrl:'https://snapshot.invalid',customersUrl:'https://customers.invalid',recoveryMs:300000,staleMs:90000},state,async()=>{if(state.connections.prematch.distributionObservations?.length)saved=true;},abort.signal,{clientFactory:()=>fake,connect:(async()=>{assert.fail('Do not connect MQ after failed distribution activation');}) as unknown as typeof amqp.connect}),OperationError);
 assert.equal(saved,true);assert.deepEqual(state.connections.prematch.distributionObservations,observations);
});
