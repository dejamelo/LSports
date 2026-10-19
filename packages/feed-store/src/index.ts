import { readFile, mkdir, rename, writeFile, open } from "node:fs/promises";
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
    const { workerCheckpoint: _checkpoint, ...publicFeed } = feed as EventFeed & { workerCheckpoint?: unknown };
    return publicFeed;
  } catch {
    return unavailable(
      "Sin datos del worker. Verificá la configuración y el proceso de integración.",
    );
  }
}
// One local worker writes a single atomic projection; API only reads. Never store credentials here.
export function createPublisher(path = statePath()) {
  let tail = Promise.resolve();
  return (feed: EventFeed, workerCheckpoint?: unknown) => {
    const body = JSON.stringify({ ...feed, ...(workerCheckpoint === undefined ? {} : { workerCheckpoint }) });
    const operation = tail.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      const file=await open(temp,'w',0o600);
      try{await file.writeFile(body);await file.sync();}finally{await file.close();}
      await rename(temp,path);
      const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}
    });
    tail = operation.catch(() => {});
    return operation;
  };
}
