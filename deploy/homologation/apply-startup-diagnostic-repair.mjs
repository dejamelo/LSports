// One guarded diagnostic activation. No generic second collection or extra restart.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {writeFileSync,appendFileSync} from 'node:fs';
import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),report=join(here,'startup-diagnostic-repair-'+Date.now()+'.jsonl');writeFileSync(report,'',{mode:0o600,flag:'wx'});
const emit=row=>{console.log(JSON.stringify(row));appendFileSync(report,JSON.stringify(row)+'\n');};
let activated=false,latestFailure,retirement;
emit({stage:'startup_diagnostic_activation',status:'starting',report,note:'Historical exception text was not preserved. Activate only stage/type/code diagnostics through the existing backup, copy-recovery and source-scope gates.'});
const child=spawn(process.execPath,[join(here,'apply-transport-cleanup-repair.mjs')],{stdio:['inherit','pipe','inherit']});
createInterface({input:child.stdout}).on('line',line=>{console.log(line);try{const row=JSON.parse(line);appendFileSync(report,JSON.stringify(row)+'\n');if(row.applicationActivated===true)activated=true;const record=row.record||row;if(record.operation==='inbox.actor_failure'&&record.lane==='prematch')latestFailure=record;if(row.stage==='inbox_retirement_result'&&row.lane==='prematch')retirement=row;}catch{}});
const code=await new Promise(resolve=>{child.once('error',()=>resolve(2));child.once('close',c=>resolve(c??2));});
emit({stage:'startup_diagnostic_result',workflowExitCode:code,applicationActivated:activated,preMatchStartupFailure:latestFailure??null,preMatchRetirement:retirement??null,report,historicalExceptionRecovered:false,integrationVerified:false,note:'Only the recorded stage/type/code can establish the next correction. A failed activation is not permission to restart again.'});process.exitCode=code;
