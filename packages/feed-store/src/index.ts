import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventFeed } from "@lsports/contracts";
export function dataMode(): "demo" | "connected" {
  const mode = process.env.DATA_MODE || "demo";
  if (mode !== "demo" && mode !== "connected")
    throw new Error("DATA_MODE must be demo or connected");
  return mode;
}
export const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
export const statePath = () =>
  resolve(root, process.env.LSPORTS_STATE_FILE || ".runtime/trade-feed.json");
export const unavailable = (message: string): EventFeed => ({
  mode: "connected",
  health: "unavailable",
  notice: message,
  events: [],
  horseRacing: {
    status: "unknown",
    message: "Hípica: disponibilidad del paquete sin verificar.",
  },
});
export async function readConnectedFeed(
  path = statePath(),
  now = Date.now(),
): Promise<EventFeed> {
  try {
    const feed = JSON.parse(await readFile(path, "utf8")) as EventFeed;
    const age = now - Date.parse(feed.updatedAt || "");
    if (
      feed.mode !== "connected" ||
      !Array.isArray(feed.events) ||
      !Number.isFinite(age) ||
      age < -5000 ||
      age > 20000
    )
      return unavailable(
        "Worker sin señal reciente. No se muestran cuotas almacenadas.",
      );
    return feed;
  } catch {
    return unavailable(
      "Sin datos del worker. Verificá la configuración y el proceso de integración.",
    );
  }
}
// One local worker writes a single atomic projection; API only reads. Never store credentials here.
export function createPublisher(path = statePath()) {
  let tail = Promise.resolve();
  return (feed: EventFeed) => {
    const body = JSON.stringify(feed);
    const operation = tail.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, body, { mode: 0o600 });
      await rename(temp, path);
    });
    tail = operation.catch(() => {});
    return operation;
  };
}
