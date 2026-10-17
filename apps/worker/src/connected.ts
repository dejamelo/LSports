import amqp from "amqplib";
import type { ConsumeMessage } from "amqplib";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createPublisher, statePath } from "@lsports/feed-store";
import { loadConfig } from "./config.js";
import type { PackageConfig } from "./config.js";
import { TradeState, classifySport } from "./state.js";
import { clients, decodeMessage, safeFailure } from "./provider.js";

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
  const publish = createPublisher(path);
  const save = () => publish(state.feed());
  let writing: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
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
            const message = safeFailure(error);
            state.set(pkg.lane, { phase: "error", message });
            console.error(
              JSON.stringify({ lane: pkg.lane, status: "error", message }),
            );
            await save();
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
    message: "Conectando y recuperando snapshot…",
  });
  await save();
  const api = dependencies.clientFactory(pkg, config);
  await api.startDistribution();
  await delay(2000, undefined, { signal });
  if (signal.aborted) return;
  const connection = await dependencies.connect(
    {
      protocol: pkg.tls ? "amqps" : "amqp",
      hostname: pkg.hostname,
      port: pkg.port,
      username: pkg.username,
      password: pkg.password,
      vhost: pkg.vhost,
      heartbeat: 30,
    },
    { timeout: 15000, ...(pkg.tls ? { servername: pkg.hostname } : {}) },
  );
  let failure: unknown;
  let closed = false;
  const fail = (error: unknown) => {
    failure = error;
    closed = true;
    state.set(lane, {
      phase: signal.aborted ? "stopped" : "error",
      message: signal.aborted
        ? "Worker detenido. Cuotas bloqueadas."
        : safeFailure(error),
    });
    void save().catch(() => {});
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
  try {
    const channel = await connection.createChannel();
    channel.on("error", fail);
    channel.on("close", () => fail(new Error("Channel closed")));
    await channel.prefetch(100);
    const processMessage = async (msg: ConsumeMessage) => {
      if (closed) return;
      try {
        const decoded = decodeMessage(
          msg.content,
          msg.properties.headers || {},
        );
        if (decoded.interrupted) throw new Error("Provider feed interrupted");
        if (!seen.has(decoded.guid)) {
          state.apply(lane, decoded.events, decoded.at);
          seen.add(decoded.guid);
          if (seen.size > 10000) seen.delete(seen.values().next().value!);
        }
        state.set(lane, {
          lastMessageAt: new Date(lastReceived).toISOString(),
        });
        await save();
        channel.ack(msg);
      } catch (error) {
        try {
          channel.nack(msg, false, false);
        } catch {}
        fail(error);
      }
    };
    await channel.consume(
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
    );
    const recover = async () => {
      recovering = true;
      state.set(lane, {
        phase: "recovering",
        message: "Recuperando snapshot; cuotas bloqueadas.",
      });
      await processing;
      await save();
      const started = Date.now();
      const rows = await api.snapshot();
      if (closed || signal.aborted)
        throw new Error("Disconnected during recovery");
      state.replace(lane, rows, started);
      seen.clear();
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
        message: "Feed conectado; snapshot recuperado.",
      });
      await save();
      console.log(
        JSON.stringify({
          lane,
          status: "snapshot_recovered",
          events: rows.length,
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
    } catch {
      console.warn(
        JSON.stringify({
          lane,
          status: "metadata_unavailable",
          message: "El catálogo no confirma la habilitación de Hípica.",
        }),
      );
    }
    let nextSnapshot = Date.now() + config.recoveryMs;
    while (!closed && !signal.aborted) {
      await delay(500, undefined, { signal }).catch(() => {});
      if (Date.now() - lastReceived > config.staleMs)
        throw new Error("Feed timeout");
      if (Date.now() >= nextSnapshot) {
        await recover();
        nextSnapshot = Date.now() + config.recoveryMs;
      }
    }
    if (!signal.aborted) throw failure || new Error("Disconnected");
  } finally {
    signal.removeEventListener("abort", abort);
    state.set(lane, {
      phase: signal.aborted ? "stopped" : "error",
      message: signal.aborted
        ? "Worker detenido."
        : "Conexión interrumpida; cuotas bloqueadas.",
    });
    try {
      await save();
    } finally {
      await connection.close().catch(() => {});
      await processing;
    }
  }
}
