import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assembleRemoteHelper,helperInvocation} from './remote-helper-transport.mjs';
const here=dirname(fileURLToPath(import.meta.url)),repo=process.env.ADL_REPO_ROOT,ref=process.env.ADL_RUNTIME_REF;
if(!repo||!ref)throw Error('PINNED_REPOSITORY_AND_REF_REQUIRED');
const blob=spawnSync('git',['show',ref+':apps/worker/src/full-snapshot.ts'],{cwd:repo,encoding:'utf8',timeout:10000});if(blob.status!==0)throw Error('CANDIDATE_SOURCE_UNAVAILABLE');
const sha=createHash('sha256').update(blob.stdout).digest('hex');
const keys=readdirSync(join(homedir(),'Downloads'),{withFileTypes:true}).filter(f=>f.isFile()&&/Lottery.*Key\.pem$/.test(f.name));if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE_OR_AVAILABLE');
console.log('Acompanhar somente a tentativa 2026-10-22T13:43:22 UTC; somente leitura, por até 5 minutos.');
const defs=(await assembleRemoteHelper(here)).replace("if __name__=='__main__':raise SystemExit(cutover_main())",'');
const source=defs+'\nPRESSURE_CANDIDATE_SHA = '+JSON.stringify(sha)+'\n'+readFileSync(join(here,'recovery-pressure-report.py'),'utf8').split('try:pressure_main()')[0]+'\n'+readFileSync(join(here,'snapshot-pressure-preflight.py'),'utf8');
const rpc=await helperInvocation(here,source,{});
const expected='2026-10-22T13:43:22',deadline=Date.now()+300000;
const reportFile=join(here,'snapshot-attempt-'+Date.now()+'.json'),samples=[];
while(Date.now()<deadline){
 console.log('Consulta somente leitura: '+new Date().toISOString());
 const probe=spawnSync('ssh',['-i',join(homedir(),'Downloads',keys[0].name),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com',rpc.command],{input:rpc.input,encoding:'utf8',timeout:45000,maxBuffer:1024*1024});
 const rows=(probe.stdout||'').trim().split('\n').flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}}),r=rows.findLast(r=>r.operation==='snapshot_pressure_preflight');
 if(probe.status!==0||!r||r.status==='blocked'){console.log(JSON.stringify(r||{reason:'READ_ONLY_QUERY_FAILED',exitCode:probe.status,spawnCode:probe.error?.code,reportFile}));process.exitCode=2;break;}
 const snapshot=r.snapshot||{},same=String(snapshot.startedAt||'').startsWith(expected);
 const failed=same&&Date.parse(r.lastSnapshotErrorAt)>=Date.parse(snapshot.startedAt)&&Date.parse(r.lastSnapshotErrorAt)>=Date.parse(snapshot.lastProgressAt);
 const result=r.action==='validate_existing_recovery'?'recovered_requires_feed_validation':!same?'attempt_changed_do_not_reuse_previous_error':failed?'current_attempt_failed':'attempt_in_progress';
 samples.push({...r,result,observedAt:new Date().toISOString()});writeFileSync(reportFile,JSON.stringify(samples,null,2),{mode:0o600});
 console.log(JSON.stringify({result,phase:r.phase,snapshot,lastSnapshotAt:r.lastSnapshotAt,lastSnapshotErrorAt:r.lastSnapshotErrorAt,currentFailure:failed?r.diagnostic:undefined,reportFile,workerRestarted:false}));
 if(result!=='attempt_in_progress')break;
 await new Promise(resolve=>setTimeout(resolve,Math.min(15000,Math.max(0,deadline-Date.now()))));
}
if(samples.at(-1)?.result==='attempt_in_progress')console.log(JSON.stringify({result:'observation_window_ended_not_proof_of_stall',reportFile,workerRestarted:false}));
