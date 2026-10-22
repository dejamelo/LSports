import {readFileSync,readdirSync,writeFileSync,openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assembleRemoteHelper,helperInvocation} from './remote-helper-transport.mjs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const here=dirname(fileURLToPath(import.meta.url));
const keys=readdirSync(join(homedir(),'Downloads'),{withFileTypes:true}).filter(f=>f.isFile()&&/Lottery.*Key\.pem$/.test(f.name));
if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE_OR_AVAILABLE');
const definitions=(await assembleRemoteHelper(here)).replace("if __name__=='__main__':raise SystemExit(cutover_main())",'');
const source=definitions+'\n'+readFileSync(join(here,'recovery-inbox-identity.py'),'utf8');
const invocation=await helperInvocation(here,source,{});
const path=join(here,'recovery-inbox-identity.json'),progressPath=join(here,'recovery-inbox-identity-progress.jsonl');
const fd=openSync(progressPath,'wx',0o600);let lastStage='ssh_connect',bytes=0,stderrPresent=false,interrupted=false,timedOut=false;const rows=[];
function record(row){writeSync(fd,JSON.stringify(row)+'\n');fsyncSync(fd);if(row.stage)lastStage=row.stage;console.log(JSON.stringify(row));}
function savePartial(reason){const result={reason,lastStage,progressPath,workerRestarted:false,signalsToWorker:0};writeFileSync(join(here,'recovery-inbox-identity-partial.json'),JSON.stringify({summary:result,records:rows},null,2),{mode:0o600});return result;}
record({operation:'recovery_inbox_identity_progress',stage:lastStage,progressPath,readOnly:true});
const child=spawn('ssh',['-i',join(homedir(),'Downloads',keys[0].name),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com',invocation.command],{stdio:['pipe','pipe','pipe']});
const timer=setTimeout(()=>{timedOut=true;record(savePartial('COLLECTOR_DEADLINE_ONLY_SSH_TERMINATED'));child.kill('SIGTERM');},60000);
const onInterrupt=()=>{interrupted=true;record(savePartial('USER_INTERRUPTED_COLLECTION'));};process.once('SIGINT',onInterrupt);
child.stderr.on('data',()=>{stderrPresent=true;});child.stdin.on('error',()=>{});child.stdin.end(invocation.input);
const lines=createInterface({input:child.stdout});
lines.on('line',line=>{bytes+=Buffer.byteLength(line);if(bytes>2*1024**2){timedOut=true;record(savePartial('COLLECTOR_OUTPUT_LIMIT'));child.kill('SIGTERM');return;}try{const row=JSON.parse(line);rows.push(row);if(row.operation==='recovery_inbox_identity_progress')record(row);}catch{}});
const outcome=await new Promise(resolve=>{child.once('error',error=>resolve({exitCode:null,spawnCode:error.code}));child.once('close',(code,signal)=>resolve({exitCode:code,signal}));});
clearTimeout(timer);process.removeListener('SIGINT',onInterrupt);
const report=rows.findLast(r=>r.operation==='recovery_inbox_identity'&&r.status!=='blocked');
if(outcome.exitCode!==0||!report||interrupted||timedOut){const summary={...savePartial('INBOX_IDENTITY_COLLECTION_INCOMPLETE'),...outcome,stderrPresent,diagnostic:rows.findLast(r=>r.status==='blocked')};console.error(JSON.stringify(summary));process.exitCode=interrupted?130:2;}
else{writeFileSync(path,JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({reportFile:path,progressPath,workerId:report.workerId,processes:report.processes,sqliteQueriesExecuted:0,checkpointRead:false,workerRestarted:false}));}
fsyncSync(fd);closeSync(fd);
