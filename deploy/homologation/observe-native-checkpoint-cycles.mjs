// Observation only: no cutover executor, provider request, cache or service mutation.
import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';import {readFileSync,readdirSync,writeFileSync,appendFileSync} from 'node:fs';import {homedir} from 'node:os';import {join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),report=join(here,'native-checkpoint-cycles-'+Date.now()+'.jsonl');writeFileSync(report,'',{mode:0o600,flag:'wx'});
const emit=r=>{console.log(JSON.stringify(r));appendFileSync(report,JSON.stringify(r)+'\n');};
const keys=readdirSync(join(homedir(),'Downloads')).filter(n=>/Lottery.*Key\.pem$/.test(n));if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE');
emit({stage:'durable_cycles_connection',status:'connecting_read_only',report,workerMutationRequested:false});
const child=spawn('ssh',['-i',join(homedir(),'Downloads',keys[0]),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n python3 -'],{stdio:['pipe','pipe','pipe']});
child.stdin.on('error',()=>{});child.stdin.end(readFileSync(join(here,'observe-native-checkpoint-cycles.py')));let reason,completed=false,bytes=0;
child.stderr.on('data',part=>{const s=part.toString();if(/permission denied/i.test(s))reason='SSH_AUTHENTICATION_FAILED';else if(/timed out/i.test(s))reason='SSH_TIMEOUT';});
createInterface({input:child.stdout}).on('line',line=>{bytes+=line.length;if(bytes>8*1024**2){reason='OBSERVATION_OUTPUT_LIMIT';child.kill('SIGTERM');return;}try{const r=JSON.parse(line);emit(r);if(r.stage==='durable_cycles_result')completed=true;}catch{}});
const heartbeat=setInterval(()=>console.log(JSON.stringify({stage:'durable_cycles_connection',status:'observing',report,providerRequests:0,workerRestarted:false})),20000);
const deadline=setTimeout(()=>{reason='READ_ONLY_OBSERVATION_DEADLINE';child.kill('SIGTERM');},1200000);
process.once('SIGINT',()=>{reason='LOCAL_OBSERVATION_CANCELLED';child.kill('SIGTERM');});
const code=await new Promise(resolve=>{child.once('error',e=>{reason=e.code;resolve(2);});child.once('close',c=>resolve(c??2));});clearInterval(heartbeat);clearTimeout(deadline);
emit({stage:'durable_cycles_complete',exitCode:code,reason:reason??(!completed?'NO_STRUCTURED_RESULT':undefined),report,readOnly:true,workerRestarted:false,providerRequests:0,integrationVerified:false});process.exitCode=code||(!completed?2:0);
