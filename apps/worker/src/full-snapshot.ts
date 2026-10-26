/** Ordinary vendor HTTP JSON, streamed to a private bounded disk spool, NOT a new vendor streaming API.
 * Validate the entire envelope before applying any rows. Replay one SDK-converted fixture at a time.
 */
import {createHash} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdtemp,rm,statfs,open} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGunzip,createInflate,createBrotliDecompress} from 'node:zlib';
import {setImmediate as yieldTurn,setTimeout as waitTurn} from 'node:timers/promises';
import {Mapper,GetEventRequestDto,GetInPlayEventRequestDto,GetEventRequest,GetEventsResultElement,TransformerUtil,IdSafeJsonParser} from 'trade360-nodejs-sdk';
import {OperationError} from './diagnostics.js';
import {snapshotCapacity} from './snapshot-capacity.js';
import {normalizeSdkTimestamps,attachTimestampPrecision,hasInvalidProviderTimestamp} from './timestamp-contract.js';
import {inspectResponse} from './response-inspection.js';
import type {TradeEvent} from './state.js';
const MiB=1024*1024;
// At the observed AWS rate (~3 MiB/s), a 2-GiB response takes about 11 minutes.
// Allow bounded stream pauses without removing either the inactivity timeout
// or the independent 12-minute total deadline.
export const FULL_SNAPSHOT_LIMITS={responseBytes:2*1024*MiB,itemBytes:16*MiB,fixtures:50000,idleMs:60000,totalMs:12*60*1000,memoryWaitMs:60000,memoryRetryMs:250};
const fail=(reason:string,shape:Partial<NonNullable<import('@lsports/contracts').IntegrationDiagnostic['snapshotValidation']>>={}):never=>{throw new OperationError({operation:'snapshot.events',protocol:'http',category:'invalid_response',reason:'invalid_snapshot',snapshotValidation:{phase:'batch',code:'full_document_invalid',detail:reason,attribution:'not_proven',...shape},message:'Snapshot completo rechazado: '+reason+'. No se publica baseline incompleto.'});};
export function fullSnapshotMemory(lane:'prematch'|'inplay'='prematch'){const c=snapshotCapacity({...process.env,[lane==='inplay'?'LSPORTS_INPLAY_SNAPSHOT_MAX_RESPONSE_MB':'LSPORTS_PREMATCH_SNAPSHOT_MAX_RESPONSE_MB']:'32'},undefined,lane);if(!c.allowed){console.info(JSON.stringify({operation:'offline.memory_budget',lane,stage:'snapshot_guard',budgetBytes:c.budgetBytes,headroomBytes:c.headroomBytes,allowed:false,memory:c.memory}));throw new OperationError({operation:'snapshot.events',protocol:'local',category:'response_limit',reason:'memory_budget_exceeded',deferred:true,memoryBudgetBytes:c.budgetBytes,memoryHeadroomBytes:c.headroomBytes,snapshotMemory:c.memory,responseLimitBytes:FULL_SNAPSHOT_LIMITS.itemBytes,message:'Margen insuficiente para conversión/persistencia incremental; recuperación pendiente.'});}}
// Tokens bounded independently of the full document. Strings are never interpreted as structure.
async function* tokens(file:string,max:number){let primitive='',quoted=false,escape=false,parts:string[]=[],size=0;
 for await(const chunk of createReadStream(file,{encoding:'utf8',highWaterMark:64*1024})){
  const batch:string[]=[];let start=quoted?0:-1;
  for(let i=0;i<chunk.length;i++){const ch=chunk[i];
   if(quoted){if(size+i-start+1>max)fail('token_size_limit');if(escape)escape=false;else if(ch==='\\')escape=true;else if(ch==='"'){parts.push(chunk.slice(start,i+1));batch.push(parts.join(''));parts=[];size=0;quoted=false;start=-1;}}
   else if(ch==='"'){if(primitive)fail('invalid_json');quoted=true;start=i;}
   else if(ch===' '||ch==='\n'||ch==='\r'||ch==='\t'||'{}[],:'.includes(ch)){if(primitive){batch.push(primitive);primitive='';}if('{}[],:'.includes(ch))batch.push(ch);}
   else{primitive+=ch;if(primitive.length>max)fail('token_size_limit');}
  }
  if(quoted){const part=chunk.slice(start);parts.push(part);size+=part.length;}
  if(batch.length)yield batch;
  await yieldTurn();
 }if(quoted)fail('truncated_string');if(primitive)yield [primitive];
}
export async function walkSnapshot(file:string,onRow:(raw:unknown,rawBytes:number)=>Promise<void>,limit=FULL_SNAPSHOT_LIMITS.itemBytes,checkpoint?:'regular'|'events',onCheckpointRow?:(row:unknown,regular:boolean)=>Promise<void>){
 const it=tokens(file,limit)[Symbol.asyncIterator]();let batch:string[]=[],offset=0,lastItemBytes=0;
 const fill=async()=>{const next=await it.next();if(next.done)fail('truncated_json');batch=next.value as string[];offset=0;};
 const take=async()=>{if(offset>=batch.length)await fill();return batch[offset++];};
 const rawValue=async(first:string,max=limit)=>{
  if(checkpoint)fullSnapshotMemory();
  let n=first.length,blockChars=n,pieces=[first];const blocks:string[]=[];
  const append=(token:string)=>{pieces.push(token);blockChars+=token.length;if(blockChars>=64*1024){blocks.push(pieces.join(''));pieces=[];blockChars=0;}};
  let depth=first==='{'||first==='['?1:0;
  while(depth){if(offset>=batch.length)await fill();while(offset<batch.length&&depth){const t=batch[offset++];n+=t.length;if(n>max)fail('item_size_limit');append(t);if(t==='{'||t==='[')depth++;if(t==='}'||t===']')depth--;if(depth>128)fail('nesting_limit');if(depth<0)fail('invalid_json');}}
  if(pieces.length)blocks.push(pieces.join(''));pieces=[];
  const text=blocks.join('');blocks.length=0;
  lastItemBytes=Buffer.byteLength(text);if(lastItemBytes>max)fail('item_size_limit');
  if(checkpoint)fullSnapshotMemory();
  try{return IdSafeJsonParser.parse(text);}catch{return fail('invalid_json');}
 };
 // Projection metadata is not a fixture. Validate its complete JSON grammar
 // without retaining entire ticket/diagnostic collections beside recovered rows.
 const metadataValue=async(first:string,depth=0):Promise<void>=>{
  if(depth>128)fail('nesting_limit');
  if(first==='['){let token=await take();if(token===']')return;for(;;){await metadataValue(token,depth+1);token=await take();if(token===']')return;if(token!==',')fail('invalid_body_separator');token=await take();}}
  if(first==='{'){let token=await take();if(token==='}')return;for(;;){if(Buffer.byteLength(token)>limit)fail('item_size_limit');let key:unknown;try{key=JSON.parse(token);}catch{fail('invalid_root_key');}if(typeof key!=='string')fail('invalid_root_key');if(await take()!==':')fail('invalid_root_colon');await metadataValue(await take(),depth+1);token=await take();if(token==='}')return;if(token!==',')fail('invalid_root_separator');token=await take();}}
  if(Buffer.byteLength(first)>limit)fail('item_size_limit');
  try{JSON.parse(first);}catch{fail('invalid_json');}
 };
 // A persisted workerCheckpoint is an envelope, not a snapshot fixture.
 // Bound each fixture independently, including legacy embedded regular rows.
 const privateCheckpoint=async(first:string)=>{
  if(first!=='{')fail('invalid_checkpoint_object');
  const result:Record<string,unknown>={},seen=new Set<string>();let next=await take();
  while(next!=='}'){
   let key:unknown;try{key=JSON.parse(next);}catch{fail('invalid_root_key');}
   if(typeof key!=='string'||key.length>64||seen.size>=64||seen.has(key as string))fail('duplicate_or_invalid_root_key');
   seen.add(key as string);if(await take()!==':')fail('invalid_root_colon');const first=await take();
   if(key==='regular'||key==='outright'){
    if(first!=='[')fail('body_not_array');result[key]=[];let token=await take();
    if(token!==']')for(;;){const row=await rawValue(token);await onCheckpointRow?.(row,key==='regular');token=await take();if(token===']')break;if(token!==',')fail('invalid_body_separator');token=await take();}
   }else result[key as string]=await rawValue(first,64*1024);
   next=await take();if(next==='}')break;if(next!==',')fail('invalid_root_separator');next=await take();if(next==='}')fail('trailing_comma');
  }
  return result;
 };
 let header:unknown,body=false;const rootErrors:Record<string,unknown>={};const keys=new Set<string>();
 try{if(await take()!=='{')fail('root_not_object');let next=await take();while(next!=='}'){
  let key:unknown;try{key=JSON.parse(next);}catch{fail('invalid_root_key');}if(typeof key!=='string'||key.length>64||keys.size>=64||keys.has(key))fail('duplicate_or_invalid_root_key');keys.add(key as string);if(await take()!==':')fail('invalid_root_colon');
  let first=await take();if(key===(checkpoint||'Body')){
   body=true;if(first!=='[')fail('body_not_array');first=await take();if(first!==']')for(;;){const row=await rawValue(first);await onRow(row,lastItemBytes);first=await take();if(first===']')break;if(first!==',')fail('invalid_body_separator');first=await take();}
  }else{const value=checkpoint==='events'&&key==='workerCheckpoint'?await privateCheckpoint(first):checkpoint&&key!=='mode'&&key!=='version'?(await metadataValue(first),undefined):await rawValue(first,checkpoint?limit:64*1024);if(key===(checkpoint==='regular'?'version':checkpoint==='events'?'workerCheckpoint':'Header'))header=value;else if(checkpoint||['Errors','errors','Error','error'].includes(key as string))rootErrors[key as string]=value;}
  next=await take();if(next==='}')break;if(next!==',')fail('invalid_root_separator');next=await take();if(next==='}')fail('trailing_comma');
 }if(offset<batch.length||!(await it.next()).done)fail('trailing_json');
 if(checkpoint){if(!body||checkpoint==='regular'&&header!==1||checkpoint==='events'&&rootErrors.mode!=='connected')throw Error('Invalid checkpoint envelope');return {header,mode:rootErrors.mode};}
 const inspection=inspectResponse({...rootErrors,Header:header,Body:[]},'application/json');
 if(!body||!header||typeof header!=='object'||Array.isArray(header)||inspection.applicationErrorFields)fail('invalid_header_or_application_error');
 const code=(header as {HttpStatusCode?:unknown}).HttpStatusCode;if(code!==undefined&&(!Number.isInteger(code)||Number(code)<200||Number(code)>=300))fail('header_status_rejected');
 return header;
 }finally{await it.return?.();}
}
export function convertSnapshotRow(raw:unknown):TradeEvent{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail('row_not_object');
 const r=raw as Record<string,unknown>;
 if(!Number.isSafeInteger(r.FixtureId)||Number(r.FixtureId)<=0||!r.Fixture||typeof r.Fixture!=='object'||Array.isArray(r.Fixture))return fail('invalid_fixture');
 // #217525 captured fixture 20563979 has Markets:null; official SDK preserves
 // null as no supplied market collection. Preserve it (not invented []/prices).
 const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
 const shapeFail=(fieldPath:string,value:unknown):never=>fail('invalid_markets_shape',{fieldPath,actualType:value===null?'null':Array.isArray(value)?'array':typeof value as NonNullable<import('@lsports/contracts').SnapshotValidationInspection['actualType']>,fixtureId:Number(r.FixtureId)});
 if(r.Markets!==undefined&&r.Markets!==null){
  if(!Array.isArray(r.Markets))return shapeFail('Markets',r.Markets);
  for(let i=0;i<r.Markets.length;i++){
   const m=r.Markets[i];if(!object(m))return shapeFail(`Markets[${i}]`,m);
   if(m.Bets!==undefined&&m.Bets!==null){
    if(!Array.isArray(m.Bets))return shapeFail(`Markets[${i}].Bets`,m.Bets);
    for(let j=0;j<m.Bets.length;j++)if(!object(m.Bets[j]))return shapeFail(`Markets[${i}].Bets[${j}]`,m.Bets[j]);
   }
  }
 }
 if(hasInvalidProviderTimestamp(raw))return fail('invalid_timestamp');
 const row=TransformerUtil.transform(normalizeSdkTimestamps(raw),GetEventsResultElement) as TradeEvent;attachTimestampPrecision(raw,row);
 if(row.fixtureId!==r.FixtureId||!row.fixture||row.markets?.some(m=>!Number.isSafeInteger(m.id)||!m.id||m.bets?.some(b=>b.id===undefined||b.id===null||String(b.id).trim()==='')))return fail('sdk_row_mismatch');return row;
}
export type FullSnapshotProgress={stage:'waiting_http'|'download'|'validate'|'apply'|'complete';bytes:number;validatedRows:number;appliedRows:number;lastProgressAt:string;httpStatus?:number;responseHeaderStatusCode?:number;emptyResponse?:boolean};
export async function fullSnapshot(options:{lane?:'prematch'|'inplay';timestamp?:number;url:string;credentials:{packageId:number;username:string;password:string};directory:string;assertOpen:()=>void;apply:(row:TradeEvent,started:number)=>Promise<void>;applyBatch?:(rows:TradeEvent[],started:number)=>Promise<void>;signal?:AbortSignal;progress?:(progress:FullSnapshotProgress)=>void;downloadGate?:(download:()=>Promise<void>)=>Promise<void>;limits?:Partial<typeof FULL_SNAPSHOT_LIMITS>}){
 const lane=options.lane??'prematch';const limits={...FULL_SNAPSHOT_LIMITS,...options.limits};if(!Number.isSafeInteger(limits.memoryWaitMs)||limits.memoryWaitMs<0||limits.memoryWaitMs>60000||!Number.isSafeInteger(limits.memoryRetryMs)||limits.memoryRetryMs<1||limits.memoryRetryMs>1000)throw Error('INVALID_SNAPSHOT_MEMORY_WAIT');fullSnapshotMemory(lane);options.assertOpen();
 const space=await statfs(options.directory);if(Number(space.bavail)*Number(space.bsize)<limits.responseBytes+512*MiB)fail('disk_headroom');
 const dir=await mkdtemp(join(options.directory,'.full-snapshot-'));const file=join(dir,'response.private.json');
 let bytes=0,timedOut=false,httpStatus:number|undefined,responseHeaderStatusCode:number|undefined,emptyResponse:boolean|undefined,validatedRows=0,appliedRows=0;let lastStage:FullSnapshotProgress['stage']='waiting_http';const progress=(stage:FullSnapshotProgress['stage'])=>{lastStage=stage;options.progress?.({stage,bytes,validatedRows,appliedRows,lastProgressAt:new Date().toISOString(),...(httpStatus!==undefined?{httpStatus}:{}),...(responseHeaderStatusCode!==undefined?{responseHeaderStatusCode}:{}),...(emptyResponse!==undefined?{emptyResponse}:{})});};const started=Date.now();const abort=new AbortController(),signal=options.signal?AbortSignal.any([abort.signal,options.signal]):abort.signal;
 const timer=setTimeout(()=>{timedOut=true;abort.abort();},limits.totalMs);timer.unref();
 let pressureWaitMs=0,lastMemoryLog=-Infinity;
 // A complete HTTP download is not an invalid document when live memory dips.
 // Keep exactly this spool and yield outside the state/publication mutex. The
 // unchanged guard must pass before parsing/applying more rows. Budget the total
 // wait across the whole snapshot, rather than restarting the clock per fixture.
 const memoryReady=async()=>{
  for(;;){
   signal.throwIfAborted();options.assertOpen();
   try{fullSnapshotMemory(lane);return;}catch(error){
    if(!(error instanceof OperationError)||error.diagnostic.reason!=='memory_budget_exceeded'||pressureWaitMs>=limits.memoryWaitMs)throw error;
    if(performance.now()-lastMemoryLog>=1000){lastMemoryLog=performance.now();console.info(JSON.stringify({operation:'snapshot.events',lane,status:'memory_wait',stage:lastStage,bytes,validatedRows,appliedRows,waitedMs:Math.ceil(pressureWaitMs),maximumWaitMs:limits.memoryWaitMs,spoolRetained:true,memoryBudgetBytes:error.diagnostic.memoryBudgetBytes,memoryHeadroomBytes:error.diagnostic.memoryHeadroomBytes,snapshotMemory:error.diagnostic.snapshotMemory}));}
    const began=performance.now();await waitTurn(Math.min(limits.memoryRetryMs,limits.memoryWaitMs-pressureWaitMs),undefined,{signal});pressureWaitMs+=performance.now()-began;
   }
  }
 };

 try{
  const url=new URL(lane==='inplay'?'/Inplay/GetEvents':'/Prematch/GetEvents',options.url);if(url.username||url.password||!['http:','https:'].includes(url.protocol))fail('invalid_endpoint');
  if(options.timestamp!==undefined&&(!Number.isSafeInteger(options.timestamp)||options.timestamp<0||options.timestamp>99999999999))throw Error('INVALID_RECOVERY_TIMESTAMP_SECONDS');
  const dto=lane==='inplay'?new GetInPlayEventRequestDto(options.timestamp===undefined?{}:{timestamp:options.timestamp}):new GetEventRequestDto(options.timestamp===undefined?{}:{timestamp:options.timestamp});
  // The SDK does not export its InPlay request class. Serialize the same DTO fields and package credentials it maps before sending GetEvents; response handling remains the bounded SDK-compatible spool parser below.
  const body=JSON.stringify(lane==='inplay'?{...options.credentials,...(options.timestamp===undefined?{}:{timestamp:options.timestamp})}:new Mapper(options.credentials).map(dto,GetEventRequest));
  progress('waiting_http');const download=()=>{progress('download');return new Promise<void>((resolve,reject)=>{
   const req=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method:'POST',signal,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'Accept-Encoding':'gzip, deflate, br'}},res=>{
    httpStatus=res.statusCode;
    if(res.statusCode!==200){res.resume();const status=res.statusCode||0;const retry=res.headers['retry-after'];const seconds=typeof retry==='string'?Number(retry):NaN;const at=typeof retry==='string'?Date.parse(retry):NaN;reject(new OperationError({operation:'snapshot.events',protocol:'http',httpStatus:status,category:status===429?'rate_limited':status===401?'authentication_rejected':'supplier_error',...(status===429?{retryAfterMs:Number.isFinite(seconds)?Math.max(1000,seconds*1000):Number.isFinite(at)?Math.max(1000,at-Date.now()):60000}:{}),message:'HTTP snapshot completo rechazado; cuerpo omitido.'}));return;}
    const encoding=res.headers['content-encoding'];const decompressor=encoding==='gzip'?createGunzip():encoding==='deflate'?createInflate():encoding==='br'?createBrotliDecompress():undefined;
    if(encoding&&encoding!=='identity'&&!decompressor){res.destroy();reject(new OperationError({operation:'snapshot.events',protocol:'http',category:'invalid_response',reason:'invalid_snapshot',snapshotValidation:{phase:'batch',code:'full_document_invalid',detail:'unsupported_content_encoding',attribution:'not_proven'},message:'Content-Encoding no soportado; baseline bloqueado.'}));return;}
    const bound=new Transform({transform(chunk,_enc,cb){bytes+=chunk.length;if(bytes>limits.responseBytes){cb(new OperationError({operation:'snapshot.events',protocol:'http',category:'response_limit',reason:'response_size_limit',responseLimitBytes:limits.responseBytes,message:'Límite finito del spool excedido; baseline bloqueado.'}));return;}cb(null,chunk);}});
    const dest=createWriteStream(file,{flags:'wx',mode:0o600});
    const streams=decompressor?[res,decompressor,bound,dest]:[res,bound,dest];
    pipeline(streams,{signal}).then(resolve,reject);
   });req.setTimeout(limits.idleMs,()=>req.destroy(new Error('Snapshot idle timeout')));req.on('error',reject);req.end(body);
  });};
  await (options.downloadGate?options.downloadGate(download):download());clearTimeout(timer);options.assertOpen();
  // Flush only our downloaded spool; never drop caches globally or touch inbox WAL.
  const downloaded=await open(file,'r');try{await downloaded.sync();}finally{await downloaded.close();}
  progress('validate');await memoryReady();
  const ids=new Set<number>();let rows=0;
  const responseHeader=await walkSnapshot(file,async raw=>{options.assertOpen();const row=convertSnapshotRow(raw);if(ids.has(row.fixtureId)||++rows>limits.fixtures)fail('duplicate_or_excess_fixture');ids.add(row.fixtureId);validatedRows=rows;if(rows%100===0)progress('validate');if(rows%10===0){await memoryReady();await yieldTurn();}},limits.itemBytes);
  if(responseHeader&&typeof responseHeader==='object'&&!Array.isArray(responseHeader)){const code=(responseHeader as Record<string,unknown>).HttpStatusCode;if(Number.isSafeInteger(code)&&Number(code)>=100&&Number(code)<=599)responseHeaderStatusCode=Number(code);}emptyResponse=rows===0;
  // The file stays on disk: never reserve four copies of the entire HTTP body.
  // Conversion is item-bounded; re-check live heap/available headroom before EACH row.
  await memoryReady();
  progress('apply');
  // Envelope (including trailing Header/errors) and ALL rows verified before first application.
  let lastApplyProgress=performance.now(),lastPublishedApplied=0;let pending:TradeEvent[]=[],pendingBytes=0;
  const flush=async()=>{if(!pending.length)return;await memoryReady();const batch=pending;pending=[];pendingBytes=0;
   if(options.applyBatch)await options.applyBatch(batch,started);else for(const row of batch)await options.apply(row,started);
   appliedRows+=batch.length;if(lastPublishedApplied===0||Math.floor(appliedRows/100)>Math.floor(lastPublishedApplied/100)||performance.now()-lastApplyProgress>=5000){lastApplyProgress=performance.now();lastPublishedApplied=appliedRows;progress('apply');}
  };
  await walkSnapshot(file,async(raw,rawBytes)=>{options.assertOpen();await memoryReady();
   // At most 16 fixtures / 2 MiB encoded source per queued job; a large bounded
   // fixture runs alone. Never accumulate an entire document or bypass ordering.
   if(pending.length&&(pending.length>=16||pendingBytes+rawBytes>2*MiB))await flush();
   pending.push(convertSnapshotRow(raw));pendingBytes+=rawBytes;
   if(!options.applyBatch||pending.length>=16||pendingBytes>=2*MiB)await flush();
  },limits.itemBytes);await flush();
  progress('complete');
  return {ids,rows,bytes,startedAt:new Date(started).toISOString(),completedAt:new Date().toISOString()};
 }catch(error){try{progress(lastStage);}catch{/* Progress reporting must not replace the original failure. */}if(timedOut)throw new OperationError({operation:'snapshot.events',protocol:'http',category:'network',reason:'timeout',timeoutMs:limits.totalMs,message:'Tiempo máximo de descarga snapshot excedido; baseline bloqueado.'});if(error instanceof OperationError&&httpStatus!==undefined&&error.diagnostic.httpStatus===undefined)throw new OperationError({...error.diagnostic,httpStatus});throw error;}finally{clearTimeout(timer);abort.abort();await rm(dir,{recursive:true,force:true});}
}

// Run in a fresh offline process: no restored TradeState or projected graph is
// needed to check the complete generated document against the writer's receipt.
export async function verifyProjectionFile(path:string,expected:{sha256:string;bytes:number;rows:number;eventSha256:string}){
 if(!/^[a-f0-9]{64}$/.test(expected.sha256)||!/^[a-f0-9]{64}$/.test(expected.eventSha256)||!Number.isSafeInteger(expected.bytes)||expected.bytes<1||!Number.isSafeInteger(expected.rows)||expected.rows<0)throw Error('projection_receipt_invalid');
 fullSnapshotMemory();
 const hash=createHash('sha256'),events=createHash('sha256');let bytes=0,rows=0;
 for await(const chunk of createReadStream(path,{highWaterMark:64*1024})){hash.update(chunk);bytes+=chunk.length;}
 if(bytes!==expected.bytes||hash.digest('hex')!==expected.sha256)throw Error('projection_readback_digest_mismatch');
 await walkSnapshot(path,async raw=>{
  const event=raw as {id?:unknown;markets?:unknown;selections?:unknown};
  if(typeof event.id!=='string'||!Array.isArray(event.markets)||!Array.isArray(event.selections))throw Error('projection_readback_invalid');
  events.update(JSON.stringify(event)+'\n');rows++;
 },undefined,'events');
 if(events.digest('hex')!==expected.eventSha256)throw Error('projection_readback_content_mismatch');
 if(rows!==expected.rows)throw Error('projection_readback_count_mismatch');
 return {rows,bytes,sha256:expected.sha256,integrityVerified:true};
}
