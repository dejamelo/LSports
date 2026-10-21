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
export type AvailabilityBlocks=Partial<Record<'prematch'|'inplay',('feed_disconnected'|'processing_backlog')[]>>;
export function maskEventAvailability(event:EventFeed['events'][number],reasons:NonNullable<AvailabilityBlocks['prematch']>=[]) {
 if(!reasons.length)return event;
 const selection=(s:typeof event.selections[number])=>({...s,available:false,unavailableReasons:[...reasons,...(s.unavailableReasons||[]).filter(r=>!reasons.includes(r as typeof reasons[number]))]});
 const markets=event.markets?.map(m=>({...m,selections:m.selections.map(selection)}));
 const primary=event.markets?.findIndex(m=>m.selections===event.selections)??-1;
 return {...event,available:false,markets,selections:primary>=0?markets![primary].selections:event.selections.map(selection)};
}
// Bounded serialization: no whole-document string/Buffer alongside the projection.
// Atomic fsync+rename and caller serialization remain unchanged.
export async function writeJsonObject(file: Awaited<ReturnType<typeof open>>, value: Record<string, unknown>,masks?:AvailabilityBlocks) {
  let pending:string[]=[],bytes=0;
  const flush=async()=>{if(!bytes)return;await file.writeFile(pending.join(''));pending=[];bytes=0;};
  const put=async(text:string)=>{pending.push(text);bytes+=Buffer.byteLength(text);if(bytes>=256*1024)await flush();};
  await put('{');let first=true;
  for(const [key,entry] of Object.entries(value)){
    if(entry===undefined)continue;
    await put((first?'':',')+JSON.stringify(key)+':');first=false;
    if(Array.isArray(entry)){
      await put('[');for(let i=0;i<entry.length;i++)await put((i?',':'')+JSON.stringify(key==='events'&&entry[i]&&masks?maskEventAvailability(entry[i],masks[entry[i].source as keyof AvailabilityBlocks]):entry[i]??null));await put(']');
    }else await put(JSON.stringify(entry));
  }
  await put('}');await flush();
}
// One local worker writes a single atomic projection; API only reads. Never store credentials here.
export function createPublisher(path = statePath()) {
  let tail = Promise.resolve();
  return (feed: EventFeed, workerCheckpoint?: unknown,availabilityBlocks?:AvailabilityBlocks) => {
    const masks=availabilityBlocks?structuredClone(availabilityBlocks):undefined;
    const body = { ...feed, ...(workerCheckpoint === undefined ? {} : { workerCheckpoint }) };
    const operation = tail.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      const file=await open(temp,'w',0o600);
      try{await writeJsonObject(file,body,masks);await file.sync();}finally{await file.close();}
      await rename(temp,path);
      const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}
    });
    tail = operation.catch(() => {});
    return operation;
  };
}
