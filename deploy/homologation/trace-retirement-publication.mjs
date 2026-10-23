import {spawnSync} from 'node:child_process';
import {readFileSync,readdirSync,lstatSync,writeFileSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const names=new Set(['expand-prepared-transport-1792761499221.json','expand-prepared-transport-1792761499221.jsonl','api-worker-health-1792763403728.json']);
const found=[];let scanned=0;
function walk(root,depth){if(depth<0||scanned>16000)return;let entries;try{entries=readdirSync(root,{withFileTypes:true});}catch{return;}for(const e of entries){if(++scanned>16000)return;const p=join(root,e.name);if(e.isSymbolicLink())continue;if(e.isFile()&&names.has(e.name)){const st=lstatSync(p);if(st.size<=32*1024**2){const raw=readFileSync(p,'utf8');let rows;try{const v=JSON.parse(raw);rows=Array.isArray(v)?v:v.rows||[v];}catch{rows=raw.split('\n').flatMap(l=>{try{return[JSON.parse(l)];}catch{return[];}});}found.push({path:p,rows});}}else if(e.isDirectory()&&depth&&(!['node_modules','.git'].includes(e.name)))walk(p,depth-1);}}
walk(join(homedir(),'Downloads'),1);walk(join(homedir(),'Library/Application Support/ADL/Cutover'),0);
for(const root of [tmpdir(),'/tmp']){let dirs=[];try{dirs=readdirSync(root,{withFileTypes:true});}catch{}for(const d of dirs)if(d.isDirectory()&&d.name.startsWith('adl-'))walk(join(root,d.name),3);}
const keys=readdirSync(join(homedir(),'Downloads')).filter(n=>/Lottery.*Key\.pem$/.test(n));
if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE');
console.log(JSON.stringify({stage:'targeted_retirement_trace',status:'reading_existing_reports_and_current_logs',existingReports:found.map(r=>r.path),workerMutationRequested:false}));
const r=spawnSync('ssh',['-i',join(homedir(),'Downloads',keys[0]),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n python3 -'],{input:readFileSync(join(here,'trace-retirement-publication.py')),encoding:'utf8',timeout:75000,maxBuffer:4*1024**2});
const remote=(r.stdout||'').split('\n').flatMap(l=>{try{return[JSON.parse(l)];}catch{return[];}});
const report=join(here,'retirement-publication-trace-'+Date.now()+'.json');
writeFileSync(report,JSON.stringify({existingReports:found,remote,sshExitCode:r.status,errorCode:r.error?.code,readOnly:true},null,2),{mode:0o600,flag:'wx'});
const trace=remote.find(x=>x.stage==='retirement_publication_trace');
console.log(JSON.stringify({stage:'targeted_retirement_trace',status:r.status===0?'collected':'blocked',report,worker:trace?.worker,actors:trace?.currentActorSamples,lastCompletedPublications:trace?.lastCompletedPublications,reason:trace?.reason||r.error?.code,sshExitCode:r.status,providerRequests:0,signalsSent:0,workerRestarted:false,integrationVerified:false}));
process.exitCode=r.status??2;
