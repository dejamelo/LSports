/** Ordinary vendor HTTP JSON, streamed to a private bounded disk spool, NOT a new vendor streaming API.
 * Validate the entire envelope before applying any rows. Replay one SDK-converted fixture at a time.
 */
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdtemp,rm,statfs} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGunzip,createInflate,createBrotliDecompress} from 'node:zlib';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {Mapper,GetEventRequestDto,GetEventRequest,GetEventsResultElement,TransformerUtil,IdSafeJsonParser} from 'trade360-nodejs-sdk';
import {OperationError} from './diagnostics.js';
import {snapshotCapacity} from './snapshot-capacity.js';
import {normalizeSdkTimestamps,attachTimestampPrecision,hasInvalidProviderTimestamp} from './timestamp-contract.js';
import {inspectResponse} from './response-inspection.js';
import type {TradeEvent} from './state.js';
const MiB=1024*1024;
export const FULL_SNAPSHOT_LIMITS={responseBytes:2*1024*MiB,itemBytes:16*MiB,fixtures:50000,idleMs:20000,totalMs:120000};
const fail=(reason:string):never=>{throw new OperationError({operation:'snapshot.events',protocol:'http',category:'invalid_response',reason:'invalid_snapshot',snapshotValidation:{phase:'batch',code:'full_document_invalid',detail:reason,attribution:'not_proven'},message:'Snapshot completo rechazado: '+reason+'. No se publica baseline incompleto.'});};
export function fullSnapshotMemory(retainedBudget=0){const c=snapshotCapacity({...process.env,LSPORTS_PREMATCH_SNAPSHOT_MAX_RESPONSE_MB:'32'},undefined,'prematch');if(!c.allowed||c.headroomBytes<retainedBudget)throw new OperationError({operation:'snapshot.events',protocol:'local',category:'response_limit',reason:'memory_budget_exceeded',deferred:true,memoryBudgetBytes:Math.max(c.budgetBytes,retainedBudget),memoryHeadroomBytes:c.headroomBytes,responseLimitBytes:FULL_SNAPSHOT_LIMITS.itemBytes,message:'Margen insuficiente para conversión/persistencia incremental; recuperación pendiente.'});}
// Tokens bounded independently of the full document. Strings are never interpreted as structure.
async function* tokens(file:string,max:number){let primitive='',quoted=false,escape=false,parts:string[]=[],size=0;
 for await(const chunk of createReadStream(file,{encoding:'utf8',highWaterMark:64*1024})){
  let start=quoted?0:-1;
  for(let i=0;i<chunk.length;i++){const ch=chunk[i];
   if(quoted){if(size+i-start+1>max)fail('token_size_limit');if(escape)escape=false;else if(ch==='\\')escape=true;else if(ch==='"'){parts.push(chunk.slice(start,i+1));yield parts.join('');parts=[];size=0;quoted=false;start=-1;}}
   else if(ch==='"'){if(primitive)fail('invalid_json');quoted=true;start=i;}
   else if(ch===' '||ch==='\n'||ch==='\r'||ch==='\t'||'{}[],:'.includes(ch)){if(primitive){yield primitive;primitive='';}if('{}[],:'.includes(ch))yield ch;}
   else{primitive+=ch;if(primitive.length>max)fail('token_size_limit');}
  }
  if(quoted){const part=chunk.slice(start);parts.push(part);size+=part.length;}await yieldTurn();
 }if(quoted)fail('truncated_string');if(primitive)yield primitive;
}
export async function walkSnapshot(file:string,onRow:(raw:unknown)=>Promise<void>,limit=FULL_SNAPSHOT_LIMITS.itemBytes){
 const it=tokens(file,limit)[Symbol.asyncIterator]();
 const take=async()=>{const n=await it.next();if(n.done)fail('truncated_json');return n.value;};
 const rawValue=async(first:string,max=limit)=>{let n=first.length;const pieces=[first];let depth=first==='{'||first==='['?1:0;while(depth){const t=await take();n+=t.length;if(n>max)fail('item_size_limit');pieces.push(t);if(t==='{'||t==='[')depth++;if(t==='}'||t===']')depth--;if(depth>128)fail('nesting_limit');if(depth<0)fail('invalid_json');}try{const text=pieces.join('');if(Buffer.byteLength(text)>max)fail('item_size_limit');return IdSafeJsonParser.parse(text);}catch{return fail('invalid_json');}};
 let header:unknown,body=false;const rootErrors:Record<string,unknown>={};const keys=new Set<string>();
 try{if(await take()!=='{')fail('root_not_object');let next=await take();while(next!=='}'){
  let key:unknown;try{key=JSON.parse(next);}catch{fail('invalid_root_key');}if(typeof key!=='string'||key.length>64||keys.size>=64||keys.has(key))fail('duplicate_or_invalid_root_key');keys.add(key as string);if(await take()!==':')fail('invalid_root_colon');
  let first=await take();if(key==='Body'){
   body=true;if(first!=='[')fail('body_not_array');first=await take();if(first!==']')for(;;){await onRow(await rawValue(first));first=await take();if(first===']')break;if(first!==',')fail('invalid_body_separator');first=await take();}
  }else{const value=await rawValue(first,64*1024);if(key==='Header')header=value;else if(['Errors','errors','Error','error'].includes(key as string))rootErrors[key as string]=value;}
  next=await take();if(next==='}')break;if(next!==',')fail('invalid_root_separator');next=await take();if(next==='}')fail('trailing_comma');
 }if(!(await it.next()).done)fail('trailing_json');
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
 if(r.Markets!==undefined&&(!Array.isArray(r.Markets)||r.Markets.some(m=>!m||typeof m!=='object'||Array.isArray(m)||(m.Bets!==undefined&&!Array.isArray(m.Bets)))))return fail('invalid_markets_shape');
 if(hasInvalidProviderTimestamp(raw))return fail('invalid_timestamp');
 const row=TransformerUtil.transform(normalizeSdkTimestamps(raw),GetEventsResultElement) as TradeEvent;attachTimestampPrecision(raw,row);
 if(row.fixtureId!==r.FixtureId||!row.fixture||row.markets?.some(m=>!Number.isSafeInteger(m.id)||!m.id||m.bets?.some(b=>b.id===undefined||b.id===null||String(b.id).trim()==='')))return fail('sdk_row_mismatch');return row;
}
export async function fullSnapshot(options:{url:string;credentials:{packageId:number;username:string;password:string};directory:string;assertOpen:()=>void;apply:(row:TradeEvent,started:number)=>Promise<void>;signal?:AbortSignal;limits?:Partial<typeof FULL_SNAPSHOT_LIMITS>}){
 const limits={...FULL_SNAPSHOT_LIMITS,...options.limits};fullSnapshotMemory();options.assertOpen();
 const space=await statfs(options.directory);if(Number(space.bavail)*Number(space.bsize)<limits.responseBytes+512*MiB)fail('disk_headroom');
 const dir=await mkdtemp(join(options.directory,'.full-snapshot-'));const file=join(dir,'response.private.json');
 let bytes=0,timedOut=false,httpStatus:number|undefined;const started=Date.now();const abort=new AbortController(),signal=options.signal?AbortSignal.any([abort.signal,options.signal]):abort.signal;
 const timer=setTimeout(()=>{timedOut=true;abort.abort();},limits.totalMs);timer.unref();
 try{
  const url=new URL('/Prematch/GetEvents',options.url);if(url.username||url.password||!['http:','https:'].includes(url.protocol))fail('invalid_endpoint');
  const body=JSON.stringify(new Mapper(options.credentials).map(new GetEventRequestDto({}),GetEventRequest));
  await new Promise<void>((resolve,reject)=>{
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
  });clearTimeout(timer);options.assertOpen();
  const ids=new Set<number>();let rows=0;
  await walkSnapshot(file,async raw=>{options.assertOpen();const row=convertSnapshotRow(raw);if(ids.has(row.fixtureId)||++rows>limits.fixtures)fail('duplicate_or_excess_fixture');ids.add(row.fixtureId);if(rows%10===0){fullSnapshotMemory();await yieldTurn();}},limits.itemBytes);
  fullSnapshotMemory(bytes*4+128*MiB);
  // Envelope (including trailing Header/errors) and ALL rows verified before first application.
  await walkSnapshot(file,async raw=>{options.assertOpen();fullSnapshotMemory();await options.apply(convertSnapshotRow(raw),started);},limits.itemBytes);
  return {ids,rows,bytes,startedAt:new Date(started).toISOString(),completedAt:new Date().toISOString()};
 }catch(error){if(timedOut)throw new OperationError({operation:'snapshot.events',protocol:'http',category:'network',reason:'timeout',timeoutMs:limits.totalMs,message:'Tiempo máximo de descarga snapshot excedido; baseline bloqueado.'});if(error instanceof OperationError&&httpStatus!==undefined&&error.diagnostic.httpStatus===undefined)throw new OperationError({...error.diagnostic,httpStatus});throw error;}finally{clearTimeout(timer);abort.abort();await rm(dir,{recursive:true,force:true});}
}
