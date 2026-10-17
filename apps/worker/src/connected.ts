import type { FeedMessageMetadata } from "@lsports/contracts";
import amqp from "amqplib";
import type { ConsumeMessage } from "amqplib";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
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

export async function runConnected(signal: AbortSignal) {
  const fatal = new AbortController();
  signal = AbortSignal.any([signal, fatal.signal]);
  const config = loadConfig();
  const path = statePath();
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  try {
    const lock = await open(lockPath, "wx", 0o600);
    await lock.writeFile(String(process.pid));
    await lock.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number(await readFile(lockPath, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("Invalid worker lock; inspect before removing .lock");
    try {
      process.kill(pid, 0);
      throw new Error("Another worker owns the state file");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
    await rm(lockPath);
    return runConnected(signal);
  }
  const state = new TradeState();
  try {
    const recovery = await restore(state, path);
    console.info(JSON.stringify({ operation: "file.restore", status: "ok", ...recovery }));
  } catch {
    await rm(lockPath, { force: true });
    throw new Error("No se pudo restaurar el estado TRADE. Archivo original conservado; no se inicia la escritura.");
  }
  const publish = createPublisher(path);
  const save = () =>
    operation("file.persist", "local", () => publish(state.feed(), checkpoint(state)));
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
          await session(pkg, config, state, save, signal);
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
    try {
      await save();
    } finally {
      await rm(lockPath, { force: true });
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
  const fail = (error: unknown) => {
    if (closed) return;
    failure = error;
    closed = true;
    const diagnostic = describeFailure(error, "amqp.connection", "amqp");
    state.set(lane, {
      phase: signal.aborted ? "stopped" : "error",
      message: signal.aborted
        ? "Worker detenido. Cuotas bloqueadas."
        : formatDiagnostic(diagnostic),
      diagnostic: signal.aborted ? undefined : diagnostic,
    });
    void save().catch(() => {});
    // Stop further deliveries immediately; unacknowledged messages return on close.
    void Promise.resolve()
      .then(() => connection.close())
      .catch(() => {});
  };
  connection.on("error", fail);
  connection.on("close", () => fail(new Error("Connection closed")));
  const abort = () => fail(new Error("Stopped"));
  signal.addEventListener("abort", abort, { once: true });
  let processing = Promise.resolve();
  let buffered: ConsumeMessage[] = [];
  let recovering = true;
  let lastReceived = Date.now();
  const seen = new Set<string>();
  const reportedShapes = new Set<string>();
  try {
    const channel = await operation("amqp.channel", "amqp", () =>
      connection.createChannel(),
    );
    channel.on("error", (error) =>
      fail(new OperationError(describeFailure(error, "amqp.channel", "amqp"))),
    );
    channel.on("close", () => fail(new Error("Channel closed")));
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
            state.apply(lane, decoded.events, decoded.at),
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
            fail(new Error("Consumer cancelled"));
            return;
          }
          lastReceived = Date.now();
          if (recovering) buffered.push(msg);
          else processing = processing.then(() => processMessage(msg));
        },
        { noAck: false },
      ),
    );
    const nextDue: Record<string, number> = { "snapshot.events": 0,
      "snapshot.outright.fixtures": api.outrightFixtures ? 0 : Infinity,
      "snapshot.outright.markets": api.outrightMarkets ? 0 : Infinity };
    const retryTime = (d: import("@lsports/contracts").IntegrationDiagnostic) => Math.max(Date.now() + 1000, Date.parse(d.retryAt || "") || Date.now() + (d.retryAfterMs ?? 60000));
    const recover = async () => {
      recovering = true;
      state.set(lane, {
        phase: "recovering",
        message: "Recuperando snapshot; cuotas bloqueadas.",
      });
      await processing;
      await save();
      let rows: import("./state.js").TradeEvent[] | undefined;
      if (Date.now() >= nextDue["snapshot.events"]) {
        const started = Date.now();
        try {
          rows = await api.snapshot();
          if (closed || signal.aborted) throw failure || new Error("Disconnected during recovery");
          state.replace(lane, rows, started, api.snapshotAudit?.());
          state.set(lane, { diagnostic: undefined });
          nextDue["snapshot.events"] = Date.now() + Math.max(300000, config.recoveryMs);
        } catch (error) {
          if (closed || signal.aborted) throw error;
          const diagnostic = describeFailure(error, "snapshot.events", "http");
          if (diagnostic.category !== "rate_limited") throw error;
          state.set(lane, { diagnostic });
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
        ["snapshot.outright.markets", api.outrightMarkets, "marketEvents"],
      ] as const) {
        if (!action || Date.now() < nextDue[name]) continue;
        outrightRecovery.diagnostics = outrightRecovery.diagnostics?.filter(d => d.operation !== name);
        const startedOutright = Date.now();
        try {
          const recovered = await action();
          if (closed || signal.aborted) throw failure || new Error("Disconnected during outright recovery");
          await operation("feed.apply", "local", async () => state.apply(lane, recovered, startedOutright));
          outrightRecovery[counter] = recovered.length;
          outrightRecovery.responseInspections = api.outrightResponseInspections?.();
          nextDue[name] = Date.now() + Math.max(300000, config.recoveryMs);
          console.info(JSON.stringify({ lane, operation: name, status: "ok", events: recovered.length }));
        } catch (error) {
          if (closed || signal.aborted) throw error;
          const diagnostic = describeFailure(error, name, "http");
          nextDue[name] = diagnostic.category === "rate_limited" ? retryTime(diagnostic) : Date.now() + Math.max(300000, config.recoveryMs);
          (outrightRecovery.diagnostics ||= []).push(diagnostic);
          console.warn(JSON.stringify({ lane, status: "error", ...diagnostic }));
        }
      }
      if (outrightRecovery.diagnostics?.length) outrightRecovery.status = outrightRecovery.diagnostics.some(d => d.category === "rate_limited") ? "rate_limited" : "partial";
      state.set(lane, { outrightRecovery });
      if (rows !== undefined) seen.clear();
      // Messages remain unacknowledged while HTTP recovery runs; replay deltas over snapshot.
      while (buffered.length && !closed) {
        const batch = buffered;
        buffered = [];
        for (const msg of batch) await processMessage(msg);
      }
      if (closed) throw failure;
      recovering = false;
      state.set(lane, {
        phase: "connected",
        message: rows !== undefined && rows.length
          ? "Feed conectado; snapshot recuperado." + (["partial", "rate_limited"].includes(outrightRecovery.status) ? " Recuperación Outright incompleta; revisá el diagnóstico." : "")
          : (rows === undefined ? "Feed AMQP conectado; recuperación HTTP pendiente." : "Feed conectado; snapshot regular vacío (0 fixtures).") + (["partial", "rate_limited"].includes(outrightRecovery.status) ? " Recuperación Outright incompleta; revisá el diagnóstico." : " Recuperación Outright consultada por separado."),
      });
      await save();
      console.log(
        JSON.stringify({
          lane,
          status: "snapshot_recovered",
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
      await save();
    } finally {
      await connection.close().catch(() => {});
      await processing;
    }
  }
}
