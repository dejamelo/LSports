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
import { checkpoint, restore } from "./persistence.js";
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
    const save = () =>
      operation("file.persist", "local", async () => {
        const feed = state.feed();
        tenantTickets?.reconcile(feed);
      ticketStore.reconcile(feed); // Durable settlement before projection write and AMQP ACK.
        await publish(feed, checkpoint(state));
      });
    let writing: Promise<void> | undefined;
    let lastCoverageLog = 0;
    const heartbeat = setInterval(() => {
      if (Date.now() - lastCoverageLog >= 60000) {
        lastCoverageLog = Date.now();
        console.info(
          JSON.stringify({
            operation: "feed.coverage",
            coverage: state.feed().coverage,
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
            await (dependencies.session ?? session)(pkg, config, state, save, signal);
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
      clearInterval(heartbeat);
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
  dependencies = { connect: amqp.connect, clientFactory: clients },
) {
  const lane = pkg.lane;
  state.set(lane, {
    phase: "recovering",
    session:{id:randomUUID(),startedAt:new Date().toISOString()},
    recoveryProgress:{stage:"snapshot",startedAt:new Date().toISOString(),regularSnapshotReady:false},
    diagnostic: undefined,
    message: "Conectando y recuperando snapshot…",
  });
  await save();
  const api = dependencies.clientFactory(pkg, config);
  await api.startDistribution();
  await delay(2000, undefined, { signal });
  if (signal.aborted) return;
  const connection = await connectMq(pkg, dependencies.connect);
  let failure: unknown;
  let closed = false;
  let closing: Promise<void> | undefined;
  const closeConnection = () => closing ??= Promise.resolve().then(() => connection.close()).catch(() => {});
  const fail = (error: unknown) => {
    if (closed) return;
    failure = error;
    closed = true;
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
  connection.on("error", fail);
  connection.on("close", (cause:unknown) => {
    const diagnostic=cause instanceof Error?describeFailure(cause,"amqp.connection","amqp"):undefined;
    fail(diagnostic?new OperationError({...diagnostic,...(!diagnostic.reason||diagnostic.reason==="unknown_exception"?{reason:"connection_closed" as const}:{})}):transportEnd("connection_closed"));
  });
  const abort = () => fail(transportEnd("worker_stopped"));
  signal.addEventListener("abort", abort, { once: true });
  let processing = Promise.resolve();
  let buffered: ConsumeMessage[] = [];
  let bufferingForSnapshot = true;
  let lastReceived = Date.now();
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
    const processMessage = async (msg: ConsumeMessage) => {
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
          await operation("amqp.ack", "amqp", async () => channel.ack(msg));
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
            state.apply(lane, decoded.events, decoded.at,{source:"amqp",receivedAt:Date.now()}),
          );
        }
        state.set(lane, {
          lastMessageAt: new Date(lastReceived).toISOString(),
        });
        await save();
        seen.add(decoded.guid);
        if (seen.size > 10000) seen.delete(seen.values().next().value!);
        await operation("amqp.ack", "amqp", async () => channel.ack(msg));
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
          "requeue_requested" | "unacknowledged_until_close" =
          "unacknowledged_until_close";
        try {
          channel.nack(msg, false, true);
          deliveryDisposition = "requeue_requested";
        } catch {}
        fail(new OperationError({ ...diagnostic, deliveryDisposition }));
      }
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
          else processing = processing.then(() => processMessage(msg));
        },
        { noAck: false, exclusive: true },
      ),
    );
    const nextDue: Record<string, number> = { "snapshot.events": 0,
      "snapshot.outright.fixtures": api.outrightFixtures ? 0 : Infinity,
      "snapshot.outright.markets": api.outrightMarkets ? 0 : Infinity };
    const retryTime = (d: import("@lsports/contracts").IntegrationDiagnostic) => Math.max(Date.now() + 1000, Date.parse(d.retryAt || "") || Date.now() + (d.retryAfterMs ?? 60000));
    // A reconnect must establish its own regular snapshot baseline; a previous
    // session's lastSnapshotAt is not proof that this connection recovered.
    let regularSnapshotReady = false;
    const requireOpen=()=>{if(closed || signal.aborted)throw failure || transportEnd("worker_stopped");};
    const recover = async () => {
      requireOpen();
      bufferingForSnapshot = true;
      state.set(lane, {
        phase: "recovering",
        recoveryProgress:{stage:"snapshot",startedAt:new Date().toISOString(),regularSnapshotReady},
        message: "Recuperando snapshot; cuotas bloqueadas.",
      });
      await processing;
      requireOpen();
      await save();
      requireOpen();
      let rows: import("./state.js").TradeEvent[] | undefined;
      if (Date.now() >= nextDue["snapshot.events"]) {
        const started = Date.now();
        state.set(lane,{lastSnapshotAttemptAt:new Date(started).toISOString()});
        try {
          rows = await api.snapshot();
          if (closed || signal.aborted) throw failure || new Error("Disconnected during recovery");
          state.replace(lane, rows, started, api.snapshotAudit?.());
          regularSnapshotReady = true;
          state.set(lane, { diagnostic: undefined, lastSnapshotDiagnostic: undefined });
          nextDue["snapshot.events"] = Date.now() + Math.max(300000, config.recoveryMs);
        } catch (error) {
          if (closed || signal.aborted) throw error;
          state.set(lane,{lastSnapshotErrorAt:new Date().toISOString()});
          const diagnostic = describeFailure(error, "snapshot.events", "http");
          state.set(lane, { diagnostic, lastSnapshotDiagnostic: diagnostic });
          if (diagnostic.category !== "rate_limited" && diagnostic.reason !== "memory_budget_exceeded") throw error;
          nextDue["snapshot.events"] = retryTime(diagnostic);
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
          await operation("feed.apply", "local", async () => state.apply(lane, recovered, startedOutright,{source:"snapshot",receivedAt:Date.now()}));
          outrightRecovery[counter] = recovered.length;
          attempt.lastSuccessAt=new Date().toISOString();
          if(name === "snapshot.outright.markets") outrightRecovery.timestampRejections = api.outrightTimestampRejections?.() || [];
          outrightRecovery.responseInspections = api.outrightResponseInspections?.();
          nextDue[name] = Date.now() + Math.max(300000, config.recoveryMs);
          console.info(JSON.stringify({ lane, operation: name, status: name === "snapshot.outright.markets" && outrightRecovery.timestampRejections?.length ? "partial" : "ok", events: recovered.length, ...(name === "snapshot.outright.markets" ? {timestampRejected:outrightRecovery.timestampRejections?.length || 0} : {}) }));
        } catch (error) {
          if (closed || signal.aborted) throw error;
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
      if (rows !== undefined) seen.clear();
      // Capture a FINITE prefix and hand the same serial chain to live delivery.
      // Do not wait for a continuously replenished buffer to become empty.
      // No await between installing the prefix and switching delivery mode:
      // newer messages append after it, preserving ordering and persist-before-ACK.
      const batch = buffered;
      buffered = [];
      state.set(lane,{recoveryProgress:{...state.connections[lane].recoveryProgress!,stage:"handoff",queuedAtHandoff:batch.length,processedAtHandoff:0,lastProgressAt:new Date().toISOString()}});
      const barrier = processing.then(async () => {
        for (const msg of batch) {
          await processMessage(msg);
          if (closed) break;
          const progress=state.connections[lane].recoveryProgress!;
          state.set(lane,{recoveryProgress:{...progress,processedAtHandoff:(progress.processedAtHandoff || 0)+1,lastProgressAt:new Date().toISOString()}});
        }
      });
      processing = barrier;
      bufferingForSnapshot = false;
      await barrier;
      if (closed) throw failure;
      state.set(lane, {
        phase: regularSnapshotReady ? "connected" : "recovering",
        recoveryProgress:{...state.connections[lane].recoveryProgress!,stage:regularSnapshotReady?"idle":"waiting_retry",regularSnapshotReady,completedAt:new Date().toISOString(),nextRegularAttemptAt:new Date(nextDue["snapshot.events"]).toISOString()},
        message: !regularSnapshotReady ? "AMQP activo; snapshot inicial pendiente. Cuotas bloqueadas hasta completar la recuperación." : rows !== undefined && rows.length
          ? "Feed conectado; snapshot recuperado." + (["partial", "rate_limited"].includes(outrightRecovery.status) ? " Recuperación Outright incompleta; revisá el diagnóstico." : "")
          : (rows === undefined ? "Feed AMQP conectado; recuperación HTTP pendiente." : "Feed conectado; snapshot regular vacío (0 fixtures).") + (["partial", "rate_limited"].includes(outrightRecovery.status) ? " Recuperación Outright incompleta; revisá el diagnóstico." : " Recuperación Outright consultada por separado."),
      });
      await save();
      console.log(
        JSON.stringify({
          lane,
          status: rows === undefined ? "snapshot_deferred" : "snapshot_recovered",
          ...(rows !== undefined ? { events: rows.length } : { snapshotDeferred: true }),
          snapshotAudit: api.snapshotAudit?.(),
          coverage: state.feed().coverage?.[lane],
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
    signal.removeEventListener("abort", abort);
    state.set(lane, {
      phase: signal.aborted ? "stopped" : "error",
      message: signal.aborted
        ? "Worker detenido."
        : state.connections[lane].message,
    });
    try {
      // Drain writes for deliveries already being processed before final persist.
      await processing;
      await save();
    } finally {
      await closeConnection();
    }
  }
}
