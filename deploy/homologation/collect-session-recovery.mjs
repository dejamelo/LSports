import {spawn} from 'node:child_process';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const keys=readdirSync(join(homedir(),'Downloads')).filter(n=>/Lottery.*Key\.pem$/.test(n));
if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE');
const api=process.argv.includes('--api-health'),drain=process.argv.includes('--drain');
const scripts=[...(api?['api-worker-health-diagnostic.py']:[]),'session-recovery-diagnostic.py',...(drain?['inbox-retirement-diagnostic.py']:[])];
const input=Buffer.concat(scripts.flatMap(name=>[readFileSync(join(here,name)),Buffer.from('\n')]));
const child=spawn('ssh',['-i',join(homedir(),'Downloads',keys[0]),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n python3 -'],{stdio:['pipe','pipe','pipe']});
const rows=[];let pending='',bytes=0,overflow=false,errorCode;
child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(input);
child.stdout.on('data',part=>{
 bytes+=part.length;if(bytes>1024**2){overflow=true;return;}
 pending+=part;let end;
 while((end=pending.indexOf('\n'))>=0){
  const line=pending.slice(0,end);pending=pending.slice(end+1);
  try{const row=JSON.parse(line);rows.push(row);if(row.stage!=='recent_lifecycle')console.log(JSON.stringify(row));}catch{}
 }
});
const heartbeat=setInterval(()=>console.log(JSON.stringify({stage:'read_only_observation',status:'running',providerRequests:0,workerRestarted:false})),20000);
const timeout=setTimeout(()=>{errorCode='READ_ONLY_SSH_DEADLINE';child.kill('SIGTERM');},240000);
const code=await new Promise(resolve=>{child.on('error',e=>{errorCode=e.code;resolve(2);});child.on('close',resolve);});
clearInterval(heartbeat);clearTimeout(timeout);
const report=join(here,(api?'api-worker-health-':'session-recovery-')+Date.now()+'.json');
const exitCode=overflow||errorCode?2:code??2;
writeFileSync(report,JSON.stringify({rows,exitCode,readOnly:true,signalsSent:0,providerRequests:0,collectorError:errorCode,outputLimitExceeded:overflow},null,2),{mode:0o600,flag:'wx'});
for(const row of rows.filter(r=>r.stage==='recent_lifecycle').slice(-8))console.log(JSON.stringify(row));
console.log('Relatório: '+report);
if(exitCode!==0)console.log(JSON.stringify({status:'blocked',reason:errorCode||'READ_ONLY_SSH_INSPECTION_FAILED',exitCode}));
process.exitCode=exitCode;
