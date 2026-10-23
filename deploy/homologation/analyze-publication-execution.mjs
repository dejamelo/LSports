// Analyze existing sanitized execution evidence. No worker/provider actions.
import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,realpath,mkdir,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url));
const ORIGINAL_WRAPPER_SHA256='74c3ff4af023a567988ff1fc80606b5fa27b4479e3758873ae54075ea0ceeb0e';
const MAX_FILE=32*1024*1024;
const token=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,180}$/.test(v)?v:undefined;
export function parseLines(raw){return raw.split('\n').flatMap(line=>{try{const r=JSON.parse(line);return r&&typeof r==='object'&&!Array.isArray(r)?[r]:[];}catch{return[];}});}
function safeFailure(row,depth=0){
 const safe={};
 for(const key of ['operation','stage','status','reason','lastStructuredStage','exceptionType','childProgram'])if(token(row[key]))safe[key]=row[key];
 for(const key of ['exitCode','childExitCode'])if(typeof row[key]==='number')safe[key]=row[key];
 if(depth<3&&row.helperExit&&typeof row.helperExit==='object')safe.helperExit=safeFailure(row.helperExit,depth+1);
 if(typeof row.backup==='string'&&/^\/var\/backups\/adl-partitioned-upgrade-[A-Za-z0-9_-]+$/.test(row.backup))safe.backup=row.backup;
 return safe;
}
const KNOWN_TERMINAL_CODES=new Set(['PIPELINE_PATCH_SCOPE_UNVERIFIED','PUBLICATION_RESERVE_PATCH_SCOPE_UNVERIFIED','PIPELINE_LOAD_ACCEPTANCE_FAILED_NO_STOP','HELPER_EXIT_NONZERO_NO_STRUCTURED_DIAGNOSTIC','PRIVATE_PARTITIONED_UPGRADE_FAILED','API_NOT_HEALTHY','UPGRADE_STOP_OBSERVATION_DEADLINE_NO_MORE_SIGNALS']);
export function terminalErrorSignals(raw){
 const signals=[];
 for(const line of raw.split('\n')){
  const e=/\b(TypeError|ReferenceError|RangeError|SyntaxError|Error):\s*([A-Z][A-Z_0-9]{2,160})?/.exec(line);
  if(e)signals.push({errorType:e[1],knownCode:KNOWN_TERMINAL_CODES.has(e[2])?e[2]:null});
  const frame=/deploy\/homologation\/([A-Za-z0-9_.-]+\.(?:mjs|js|py)):(\d+)(?::(\d+))?/.exec(line);
  if(frame)signals.push({file:frame[1],line:Number(frame[2]),column:frame[3]?Number(frame[3]):null});
 }
 return signals.slice(-16);
}
export function deploymentFailure(rows){
 // The observer can succeed after deployment failed. Do not confuse its status
 // with the child executor's result, or select an old/transient blocked row.
 const boundary=rows.findIndex(r=>r.stage==='post_update_retirement');
 const deployment=boundary<0?rows:rows.slice(0,boundary);
 const failures=deployment.filter(r=>['blocked','failed'].includes(r.status)&&r.stage!=='api_healthy_gate');
 const terminal=deployment.findLast(r=>r.operation==='cutover.resumable'&&['blocked','failed'].includes(r.status))||failures.at(-1);
 const final=rows.findLast(r=>r.stage==='executor_complete');
 return {deploymentExitCode:final?.deploymentExitCode??rows[boundary]?.deploymentExitCode??null,observationExitCode:final?.observationExitCode??null,terminalFailure:terminal?safeFailure(terminal):null,precedingFailureEvidence:failures.slice(-5).map(safeFailure),stageVerified:!!terminal};
}
function safePublication(row){
 const safe=safeFailure(row);
 for(const key of ['atUTC','lastCompletedAt'])if(iso(row[key]))safe[key]=row[key];
 for(const key of ['publicationStage'])if(token(row[key]))safe[key]=row[key];
 for(const key of ['elapsedMs','publicationElapsedMs','writes','lastDurationMs','waitedMs','rows'])if(typeof row[key]==='number')safe[key]=row[key];
 return safe;
}
const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?v:undefined;
export function extractCounters(rows){
 const result=[];let containerId;
 for(const root of rows){
  if(root.stage==='worker_identity'&&/^[a-f0-9]{64}$/.test(root.id||''))containerId=root.id;
  const walk=(r,context={},depth=0)=>{
   if(!r||typeof r!=='object'||depth>18)return;
   const c={...context};
   if(['prematch','inplay'].includes(r.lane))c.lane=r.lane;
   if(iso(r.atUTC))c.observedAtUTC=r.atUTC;
   if(token(r.operation))c.operation=r.operation;
   if(r.session?.id&&token(r.session.id))c.sessionId=r.session.id;
   if(token(r.sessionId))c.sessionId=r.sessionId;
   if(typeof r.processed==='number'){
    result.push({lane:c.lane||'unverified',containerId:containerId??null,sessionId:c.sessionId??null,source:c.operation==='inbox.processing_progress'?'direct_actor':'saved_or_unspecified',operation:c.operation??null,observedAtUTC:c.observedAtUTC??null,metricWindowEndUTC:iso(r.metricWindowEndUTC)??null,processed:r.processed,checkpointed:typeof r.checkpointed==='number'?r.checkpointed:null,backlog:typeof r.backlog==='number'?r.backlog:null,processingBacklog:typeof r.processingBacklog==='number'?r.processingBacklog:null});
   }
   for(const [key,value]of Object.entries(r)){
    const next=['prematch','inplay'].includes(key)?{...c,lane:key}:c;
    if(Array.isArray(value)){for(const item of value)walk(item,next,depth+1);}else if(value&&typeof value==='object')walk(value,next,depth+1);
   }
  };
  walk(root);
 }
 // Wrapper and full JSON often repeat the same observations.
 return [...new Map(result.map(r=>[JSON.stringify(r),r])).values()];
}
export function classifyCounterDrops(samples){
 const previous=new Map(),drops=[];
 for(const current of samples){
  if(current.lane==='unverified')continue;
  const old=previous.get(current.lane);previous.set(current.lane,current);
  if(!old||current.processed>=old.processed)continue;
  let classification='session_or_origin_unverified';
  if(old.containerId&&current.containerId&&old.containerId!==current.containerId)classification='container_changed';
  else if(old.sessionId&&current.sessionId&&old.sessionId!==current.sessionId)classification='session_changed';
  else if(current.source!==old.source)classification='different_metric_origins';
  else if(old.metricWindowEndUTC&&current.metricWindowEndUTC&&Date.parse(current.metricWindowEndUTC)<Date.parse(old.metricWindowEndUTC))classification='older_metric_window';
  else if(old.sessionId&&old.sessionId===current.sessionId)classification='same_session_counter_decrease_requires_investigation';
  drops.push({classification,previous:old,current});
 }
 return drops;
}
async function readPrivateEvidence(file){
 const st=await lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_FILE)throw Error('EVIDENCE_FILE_TYPE_OR_SIZE_UNVERIFIED');
 return readFile(file,'utf8');
}
export async function findExecution(roots){
 const candidates=[];const visited=new Set();
 for(const root of roots){
  let directory;try{directory=await realpath(root);}catch{continue;}
  if(visited.has(directory))continue;visited.add(directory);
  for(const entry of await readdir(directory,{withFileTypes:true})){
   if(!entry.isDirectory()||!/^adl-publication-repair\.[A-Za-z0-9]+$/.test(entry.name))continue;
   const folder=join(directory,entry.name,'deploy','homologation');
   let wrapper;try{wrapper=await readPrivateEvidence(join(folder,'apply-publication-reserve-repair.mjs'));}catch{continue;}
   if(createHash('sha256').update(wrapper).digest('hex')!==ORIGINAL_WRAPPER_SHA256)continue;
   for(const name of await readdir(folder)){
    const match=/^publication-reserve-repair-(\d{13})\.jsonl$/.exec(name);if(!match)continue;
    const file=join(folder,name),rows=parseLines(await readPrivateEvidence(file));const last=rows.at(-1);
    if(last?.stage!=='executor_complete'||last.deploymentExitCode!==2||last.observationExitCode!==0)continue;
    candidates.push({file,folder,rows,startedMs:Number(match[1]),mtimeMs:(await lstat(file)).mtimeMs});
   }
  }
 }
 // Latest completed execution of the exact immutable wrapper and exit tuple
 // reported by the user. This selects reports only, never backup/image/data.
 candidates.sort((a,b)=>b.startedMs-a.startedMs);
 if(!candidates.length)throw Error('COMPLETED_2BD97D2_EXECUTION_REPORT_NOT_FOUND');
 if(candidates[1]?.startedMs===candidates[0].startedMs)throw Error('EXECUTION_REPORT_IDENTITY_AMBIGUOUS');
 return {...candidates[0],matchingCompletedReports:candidates.length};
}
export async function main(){
 const selected=await findExecution([tmpdir(),process.env.TMPDIR||'/tmp','/tmp']);
 const originals=[{file:selected.file,rows:selected.rows}];
 let terminalRaw='';
 try{terminalRaw=await readPrivateEvidence(join(dirname(dirname(selected.folder)),'result.log'));}catch(error){if(error.code!=='ENOENT')throw error;}
 const terminalRows=parseLines(terminalRaw);
 // Recover the FULL observer JSON, not only the last eight lines echoed by its
 // wrapper. Match its timestamp to this execution, not an unrelated old run.
 for(const name of await readdir(selected.folder)){
  const match=/^(?:api-worker-health|session-recovery)-(\d{13})\.json$/.exec(name);if(!match)continue;
  if(Number(match[1])<selected.startedMs||Number(match[1])>selected.mtimeMs+5000)continue;
  const file=join(selected.folder,name),body=JSON.parse(await readPrivateEvidence(file));
  if(Array.isArray(body.rows))originals.push({file,rows:body.rows});
 }
 const rows=originals.flatMap(x=>x.rows);let failure=deploymentFailure(selected.rows);
 if(!failure.stageVerified&&terminalRows.length)failure=deploymentFailure(terminalRows);
 const samples=extractCounters(rows),drops=classifyCounterDrops(samples);
 const identity=rows.findLast(r=>r.stage==='worker_identity'&&/^[0-9a-f]{64}$/.test(r.id||''));
 const lifecycle=rows.filter(r=>r.stage==='recent_lifecycle').map(r=>r.record).filter(Boolean);
 const phases=lifecycle.filter(r=>['file.persist','state.publication_wait','inbox.checkpoint','worker.start','distribution.start','distribution.stop'].includes(r.operation)).map(safePublication);
 const directory=join(homedir(),'Library','Application Support','ADL','Diagnostics','CheckpointWrite-'+Date.now());await mkdir(directory,{recursive:true,mode:0o700});
 // Preserve all existing structured evidence privately, without printing it.
 await writeFile(join(directory,'existing-execution-evidence.json'),JSON.stringify(originals),{mode:0o600,flag:'wx'});
 if(terminalRaw)await writeFile(join(directory,'execution-terminal.private.log'),terminalRaw,{mode:0o600,flag:'wx'});
 const summary={stage:'existing_execution_analysis',selectedReport:selected.file,selection:'exact_2bd97d2_wrapper_completed_exit_2_0_then_latest_execution_timestamp',matchingCompletedReports:selected.matchingCompletedReports,sourceFiles:originals.map(x=>x.file),...failure,terminalErrorSignals:terminalErrorSignals(terminalRaw),workerIdentity:identity?{id:identity.id,imageId:identity.imageId,startedAtUTC:identity.startedAtUTC}:null,counterDrops:drops.slice(-12),counterEvidence:samples.slice(-24),publicationEvidence:phases.slice(-16),writeDurationInterpretation:'elapsedMs/publicationElapsedMs measure entire publication, NOT duration of one writeFile; repeated write stages may be different chunks',reportDirectory:directory};
 await writeFile(join(directory,'analysis.json'),JSON.stringify(summary,null,2),{mode:0o600,flag:'wx'});
 // Print only existing sanitizer-derived metadata. Never raw result.log or payloads.
 console.log(JSON.stringify({...summary,counterEvidence:samples.slice(-6),counterDrops:drops.slice(-3),publicationEvidence:phases.slice(-6)}));
 if(!identity?.id){console.log(JSON.stringify({stage:'checkpoint_write_probe',status:'blocked',reason:'EXECUTION_WORKER_IDENTITY_MISSING_NO_REMOTE_PROBE'}));process.exitCode=2;return;}
 const keys=(await readdir(join(homedir(),'Downloads'))).filter(n=>/Lottery.*Key\.pem$/.test(n));if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE');
 const firstPhase=phases.map(r=>r.atUTC).filter(iso).sort((a,b)=>Date.parse(a)-Date.parse(b))[0];
 const config={expectedId:identity.id,...(firstPhase?{sinceUTC:firstPhase}:{})};
 const source=await readFile(join(here,'checkpoint-write-probe.py'),'utf8');
 const script='PROBE_CONFIG='+JSON.stringify(config)+'\n'+source;
 const child=spawn('ssh',['-i',join(homedir(),'Downloads',keys[0]),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n python3 -'],{stdio:['pipe','pipe','pipe']});
 child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(script);
 let pending='',bytes=0,tooLarge=false;const remote=[];
 const displayRemote=r=>{
 if(r.stage==='checkpoint_file_sample')return {stage:r.stage,sample:r.sample,atUTC:r.atUTC,files:r.files,checkpointDescriptors:r.checkpointDescriptors,processIo:r.processes?.filter(p=>['node','MainThread'].includes(p.executableKind)).map(p=>({pid:p.pid,io:p.io,activeCheckpointIo:p.activeCheckpointIo})),cgroup:r.cgroup};
 if(r.stage==='checkpoint_io_result')return {...r,recentPublicationLogs:r.recentPublicationLogs?.filter(x=>x.status==='ok'||x.status==='error'||x.signals||x.operation==='inbox.checkpoint'||x.operation==='worker.start'||x.operation==='worker.shutdown').slice(-10),publicationLogRecords:r.recentPublicationLogs?.length,wholePublicationsCompletedInLogWindow:r.recentPublicationLogs?.filter(x=>x.operation==='file.persist'&&x.status==='ok').length};
 return r;
};
 child.stdout.on('data',part=>{bytes+=part.length;if(bytes>2*1024**2){tooLarge=true;return;}pending+=part;let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);try{const r=JSON.parse(line);remote.push(r);console.log(JSON.stringify(displayRemote(r)));}catch{}}});
 let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},65000);
 const code=await new Promise(resolve=>{child.once('error',()=>resolve(2));child.once('close',resolve);});clearTimeout(timer);
 await writeFile(join(directory,'checkpoint-write-probe.json'),JSON.stringify({rows:remote,exitCode:code,timedOut,tooLarge},null,2),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({stage:'checkpoint_analysis_complete',reportDirectory:directory,readOnly:true,providerRequests:0,workerRestarted:false,signalsToWorker:0,exitCode:code,integrationVerified:false}));
 process.exitCode=code||timedOut||tooLarge?2:0;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await main();}catch(error){console.log(JSON.stringify({stage:'existing_execution_analysis',status:'blocked',reason:/^[A-Z_0-9]+$/.test(error.message)?error.message:'EVIDENCE_ANALYSIS_FAILED',errorType:error.name,workerMutationRequested:false}));process.exitCode=2;}
}
