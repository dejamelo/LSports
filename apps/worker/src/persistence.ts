import { validTrace, validMarketEvidence } from "./settlement-evidence.js";
import { constants } from 'node:fs';
import { createReadStream } from 'node:fs';
import { copyFile, open, rename, mkdir, lstat, stat } from 'node:fs/promises';
import {getHeapStatistics} from 'node:v8';
import {dirname} from 'node:path';
import {walkSnapshot} from './full-snapshot.js';
import {jsonItems,writeJsonObject,writeJsonRecord} from '@lsports/feed-store';
import type { EventFeed, Lane } from '@lsports/contracts';
import type { Fixture, Market } from 'trade360-nodejs-sdk';
import { TradeState, compactBetAt, persistedBetOrders, restorePreciseBetOrders, type Row } from './state.js';

// The sidecar is parsed as a bounded stream, one <=32 MiB record at a time.
// Keep a finite file cap while admitting the measured 2.20 GB production
// checkpoint; this does not change heap, inbox, response or record limits.
export const MAX_PRIVATE_REGULAR_CHECKPOINT_BYTES = 3 * 1024 ** 3;
export function privateCheckpointFileAllowed(size:number,isFile:boolean,isSymbolicLink:boolean){
  return Number.isSafeInteger(size)&&size>=0&&size<=MAX_PRIVATE_REGULAR_CHECKPOINT_BYTES&&isFile&&!isSymbolicLink;
}

const validId = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const tuples = (v: unknown): v is [string, unknown][] => Array.isArray(v) && v.every(e => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string');
export function checkpoint(state: TradeState, includeRegular=true) {
  const regular=includeRegular?(['prematch','inplay'] as const).flatMap(lane=>[...state.rows[lane]].filter(([,row])=>!row.outright).map(([key,row])=>({
    lane,fixtureId:Number(key),fixture:row.fixture,livescore:row.livescore,
    markets:[...row.markets],marketAt:[...row.marketAt],betAt:[...row.betAt],betOrder:[...persistedBetOrders(row)],
  }))):[];
  return { version: 1, regular, outright: (['prematch', 'inplay'] as const).flatMap(lane =>
    [...state.rows[lane]].filter(([, row]) => row.outright).map(([key, row]) => ({
      lane, fixtureId: Number(String(key).split(':').at(-1)),
      fixture: row.fixture, outright: row.outright, livescore: row.livescore, outrightScore: row.outrightScore, marketReceipt: row.marketReceipt,
      deferredTimestampBets: row.deferredTimestampBets ? [...row.deferredTimestampBets] : undefined,
      timestampRecovery: row.timestampRecovery ? [...row.timestampRecovery] : undefined,
      settlementAudit: row.settlementAudit ? [...row.settlementAudit] : undefined,
      settlementMarkets: row.settlementMarkets ? [...row.settlementMarkets] : undefined,
      betOrder: [...persistedBetOrders(row)],
      markets: [...row.markets], marketAt: [...row.marketAt], betAt: [...row.betAt],
    }))) };
}

// Internal writer payload: emitted arrays are lazy; wire/checkpoint schema is unchanged.
const mapItems=(value:Map<any,any>|undefined,marketIds?:ReadonlySet<string>)=>value?jsonItems(function*(){for(const [key,item] of value)if(!marketIds||marketIds.has(String(key).split(':',1)[0]))yield [key,item];}):undefined;
export function streamedRow(lane:Lane,key:string|number,row:Row,outright=false,marketIds?:ReadonlySet<string>){return {
 lane,fixtureId:outright?Number(String(key).split(':').at(-1)):Number(key),fixture:row.fixture,
 ...(outright?{outright:row.outright,outrightScore:row.outrightScore}:{}),livescore:row.livescore,
 markets:mapItems(row.markets,marketIds),marketAt:mapItems(row.marketAt,marketIds),betAt:mapItems(row.betAt,marketIds),betOrder:jsonItems(function*(){yield* persistedBetOrders(row,marketIds);}),marketReceipt:row.marketReceipt,
 deferredTimestampBets:mapItems(row.deferredTimestampBets,marketIds),timestampRecovery:mapItems(row.timestampRecovery,marketIds),settlementAudit:mapItems(row.settlementAudit,marketIds),settlementMarkets:mapItems(row.settlementMarkets,marketIds),
};}
// Use under publicationTurn/state.exclusive, exactly like streamed regular persistence.
export function streamCheckpoint(state:TradeState){
 const rows={prematch:new Map(state.rows.prematch),inplay:new Map(state.rows.inplay)};
 return {version:1,regular:[],outright:jsonItems(function*(){for(const lane of ['prematch','inplay'] as const)for(const[key,row]of rows[lane])if(row.outright)yield streamedRow(lane,key,row,true);})};
}

export const checkpointJournalPath=(path:string)=>path+'.checkpoint-journal.jsonl';
export const CHECKPOINT_JOURNAL_COMPACT_BYTES=1024**3;
export async function persistCheckpointDelta(path:string,state:TradeState,changes:readonly {lane:Lane;key:number|string;marketIds?:readonly string[]|null}[]){
 const journal=checkpointJournalPath(path);await mkdir(dirname(path),{recursive:true});
 const file=await open(journal,'a',0o600);let rows=0,bytes=0,serializeMs=0,writeAwaitMs=0,fsyncAwaitMs=0,journalBytes=0;
 try{
  for(const change of changes){
   const row=state.rows[change.lane].get(change.key);
   const partial=!!row&&change.marketIds!==undefined&&change.marketIds!==null;
   const marketIds=partial?new Set(change.marketIds):undefined;
   const record=row?{op:partial?'merge':'upsert',lane:change.lane,key:change.key,regular:!row.outright,...(partial?{marketIds:[...marketIds!]}:{}),entry:streamedRow(change.lane,change.key,row,!!row.outright,marketIds)}:{op:'delete',lane:change.lane,key:change.key};
   const encoded=await writeJsonRecord(file,record);bytes+=encoded.bytes;serializeMs+=encoded.serializeMs;writeAwaitMs+=encoded.writeAwaitMs;
   const at=performance.now();await file.writeFile('\n');writeAwaitMs+=performance.now()-at;bytes++;rows++;
  }
  if(rows){const at=performance.now();await file.sync();fsyncAwaitMs=performance.now()-at;journalBytes=(await file.stat()).size;}
 }finally{await file.close();}
 return {rows,bytes,journalBytes,serializeMs:Math.ceil(serializeMs),writeAwaitMs:Math.ceil(writeAwaitMs),fsyncAwaitMs:Math.ceil(fsyncAwaitMs),compactDue:journalBytes>=CHECKPOINT_JOURNAL_COMPACT_BYTES};
}

/** Atomic full-state compaction. The journal is rotated only after the new baseline is durable. */
export async function compactCheckpointJournal(path:string,state:TradeState){
 const temp=path+'.checkpoint-compaction.tmp',journal=checkpointJournalPath(path),journalTemp=journal+'.empty.tmp';
 await mkdir(dirname(path),{recursive:true});
 try{await copyFile(path,path+'.pre-indexed-compaction.bak',constants.COPYFILE_EXCL);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'&&(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const file=await open(temp,'w',0o600);let rows=0,bytes=0;const write=async(s:string)=>{await file.writeFile(s);bytes+=Buffer.byteLength(s);};
 try{
  await write('{"mode":"connected","events":[],"workerCheckpoint":{"version":1,"regular":[');
  let first=true;
  for(const lane of ['prematch','inplay'] as const)for(const[key,row]of state.rows[lane])if(!row.outright){if(!first)await write(',');first=false;await writePrivateCheckpointRecord(file,streamedRow(lane,key,row,false));rows++;}
  await write('],"outright":[');first=true;
  for(const lane of ['prematch','inplay'] as const)for(const[key,row]of state.rows[lane])if(row.outright){if(!first)await write(',');first=false;await writePrivateCheckpointRecord(file,streamedRow(lane,key,row,true));rows++;}
  await write(']}}');const at=performance.now();await file.sync();const fsyncMs=performance.now()-at;
  bytes=(await file.stat()).size;
  await file.close();await rename(temp,path);
  const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}
  const empty=await open(journalTemp,'w',0o600);try{await empty.sync();}finally{await empty.close();}
  await rename(journalTemp,journal);const journalDir=await open(dirname(journal),'r');try{await journalDir.sync();}finally{await journalDir.close();}
  return {rows,bytes,fsyncMs:Math.ceil(fsyncMs)};
 }catch(error){try{await file.close();}catch{}throw error;}
}

// One bounded buffer spans fixture boundaries. Previously every comma and
// each small record forced a separate asynchronous filesystem write.
export function checkpointWriteBuffer(file:Pick<Awaited<ReturnType<typeof open>>,'writeFile'>,observe?:(phase:string)=>void,limit=1024*1024){
 if(!Number.isSafeInteger(limit)||limit<65536||limit>1024*1024)throw Error('INVALID_CHECKPOINT_WRITE_BUFFER');
 let chunks:string[]=[],bytes=0;const stats={writeCalls:0,writeBytes:0,maxBufferedBytes:0,writeAwaitMs:0};
 const write=async(text:string)=>{observe?.('regular_checkpoint.write');const at=performance.now();try{await file.writeFile(text);stats.writeCalls++;stats.writeBytes+=Buffer.byteLength(text);}finally{stats.writeAwaitMs+=performance.now()-at;observe?.('regular_checkpoint.encode');}};
 const flush=async()=>{if(!bytes)return;const text=chunks.join('');chunks=[];bytes=0;await write(text);};
 return {stats,flush,async writeFile(text:string){
  const size=Buffer.byteLength(text);
  if(size>limit){await flush();await write(text);return;}
  if(bytes+size>limit||chunks.length>=4096)await flush();
  chunks.push(text);bytes+=size;stats.maxBufferedBytes=Math.max(stats.maxBufferedBytes,bytes);
  if(bytes===limit)await flush();
 }};
}

// Native encode one field/map entry at a time, never a full fixture or state.
// Lazy map arrays keep their order and JSON schema. The private writer needs
// neither the public event hash nor recursive primitive-token inspection.
export async function writePrivateCheckpointRecord(file:Pick<Awaited<ReturnType<typeof open>>,'writeFile'>,record:Record<string,unknown>){
 let size=0,parts:string[]=[],pending=0,writeAwaitMs=0;const began=performance.now();
 const write=async(text:string)=>{const at=performance.now();try{await file.writeFile(text);}finally{writeAwaitMs+=performance.now()-at;}};
 const flush=async()=>{if(!pending)return;const text=parts.join('');parts=[];pending=0;await write(text);};
 const add=async(text:string)=>{const bytes=Buffer.byteLength(text);size+=bytes;if(size>32*1024**2)throw Error('checkpoint_record_limit');if(pending+bytes>65536)await flush();if(bytes>65536){await write(text);return;}parts.push(text);pending+=bytes;};
 await add('{');let first=true;
 for(const [key,value] of Object.entries(record)){
  if(value===undefined)continue;
  if(!first)await add(',');first=false;await add(JSON.stringify(key)+':');
  if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype&&Symbol.iterator in value){
   await add('[');let entryFirst=true;
   for(const entry of value as Iterable<unknown>){if(!entryFirst)await add(',');entryFirst=false;await add(JSON.stringify(entry)??'null');}
   await add(']');
  }else await add(JSON.stringify(value)??'null');
 }
 await add('}');await flush();return {serializeMs:Math.max(0,performance.now()-began-writeAwaitMs),writeAwaitMs};
}

// Stable private sidecar may be ahead of the public feed after a crash; replay remains
// idempotent and restored prices remain blocked. ACK is sent only after BOTH writes.
export async function persistRegularCheckpoint(path:string,regular:ReturnType<typeof checkpoint>['regular']|TradeState,observe?:(phase:string)=>void){
  const began=performance.now();let fsyncAwaitMs=0,closeAwaitMs=0,renameAwaitMs=0,directorySyncAwaitMs=0;
  await mkdir(dirname(path),{recursive:true});const target=path+'.regular-checkpoint.json',temp=target+'.'+process.pid+'.tmp';
  observe?.('regular_checkpoint.open');const file=await open(temp,'w',0o600);
  const output=checkpointWriteBuffer(file,observe);const writer=output as unknown as typeof file;let serializeMs=0;try{
    if(regular instanceof TradeState){
      await writer.writeFile('{"version":1,"regular":[');let first=true;
      // Freeze only row identities/references, not their market/bet maps. A live
      // Map iterator would chase fixtures arriving during this write indefinitely.
      const captured=(['prematch','inplay'] as const).flatMap(lane=>[...regular.rows[lane]].filter(([,row])=>!row.outright).map(([key,row])=>({lane,key,row})));
      for(const {lane,key,row} of captured){
        if(!first)await writer.writeFile(',');first=false;
        serializeMs+=(await writePrivateCheckpointRecord(writer,streamedRow(lane,key,row))).serializeMs;
      }
      await writer.writeFile(']}');
    }else {const encoded=await writeJsonObject(writer,{version:1,regular});serializeMs+=encoded.serializeMs;}
    await output.flush();observe?.('regular_checkpoint.fsync');let at=performance.now();await file.sync();fsyncAwaitMs=performance.now()-at;
  }finally{const at=performance.now();await file.close();closeAwaitMs=performance.now()-at;}
  observe?.('regular_checkpoint.rename');let at=performance.now();await rename(temp,target);renameAwaitMs=performance.now()-at;
  const directory=await open(dirname(path),'r');try{observe?.('regular_checkpoint.directory_fsync');at=performance.now();await directory.sync();directorySyncAwaitMs=performance.now()-at;}finally{await directory.close();}
  const totalWallMs=performance.now()-began;
  return {...output.stats,serializeMs,fsyncAwaitMs,closeAwaitMs,renameAwaitMs,directorySyncAwaitMs,totalWallMs,otherWallMs:Math.max(0,totalWallMs-output.stats.writeAwaitMs-serializeMs-fsyncAwaitMs-closeAwaitMs-renameAwaitMs-directorySyncAwaitMs)};
}

// Read directly: API freshness protection must not prevent recovery after downtime.
// Never restore connection status from disk or infer current availability from a saved feed.
export async function restore(state: TradeState, path: string, progress?:(sample:{stage:string;rows:number})=>void) {
  progress?.({stage:'checkpoint.scan',rows:0});
  let value: unknown,baseExists=true,journalRows=0;
  try {
    const metadata=await walkSnapshot(path,async()=>{},32*1024**2,'events') as {header?:unknown;mode?:unknown};
    value={mode:metadata.mode,events:[],...(metadata.header!==undefined?{workerCheckpoint:metadata.header}:{})};
  } catch(error) {
    if((error as NodeJS.ErrnoException).code==='ENOENT'){
      try{await stat(checkpointJournalPath(path));baseExists=false;value={mode:'connected',events:[],workerCheckpoint:{version:1,regular:[],outright:[]}};}
      catch(journalError){if((journalError as NodeJS.ErrnoException).code==='ENOENT')return {source:'missing',rows:0};throw journalError;}
    } else throw error;
  }
  if (!object(value) || value.mode !== 'connected' || !Array.isArray(value.events))
    throw new Error('Invalid saved TRADE state; original file preserved');
  progress?.({stage:'checkpoint.rebuild',rows:0});
  const recovered = new TradeState();
  let rows = 0;
  let restoreStage='checkpoint.rebuild';
  let restoreJournalEntry:((entry:unknown,regular:boolean,mode?:'replace'|'merge',marketIds?:readonly string[])=>void)|undefined;
  if (value.workerCheckpoint !== undefined) {
    const saved = value.workerCheckpoint;
    if (!object(saved) || saved.version !== 1 || !Array.isArray(saved.outright))
      throw new Error('Unsupported TRADE checkpoint; original file preserved');
    if(saved.regularExternal!==undefined&&saved.regularExternal!==true)throw new Error('Invalid private checkpoint reference');
    if(saved.regular!==undefined&&!Array.isArray(saved.regular))throw new Error('Invalid regular checkpoint');
    const restoreEntry=(entry:unknown,regular:boolean,mode?:'replace'|'merge',mergeMarketIds?:readonly string[])=>{
      if(rows%100===0)progress?.({stage:restoreStage,rows});
      if(Math.min(getHeapStatistics().heap_size_limit-process.memoryUsage().heapUsed,process.availableMemory?.()??Infinity)<320*1024**2)throw new Error('Private checkpoint incremental memory guard; original preserved');
      if (!object(entry) || !['prematch', 'inplay'].includes(String(entry.lane)) || !validId(entry.fixtureId) ||
          (!regular&&(!object(entry.outright)||!validId(entry.outright.competitionId))) || (regular&&entry.outright!==undefined) ||
          !tuples(entry.markets) || !tuples(entry.marketAt) || !tuples(entry.betAt) ||
          entry.markets.some(([, m]) => !object(m) || !validId(m.id) || (m.bets !== undefined && !Array.isArray(m.bets))) ||
          [...entry.marketAt, ...entry.betAt].some(([, t]) => typeof t !== 'number' || !Number.isFinite(t)) ||
          (entry.fixture !== undefined && (!object(entry.fixture) || !object(entry.fixture.value) || typeof entry.fixture.at !== 'number' || !Number.isFinite(entry.fixture.at))))
        throw new Error('Invalid outright checkpoint; original file preserved');
      if ((entry.deferredTimestampBets !== undefined && (!tuples(entry.deferredTimestampBets) || entry.deferredTimestampBets.some(([, r]) => !object(r) || !validId(r.marketId) || typeof r.selectionId!=="string" || !object(r.bet) || !object(r.inspection) || typeof r.receivedAt!=="string"))) ||
          (entry.timestampRecovery !== undefined && (!tuples(entry.timestampRecovery) || entry.timestampRecovery.some(([, r]) => !object(r) || !["awaiting_fresh_amqp","validated_amqp","awaiting_settlement_replay","settlement_replayed"].includes(String(r.status)) || ![r.previousVersion,r.baselineVersion,r.preparedAt].every(v=>typeof v==="string"&&Number.isFinite(Date.parse(v)))))))
        throw new Error('Invalid timestamp quarantine; original preserved');
      if ((entry.settlementAudit !== undefined && (!tuples(entry.settlementAudit) || entry.settlementAudit.some(([, trace]) => !validTrace(trace)))) ||
          (entry.settlementMarkets !== undefined && (!tuples(entry.settlementMarkets) || entry.settlementMarkets.some(([, evidence]) => !validMarketEvidence(evidence)))))
        throw new Error('Invalid saved settlement evidence; original file preserved');
      if (entry.outrightScore !== undefined) {
        const score = entry.outrightScore;
        if (!object(score) || typeof score.at !== 'number' || !Number.isFinite(score.at) || !object(score.value) ||
            (score.value.status !== undefined && (!Number.isInteger(score.value.status) || Number(score.value.status) < 0)) ||
            (score.value.participantResults !== undefined && (!Array.isArray(score.value.participantResults) || score.value.participantResults.some((p: unknown) =>
              !object(p) || (p.participantId !== undefined && (!Number.isSafeInteger(p.participantId) || Number(p.participantId) <= 0)) ||
              (p.name !== undefined && typeof p.name !== 'string') ||
              (p.result !== undefined && (typeof p.result !== 'number' || !Number.isFinite(p.result)))))))
          throw new Error('Invalid saved outright score; original file preserved');
      }
      if (entry.marketReceipt !== undefined && (!object(entry.marketReceipt) ||
          !object(entry.marketReceipt.messagesByType) ||
          Object.values(entry.marketReceipt.messagesByType).some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0) ||
          ['marketUpdates', 'betUpdates', 'providerMarketUpdates', 'providerBetUpdates', 'staleBetUpdates'].some(k =>
            typeof (entry.marketReceipt as Record<string, unknown>)[k] !== 'number' || !Number.isFinite((entry.marketReceipt as Record<string, number>)[k]))))
        throw new Error('Invalid saved market counters; original file preserved');
      if(entry.betOrder !== undefined && (!tuples(entry.betOrder) || entry.betOrder.some(([,v])=>typeof v!=='string'||!/^[-]?[0-9]{1,25}$/.test(v))))throw new Error('Invalid precise timestamp ordering; original preserved');
      const lane = entry.lane as Lane;
      const key = regular?entry.fixtureId:`outright:${(entry.outright as Record<string,unknown>).competitionId}:${entry.fixtureId}`;
      const existing=mode==='merge'?recovered.rows[lane].get(key):undefined;
      if(mode==='replace')recovered.rows[lane].delete(key);
      if (mode!=='merge'&&recovered.rows[lane].has(key)) throw new Error('Duplicate checkpoint identity');
      const mergeScopedTuples=<T>(prior:Map<string,T>|undefined,incoming:unknown,scope:readonly string[]|undefined,compound:boolean):Map<string,T>=>{
        const result=new Map(prior||[]);
        if(scope){const touched=new Set(scope);for(const id of result.keys()){const marketId=compound?id.slice(0,id.indexOf(':')):id;if(touched.has(marketId))result.delete(id);}}
        if(incoming!==undefined)for(const [id,value] of incoming as [string,T][])result.set(id,value);
        return result;
      };
      const scoped=mode==='merge'?mergeMarketIds:undefined;
      const markets=mergeScopedTuples(existing?.markets,entry.markets,scoped,false) as Map<string,Market>;
      const marketAt=mergeScopedTuples(existing?.marketAt,entry.marketAt,scoped,false);
      const savedBetAt=mergeScopedTuples(existing?.betAt,entry.betAt,scoped,true);
      const betAt=compactBetAt(markets,savedBetAt);
      const mergeTuples=<T>(prior:Map<string,T>|undefined,incoming:unknown):Map<string,T>|undefined=>{
        if(incoming===undefined)return prior?new Map(prior):undefined;
        const result=new Map(prior||[]);for(const [id,value] of incoming as [string,T][])result.set(id,value);return result;
      };
      const betOrder=mode==='merge'?mergeScopedTuples(existing?.betOrder,entry.betOrder,scoped,true):mergeTuples(existing?.betOrder,entry.betOrder);
      const restoredRow:Row={
        deferredTimestampBets: (mode==='merge'?mergeScopedTuples(existing?.deferredTimestampBets,entry.deferredTimestampBets,scoped,true):mergeTuples(existing?.deferredTimestampBets,entry.deferredTimestampBets)) as Row["deferredTimestampBets"],
        timestampRecovery: (mode==='merge'?mergeScopedTuples(existing?.timestampRecovery,entry.timestampRecovery,scoped,true):mergeTuples(existing?.timestampRecovery,entry.timestampRecovery)) as Row["timestampRecovery"],
        settlementAudit: (mode==='merge'?mergeScopedTuples(existing?.settlementAudit,entry.settlementAudit,scoped,true):mergeTuples(existing?.settlementAudit,entry.settlementAudit)) as Row["settlementAudit"],
        settlementMarkets: (mode==='merge'?mergeScopedTuples(existing?.settlementMarkets,entry.settlementMarkets,scoped,false):mergeTuples(existing?.settlementMarkets,entry.settlementMarkets)) as Row["settlementMarkets"],
        outrightScore: (entry.outrightScore??existing?.outrightScore) as Row["outrightScore"],
        fixture: (entry.fixture??existing?.fixture) as Row["fixture"], outright: (entry.outright??existing?.outright) as Row["outright"],
        livescore: (entry.livescore??existing?.livescore) as Row["livescore"], marketReceipt: (entry.marketReceipt??existing?.marketReceipt) as Row["marketReceipt"],
        betOrder,
        markets, marketAt, betAt,
      };
      restorePreciseBetOrders(restoredRow);
      recovered.rows[lane].set(key, restoredRow);
      rows++;
    };
    restoreJournalEntry=restoreEntry;
    if(baseExists)await walkSnapshot(path,async()=>{},32*1024**2,'events',async(entry,regular)=>{
      if(regular&&saved.regularExternal===true)throw new Error('Conflicting embedded regular checkpoint; original preserved');
      restoreEntry(entry,regular);
    });
    if(saved.regularExternal===true){
      const sidePath=path+'.regular-checkpoint.json',info=await lstat(sidePath);
      if(!privateCheckpointFileAllowed(info.size,info.isFile(),info.isSymbolicLink()))throw new Error('Private regular checkpoint identity guard; original preserved');
      restoreStage='checkpoint.sidecar';progress?.({stage:restoreStage,rows});
      await walkSnapshot(sidePath,async entry=>{restoreEntry(entry,true);},32*1024**2,'regular');
    }
  } else {
    // Migrate the previous UI-only projection. Preserve all participants and exposed markets;
    // provider-specific data absent from that old format cannot be reconstructed.
    await walkSnapshot(path,async raw=>{
      const event=raw as EventFeed['events'][number];
      if (!object(event) || event.kind !== 'outright') return;
      const match = typeof event.id === 'string' && /^(prematch|inplay):outright:(\d+):(\d+)$/.exec(event.id);
      if (!match || !validId(Number(match[2])) || !validId(Number(match[3])))
        throw new Error('Invalid legacy outright identity; original file preserved');
      const lane = match[1] as Lane;
      const at = Date.parse(event.updatedAt || '');
      if (!Number.isFinite(at) || (event.participants !== undefined && !Array.isArray(event.participants)))
        throw new Error('Invalid legacy outright metadata; original file preserved');
      const markets = (event.markets || []).map(m => {
        const prefix = `${event.id}:`;
        if (!m.id.startsWith(prefix) || !validId(Number(m.id.slice(prefix.length))))
          throw new Error('Invalid legacy market identity');
        return { id: Number(m.id.slice(prefix.length)), name: m.name, status: m.status,
          bets: m.selections.map(s => {
            if (!s.id.startsWith(`${m.id}:`) || !s.id.slice(m.id.length + 1)) throw new Error('Invalid legacy selection identity');
            return { id: s.id.slice(m.id.length + 1), name: s.line && s.label.endsWith(` (${s.line})`) ? s.label.slice(0, -(` (${s.line})`.length)) : s.label, line: s.line, price: String(s.odds),
              status: s.status, participantId: s.participantId, settlement: s.settlement, isChanged: -1 };
          }) } as Market;
      });
      recovered.apply(lane, [{ fixtureId: Number(match[3]), outright: {
        competitionId: Number(match[2]), competitionName: event.competition?.name,
        competitionType: event.competition?.type,
        fixture: { fixtureName: event.home, sport: { name: ({ hipica: 'Horse Racing', futbol: 'Football', tenis: 'Tennis', basquet: 'Basketball', otros: 'Other' })[event.sport] },
          status: event.status, participants: event.participants } as Fixture,
      }, markets }], at);
      if (event.marketDiagnostic) {
        const d = event.marketDiagnostic;
        const row = recovered.rows[lane].get(`outright:${match[2]}:${match[3]}`)!;
        if (!object(d.messagesByType) || Object.values(d.messagesByType).some(v => typeof v !== 'number' || !Number.isFinite(v)) ||
            [d.marketUpdates, d.betUpdates, d.providerMarketUpdates, d.providerBetUpdates, d.staleBetUpdates].some(v => typeof v !== 'number' || !Number.isFinite(v)))
          throw new Error('Invalid legacy market counters; original file preserved');
        row.marketReceipt = { messagesByType: d.messagesByType, marketUpdates: d.marketUpdates,
          betUpdates: d.betUpdates, providerMarketUpdates: d.providerMarketUpdates,
          providerBetUpdates: d.providerBetUpdates, staleBetUpdates: d.staleBetUpdates,
          lastMarketMessageAt: d.lastMarketMessageAt };
      }
      rows++;
    },32*1024**2,'events');
    // Preserve the original projection before its one-way migration. No overwrite of an older backup.
    try { await copyFile(path, `${path}.pre-checkpoint.bak`, constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  // The append-only journal is fsynced before its durable inbox prefix is retired.
  // A torn record fails closed and leaves both baseline and journal untouched.
  const journal=checkpointJournalPath(path);
  try{
    await stat(journal);
    let pending='';
    for await(const chunk of createReadStream(journal,{encoding:'utf8'})){
      pending+=chunk;
      if(Buffer.byteLength(pending)>32*1024**2&&!pending.includes('\n'))throw new Error('Checkpoint journal record limit; original preserved');
      for(;;){const end=pending.indexOf('\n');if(end<0)break;const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line)throw new Error('Empty checkpoint journal record; original preserved');
        let record:unknown;try{record=JSON.parse(line);}catch{throw new Error('Invalid checkpoint journal record; original preserved');}
        if(!object(record)||!['upsert','merge','delete'].includes(String(record.op))||!['prematch','inplay'].includes(String(record.lane))||!(typeof record.key==='number'&&validId(record.key)||typeof record.key==='string'&&record.key.length>0&&record.key.length<=128)||(record.op==='merge'&&(!Array.isArray(record.marketIds)||record.marketIds.some(id=>typeof id!=='string'||!validId(Number(id))))))throw new Error('Invalid checkpoint journal identity; original preserved');
        const lane=record.lane as Lane;
        if(record.op==='delete')recovered.rows[lane].delete(record.key as number|string);
        else{
          if(typeof record.regular!=='boolean'||!object(record.entry)||record.entry.lane!==lane)throw new Error('Invalid checkpoint journal row; original preserved');
          const entry=record.entry as Record<string,unknown>;
          const key=record.regular?entry.fixtureId:`outright:${(entry.outright as Record<string,unknown>)?.competitionId}:${entry.fixtureId}`;
          if(key!==record.key)throw new Error('Checkpoint journal key mismatch; original preserved');
          if(!restoreJournalEntry)throw new Error('Checkpoint journal cannot apply to legacy baseline; original preserved');
          restoreJournalEntry(entry,record.regular,record.op==='merge'?'merge':'replace',record.op==='merge'?record.marketIds as string[]:undefined);
        }
        journalRows++;
      }
    }
    if(pending.length)throw new Error('Truncated checkpoint journal; original preserved');
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  // Commit only after the whole file has been validated. Restored prices stay blocked pending updates.
  progress?.({stage:'checkpoint.commit',rows});
  state.rows = recovered.rows;
  for (const lane of ['prematch', 'inplay'] as const)
    for (const row of state.rows[lane].values()) row.restored = true;
  const totalRows=state.rows.prematch.size+state.rows.inplay.size;
  return { source: journalRows?'checkpoint_journal':value.workerCheckpoint === undefined ? 'legacy_projection' : 'checkpoint', rows:totalRows, ...(journalRows?{journalRows}:{}) };
}
