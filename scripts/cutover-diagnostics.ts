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
// Inspect the executable and the executed script, never a substring in arbitrary arguments.
export function processMatches(text:string, executableText?:string){
 const executables=new Map((executableText||'').split('\n').flatMap(line=>{const m=line.match(/^\s*(\d+)\s+(.+?)\s*$/);return m?[[Number(m[1]),basename(m[2])] as const]:[];}));
 const rows=text.split('\n').flatMap(line=>{
  const row=line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);if(!row)return [];
  const withState=row[3].match(/^([RSDTtZXIWU][A-Za-z+<NsWTsl-]{0,11})\s+(.+)$/);
  const args=withState?.[2]??row[3],tokens=args.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)?.map(t=>t.replace(/^(?:"(.*)"|'(.*)')$/,'$1$2'))||[];
  return [{pid:Number(row[1]),parentPid:Number(row[2]),state:withState?.[1],args,tokens,exe:executables.get(Number(row[1]))}];
 });
 const mentions=(args:string)=>/apps\/worker(?:\/|\s|$)|scripts\/homologation-worker\.[tj]s|(?:dev|start):worker|@lsports\/worker/.test(args);
 const linkedParents=new Set(rows.filter(r=>mentions(r.args)).map(r=>r.parentPid));
 return rows.flatMap(row=>{
  if(row.state?.startsWith('Z'))return [];
  const suspicious=mentions(row.args)||linkedParents.has(row.pid);
  if(!suspicious)return [];
  const uncertain=()=>[{pid:row.pid,parentPid:row.parentPid,kind:'identity_inconclusive'}];
  const first=basename(row.tokens[0]||'');
  if(executableText!==undefined&&(!row.exe||row.exe!==first))return uncertain();
  // Git can read worker source; it cannot consume AMQP. Require independent comm evidence.
  if(row.exe==='git'&&first==='git')return row.parentPid>1&&!rows.some(r=>r.pid===row.parentPid)?[{pid:row.parentPid,parentPid:0,kind:'identity_inconclusive'}]:[];
  const runtime=row.exe||first;
  if(!['node','nodejs','tsx','ts-node','npm','npx'].includes(runtime))return uncertain();
  let tokens=row.tokens.slice(1);
  const valueFlags=new Set(['--import','--loader','--experimental-loader','--require','-r','--conditions','-C','--env-file','--env-file-if-exists','--tsconfig']);
  while(tokens[0]?.startsWith('-')){
   const flag=tokens.shift()!;
   if(['-e','--eval','-p','--print'].includes(flag)||/^--(?:eval|print)=/.test(flag))return uncertain();
   if(mentions(flag))return uncertain();
   if(valueFlags.has(flag)){if(!tokens.length||mentions(tokens[0]))return uncertain();tokens.shift();}
   else if(!flag.includes('=')&&!['--no-warnings','--enable-source-maps','--trace-warnings','--watch','--watch-preserve-output','--experimental-strip-types'].includes(flag))return uncertain();
  }
  let entry=tokens.shift()||'';
  if(/(?:^|\/)(?:tsx\/dist\/cli\.[cm]?js|node_modules\/\.bin\/tsx)$/.test(entry)){entry=tokens.shift()||'';}
  if(/(?:^|\/)apps\/worker\/(?:src|dist)\/index\.[tj]s$/.test(entry))return [{pid:row.pid,parentPid:row.parentPid,kind:'worker_entrypoint'}];
  if(/(?:^|\/)scripts\/homologation-worker\.[tj]s$/.test(entry))return [{pid:row.pid,parentPid:row.parentPid,kind:'homologation_entrypoint'}];
  if(/(?:^|\/)(?:concurrently\/dist\/bin\/concurrently(?:\.[cm]?js)?|node_modules\/\.bin\/concurrently)$/.test(entry))return row.state?.startsWith('T')?[]:[{pid:row.pid,parentPid:row.parentPid,kind:'worker_supervisor'}];
  if((['npm','npx'].includes(runtime)||/npm-cli\.js$/.test(entry))&&tokens.some(t=>/^(?:dev|start):worker$/.test(t)))return [{pid:row.pid,parentPid:row.parentPid,kind:'worker_supervisor'}];
  const knownTool=/(?:^|\/)deploy\/homologation\/(?:complete-adl-cutover|resumable-adl-cutover)\.mjs$|(?:^|\/)scripts\/(?:audit-aws-cutover|diagnose-cutover)\.ts$/.test(entry);
  if(knownTool)return [];
  return uncertain();
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
export async function diagnoseCutover(options:{state:string;refreshMs:number;now?:number;ps?:()=>Promise<string>;executables?:()=>Promise<string>;alive?:(pid:number)=>string}){
 const now=options.now??Date.now();const state=options.state;const base=basename(state);const folder=dirname(state);
 const blockers:{stage:string;reason:string;item?:string}[]=[];
 const block=(stage:string,reason:string,item?:string)=>blockers.push({stage,reason,...(item?{item}:{})});
 const ps=options.ps??(async()=> (await promisify(execFile)('ps',['-axo','pid=,ppid=,state=,command='],{timeout:5000,maxBuffer:8*1024*1024})).stdout);
 const alive=options.alive??((pid:number)=>{try{process.kill(pid,0);return 'running';}catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH'?'not_running':'unknown';}});
 const executableQuery=options.executables??(options.ps?async()=>undefined:async()=>(await promisify(execFile)('ps',['-axo','pid=,comm='],{timeout:5000,maxBuffer:8*1024*1024})).stdout);
 const [processResult,listResult,checkpointResult,executableResult]=await Promise.allSettled([ps(),readdir(folder),jsonFile(state,256*1024*1024,true),executableQuery()]);
 const executableText=executableResult.status==='fulfilled'?executableResult.value:undefined;
 if(executableResult.status==='rejected')block('processes','PROCESS_EXECUTABLE_QUERY_FAILED');
 let processes:unknown={status:'unverified'};
 if(processResult.status==='fulfilled'){
  const matches=processMatches(processResult.value,executableText);processes={status:'ok',matching:matches.length,matches};
  if(matches.some(m=>m.kind!=='identity_inconclusive'))block('processes','WORKER_PROCESS_PRESENT');
  if(matches.some(m=>m.kind==='identity_inconclusive'))block('processes','PROCESS_IDENTITY_INCONCLUSIVE');
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
   const summary=(lane:string)=>{
    const raw=(present(lane)?lanes[lane]:{}) as Record<string,unknown>;
    const recovery=(raw.recoveryProgress&&typeof raw.recoveryProgress==='object'?raw.recoveryProgress:{}) as Record<string,unknown>;
    const phases=['starting','recovering','connected','error','stopped'];const stages=['snapshot','handoff','waiting_retry','idle'];
    return {phase:typeof raw.phase==='string'&&phases.includes(raw.phase)?raw.phase:'unknown',
     recoveryStage:typeof recovery.stage==='string'&&stages.includes(recovery.stage)?recovery.stage:'unknown',
     regularSnapshotReady:typeof recovery.regularSnapshotReady==='boolean'?recovery.regularSnapshotReady:null};
   };
   checkpoint={status:valid&&value?.mode==='connected'?'ok':'invalid',bytes:read.bytes,mode:valid&&value?.mode==='connected'?'connected':valid&&value?.mode==='demo'?'demo':'other',lanes:{prematch:present('prematch'),inplay:present('inplay')},laneState:{prematch:summary('prematch'),inplay:summary('inplay')}};
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
  workerLockAbsent:lockNames.length===0,matchingWorkerProcesses:processResult.status==='fulfilled'?processMatches(processResult.value,executableText).length:null,
  journalCount:journalNames.length,refreshMs:Number.isFinite(options.refreshMs)?options.refreshMs:null,notBeforeUTC,
  note:'No commands, payloads, credentials or raw errors printed. All locks preserved, including dead owners. No lock reclamation, provider requests or AWS changes.'};
}
