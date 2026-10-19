// Local read-only evidence. No provider imports, locks acquired, signals sent or secrets printed.
import {lstat,readFile,readdir} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {getHeapStatistics} from 'node:v8';
import {cutoverBarrier} from './cutover-policy.js';

export function safeError(error:unknown) {
 const e=error as {code?:unknown;killed?:boolean};
 if(e?.killed)return 'PROCESS_TIMEOUT';
 const allowed=['ENOENT','EACCES','EPERM','EISDIR','ELOOP','ERR_CHILD_PROCESS_STDIO_MAXBUFFER'];
 return typeof e?.code==='string'&&allowed.includes(e.code)?e.code:typeof e?.code==='number'?'PROCESS_EXIT_NONZERO':'UNEXPECTED_ERROR';
}
export function processMatches(text:string){
 return text.split('\n').flatMap(line=>{
  const row=line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);if(!row)return [];
  const args=row[3];
  const kind=/apps\/worker\/src\/index\.[tj]s/.test(args)?'worker_entrypoint':
   /scripts\/homologation-worker\.[tj]s/.test(args)?'homologation_entrypoint':
   /npm run dev:worker/.test(args)?'worker_supervisor':undefined;
  return kind?[{pid:Number(row[1]),parentPid:Number(row[2]),kind}]:[];
 });
}
async function jsonFile(path:string,maxBytes:number,admitMemory=false){
 try{
  const info=await lstat(path);
  if(info.isSymbolicLink()||!info.isFile())return {ok:false,reason:'NOT_REGULAR_FILE',bytes:info.size};
  if(info.size>maxBytes)return {ok:false,reason:'FILE_SIZE_LIMIT',bytes:info.size,limitBytes:maxBytes};
  if(admitMemory){
   const budget=info.size*8+64*1024*1024;
   const heap=Math.max(0,getHeapStatistics().heap_size_limit-process.memoryUsage().heapUsed);
   const headroom=Math.min(heap,process.availableMemory?.()??heap);
   if(budget>headroom)return {ok:false,reason:'DIAGNOSTIC_MEMORY_BUDGET',bytes:info.size,memoryBudgetBytes:budget,memoryHeadroomBytes:headroom};
  }
  try{return {ok:true,bytes:info.size,value:JSON.parse(await readFile(path,'utf8')) as unknown};}
  catch(e){return {ok:false,reason:e instanceof SyntaxError?'INVALID_JSON':safeError(e),bytes:info.size};}
 }catch(e){return {ok:false,reason:safeError(e)};}
}
export async function diagnoseCutover(options:{state:string;refreshMs:number;now?:number;ps?:()=>Promise<string>;alive?:(pid:number)=>string}){
 const now=options.now??Date.now();const state=options.state;const base=basename(state);const folder=dirname(state);
 const blockers:{stage:string;reason:string;item?:string}[]=[];
 const block=(stage:string,reason:string,item?:string)=>blockers.push({stage,reason,...(item?{item}:{})});
 const ps=options.ps??(async()=> (await promisify(execFile)('ps',['-axo','pid=,ppid=,command='],{timeout:5000,maxBuffer:8*1024*1024})).stdout);
 const alive=options.alive??((pid:number)=>{try{process.kill(pid,0);return 'running';}catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH'?'not_running':'unknown';}});
 const [processResult,listResult,checkpointResult]=await Promise.allSettled([ps(),readdir(folder),jsonFile(state,256*1024*1024,true)]);
 let processes:unknown={status:'unverified'};
 if(processResult.status==='fulfilled'){
  const matches=processMatches(processResult.value);processes={status:'ok',matching:matches.length,matches};
  if(matches.length)block('processes','WORKER_PROCESS_PRESENT');
 }else{const reason=safeError(processResult.reason);processes={status:'unverified',reason};block('processes',reason);}
 let names:string[]=[];
 if(listResult.status==='fulfilled')names=listResult.value;
 else block('directory',safeError(listResult.reason));
 const lockNames=names.filter(n=>n===base+'.lock'||n===base+'.lock.reclaim'||n.startsWith(base+'.snapshot-')&&/\.(lock|reclaim)$/.test(n));
 const locks=await Promise.all(lockNames.map(async(name,index)=>{
  const kind=name===base+'.lock'?'worker':name===base+'.lock.reclaim'?'worker_guard':'scheduler';
  const item='lock-'+(index+1);block('locks','LOCK_PRESENT_PRESERVED',item);
  try{
   const file=join(folder,name);const info=await lstat(file);
   if(!info.isFile()||info.isSymbolicLink()||info.size>64)return {item,kind,owner:'unverified',reason:'LOCK_FORMAT_UNVERIFIED',action:'preserved'};
   const raw=(await readFile(file,'utf8')).trim();const pid=/^[1-9]\d{0,9}$/.test(raw)?Number(raw):undefined;
   return {item,kind,ownerPid:pid??null,owner:pid&&Number.isSafeInteger(pid)?alive(pid):'unknown',ageSeconds:Math.max(0,Math.floor((now-info.mtimeMs)/1000)),action:'preserved'};
  }catch(e){return {item,kind,owner:'unverified',reason:safeError(e),action:'preserved'};}
 }));
 const journalNames=names.filter(n=>n.startsWith(base+'.snapshot-')&&/^[a-zA-Z0-9_.-]+\.json$/.test(n));
 const schedules:unknown[]=[];
 const journals=await Promise.all(journalNames.map(async(name,index)=>{
  const item='journal-'+(index+1);const read=await jsonFile(join(folder,name),1024*1024);
  if(!read.ok){block('journals',read.reason!,item);return {item,status:'invalid',reason:read.reason,bytes:read.bytes};}
  const value=read.value as {nextAt?:unknown;due?:unknown;failures?:unknown}|null;
  const object=(v:unknown)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const finite=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  if(!object(value)||!finite(value?.nextAt)||!object(value?.due)||!object(value?.failures)||
     !Object.values(value!.due as object).every(finite)||!Object.values(value!.failures as object).every(finite)){
   block('journals','INVALID_SCHEDULE',item);return {item,status:'invalid',reason:'INVALID_SCHEDULE',bytes:read.bytes};
  }
  schedules.push(value);
  const due=Object.values(value!.due as Record<string,number>);
  const maxDue=Math.max(value!.nextAt as number,...due);
  const deadline=maxDue<=8640000000000000?new Date(maxDue).toISOString():null;
  if(deadline===null)block('journals','INVALID_DEADLINE',item);
  return {item,status:'ok',bytes:read.bytes,operations:due.length,nextAllowedAt:deadline};
 }));
 if(!journalNames.length)block('journals','JOURNALS_MISSING');
 let checkpoint:Record<string,unknown>={status:'unverified'};let connections:unknown;
 if(checkpointResult.status==='fulfilled'){
  const read=checkpointResult.value;
  if(!read.ok){checkpoint={status:'invalid',reason:read.reason,bytes:read.bytes,limitBytes:read.limitBytes,memoryBudgetBytes:read.memoryBudgetBytes,memoryHeadroomBytes:read.memoryHeadroomBytes};block('checkpoint',read.reason!);}
  else{
   const value=read.value as {mode?:unknown;connections?:unknown}|null;
   const valid=value!==null&&typeof value==='object'&&!Array.isArray(value);connections=valid?value.connections:undefined;
   const lanes=connections!==null&&typeof connections==='object'?connections as Record<string,unknown>:{};
   const present=(lane:string)=>lanes[lane]!==null&&typeof lanes[lane]==='object'&&!Array.isArray(lanes[lane]);
   checkpoint={status:valid&&value?.mode==='connected'?'ok':'invalid',bytes:read.bytes,mode:valid&&value?.mode==='connected'?'connected':valid&&value?.mode==='demo'?'demo':'other',lanes:{prematch:present('prematch'),inplay:present('inplay')}};
   if(!valid||value?.mode!=='connected')block('checkpoint','CONNECTED_EVIDENCE_REQUIRED');
   if(!present('prematch')||!present('inplay'))block('checkpoint','LANE_EVIDENCE_MISSING');
  }
 }else block('checkpoint',safeError(checkpointResult.reason));
 let notBeforeUTC:string|undefined;
 if(schedules.length===journalNames.length&&schedules.length&&checkpoint.status==='ok'){
  try{notBeforeUTC=cutoverBarrier(schedules,connections,now,options.refreshMs);}
  catch(e){const message=(e as Error).message;block('cooldown',['COOLDOWN_UNPROVEN','INVALID_SCHEDULE','LANE_EVIDENCE_MISSING','INVALID_COOLDOWN_DATE'].includes(message)?message:'INVALID_COOLDOWN_EVIDENCE');}
 }else if(!Number.isSafeInteger(options.refreshMs)||options.refreshMs<60000)block('cooldown','INVALID_REFRESH_INTERVAL');
 return {operation:'cutover.diagnose',status:blockers.length?'blocked':'ok',readOnly:true,providerRequests:0,workerStarted:false,
  nodeVersion:process.version,capturedAt:new Date(now).toISOString(),blockers,processes,locks,journals,checkpoint,
  workerLockAbsent:lockNames.length===0,matchingWorkerProcesses:processResult.status==='fulfilled'?processMatches(processResult.value).length:null,
  journalCount:journalNames.length,refreshMs:Number.isFinite(options.refreshMs)?options.refreshMs:null,notBeforeUTC,
  note:'No commands, payloads, credentials or raw errors printed. All locks preserved, including dead owners. No lock reclamation, provider requests or AWS changes.'};
}
