import { gzipSync } from "node:zlib";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import amqp from "amqplib";
import type { ConsumeMessage } from "amqplib";
import { session } from "./connected.js";
import { TradeState, quoteConfirmed } from "./state.js";
import type { PackageConfig } from "./config.js";
import { clients } from "./provider.js";
test("worker consumes while snapshot is pending, preserves newer deltas, persists before ack and gates on shutdown", async () => {
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
      persistedOdds = Number(state.rows.prematch.get(100)?.markets.get('1')?.bets?.[0]?.price||0);
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
  assert.equal(acks, 2); // Both uncommitted deliveries in the finite batch are requeued.

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


test('distribution is started before AMQP; failed activation persists observations without connecting',async()=>{
 const{OperationError}=await import('./diagnostics.js');const state=new TradeState(),abort=new AbortController();let saved=false,consuming=false,closed=0;
 const observations=[{stage:'after_propagation' as const,observedAtUTC:'2026-10-19T14:00:03Z',bodyIsDistributionOn:false,sdkIsDistributionOn:false,elapsedSinceStartMs:2002,propagationDelayMs:2000}];
 const pkg:PackageConfig={lane:'prematch',packageId:4511,username:'isolated',password:'',hostname:'unused',vhost:'unused',queue:'unused',port:5672,tls:false};
 const channel=Object.assign(new EventEmitter(),{async prefetch(){},async consume(){consuming=true;}});
 const connection=Object.assign(new EventEmitter(),{async createChannel(){return channel;},async close(){closed++;connection.emit('close');}});
 const fake:ReturnType<typeof clients>={async snapshot(){assert.fail('Snapshot cannot run after failed activation');},async catalog(){return[];},async distributionStatus(){assert.fail('Unused stub');},distributionObservations:()=>observations,async startDistribution(){assert.equal(consuming,false);throw new OperationError({operation:'distribution.start',protocol:'http',category:'invalid_response',reason:'distribution_still_off',message:'ISOLATED'});}};
 await assert.rejects(session(pkg,{packages:[pkg],snapshotUrl:'https://snapshot.invalid',customersUrl:'https://customers.invalid',recoveryMs:300000,staleMs:90000},state,async()=>{if(state.connections.prematch.distributionObservations?.length)saved=true;},abort.signal,{clientFactory:()=>fake,connect:(async()=>connection) as unknown as typeof amqp.connect}),OperationError);
 assert.equal(saved,true);assert.equal(closed,0);assert.equal(consuming,false);assert.deepEqual(state.connections.prematch.distributionObservations,observations);
});

test('full recovery consumes 100 deltas before snapshot completes, commits once before ACK and stops distribution before closing',{timeout:15000},async()=>{
 const state=new TradeState(),abort=new AbortController();let deliver:(m:ConsumeMessage)=>void=()=>{};let acks=0,persisted=0,messageWrites=0,stopped=false;
 let resolveAck:()=>void=()=>{};const allAcked=new Promise<void>(r=>resolveAck=r);
 const channel=Object.assign(new EventEmitter(),{async prefetch(n:number){assert.equal(n,100);},async consume(_q:string,cb:typeof deliver){deliver=cb;},ack(){assert.equal(persisted,100);assert.equal(stopped,false);if(++acks===100)resolveAck();},nack(){assert.fail('Valid updates must not be dropped');}});
 const connection=Object.assign(new EventEmitter(),{async createChannel(){return channel;},async close(){assert.equal(stopped,true);connection.emit('close');}});
 const pkg:PackageConfig={lane:'prematch',packageId:4511,username:'isolated',password:'',hostname:'unused',vhost:'StmPreMatch',port:5672,tls:false,queue:'_4511_'};
 const fake:ReturnType<typeof clients>={async startDistribution(){},async stopDistribution(){assert.equal(acks,100);stopped=true;},async distributionStatus(){return{isDistributionOn:true,consumers:[],numberMessagesInQueue:0,messagesPerSecond:0};},async snapshot(){assert.fail('Must use unfiltered spooled snapshot');},async catalog(){return[];},async snapshotFull(sink){
  for(let i=0;i<100;i++)deliver({content:Buffer.from(JSON.stringify({Header:{Type:3,MsgGuid:'live-'+i,ServerTimestamp:Date.now()},Body:{Events:[{FixtureId:1,Markets:[{Id:1,Status:1,Bets:[{Id:'123',Price:'2.8',Status:1}]}]}]}})),properties:{headers:{}},fields:{redelivered:false}} as ConsumeMessage);
  await allAcked;assert.equal(state.connections.prematch.recoveryProgress?.regularSnapshotReady,false);assert.equal(state.connections.prematch.phase,'recovering');assert.ok(messageWrites<=3);
  await sink.apply({fixtureId:1,fixture:{status:1,sport:{name:'Football'}},markets:[{id:1,status:1,bets:[{id:'123',price:'2.1',status:1,isChanged:1}]}]},Date.now()-10000);
  return{ids:new Set([1]),rows:1,bytes:100};
 }};
 await session(pkg,{packages:[pkg],snapshotUrl:'https://snapshot.invalid',customersUrl:'https://customers.invalid',recoveryMs:300000,staleMs:90000},state,async()=>{persisted=state.feed().coverage?.prematch.messages??0;if(persisted)messageWrites++;if(state.connections.prematch.phase==='connected')abort.abort();},abort.signal,{clientFactory:()=>fake,connect:(async()=>connection) as unknown as typeof amqp.connect});
 assert.equal(acks,100);assert.equal(stopped,true);assert.equal(state.feed().events[0].markets?.[0].selections[0].odds,2.8);
});


test('supplier-confirmed Start/propagation/status precedes connect/consume/snapshot on BOTH lanes, without a second wait',{timeout:10000},async()=>{
 for(const lane of ['prematch','inplay'] as const){
  const order:string[]=[],state=new TradeState(),abort=new AbortController();let propagated=false,consumer=false;
  const pkg:PackageConfig={lane,packageId:lane==='prematch'?4511:4510,username:'isolated',password:'',hostname:'unused',vhost:'unused',queue:'unused',port:5672,tls:false};
  const channel=Object.assign(new EventEmitter(),{async prefetch(){},async consume(){order.push('consume');consumer=true;return{consumerTag:'isolated'};}});
  const connection=Object.assign(new EventEmitter(),{async createChannel(){return channel;},async close(){order.push('close');connection.emit('close');}});
  const api:ReturnType<typeof clients>={async startDistribution(){order.push('start');await new Promise(r=>setTimeout(r,10));propagated=true;order.push('status_on');},async stopDistribution(){order.push('stop');},async snapshot(){assert(consumer);order.push('snapshot');return[];},async catalog(){return[];},async distributionStatus(){return{isDistributionOn:true,consumers:[],numberMessagesInQueue:0,messagesPerSecond:0};}};
  const before=Date.now();await session(pkg,{packages:[pkg],snapshotUrl:'https://snapshot.invalid',customersUrl:'https://customers.invalid',recoveryMs:300000,staleMs:90000},state,async()=>{if(state.connections[lane].phase==='connected')abort.abort();},abort.signal,{clientFactory:()=>api,connect:(async()=>{assert(propagated);order.push('connect');return connection;}) as unknown as typeof amqp.connect});
  assert.deepEqual(order.slice(0,5),['start','status_on','connect','consume','snapshot']);assert(order.indexOf('stop')<order.indexOf('close'));assert(Date.now()-before<1800,'session must not add another 2000ms after provider propagation');
 }
});

test('queued persistence is shared, active capture is NEVER joined; callers await a capture after their mutation',async()=>{
 const {coalescedPersistence}=await import('./connected.js');let version=1;const captured:number[]=[],release:(()=>void)[]=[];
 const save=coalescedPersistence(async()=>{captured.push(version);await new Promise<void>(resolve=>release.push(resolve));});
 const one=save();await new Promise(r=>setImmediate(r));version=2;const two=save();version=3;const three=save();assert.equal(two,three);assert.notEqual(one,two);assert.deepEqual(captured,[1]);
 release.shift()!();await one;await new Promise(r=>setImmediate(r));assert.deepEqual(captured,[1,3]);version=4;const four=save();let resolved=false;four.then(()=>{resolved=true;});assert.equal(resolved,false);release.shift()!();await two;await new Promise(r=>setImmediate(r));assert.deepEqual(captured,[1,3,4]);assert.equal(resolved,false);release.shift()!();await four;assert.equal(resolved,true);
});

test('1600 snapshot rows do not trigger 160 full checkpoints; continuous AMQP still persists before ACK',{timeout:10000},async()=>{
 const pkg:PackageConfig={lane:'prematch',packageId:4511,username:'isolated',password:'',hostname:'unused',vhost:'unused',queue:'unused',port:5672,tls:false};const state=new TradeState(),abort=new AbortController();let writes=0,acks=0,deliver:((msg:ConsumeMessage)=>void)|undefined;let persisted=false;
 const channel=Object.assign(new EventEmitter(),{async prefetch(){},async consume(_q:string,cb:(msg:ConsumeMessage)=>void){deliver=cb;return{consumerTag:'test'};},ack(){assert.equal(persisted,true);acks++;},nack(){assert.fail('must not nack');}});
 const connection=Object.assign(new EventEmitter(),{async createChannel(){return channel;},async close(){connection.emit('close');}});
 const api:ReturnType<typeof clients>={async startDistribution(){},async stopDistribution(){},async distributionStatus(){return{isDistributionOn:true,consumers:[],numberMessagesInQueue:0,messagesPerSecond:0};},async snapshot(){assert.fail('Full recovery only');},async catalog(){return[];},async snapshotFull(sink){
  for(let i=1;i<=1600;i++)await sink.apply({fixtureId:i,fixture:{status:1,sport:{name:'Football'}},markets:[]},Date.now()-1000);
  deliver!({content:Buffer.from(JSON.stringify({Header:{Type:3,MsgGuid:'throughput-test',ServerTimestamp:Date.now()},Body:{Events:[{FixtureId:1,Markets:[{Id:1,Status:1,Bets:[{Id:'123',Price:'2.4',Status:1}]}]}]}})),properties:{headers:{}},fields:{redelivered:false}} as ConsumeMessage);
  while(!acks)await new Promise(r=>setImmediate(r));return{ids:new Set(Array.from({length:1600},(_,i)=>i+1)),rows:1600,bytes:100};
 }};
 await session(pkg,{packages:[pkg],snapshotUrl:'http://isolated',customersUrl:'http://isolated',staleMs:90000,recoveryMs:300000},state,async()=>{writes++;if(state.feed().coverage?.prematch.messages)persisted=true;if(state.connections.prematch.phase==='connected')abort.abort();},abort.signal,{clientFactory:()=>api,connect:(async()=>connection) as unknown as typeof amqp.connect});
 assert.equal(acks,1);assert.ok(writes<15,`redundant full writes: ${writes}`);assert.equal(state.connections.prematch.fullSnapshot?.ackedDuringRecovery,1);
});

test('a local coordinator deferral retries at its deadline without adding five minutes or classifying it as supplier HTTP429',{timeout:5000},async()=>{
 const {OperationError}=await import('./diagnostics.js');
 const pkg:PackageConfig={lane:'prematch',packageId:4511,username:'isolated',password:'',hostname:'unused',vhost:'unused',queue:'unused',port:5672,tls:false},abort=new AbortController(),state=new TradeState();let attempts=0;
 const channel=Object.assign(new EventEmitter(),{async prefetch(){},async consume(){return{consumerTag:'test'};}}),connection=Object.assign(new EventEmitter(),{async createChannel(){return channel;},async close(){connection.emit('close');}});
 const api:ReturnType<typeof clients>={async startDistribution(){},async stopDistribution(){},async distributionStatus(){return{isDistributionOn:true,consumers:[],numberMessagesInQueue:0,messagesPerSecond:0};},async snapshot(){throw Error('unexpected');},async catalog(){return[];},async snapshotFull(){if(++attempts===1)throw new OperationError({operation:'snapshot.events',protocol:'http',category:'rate_limited',deferred:true,rateLimitSource:'local_in_flight',retryAt:new Date(Date.now()+10).toISOString(),retryAfterMs:10,message:'isolated local defer'});return{ids:new Set(),rows:0,bytes:0};}};
 const timeout=setTimeout(()=>abort.abort(),3500);
 try{await session(pkg,{packages:[pkg],snapshotUrl:'http://isolated',customersUrl:'http://isolated',staleMs:90000,recoveryMs:300000},state,async()=>{if(state.connections.prematch.phase==='connected')abort.abort();},abort.signal,{clientFactory:()=>api,connect:(async()=>connection) as unknown as typeof amqp.connect});assert.equal(attempts,2);assert.equal(state.connections.prematch.lastSnapshotDiagnostic,undefined);}finally{clearTimeout(timeout);}
});

test('snapshot wait instrumentation distinguishes processing barrier from state exclusivity without reordering',async()=>{
 const {snapshotApplyTurn}=await import('./connected.js');const state=new TradeState();let releaseProcessing!:()=>void,releaseState!:()=>void;const stages:string[]=[];const order:string[]=[];
 const processing=new Promise<void>(resolve=>releaseProcessing=resolve);
 const occupied=state.exclusive(()=>new Promise<void>(resolve=>{releaseState=resolve;}));
 const task=snapshotApplyTurn(processing,state,()=>{order.push('apply');return 7;},stage=>stages.push(stage),5);
 await new Promise(r=>setTimeout(r,15));assert.ok(stages.includes('processing_queue'));assert.deepEqual(order,[]);
 releaseProcessing();await new Promise(r=>setTimeout(r,15));assert.ok(stages.includes('state_exclusive'));assert.deepEqual(order,[]);
 releaseState();await occupied;assert.equal(await task,7);assert.deepEqual(order,['apply']);assert.equal(stages.at(-1),'completed');
});

test('snapshot wait diagnostics cannot hide the original application failure',async()=>{
 const {snapshotApplyTurn}=await import('./connected.js');const expected=new Error('isolated application failure');
 await assert.rejects(snapshotApplyTurn(Promise.resolve(),new TradeState(),()=>{throw expected;},()=>{throw new Error('isolated logging failure');}),error=>error===expected);
});

test('publication capture releases the state gate during disk I/O while preserving a frozen checkpoint',async()=>{
 const {publicationCaptureTurn}=await import('./connected.js');const state=new TradeState();state.apply('prematch',[{fixtureId:1,fixture:{status:1}}],1);
 let began!:()=>void,release!:()=>void;const started=new Promise<void>(r=>began=r);const pending=publicationCaptureTurn(state,async stable=>{began();await new Promise<void>(r=>release=r);assert.equal(stable.rows.prematch.get(1)?.fixture?.value.status,1);});
 await started;await state.publicationMutation(()=>state.apply('prematch',[{fixtureId:1,fixture:{status:2}}],2));assert.equal(state.rows.prematch.get(1)?.fixture?.value.status,2);release();await pending;
 assert.equal(state.rows.prematch.get(1)?.fixture?.value.status,2);await state.publicationIdle();
});
test('publication capture cleans up failed writers and preserves external frozen projections',async()=>{
 const {publicationCaptureTurn}=await import('./connected.js');const state=new TradeState();state.apply('prematch',[{fixtureId:1,fixture:{status:1}}],1);const view=state.projection();
 await assert.rejects(publicationCaptureTurn(state,async()=>{throw Error('isolated disk failure');}));await state.publicationIdle();
 await state.publicationMutation(()=>state.apply('prematch',[{fixtureId:1,fixture:{status:2}}],2));assert.equal(state.rows.prematch.get(1)?.fixture?.value.status,2);assert.ok(view);
});

test('captured checkpoint retains market versions and settlements while live state advances',async()=>{
 const {checkpoint}=await import('./persistence.js');const state=new TradeState();
 state.apply('prematch',[{fixtureId:1,fixture:{status:1},markets:[{id:1,status:1,bets:[{id:'1',price:'2.1',status:1,isChanged:0}]}]}],100);
 const expected=structuredClone(checkpoint(state));const captured=await state.exclusive(()=>state.capturePublication());
 try{await state.publicationMutation(()=>state.apply('prematch',[{fixtureId:1,markets:[{id:1,status:1,bets:[{id:'1',price:'3.2',status:1,isChanged:0}]}]}],200));assert.deepEqual(checkpoint(captured.state),expected);assert.notDeepEqual(checkpoint(state),expected);}finally{captured.release();}
});

test('heartbeat cannot queue repeated full writes while a snapshot is applying',async()=>{
 const {heartbeatPublicationDue}=await import('./connected.js');const state=new TradeState();
 state.set('prematch',{fullSnapshot:{method:'disk_spool_two_pass',startedAt:'2026-10-22T20:00:00Z',stage:'apply'}});
 assert.equal(heartbeatPublicationDue(state,1000,6000),false);assert.equal(heartbeatPublicationDue(state,1000,61000),true);
 state.set('prematch',{lastSnapshotErrorAt:'2026-10-22T20:01:00Z'});assert.equal(heartbeatPublicationDue(state,1000,6000),true);
});

test('durable inbox checkpoint is deferred only during full snapshot application',async()=>{
 const {inboxCheckpointDeferredDuringSnapshot}=await import('./connected.js');
 assert.equal(inboxCheckpointDeferredDuringSnapshot(true),true);
 assert.equal(inboxCheckpointDeferredDuringSnapshot(false),false);
});

test('heap reserve waits for publication completion without retaining the writer gate',async()=>{
 const {spawnSync}=await import('node:child_process');const code=`import{TradeState}from'./apps/worker/src/state.ts';const s=new TradeState();const captured=await s.exclusive(()=>s.capturePublication());let mutated=false,waiting=false;const task=s.publicationMutation(()=>mutated=true,active=>waiting=active);await new Promise(r=>setTimeout(r,20));if(mutated||!waiting)throw Error('reserve not enforced');captured.release();await task;if(!mutated||waiting)throw Error('writer did not release reserve');console.log('heap-reserve-offline-ok');`;
 const child=spawnSync(process.execPath,['--max-old-space-size=128','--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),encoding:'utf8',timeout:15000});assert.equal(child.status,0,child.stderr);assert.ok(child.stdout.includes('heap-reserve-offline-ok'));
});

test('snapshot confirmation shares bounded immutable observations instead of duplicating fresh keys',()=>{
 const s=new TradeState();const bets=Array.from({length:10000},(_,i)=>({id:String(i),price:'2.1',status:1,isChanged:0}));
 s.apply('prematch',[{fixtureId:1,markets:[{id:1,status:1,bets}]}],100);
 s.beginPartitionedSnapshot('prematch');
 s.apply('prematch',[{fixtureId:1,marketRecovery:true,markets:[{id:1,status:1,bets}]}],200);
 const row=s.rows.prematch.get(1)!;
 assert.equal(row.freshBets?.size,0);assert.equal(row.snapshotBets?.size,0);
 const stored=row.markets.get('1')!.bets![0];assert.equal(quoteConfirmed(row,'1:0',stored),true);
 row.quoteInvalidations=new Set(['1:0']);assert.equal(quoteConfirmed(row,'1:0',stored),false);
 row.quoteInvalidations.clear();
 s.apply('prematch',[{fixtureId:1,marketRecovery:true,markets:[{id:1,status:1,bets}]}],200);assert.equal(quoteConfirmed(row,'1:0',row.markets.get('1')!.bets![0]),true);
 // A status-only live update preserves the confirmed stored quote.
 s.apply('prematch',[{fixtureId:1,markets:[{id:1,status:1,bets:[{...bets[0],status:2}]}]}],200);assert.equal(quoteConfirmed(row,'1:0',row.markets.get('1')!.bets![0]),true);
 // An older snapshot observation cannot erase the prior confirmed quote.
 s.apply('prematch',[{fixtureId:1,marketRecovery:true,markets:[{id:1,bets:[{...bets[0],lastUpdate:new Date(100)}]}]}],300);
 assert.equal(row.freshBets?.has('1:0'),true);
});

test('snapshot reuses persisted selection objects only when effective fields are identical',()=>{
 const s=new TradeState(),time=new Date('2026-10-26T03:00:00.000Z');
 s.apply('prematch',[{fixtureId:9,fixture:{status:1},markets:[{id:160,status:1,bets:[{id:'7',price:'2.1',status:1,lastUpdate:time}]}]} as any],+time);
 const row=s.rows.prematch.get(9)!,saved=row.markets.get('160')!.bets![0];
 s.beginPartitionedSnapshot('prematch');
 s.apply('prematch',[{fixtureId:9,fixture:{status:1},markets:[{id:160,status:1,bets:[{id:'7',price:'2.1',status:1,lastUpdate:new Date(+time)}]}]} as any],+time,{source:'snapshot',receivedAt:+time});
 assert.strictEqual(row.markets.get('160')!.bets![0],saved,'identical snapshot fields reuse the persisted object');
 s.apply('prematch',[{fixtureId:9,fixture:{status:1},markets:[{id:160,status:1,bets:[{id:'7',price:'2.2',status:1,lastUpdate:new Date(+time+1000)}]}]} as any],+time+1000,{source:'snapshot',receivedAt:+time+1000});
 const updated=row.markets.get('160')!.bets![0];assert.strictEqual(updated,saved);assert.equal(updated.price,'2.2');
});

test('capacity pressure drains the durable inbox before snapshot and between apply batches without a circular wait',{timeout:10000},async()=>{
 const state=new TradeState(),abort=new AbortController();let paused=true,acks=0,staged=0,persisted=0;let deliver:(m:ConsumeMessage)=>void=()=>{};
 const message=(n:number)=>({content:Buffer.from(JSON.stringify({Header:{Type:3,MsgGuid:'pressure-'+n,ServerTimestamp:Date.now()},Body:{Events:[{FixtureId:1,Markets:[{Id:1,Status:1,Bets:[{Id:'1',Price:'2.8',Status:1}]}]}]}})),properties:{headers:{}},fields:{inboxId:n,inboxReceived:Date.now(),redelivered:false}} as unknown as ConsumeMessage);
 const channel=Object.assign(new EventEmitter(),{async prefetch(){},async consume(_q:string,cb:typeof deliver){deliver=cb;cb(message(1));return{consumerTag:'durable-inbox-exclusive'};},stage(){staged++;},ack(){assert.ok(persisted>=acks+1);acks++;paused=false;},nack(){assert.fail('durable rows must not be discarded');}});
 const connection=Object.assign(new EventEmitter(),{async activateTransport(){},intakePaused:()=>paused,async createChannel(){return channel;},async close(){connection.emit('close');}});
 const pkg:PackageConfig={lane:'prematch',packageId:4511,username:'isolated',password:'',hostname:'unused',vhost:'unused',port:5672,tls:false,queue:'unused'};
 const api:ReturnType<typeof clients>={async startDistribution(){},async stopDistribution(){},async distributionStatus(){return{isDistributionOn:true,consumers:[],numberMessagesInQueue:0,messagesPerSecond:0};},async catalog(){return[];},async snapshot(){throw Error('full only');},async snapshotFull(sink){
  assert.equal(acks,1,'startup capacity must be relieved before snapshot');sink.progress?.({stage:'apply',bytes:100,validatedRows:1,appliedRows:0,lastProgressAt:new Date().toISOString()});paused=true;deliver(message(2));
  await sink.apply({fixtureId:1,fixture:{status:1,sport:{name:'Football'}},markets:[{id:1,status:1,bets:[{id:'1',price:'2.1',status:1,isChanged:0}]}]},Date.now()-10000);
  assert.equal(acks,2,'apply must release replay while capacity is paused');return{ids:new Set([1]),rows:1,bytes:100};
 }};
 await session(pkg,{packages:[pkg],snapshotUrl:'https://snapshot.invalid',customersUrl:'https://customers.invalid',recoveryMs:300000,staleMs:90000},state,async()=>{persisted=state.feed().coverage?.prematch.messages??0;if(state.connections.prematch.phase==='connected')abort.abort();},abort.signal,{clientFactory:()=>api,connect:(async()=>{throw Error('not live');}) as any,durableConnect:(async()=>connection) as any},'/isolated/inbox.sqlite');
 assert.equal(acks,2);assert.equal(staged,2);assert.equal(paused,false);
});
