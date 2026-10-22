import {connectDurableMq} from "./durable-ingress.mjs";
import {snapshotCapacity} from './snapshot-capacity.js';
import { connectionCloser } from './connection-closer.js';
import {monitorEventLoopDelay} from "node:perf_hooks";
import {randomUUID} from "node:crypto";
import { platformEnabled, PlatformStore } from "@lsports/feed-store/platform";
import { TenantTickets } from "@lsports/feed-store/tenant-tickets";
import { TicketStore } from "@lsports/feed-store/tickets";
import type { FeedMessageMetadata } from "@lsports/contracts";
import amqp from "amqplib";
import type { ConsumeMessage } from "amqplib";
import { acquireWorkerLock } from "./worker-lock.js";
import { setTimeout as delay } from "node:timers/promises";
import { createPublisher, statePath } from "@lsports/feed-store";
import { loadConfig } from "./config.js";
import type { PackageConfig } from "./config.js";
import { TradeState, classifySport } from "./state.js";
import { clients, decodeMessage } from "./provider.js";
import {
  operation,
  describeFailure,
  formatDiagnostic,
  OperationError,
} from "./diagnostics.js";
import { checkpoint, restore, persistRegularCheckpoint } from "./persistence.js";
import { connectMq } from "./mq.js";

// Retain the first terminal cause, even when close/cleanup and retry replace phase/diagnostic.
function recordSessionEnd(state:TradeState,lane:import("@lsports/contracts").Lane,diagnostic:import("@lsports/contracts").IntegrationDiagnostic){
 const current=state.connections[lane].session;
 if(!current || state.connections[lane].sessionEnds?.some(e=>e.id===current.id))return;
 state.set(lane,{sessionEnds:[...(state.connections[lane].sessionEnds || []),{...current,endedAt:new Date().toISOString(),diagnostic}].slice(-8)});
}
const transportEnd=(reason:"connection_closed"|"channel_closed"|"consumer_cancelled"|"worker_stopped")=>new OperationError({
 operation:reason==="channel_closed"?"amqp.channel":reason==="consumer_cancelled"?"amqp.consume":"amqp.connection",protocol:"amqp",category:"network",reason,
 message:reason==="worker_stopped"?"Worker detenido por señal local.":"Transporte AMQP finalizado; el evento de cierre no informa la causa del broker.",
});

// Join only a not-yet-started save. Joining an active write could ACK changes
// made after its capture; every caller must await a capture after its request.
export function coalescedPersistence(persist:()=>Promise<void>){
 let tail:Promise<void>=Promise.resolve(),queued:Promise<void>|undefined;
 return()=>{if(queued)return queued;let job:Promise<void>;job=tail.then(()=>{if(queued===job)queued=undefined;return persist();});queued=job;tail=job.catch(()=>{});return job;};
}
export async function runConnected(signal: AbortSignal, dependencies: {
  config?: ReturnType<typeof loadConfig>;
  path?: string;
  ticketPath?: string;
  session?: typeof session;
} = {}) {
  const fatal = new AbortController();
  signal = AbortSignal.any([signal, fatal.signal]);
  if (signal.aborted) return;
  const config = dependencies.config ?? loadConfig();
  const path = dependencies.path ?? statePath();
  const releaseLock = await acquireWorkerLock(`${path}.lock`);
  let tickets: TicketStore | undefined;
  let platform: PlatformStore | undefined;
  let tenantTickets: TenantTickets | undefined;
  let completed = false;
  try {
    const state = new TradeState();
    try {
      const recovery = await restore(state, path);
      state.restoration={...recovery,at:new Date().toISOString()};
      console.info(JSON.stringify({ operation: "file.restore", status: "ok", ...recovery }));
    } catch {
      throw new Error("No se pudo restaurar el estado TRADE. Archivo original conservado; no se inicia la escritura.");
    }
    tickets = new TicketStore(dependencies.ticketPath);
    const ticketStore = tickets;
    if (platformEnabled()) {
      platform = new PlatformStore(undefined, true);
      tenantTickets = new TenantTickets(platform);
    }
    const publish = createPublisher(path);
    const loopDelay=monitorEventLoopDelay({resolution:20});loopDelay.enable();
    let writes=0,lastPersistLog=0,loopWindowStart=Date.now();
    const save = coalescedPersistence(()=>state.exclusive(()=>operation("file.persist", "local", async () => {
        const memoryStage=(stage:string)=>{const m=process.memoryUsage();console.info(JSON.stringify({operation:'file.persist',status:'stage',stage,atUTC:new Date().toISOString(),rssBytes:m.rss,heapUsedBytes:m.heapUsed,externalBytes:m.external,arrayBuffersBytes:m.arrayBuffers}));};
        memoryStage('capture');
        const started=performance.now();const feed = state.projection(Date.now(),false),capturedBlocks=state.availabilityBlocks();
        tenantTickets?.reconcile(feed);ticketStore.reconcile(feed); // Durable settlement before projection publication and processed-inbox retirement.
        const {regular,...saved}=checkpoint(state,false);
        const captureDurationMs=Math.ceil(performance.now()-started),regularStarted=performance.now();
        memoryStage('regular_checkpoint');await persistRegularCheckpoint(path,state);
        const regularDurationMs=Math.ceil(performance.now()-regularStarted),publishStarted=performance.now();
        const currentBlocks=state.availabilityBlocks();for(const lane of ['prematch','inplay'] as const)capturedBlocks[lane]=[...new Set([...(capturedBlocks[lane]||[]),...(currentBlocks[lane]||[])])];
        memoryStage('projection');await publish(feed,{...saved,regularExternal:true},capturedBlocks);
        const metric={writes:++writes,lastDurationMs:Math.ceil(performance.now()-started),lastCompletedAt:new Date().toISOString(),captureDurationMs,regularDurationMs,publishDurationMs:Math.ceil(performance.now()-publishStarted),maxEventLoopDelayMs:Math.ceil(loopDelay.max/1e6),metricWindowStartUTC:new Date(loopWindowStart).toISOString(),metricWindowEndUTC:new Date().toISOString(),rssBytes:process.memoryUsage().rss};
        for(const pkg of config.packages)state.set(pkg.lane,{persistenceProgress:metric});
        if(Date.now()-lastPersistLog>=10000){lastPersistLog=Date.now();console.info(JSON.stringify({operation:'file.persist',status:'ok',...metric,regularFixtures:state.rows.prematch.size+state.rows.inplay.size}));loopDelay.reset();loopWindowStart=Date.now();}
    })));
    let writing: Promise<void> | undefined;
    let lastCoverageLog = 0;
    const heartbeat = setInterval(() => {
      if (Date.now() - lastCoverageLog >= 60000) {
        lastCoverageLog = Date.now();
        console.info(
          JSON.stringify({
            operation: "feed.coverage",
            coverage: state.projection(Date.now(),false).coverage,
          }),
        );
      }
      if (!writing)
        writing = save()
          .catch(() =>
            console.error("No se pudo guardar el estado local del worker."),
          )
          .finally(() => {
            writing = undefined;
          });
    }, 5000);
    try {
      await save();
      const tasks = config.packages.map(async (pkg) => {
        let attempt = 0;
        while (!signal.aborted) {
          try {
            await (dependencies.session ?? session)(pkg, config, state, save, signal, undefined, `${path}.${pkg.lane}.inbox.sqlite`);
            attempt = 0;
          } catch (error) {
            if (!signal.aborted) {
              const original = describeFailure(error, "worker.start", "local");
              const pause =
                ["feed.decode", "feed.apply"].includes(original.operation) &&
                original.reason !== "provider_interrupted";
              const diagnostic = {
                ...original,
                ...(pause ? { retryPolicy: "restart_required" as const } : {}),
              };
              const message =
                formatDiagnostic(diagnostic) +
                (pause
                  ? " Mensaje no confirmado como procesado. Corregí la incompatibilidad y reiniciá el worker."
                  : "");
              recordSessionEnd(state,pkg.lane,diagnostic);
              state.set(pkg.lane, { phase: "error", message, diagnostic });
              console.error(
                JSON.stringify({
                  lane: pkg.lane,
                  status: pause ? "blocked_message" : "error",
                  ...diagnostic,
                }),
              );
              await save();
              if (pause) {
                await new Promise<void>((resolve) => {
                  if (signal.aborted) resolve();
                  else
                    signal.addEventListener("abort", () => resolve(), {
                      once: true,
                    });
                });
                break;
              }
            }
          }
          if (!signal.aborted)
            await delay(
              Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)),
              undefined,
              { signal },
            ).catch(() => {});
        }
      });
      try {
        await Promise.all(tasks);
      } catch (error) {
        fatal.abort();
        await Promise.allSettled(tasks);
        throw error;
      }
    } finally {
      clearInterval(heartbeat);loopDelay.disable();
      if (writing) await writing;
      for (const lane of ["prematch", "inplay"] as const)
        state.set(lane, {
          phase: "stopped",
          message: "Worker detenido. Cuotas bloqueadas.",
        });
      await save();
      completed = true;
    }
  } finally {
    try {
      try { tenantTickets?.close(); } finally { platform?.close(); }
    } finally {
      try { tickets?.close(); }
      finally {
        const released = await releaseLock();
        console.info(JSON.stringify({ operation: "worker.shutdown", status: completed ? "ok" : "error", lock: released ? "released" : "ownership_changed_preserved" }));
      }
    }
  }
}
export async function session(
  pkg: PackageConfig,
  config: ReturnType<typeof loadConfig>,
  state: TradeState,
  save: () => Promise<void>,
  signal: AbortSignal,
  dependencies: {connect:typeof amqp.connect;clientFactory:typeof clients;durableConnect?:typeof connectDurableMq} = { connect: amqp.connect, clientFactory: clients },
  ingressPath?: string,
) {
  const lane = pkg.lane;
  let acknowledgedMessages=0,lastReceived=Date.now(),processedSourceFloor:number|undefined;
  const durable=!!ingressPath;
  state.set(lane, {
    consumerProgress:{acknowledgedMessages:0},fullSnapshot:undefined,
    phase: "recovering",
    session:{id:randomUUID(),startedAt:new Date().toISOString()},
    recoveryProgress:{stage:"snapshot",startedAt:new Date().toISOString(),regularSnapshotReady:false},
    diagnostic: undefined,
    message: "Conectando y recuperando snapshot…",
  });
  await save();
  const api = dependencies.clientFactory(pkg, config);
  if(signal.aborted)return;
  // LSports #217525: OFF distribution rejects AMQP authentication (403).
  // provider.startDistribution owns the ONE 2000ms SDK-contract propagation wait
  // and verifies Body.IsDistributionOn before we open any AMQP connection.
  try{await api.startDistribution();}finally{
    const observations=api.distributionObservations?.();
    if(observations){state.set(lane,{distributionObservations:observations});await save();}
  }
  if(signal.aborted){await api.stopDistribution?.();state.set(lane,{phase:"stopped"});await save();return;}
  let connection:Awaited<ReturnType<typeof connectMq>>;
  try{connection=ingressPath ? await (dependencies.durableConnect ?? connectDurableMq)(pkg,ingressPath,metrics=>{
    acknowledgedMessages=metrics.acknowledged;
    lastReceived=Math.max(lastReceived,Date.parse(metrics.lastReceiveAt||"")||0);
    state.set(lane,{ingressProgress:metrics,consumerProgress:{...state.connections[lane].consumerProgress!,acknowledgedMessages,lastAckAt:metrics.lastAckAt||undefined}});
  }) : await connectMq(pkg, dependencies.connect);}catch(error){
    // Distribution must not remain ON without our consumer after failed connect.
    try{await api.stopDistribution?.();}catch(stopError){console.error(JSON.stringify({lane,status:'failed',...describeFailure(stopError,'distribution.stop','http')}));}
    throw error;
  }
  const transportAbort=new AbortController();
  let failure: unknown;
  let closed = false;
  const closeConnection = connectionCloser(connection);
  const fail = (error: unknown) => {
    if (closed) return;
    failure = error;
    closed = true;transportAbort.abort();
    state.set(lane,{consumerProgress:{...state.connections[lane].consumerProgress!,active:false}});
    const diagnostic = describeFailure(error, "amqp.connection", "amqp");
    recordSessionEnd(state,lane,diagnostic);
    state.set(lane, {
      phase: signal.aborted ? "stopped" : "error",
      message: signal.aborted
        ? "Worker detenido. Cuotas bloqueadas."
        : formatDiagnostic(diagnostic),
      diagnostic: signal.aborted ? undefined : diagnostic,
    });
    // This same promise is awaited by finally; close is never started twice.
    // Unacknowledged deliveries remain on the supplier's existing queue.
    void closeConnection();
  };
  connection.on("error", (error:unknown)=>{
    if(error instanceof Error&&error.message==='INBOX_CAPACITY_EXCEEDED'){
      fail(new OperationError({operation:'feed.apply',protocol:'local',category:'response_limit',reason:'inbox_capacity_exceeded',message:'Inbox durable sin capacidad; mensajes conservados, consumidor pausado y cuotas bloqueadas.'}));
      void api.stopDistribution?.().catch(stopError=>console.error(JSON.stringify({lane,...describeFailure(stopError,'distribution.stop','http')})));
    }else fail(error);
  });
  connection.on("close", (cause:unknown) => {
    const diagnostic=cause instanceof Error?describeFailure(cause,"amqp.connection","amqp"):undefined;
    fail(diagnostic?new OperationError({...diagnostic,...(!diagnostic.reason||diagnostic.reason==="unknown_exception"?{reason:"connection_closed" as const}:{})}):transportEnd("connection_closed"));
  });
  let plannedStop:Promise<void>|undefined;
  const abort = () => {if(plannedStop)return;plannedStop=(async()=>{
    if(api.stopDistribution)await api.stopDistribution();
    fail(transportEnd("worker_stopped"));
  })();void plannedStop.catch(error=>console.error(JSON.stringify({lane,status:'failed',...describeFailure(error,'distribution.stop','http')})));};
  signal.addEventListener("abort", abort, { once: true });
  let processing = Promise.resolve();let backgroundCommit:Promise<void>|undefined;let checkpointPending=0;
  let buffered: ConsumeMessage[] = [];
  let bufferingForSnapshot = false;
  let drainTimer:ReturnType<typeof setTimeout>|undefined;
  const seen = new Set<string>();
  const reportedShapes = new Set<string>();
  try {
    // Abort can happen while connectMq is in flight, before listener installation.
    if (signal.aborted) { abort(); return; }
    const channel = await operation("amqp.channel", "amqp", () =>
      connection.createChannel(),
    );
    channel.on("error", (error) =>
      fail(new OperationError(describeFailure(error, "amqp.channel", "amqp"))),
    );
    // amqplib closes channels synchronously BEFORE emitting connection.close(error).
    // Give that event its turn so a generic channel closure cannot hide broker codes.
    channel.on("close", () => queueMicrotask(() => fail(transportEnd("channel_closed"))));
    await operation("amqp.prefetch", "amqp", () => channel.prefetch(100));
    const ackDelivery=(msg:ConsumeMessage)=>{channel.ack(msg);if(durable)return;state.set(lane,{consumerProgress:{...state.connections[lane].consumerProgress!,acknowledgedMessages:++acknowledgedMessages,lastAckAt:new Date().toISOString()}});};
    const pendingAcks:ConsumeMessage[]=[];const pendingMetadata=new Map<ConsumeMessage,FeedMessageMetadata>();
    const processMessage = async (msg: ConsumeMessage,commit=true) => {
      if (closed) return;
      let messageMetadata: FeedMessageMetadata | undefined;
      try {
        const decoded = decodeMessage(
          msg.content,
          msg.properties.headers || {},
          msg.properties,
          msg.fields?.redelivered,
        );
        messageMetadata = decoded.metadata;
        state.recordMessage(
          lane,
          decoded.type,
          decoded.events.length,
          seen.has(decoded.guid),
          decoded.keepAliveActiveEvents,
          Date.now(),Number((msg.fields as unknown as {inboxReceived?:number})?.inboxReceived)||Date.now(),
        );
        if (decoded.interrupted) {
          const diagnostic = {
            operation: "feed.decode" as const,
            protocol: "amqp" as const,
            category: "supplier_error" as const,
            reason: "provider_interrupted" as const,
            message:
              "El heartbeat señala interrupción del proveedor; cuotas bloqueadas y recuperación requerida.",
            messageMetadata: decoded.metadata,
          };
          state.set(lane, {
            phase: "error",
            message: formatDiagnostic(diagnostic),
            diagnostic,
          });
          await save();
          await operation("amqp.ack", "amqp", async () => ackDelivery(msg));
          console.warn(
            JSON.stringify({
              lane,
              status: "control_processed",
              ...diagnostic,
            }),
          );
          fail(new OperationError(diagnostic));
          return;
        }
        if (!seen.has(decoded.guid)) {
          await operation("feed.apply", "local", async () =>
            state.exclusive(()=>state.apply(lane, decoded.events, decoded.at,{source:"amqp",receivedAt:Number((msg.fields as unknown as {inboxReceived?:number}|undefined)?.inboxReceived)||Date.now()})),
          );
        }
        if(decoded.events.length>0&&decoded.metadata.timestampSource!=='received_control')processedSourceFloor=Math.min(processedSourceFloor??Infinity,decoded.at);
        state.set(lane, {
          lastMessageAt: new Date(lastReceived).toISOString(),
        });
        if(commit)await save();
        seen.add(decoded.guid);
        if (seen.size > 10000) seen.delete(seen.values().next().value!);
        if(commit)await operation("amqp.ack", "amqp", async () => ackDelivery(msg));else {const retained=durable?{fields:{inboxId:(msg.fields as unknown as {inboxId:number}).inboxId}} as unknown as ConsumeMessage:msg;pendingAcks.push(retained);pendingMetadata.set(retained,decoded.metadata);}
        const shape = JSON.stringify([
          decoded.type,
          decoded.metadata.compression,
          decoded.metadata.timestampSource,
          decoded.metadata.warnings,
        ]);
        if (!reportedShapes.has(shape)) {
          if (reportedShapes.size >= 128)
            reportedShapes.delete(reportedShapes.values().next().value!);
          reportedShapes.add(shape);
          console.info(
            JSON.stringify({
              lane,
              operation: "feed.decode",
              status: "ok",
              messageMetadata: decoded.metadata,
            }),
          );
        }
      } catch (error) {
        const diagnostic = {
          ...describeFailure(error, "feed.decode", "amqp"),
          ...(messageMetadata ? { messageMetadata } : {}),
        };
        let deliveryDisposition:
          "requeue_requested" | "unacknowledged_until_close" | "retained_in_durable_inbox" =
          "unacknowledged_until_close";
        try {
          if(durable)deliveryDisposition="retained_in_durable_inbox";
          else {channel.nack(msg, false, true);deliveryDisposition = "requeue_requested";}
        } catch {}
        fail(new OperationError({ ...diagnostic, deliveryDisposition }));
      }
    };
    const stageDelivery=(channel as typeof channel & {stage?:(msg:ConsumeMessage)=>void}).stage;
    const commitPending=()=>{
      if(backgroundCommit||closed||!pendingAcks.length)return;
      const prefix=pendingAcks.splice(0);checkpointPending=prefix.length;const metadata=pendingMetadata.get(prefix[0]);
      backgroundCommit=save().then(()=>{if(!closed)for(const msg of prefix)ackDelivery(msg);for(const msg of prefix)pendingMetadata.delete(msg);}).catch(error=>{fail(new OperationError({...describeFailure(error,'feed.apply','local'),...(metadata?{messageMetadata:metadata}:{}),deliveryDisposition:'retained_in_durable_inbox'}));}).finally(()=>{backgroundCommit=undefined;checkpointPending=0;commitPending();});
    };
    let drainScheduled=false;
    const scheduleDrain=()=>{if(drainScheduled||closed)return;drainScheduled=true;
      const enqueue=()=>{if(closed){drainScheduled=false;return;}
      processing=processing.then(async()=>{
        drainScheduled=false;
        while(!closed&&durable&&stageDelivery&&pendingAcks.length+checkpointPending>=8192)await backgroundCommit;
        if(closed)return;
        const messages=buffered.splice(0,durable&&stageDelivery?Math.min(4096,Math.max(1,8192-pendingAcks.length-checkpointPending)):durable?4096:100);
        for(const msg of messages){await processMessage(msg,false);if(closed)break;if(durable&&stageDelivery)stageDelivery.call(channel,msg);}
        if(!closed&&durable&&stageDelivery)commitPending();
        else if(!closed&&pendingAcks.length){await save();if(!closed){for(const msg of pendingAcks)ackDelivery(msg);pendingAcks.length=0;pendingMetadata.clear();}}
        if(buffered.length&&!closed)scheduleDrain();
      }).catch(error=>{const metadata=pendingMetadata.values().next().value;for(const msg of pendingAcks){try{channel.nack(msg,false,true);}catch{}}pendingAcks.length=0;pendingMetadata.clear();fail(new OperationError({...describeFailure(error,'feed.apply','local'),...(metadata?{messageMetadata:metadata}:{}),deliveryDisposition:durable?'retained_in_durable_inbox':'requeue_requested'}));});
      };
      if(durable)drainTimer=setTimeout(enqueue,250);else enqueue();
    };
    await operation("amqp.consume", "amqp", () =>
      channel.consume(
        pkg.queue,
        (msg) => {
          if (!msg) {
            fail(transportEnd("consumer_cancelled"));
            return;
          }
          lastReceived = Date.now();
          if (bufferingForSnapshot) buffered.push(msg);
          else {buffered.push(msg);scheduleDrain();}
        },
        { noAck: false, exclusive: true },
      ),
    );
    state.set(lane,{consumerProgress:{...state.connections[lane].consumerProgress!,registeredAt:new Date().toISOString(),active:true}});
    await save();
    // Exclusive consumer is live before snapshot/inventory and drains continuously.
    if(closed)throw failure;
    if(signal.aborted){abort();return;}
    const nextDue: Record<string, number> = { "snapshot.events": 0,
      "snapshot.outright.fixtures": api.outrightFixtures ? 0 : Infinity,
      "snapshot.outright.markets": api.outrightMarkets ? 0 : Infinity };
    const retryTime = (d: import("@lsports/contracts").IntegrationDiagnostic) => Math.max(Date.now() + 1000, Date.parse(d.retryAt || "") || Date.now() + (d.retryAfterMs ?? 60000));
    // A reconnect must establish its own regular snapshot baseline; a previous
    // session's lastSnapshotAt is not proof that this connection recovered.
    let regularSnapshotReady = false;
    const durableConnection=connection as typeof connection & {recoveryAnchor?:()=>number|undefined;checkpointAnchor?:(seconds:number)=>Promise<boolean>};
    const recoveryAnchor=durableConnection.recoveryAnchor?.();
    let timestampRecoveryPending=recoveryAnchor!==undefined;
    let checkpointAnchorSeconds:number|undefined;
    const requireOpen=()=>{if(closed || signal.aborted)throw failure || transportEnd("worker_stopped");};
    const recover = async () => {
      requireOpen();
      bufferingForSnapshot = false;
      state.set(lane, {
        phase: "recovering",
        recoveryProgress:{stage:"snapshot",startedAt:new Date().toISOString(),regularSnapshotReady},
        message: "Recuperando snapshot; cuotas bloqueadas.",
      });
      await processing;
      requireOpen();
      await save();
      requireOpen();
      let rows: import("./state.js").TradeEvent[] | undefined;let partitionCompleted=false,fullCompleted=false;
      if (Date.now() >= nextDue["snapshot.events"]) {
        const started = Date.now();
        state.set(lane,{lastSnapshotAttemptAt:new Date(started).toISOString()});
        try {
          if(lane==='prematch'&&api.snapshotFull){
            if(timestampRecoveryPending){
              state.set(lane,{message:"Recuperando eventos y liquidaciones desde el checkpoint seguro; cuotas bloqueadas."});
              await api.snapshotFull({timestamp:recoveryAnchor,signal:AbortSignal.any([signal,transportAbort.signal]),assertOpen:requireOpen,apply:async(row,at)=>{
                const applied=processing.then(async()=>{requireOpen();await state.exclusive(()=>state.apply(lane,[{...row,marketRecovery:true}],at,{source:'snapshot',receivedAt:Date.now()}));});processing=applied;await applied;
              }});
              requireOpen();await processing;await save();timestampRecoveryPending=false;
              console.info(JSON.stringify({lane,operation:'snapshot.timestamp_recovery',status:'applied',timestampSeconds:recoveryAnchor,scope:'sdk_GetEvents_timestamp_not_heartbeat',settlementCoverage:'only_results_returned_by_supplier_retention'}));
            }
            const ackedAtStart=acknowledgedMessages;const fullStarted=Date.now();checkpointAnchorSeconds=Math.max(0,Math.floor(fullStarted/1000)-2);let lastProgressLog=0;
            regularSnapshotReady=false;state.set(lane,{fullSnapshot:{method:'disk_spool_two_pass',startedAt:new Date().toISOString()}});await state.exclusive(()=>state.beginPartitionedSnapshot(lane));await save();
            const result=await api.snapshotFull({signal:AbortSignal.any([signal,transportAbort.signal]),assertOpen:requireOpen,progress:progress=>{state.set(lane,{fullSnapshot:{...state.connections[lane].fullSnapshot!,...progress}});if(Date.now()-lastProgressLog>=10000||progress.stage==='complete'){lastProgressLog=Date.now();console.info(JSON.stringify({lane,operation:'snapshot.events',status:'full_spool_progress',...progress}));}},apply:async(row,at)=>{
              const applied=processing.then(async()=>{requireOpen();await state.exclusive(()=>state.apply(lane,[{...row,marketRecovery:true}],at,{source:'snapshot',receivedAt:Date.now()}));});
              processing=applied;await applied;
            }});
            requireOpen();await processing;requireOpen();await state.exclusive(()=>state.finishPartitionedSnapshot(lane,result.ids,api.snapshotAudit?.(),fullStarted));partitionCompleted=true;fullCompleted=true;
            state.set(lane,{partitionRecovery:undefined,fullSnapshot:{...state.connections[lane].fullSnapshot!,completedAt:new Date().toISOString(),rows:result.rows,bytes:result.bytes,ackedDuringRecovery:acknowledgedMessages-ackedAtStart}});
          }else if(lane==='prematch'&&api.snapshotPartitioned){
            regularSnapshotReady=false;state.set(lane,{recoveryProgress:{...state.connections[lane].recoveryProgress!,regularSnapshotReady:false}});
            let inventory=new Set<number>();
            // Inventory itself can wait through a cooldown. Do not retain 100 unacked
            // deliveries until begin(ids): that callback only runs AFTER inventory HTTP.
            await state.exclusive(()=>state.beginPartitionedSnapshot(lane));await save();
            const prefix=buffered;buffered=[];
            const handoff=processing.then(async()=>{for(const msg of prefix){await processMessage(msg,!durable);if(closed)break;}if(durable&&!closed&&pendingAcks.length){await save();if(!closed){for(const msg of pendingAcks)ackDelivery(msg);pendingAcks.length=0;pendingMetadata.clear();}}});
            processing=handoff;bufferingForSnapshot=false;await handoff;requireOpen();
            const result=await api.snapshotPartitioned({assertOpen:requireOpen,
              begin:async ids=>{requireOpen();inventory=new Set(ids);await processing;requireOpen();},
              batch:async(batch,at)=>{
                requireOpen();const capacity=snapshotCapacity({...process.env,LSPORTS_PREMATCH_SNAPSHOT_MAX_RESPONSE_MB:'64'},undefined,lane);
                if(!capacity.allowed)throw new OperationError({operation:'snapshot.events',protocol:'local',category:'response_limit',reason:'memory_budget_exceeded',deferred:true,responseLimitBytes:capacity.limitBytes,memoryBudgetBytes:capacity.budgetBytes,memoryHeadroomBytes:capacity.headroomBytes,message:'Memoria insuficiente para aplicar/persistir el lote; baseline incompleto.'});
                const applied=processing.then(async()=>{requireOpen();await state.exclusive(()=>state.apply(lane,batch.map(event=>({...event,marketRecovery:true})),at,{source:'snapshot',receivedAt:Date.now()}));await save();});
                processing=applied;await applied;
              },
              progress:async progress=>{requireOpen();state.set(lane,{partitionRecovery:progress});await save();},
            });
            requireOpen();await state.exclusive(()=>state.finishPartitionedSnapshot(lane,inventory,api.snapshotAudit?.()));partitionCompleted=true;
            console.info(JSON.stringify({lane,operation:'snapshot.events',status:'partitioned_complete',...result}));
          }else {await state.exclusive(()=>state.beginPartitionedSnapshot(lane));await save();rows=await api.snapshot();}
          if (closed || signal.aborted) throw failure || new Error("Disconnected during recovery");
          if(rows!==undefined){
            const recovered=rows;
            const applied=processing.then(async()=>{requireOpen();await state.exclusive(()=>{state.apply(lane,recovered.map(r=>({...r,marketRecovery:true})),started,{source:'snapshot',receivedAt:Date.now()});state.finishPartitionedSnapshot(lane,new Set(recovered.map(r=>r.fixtureId)),api.snapshotAudit?.(),started);});await save();});
            processing=applied;await applied;
          }
          regularSnapshotReady = true;
          state.set(lane, { diagnostic: undefined, lastSnapshotDiagnostic: undefined });
          nextDue["snapshot.events"] = Date.now() + Math.max(300000, config.recoveryMs);
        } catch (error) {
          if (closed || signal.aborted) throw failure||error;
          state.set(lane,{lastSnapshotErrorAt:new Date().toISOString()});
          const diagnostic = describeFailure(error, "snapshot.events", "http");
          state.set(lane, { diagnostic, lastSnapshotDiagnostic: diagnostic });
          const rejectedPartition=lane==='prematch'&&!!(api.snapshotFull||api.snapshotPartitioned)&&(api.snapshotFull?diagnostic.operation==='snapshot.events':(['invalid_response','sdk_error'].includes(diagnostic.category)||diagnostic.reason==='response_size_limit'));
          if (diagnostic.category !== "rate_limited" && diagnostic.reason !== "memory_budget_exceeded" && !rejectedPartition) throw error;
          // Invalid partition HTTP is not AMQP failure. Keep persist-before-ACK and
          // baseline false, without changing the independent InPlay recovery policy.
          const localDeferral=diagnostic.deferred===true&&['local_in_flight','local_host_cooldown','local_operation_cooldown'].includes(diagnostic.rateLimitSource||'');
          nextDue["snapshot.events"] = localDeferral?retryTime(diagnostic):rejectedPartition?Math.max(retryTime(diagnostic),Date.now()+Math.max(300000,config.recoveryMs)):retryTime(diagnostic);
          console.warn(JSON.stringify({ lane, status: "deferred", ...diagnostic }));
        }
      }
      const outrightRecovery: NonNullable<import("@lsports/contracts").ConnectionState["outrightRecovery"]> = {
        ...state.connections[lane].outrightRecovery,
        status: api.outrightFixtures || api.outrightMarkets ? "ok" : "unsupported", checkedAt: new Date().toISOString(),
      };
      for (const [name, action, counter] of [
        ["snapshot.outright.fixtures", api.outrightFixtures, "fixtures"],
        ["snapshot.outright.markets", api.outrightMarkets ? () => api.outrightMarkets!(state.outrightFixtureIds(lane)) : undefined, "marketEvents"],
      ] as const) {
        requireOpen();
        if (!action || Date.now() < nextDue[name]) continue;
        outrightRecovery.diagnostics = outrightRecovery.diagnostics?.filter(d => d.operation !== name);
        const startedOutright = Date.now();
        const attempt=((outrightRecovery.operations ||= {})[counter] ||= {});
        attempt.lastAttemptAt=new Date(startedOutright).toISOString();
        try {
          const recovered = await action();
          if (closed || signal.aborted) throw failure || new Error("Disconnected during outright recovery");
          await operation("feed.apply", "local", async () => state.exclusive(()=>state.apply(lane, recovered, startedOutright,{source:"snapshot",receivedAt:Date.now()})));
          outrightRecovery[counter] = recovered.length;
          attempt.lastSuccessAt=new Date().toISOString();
          if(name === "snapshot.outright.markets") outrightRecovery.timestampRejections = api.outrightTimestampRejections?.() || [];
          outrightRecovery.responseInspections = api.outrightResponseInspections?.();
          nextDue[name] = Date.now() + Math.max(300000, config.recoveryMs);
          console.info(JSON.stringify({ lane, operation: name, status: name === "snapshot.outright.markets" && outrightRecovery.timestampRejections?.length ? "partial" : "ok", events: recovered.length, ...(name === "snapshot.outright.markets" ? {timestampRejected:outrightRecovery.timestampRejections?.length || 0} : {}) }));
        } catch (error) {
          if (closed || signal.aborted) throw failure||error;
          attempt.lastErrorAt=new Date().toISOString();
          const diagnostic = describeFailure(error, name, "http");
          nextDue[name] = diagnostic.category === "rate_limited" ? retryTime(diagnostic) : Date.now() + Math.max(300000, config.recoveryMs);
          (outrightRecovery.diagnostics ||= []).push(diagnostic);
          console.warn(JSON.stringify({ lane, status: "error", ...diagnostic }));
        }
      }
      if(outrightRecovery.timestampRejections?.length) outrightRecovery.status = "partial";
      if (outrightRecovery.diagnostics?.length) outrightRecovery.status = outrightRecovery.diagnostics.some(d => d.category === "rate_limited") ? "rate_limited" : "partial";
      outrightRecovery.marketRequest = api.outrightMarketRequest?.();
      state.set(lane, { outrightRecovery });
      if (rows !== undefined||partitionCompleted) seen.clear();
      // Capture a FINITE prefix and hand the same serial chain to live delivery.
      // Do not wait for a continuously replenished buffer to become empty.
      // No await between installing the prefix and switching delivery mode:
      // newer messages append after it, preserving ordering and persist-before-ACK.
      const batch = buffered;
      buffered = [];
      state.set(lane,{recoveryProgress:{...state.connections[lane].recoveryProgress!,stage:"handoff",queuedAtHandoff:batch.length,processedAtHandoff:0,lastProgressAt:new Date().toISOString()}});
      const barrier = processing.then(async () => {
        for (const msg of batch) {
          await processMessage(msg,!durable);
          if (closed) break;
          const progress=state.connections[lane].recoveryProgress!;
          state.set(lane,{recoveryProgress:{...progress,processedAtHandoff:(progress.processedAtHandoff || 0)+1,lastProgressAt:new Date().toISOString()}});
        }
        if(durable&&!closed&&pendingAcks.length){await save();if(!closed){for(const msg of pendingAcks)ackDelivery(msg);pendingAcks.length=0;pendingMetadata.clear();}}
      });
      processing = barrier;
      bufferingForSnapshot = false;
      await barrier;
      if (closed) throw failure;
      state.set(lane, {
        phase: regularSnapshotReady ? "connected" : "recovering",
        recoveryProgress:{...state.connections[lane].recoveryProgress!,stage:regularSnapshotReady?"idle":"waiting_retry",regularSnapshotReady,completedAt:new Date().toISOString(),nextRegularAttemptAt:new Date(nextDue["snapshot.events"]).toISOString()},
        message: partitionCompleted ? "Feed conectado; snapshot completo validado con memoria limitada." : !regularSnapshotReady ? "AMQP activo; snapshot inicial pendiente. Cuotas bloqueadas hasta completar la recuperación." : rows !== undefined && rows.length
          ? "Feed conectado; snapshot recuperado." + (["partial", "rate_limited"].includes(outrightRecovery.status) ? " Recuperación Outright incompleta; revisá el diagnóstico." : "")
          : (rows === undefined ? "Feed AMQP conectado; recuperación HTTP pendiente." : "Feed conectado; snapshot regular vacío (0 fixtures).") + (["partial", "rate_limited"].includes(outrightRecovery.status) ? " Recuperación Outright incompleta; revisá el diagnóstico." : " Recuperación Outright consultada por separado."),
      });
      await save();
      if(!closed&&!signal.aborted&&regularSnapshotReady&&!timestampRecoveryPending&&checkpointAnchorSeconds!==undefined&&processedSourceFloor!==undefined)await durableConnection.checkpointAnchor?.(Math.min(checkpointAnchorSeconds,Math.max(0,Math.floor(processedSourceFloor/1000)-2)));
      console.log(
        JSON.stringify({
          lane,
          status: fullCompleted?"full_snapshot_recovered":partitionCompleted?"partitioned_snapshot_recovered":rows === undefined ? "snapshot_deferred" : "snapshot_recovered",
          ...(partitionCompleted?{events:state.connections[lane].snapshotEvents,partitioned:!fullCompleted,fullSnapshot:fullCompleted}:rows !== undefined ? { events: rows.length } : { snapshotDeferred: true }),
          snapshotAudit: api.snapshotAudit?.(),
          coverage: state.projection(Date.now(),false).coverage?.[lane],
        }),
      );
    };
    await recover();
    try {
      const sports = await api.catalog();
      state.set(lane, {
        catalogHorseRacing: sports.some(
          (s) => classifySport(s.name) === "hipica",
        ),
      });
      await save();
    } catch (error) {
      const diagnostic = describeFailure(error, "metadata.sports", "http");
      console.warn(
        JSON.stringify({
          lane,
          status: "metadata_unavailable",
          ...diagnostic,
        }),
      );
    }
    let nextStatus=Date.now()+30000;
    let nextSnapshot = Math.min(...Object.values(nextDue));
    while (!closed && !signal.aborted) {
      await delay(500, undefined, { signal }).catch(() => {});
      if (Date.now() - lastReceived > config.staleMs)
        throw new OperationError(
          describeFailure(
            Object.assign(new Error("Feed timeout"), { code: "ETIMEDOUT" }),
            "feed.stale",
            "amqp",
          ),
        );
      if(durable&&Date.now()>=nextStatus){
        nextStatus=Date.now()+30000;
        try{const status=await api.distributionStatus();state.set(lane,{distributionObservations:api.distributionObservations?.()||state.connections[lane].distributionObservations});if(status.numberMessagesInQueue>500)console.warn(JSON.stringify({lane,operation:'distribution.status',status:'backlog_alert',queueDepth:status.numberMessagesInQueue,alertThreshold:500}));}catch(error){console.warn(JSON.stringify({lane,...describeFailure(error,'distribution.status','http')}));}
      }
      if (Date.now() >= nextSnapshot) {
        await recover();
        nextSnapshot = Math.min(...Object.values(nextDue));
      }
    }
    if (!signal.aborted) throw failure || new Error("Disconnected");
  } catch (error) {
    if (!signal.aborted) fail(error);
    throw error;
  } finally {
    clearTimeout(drainTimer);
    signal.removeEventListener("abort", abort);
    state.set(lane, {
      consumerProgress:{...state.connections[lane].consumerProgress!,active:false},
      phase: signal.aborted ? "stopped" : "error",
      message: signal.aborted
        ? "Worker detenido."
        : state.connections[lane].message,
    });
    try {
      // Drain writes for deliveries already being processed before final persist.
      if(signal.aborted){abort();await plannedStop;}
      await processing;
      await backgroundCommit;
      await save();
    } finally {
      await closeConnection();
    }
  }
}
