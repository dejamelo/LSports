import {createHash} from "node:crypto";
import {getHeapStatistics} from "node:v8";
import { mkdir, rename, writeFile, open } from "node:fs/promises";
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
// This source returns a complete EventFeed. Never truncate it: reconciliation and
// settlement callers must not mistake a partial view for the complete projection.
// 48x covers input chunks, UTF-16 text, parsed graph and a response encoding;
// reserve 128 MiB for routes/auth/SQLite. Large projections need an indexed source,
// not an unbounded JSON.parse or a blind heap increase.
export const API_FEED_READ_LIMIT_BYTES = 8 * 1024 * 1024;
export function apiFeedReadBudget(heapLimit=getHeapStatistics().heap_size_limit, used=process.memoryUsage().heapUsed) {
  return Math.max(0, Math.min(API_FEED_READ_LIMIT_BYTES, Math.floor((heapLimit-used-128*1024*1024)/48)));
}
const feedReads=new Map<string,Promise<EventFeed>>();
const rejectedVersions=new Map<string,string>();
async function readCompleteFeed(path:string):Promise<EventFeed> {
  const file=await open(path, 'r');
  try {
    const before=await file.stat(),budget=apiFeedReadBudget();
    const reject=()=>{
      const version=`${before.ino}:${before.size}:${Math.floor(before.mtimeMs/60000)}`;
      if(rejectedVersions.get(path)!==version){
        // Bounded diagnostics: no file paths, payloads or credentials.
        if(rejectedVersions.size>=32)rejectedVersions.clear();
        rejectedVersions.set(path,version);
        console.warn(JSON.stringify({operation:'api.feed.read',status:'blocked',reason:'complete_projection_exceeds_read_budget',fileBytes:before.size,readBudgetBytes:budget,heapLimitBytes:getHeapStatistics().heap_size_limit,heapUsedBytes:process.memoryUsage().heapUsed,partialFeedReturned:false}));
      }
      return unavailable('Proyección completa supera la capacidad segura de lectura de la API. Cuotas bloqueadas; recuperación no verificada.');
    };
    if(!before.isFile() || before.size>budget)return reject();
    // Read the inspected inode, not a second pathname lookup; also cap growth.
    const chunks:Buffer[]=[];let bytes=0;
    for(;;){
      const buffer=Buffer.allocUnsafe(Math.min(64*1024,budget-bytes+1));
      const {bytesRead}=await file.read(buffer,0,buffer.length,null);
      if(!bytesRead)break;
      bytes+=bytesRead;if(bytes>budget)return reject();
      chunks.push(buffer.subarray(0,bytesRead));
    }
    const after=await file.stat();
    if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('FEED_CHANGED_DURING_READ');
    const feed=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8')) as EventFeed & {workerCheckpoint?:unknown};
    // Checkpoints remain private, including legacy files. They are subject to the
    // same allocation bound; removing them after an unbounded parse is unsafe.
    delete feed.workerCheckpoint;
    return feed;
  } finally {await file.close();}
}
export async function readConnectedFeed(path=statePath(), now=Date.now()):Promise<EventFeed> {
  try {
    let reading=feedReads.get(path);
    if(!reading){
      reading=readCompleteFeed(path);feedReads.set(path,reading);
      // No retained full-graph cache; only concurrent reads share an allocation.
      void reading.finally(()=>{if(feedReads.get(path)===reading)feedReads.delete(path);}).catch(()=>{});
    }
    const feed=await reading;
    if(feed.health==='unavailable'&&!feed.updatedAt)return feed;
    const age=now-Date.parse(feed.updatedAt||'');
    if(feed.mode!=='connected'||!Array.isArray(feed.events)||!Number.isFinite(age)||age < -5000||age>20000)
      return unavailable('Worker sin señal reciente. No se muestran cuotas almacenadas.');
    return feed;
  } catch {return unavailable('Sin datos del worker. Verificá la configuración y el proceso de integración.');}
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
// Explicit lazy arrays retain the public JSON schema without retaining all rows.
export const jsonItems = (items: () => Iterable<unknown>) => ({ [Symbol.iterator]: items });
export async function writeJsonObject(file: Awaited<ReturnType<typeof open>>, value: Record<string, unknown>,masks?:AvailabilityBlocks) {
  let pending:string[]=[],bytes=0,total=0;const hash=createHash('sha256'),eventHash=createHash('sha256');
  const flush=async()=>{if(!bytes)return;const text=pending.join('');hash.update(text);total+=Buffer.byteLength(text);await file.writeFile(text);pending=[];bytes=0;};
  function* write(entry:any,key='',depth=0):Generator<string>{
    if(depth>128)throw Error('projection_depth_limit');
    if(entry===null||typeof entry!=='object'){yield (JSON.stringify(entry)??'null');return;}
    if(typeof entry.toJSON==='function'){yield* write(entry.toJSON(key),key,depth+1);return;}
    // Native encode only tiny leaves/tuples, never an index array or record.
    // This keeps streaming CPU cost bounded as well as its allocation peak.
    const scalar=(v:any)=>v===null||typeof v==='number'||typeof v==='boolean'||typeof v==='string'&&v.length<=256||v===undefined;
    if(!(key==='events'&&depth===1)){
      if(Array.isArray(entry)&&entry.length<=4&&entry.every(scalar)){yield JSON.stringify(entry);return;}
      if(!Array.isArray(entry)&&typeof entry[Symbol.iterator]!=='function'){
        const keys=Object.keys(entry);if(keys.length<=24){let size=0,small=true;for(const k of keys){const v=entry[k];size+=k.length+(typeof v==='string'?v.length:32);if(size>4096||!(scalar(v)||v instanceof Date)){small=false;break;}}if(small){yield JSON.stringify(entry);return;}}
      }
    }
    if(Array.isArray(entry)||(Object.getPrototypeOf(entry)===Object.prototype&&typeof entry[Symbol.iterator]==='function')){
      yield ('[');let first=true;
      for(const item of entry){if(!first)yield (',');first=false;
        const projected=(key==='events'&&depth===1)&&item&&masks?maskEventAvailability(item,masks[item.source as keyof AvailabilityBlocks]):item;
        // Canonical source-event digest, independent of the incremental encoder.
        // One bounded fixture string, never the complete projection.
        if((key==='events'&&depth===1)){const text=JSON.stringify(projected);if(Buffer.byteLength(text)>16*1024*1024)throw Error('projection_record_limit');eventHash.update(text+'\n');yield (text);}
        else yield* write(projected,'',depth+1);}
      yield (']');return;
    }
    yield ('{');let first=true;
    for(const name of Object.keys(entry)){const item=entry[name];if(item===undefined)continue;
      if(!first)yield (',');first=false;yield (JSON.stringify(name)+':');yield* write(item,name,depth+1);}
    yield ('}');
  };
  for(const token of write(value)){pending.push(token);bytes+=Buffer.byteLength(token);if(bytes>=64*1024)await flush();}await flush();return {sha256:hash.digest('hex'),bytes:total,eventSha256:eventHash.digest('hex')};
}
// Private checkpoint contract bounds one fixture to 32 MiB, not the document.
// Stream map entries and fields into bounded chunks; never stringify a full checkpoint record.
export async function writeJsonRecord(file:Awaited<ReturnType<typeof open>>,record:Record<string,unknown>){
 let bytes=0;
 const bounded={writeFile:async(text:string)=>{bytes+=Buffer.byteLength(text);if(bytes>32*1024*1024)throw Error('checkpoint_record_limit');await file.writeFile(text);}};
 await writeJsonObject(bounded as Awaited<ReturnType<typeof open>>,record);
}
// One local worker writes a single atomic projection; API only reads. Never store credentials here.
export function createPublisher(path = statePath()) {
  let tail = Promise.resolve();
  return (feed: EventFeed, workerCheckpoint?: unknown,availabilityBlocks?:AvailabilityBlocks,observe?:(phase:string)=>void) => {
    const masks=availabilityBlocks?structuredClone(availabilityBlocks):undefined;
    const body = { ...feed, ...(workerCheckpoint === undefined ? {} : { workerCheckpoint }) };
    const operation = tail.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      observe?.('projection.open');const file=await open(temp,'w',0o600);
      const writer={writeFile:async(text:string)=>{observe?.('projection.write');await file.writeFile(text);observe?.('projection.encode');}} as typeof file;
      try{await writeJsonObject(writer,body,masks);observe?.('projection.fsync');await file.sync();}finally{await file.close();}
      observe?.('projection.rename');await rename(temp,path);
      const directory=await open(dirname(path),'r');try{observe?.('projection.directory_fsync');await directory.sync();}finally{await directory.close();}
    });
    tail = operation.catch(() => {});
    return operation;
  };
}
