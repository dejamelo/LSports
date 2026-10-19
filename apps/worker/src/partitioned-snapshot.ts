import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {OperationError} from './diagnostics.js';
import type {TradeEvent} from './state.js';
export interface PartitionProgress {recoveryId:string;stage:'inventory'|'batches'|'verify'|'complete'|'waiting';inventory:number;completedFixtures:number;batches:number;maxResponseBytes:number;retryAt?:string;inventoryDigest?:string;lastBatch?:{requested:number;received:number;missing:number;unexpected:number;exampleMissingFixtures:number[]}}
export interface PartitionSink {assertOpen():void;begin(ids:number[]):Promise<void>;batch(rows:TradeEvent[],at:number):Promise<void>;progress(value:PartitionProgress):Promise<void>}
const invalid=(text:string):never=>{throw new OperationError({operation:'snapshot.events',protocol:'http',category:'invalid_response',reason:'invalid_snapshot',message:text});};
export function completeInventory(value:unknown):number[]{
 if(!Array.isArray(value)||value.length>50000||value.some(id=>!Number.isSafeInteger(id)||id<=0))return invalid('Inventario de suscripciones inválido o superior al límite local; no se usa la proyección como inventario.');
 return [...new Set(value)].sort((a,b)=>a-b);
}
/** Holds only one decoded batch, never a concatenated full snapshot. Rechecks inventory at end. */
export async function partitionedSnapshot(io:{inventory:(id:string,part:number)=>Promise<number[]>;events:(ids:number[],id:string,part:number,responseMiB:number,markStarted:()=>void)=>Promise<TradeEvent[]>},sink:PartitionSink,options:{batchSize?:number;responseMiB?:number;wait?:(ms:number)=>Promise<void>;now?:()=>number}={}){
 const recoveryId=randomUUID(),now=options.now??Date.now,wait=options.wait??(ms=>delay(ms));
 let cap=options.responseMiB??16;
 if(!Number.isSafeInteger(cap)||cap<1||cap>64)return invalid('Límite de lote inválido.');
 const progress:PartitionProgress={recoveryId,stage:'inventory',inventory:0,completedFixtures:0,batches:0,maxResponseBytes:cap*1024*1024};
 const report=async()=>{await sink.progress({...progress});};
 const attempt=async<T>(action:()=>Promise<T>):Promise<T>=>{
  for(;;){sink.assertOpen();try{return await action();}catch(error){
   if(!(error instanceof OperationError)||!(error.diagnostic.category==='rate_limited'||error.diagnostic.reason==='memory_budget_exceeded'))throw error;
   const until=Date.parse(error.diagnostic.retryAt||'')||now()+(error.diagnostic.retryAfterMs??60000);
   progress.stage='waiting';progress.retryAt=new Date(Math.max(until,now()+1000)).toISOString();await report();
   while(now()<Date.parse(progress.retryAt)){sink.assertOpen();await wait(Math.min(1000,Date.parse(progress.retryAt)-now()));}
  }}
 };
 await report();const ids=completeInventory(await attempt(()=>io.inventory(recoveryId,0)));
 progress.inventory=ids.length;progress.inventoryDigest=createHash('sha256').update(JSON.stringify(ids)).digest('hex');
 await sink.begin(ids);let size=options.batchSize??10;
 if(!Number.isSafeInteger(size)||size<1||size>50)return invalid('Tamaño de lote inválido.');
 let index=0,part=0;
 while(index<ids.length){
  sink.assertOpen();const selected=ids.slice(index,index+size);let at=now();progress.stage='batches';delete progress.retryAt;await report();
  let rows:TradeEvent[];
  try{rows=await attempt(()=>io.events(selected,recoveryId,part,cap,()=>{at=now();}));}
  catch(error){
   if(error instanceof OperationError&&error.diagnostic.reason==='response_size_limit'){
    if(selected.length>1){size=Math.max(1,Math.floor(selected.length/2));continue;}
    // A dense single fixture may use up to 64 MiB, still far below the old 256 MiB cap.
    // The HTTP adapter rechecks the exact conversion budget; failed-request cooldown is not bypassed.
    if(cap<64){cap=Math.min(64,cap*2);progress.maxResponseBytes=cap*1024*1024;continue;}
   }
   throw error;
  }
  const got=rows.map(row=>row.fixtureId);progress.lastBatch={requested:selected.length,received:got.length,missing:selected.filter(id=>!got.includes(id)).length,unexpected:got.filter(id=>!selected.includes(id)).length,exampleMissingFixtures:selected.filter(id=>!got.includes(id)).slice(0,5)};await report();
  if(got.length!==selected.length||new Set(got).size!==got.length||got.some(id=>!selected.includes(id)))return invalid('El lote no contiene exactamente los fixtures solicitados; baseline incompleto, cuotas bloqueadas.');
  sink.assertOpen();await sink.batch(rows,at);index+=selected.length;part++;progress.completedFixtures=index;progress.batches++;await report();
 }
 progress.stage='verify';await report();const verified=completeInventory(await attempt(()=>io.inventory(recoveryId,1)));
 if(ids.length!==verified.length||ids.some((id,i)=>id!==verified[i]))return invalid('El inventario cambió durante la recuperación; se requiere otro baseline completo.');
 sink.assertOpen();progress.stage='complete';delete progress.retryAt;await report();return {...progress};
}
