// Resume the already prepared eight-GiB pipeline repair from its protected
// backup. This path never starts the Mac consumer, repeats image preparation,
// or issues a second shutdown signal.
import {readFileSync,lstatSync,writeFileSync,appendFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

const here=dirname(fileURLToPath(import.meta.url));
const progress=join(homedir(),'Library','Application Support','ADL','Cutover','execution-12811-12809.json');
const report=join(here,`pipeline-resume-${Date.now()}.jsonl`);
const emit=row=>{const line=JSON.stringify(row);console.log(line);appendFileSync(report,line+'\n');};
writeFileSync(report,'',{mode:0o600,flag:'wx'});
try{
 const st=lstatSync(progress);
 if(st.isSymbolicLink()||!st.isFile()||st.uid!==process.getuid()||(st.mode&0o077)!==0||st.size>2*1024**2)throw Error('PROTECTED_PROGRESS_LEDGER_UNVERIFIED');
 const ledger=JSON.parse(readFileSync(progress,'utf8'));
 const prepared=ledger.steps?.throughput_image;
 const backup=prepared?.result?.backup,image=prepared?.result?.image;
 if(prepared?.status!=='ok'||!/^\/var\/backups\/adl-partitioned-upgrade-[A-Za-z0-9_-]+$/.test(backup||'')||!/^adl-worker-partitioned:[0-9a-f]{24}$/.test(image||''))throw Error('PREPARED_PIPELINE_IMAGE_OR_BACKUP_UNVERIFIED');
 const env={...process.env,ADL_RESUME_BACKUP:backup,ADL_FINALIZE_VERIFIED_SHUTDOWN:'1',ADL_LIVE_PERSISTENCE_REPAIR:'1',ADL_PIPELINE_REPAIR:'1',ADL_PIPELINE_MEMORY_EIGHT_GIB:'1',ADL_PUBLICATION_RESERVE_REPAIR:'1'};
 for(const key of ['ADL_CHECKPOINT_REPAIR_BACKUP','ADL_STOPPED_RETENTION_REPAIR','ADL_EXPECTED_LIVE_IMAGE','ADL_LIVE_OOM_REPAIR','ADL_EXPECTED_OOM_PREFIX','ADL_LIVE_V8_HEAP_OOM_REPAIR','ADL_SNAPSHOT_PRESSURE_REPAIR','ADL_TRANSPORT_LIFECYCLE_REPAIR','ADL_CHECKPOINT_BUFFER_REPAIR','ADL_PARTIAL_PREFIX_REPAIR'])delete env[key];
 emit({stage:'resume_pipeline_preflight',status:'verified',image,backup,reusesPreparedImage:true,reusesProtectedBackup:true,workerStarted:false,macConsumerStarted:false,posnetChanged:false});
 const child=spawn(process.execPath,[join(here,'complete-adl-cutover.mjs'),'--pid','12811','--parent','12809','--snapshot-memory-repair'],{env,stdio:['inherit','pipe','inherit']});
 createInterface({input:child.stdout}).on('line',line=>{console.log(line);try{appendFileSync(report,JSON.stringify(JSON.parse(line))+'\n');}catch{}});
 const timer=setInterval(()=>emit({stage:'resume_pipeline',status:'running',report}),20000);
 const code=await new Promise(resolve=>{child.once('error',()=>resolve(2));child.once('close',value=>resolve(value??2));});
 clearInterval(timer);emit({stage:'resume_pipeline_complete',workflowExitCode:code,report,workerRestarted:'check activation record',integrationVerified:false,note:'Use the saved post-cutover feed validation; no success is inferred from worker start.'});process.exitCode=code;
}catch(error){emit({stage:'resume_pipeline_complete',status:'blocked',reason:/^[A-Z0-9_]+$/.test(error.message)?error.message:'PROTECTED_RESUME_FAILED',exceptionType:error.name,report,workerStarted:false,posnetChanged:false});process.exitCode=2;}
