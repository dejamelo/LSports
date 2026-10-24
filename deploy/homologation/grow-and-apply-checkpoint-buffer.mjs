import {spawn} from 'node:child_process';import {readFileSync,readdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {homedir} from 'node:os';import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),report=join(here,'checkpoint-buffer-workflow-'+Date.now()+'.jsonl');writeFileSync(report,'',{mode:0o600,flag:'wx'});
const emit=r=>{console.log(JSON.stringify(r));appendFileSync(report,JSON.stringify(r)+'\n');};let exitCode=2;
try{
 const keys=readdirSync(join(homedir(),'Downloads')).filter(n=>/Lottery.*Key\.pem$/.test(n));if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE');
 emit({stage:'storage_precondition',status:'checking',report,note:'No EBS API changes; the console expansion must already be visible. Verify pinned root device before growpart/resize2fs; no backup removal or inbox limit change.'});
 const ssh=spawn('ssh',['-i',join(homedir(),'Downloads',keys[0]),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n python3 -'],{stdio:['pipe','pipe','pipe']});
 let ready=false,stderrPresent=false,errorCode;ssh.stdin.on('error',()=>{});ssh.stdin.end(readFileSync(join(here,'grow-checkpoint-storage.py')));
 ssh.stderr.on('data',()=>{stderrPresent=true;});createInterface({input:ssh.stdout}).on('line',line=>{try{const row=JSON.parse(line);emit(row);ready ||= row.stage==='storage_capacity_gate'&&row.status==='verified';}catch{}});
 const pulse=setInterval(()=>emit({stage:'storage_precondition',status:'running',report}),20000);
 const limit=setTimeout(()=>{errorCode='BOUNDED_STORAGE_COMMAND_DEADLINE';ssh.kill('SIGTERM');},180000);
 const status=await new Promise(resolve=>{ssh.once('error',e=>{errorCode=e.code;resolve(2);});ssh.once('close',code=>resolve(code??2));});clearInterval(pulse);clearTimeout(limit);
 if(status!==0||!ready)emit({stage:'storage_precondition',status:'blocked',reason:'STORAGE_NOT_VERIFIED_NO_WORKER_UPDATE',exitCode:status,errorCode,stderrPresent});
 else{
  const child=spawn(process.execPath,[join(here,'apply-checkpoint-buffer-repair.mjs')],{stdio:['inherit','pipe','pipe']});
  child.stdout.on('data',part=>{process.stdout.write(part);appendFileSync(report,part);});const privateLog=report.replace('.jsonl','.private.log');writeFileSync(privateLog,'',{mode:0o600,flag:'wx'});child.stderr.on('data',part=>appendFileSync(privateLog,part));
  const timer=setInterval(()=>emit({stage:'checkpoint_buffer_workflow',status:'running',report}),20000);
  try{exitCode=await new Promise(resolve=>{child.once('error',()=>resolve(2));child.once('close',code=>resolve(code??2));});}finally{clearInterval(timer);}
 }
}catch(e){emit({stage:'checkpoint_buffer_workflow',status:'blocked',reason:e.message==='SSH_KEY_NOT_UNIQUE'?e.message:'LOCAL_WORKFLOW_FAILED',exceptionType:e.name});}
emit({stage:'checkpoint_buffer_workflow_result',workflowExitCode:exitCode,integrationVerified:false,report,note:'No integration claim from activation or raw ACKs. Verify durable retirement, complete snapshots, current market timestamps and selectable odds separately.'});process.exitCode=exitCode;
