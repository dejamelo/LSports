import { dataMode } from "@lsports/feed-store";
import { demoSource } from "@lsports/demo";
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => abort.abort());
async function main() {
  if (dataMode() === "connected") {
    const { runConnected } = await import("./connected.js");
    await runConnected(abort.signal);
    return;
  }
  const { setTimeout: delay } = await import("node:timers/promises");
  const interval = Number(process.env.WORKER_POLL_INTERVAL_MS || 30000);
  if (!Number.isFinite(interval) || interval < 1000)
    throw new Error("WORKER_POLL_INTERVAL_MS must be >= 1000");
  while (!abort.signal.aborted) {
    const feed = await demoSource.getEvents();
    console.log(
      JSON.stringify({
        worker: "heartbeat",
        mode: "demo",
        eventCount: feed.events.length,
      }),
    );
    await delay(interval, undefined, { signal: abort.signal }).catch(() => {});
  }
}
main().catch(() => {
  console.error(
    "Worker no iniciado. Verificá DATA_MODE, variables LSPORTS_* requeridas y el bloqueo del archivo de estado. No se muestran credenciales.",
  );
  process.exitCode = 1;
});
