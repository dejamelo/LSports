// Resume only the cleanly stopped preparation identified by the supplied log.
import {spawn} from 'node:child_process';import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {homedir} from 'node:os';import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),report=join(here,'resume-distribution-budget-'+Date.now()+'.jsonl');
writeFileSync(report,'',{mode:0o600,flag:'wx'});const emit=r=>{console.log(JSON.stringify(r));appendFileSync(report,JSON.stringify(r)+'\n');};
let exitCode=2;
try{
 const ledger=JSON.parse(readFileSync(join(homedir(),'Library/Application Support/ADL/Cutover/execution-12811-12809.json'),'utf8'));
 const expected={backup:'/var/backups/adl-partitioned-upgrade-o4uv0zl9',image:'adl-worker-partitioned:78f1104c6e9246c233a7f26b'};
 const prepared=ledger.steps?.throughput_image?.result;
 if(prepared?.backup!==expected.backup||prepared?.image!==expected.image)throw Error('LOCAL_PREPARATION_DIFFERS_NO_ACTION');
 emit({stage:'resume_budget',status:'starting',...expected,oldSpaceMiB:3584,containerMemoryLimitBytes:6442450944,report,note:'Candidate heap budget tied to private evidence. Reuse clean shutdown, prepared image and backup; real-copy rehearsal remains mandatory before activation. No migration, disk expansion or cache cleanup.'});
 const child=spawn(process.execPath,[join(here,'resume-transport-storage.mjs')],{env:{...process.env,ADL_PRESERVED_HEAP_BUDGET_REPAIR:'1'},stdio:['inherit','pipe','pipe']});
 child.stdout.on('data',chunk=>{process.stdout.write(chunk);appendFileSync(report,chunk);});
 const privateLog=report.replace('.jsonl','.private.log');writeFileSync(privateLog,'',{mode:0o600,flag:'wx'});child.stderr.on('data',chunk=>appendFileSync(privateLog,chunk));
 const timer=setInterval(()=>emit({stage:'resume_budget',status:'running',report}),20000);
 try{exitCode=await new Promise(resolve=>{child.once('error',()=>resolve(2));child.once('close',code=>resolve(code??2));});}finally{clearInterval(timer);}
}catch(e){emit({stage:'resume_budget',status:'blocked',reason:e.message==='LOCAL_PREPARATION_DIFFERS_NO_ACTION'?e.message:'LOCAL_RESUME_FAILED',exceptionType:e.name});}
emit({stage:'resume_budget_result',workflowExitCode:exitCode,integrationVerified:false,report,note:'A successful rehearsal is required before start; only real feed validation can establish recovery. Do not observe a stopped worker.'});process.exitCode=exitCode;
