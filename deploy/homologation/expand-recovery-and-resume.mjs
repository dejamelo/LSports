// Mac orchestrator. No credentials or LSports data are copied to stdout.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const here=dirname(fileURLToPath(import.meta.url));
const host='ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com';
const script=readFileSync(join(here,'grow-recovery-ext4.sh'),'utf8');
function ssh(mode){const keys=readdirSync(join(homedir(),'Downloads'),{withFileTypes:true}).filter(f=>f.isFile()&&/Lottery.*Key\.pem$/.test(f.name));if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE_OR_AVAILABLE');const r=spawnSync('ssh',['-i',join(homedir(),'Downloads',keys[0].name),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=15',host,'sudo','-n','bash','-s','--',mode],{input:script,encoding:'utf8',timeout:180000,maxBuffer:1024*1024});if(r.status!==0){process.stdout.write(r.stdout||'');throw Error('SSH_PREFLIGHT_OR_FILESYSTEM_FAILED exit='+r.status+' '+(r.error?.code||'')+'; check SSH key/agent, reachability and sudo; workers unchanged');}return r.stdout;}
function aws(args){const r=spawnSync('aws',['--region','us-east-2',...args,'--output','json','--no-cli-pager'],{encoding:'utf8',timeout:45000,maxBuffer:1024*1024,env:{...process.env,AWS_PAGER:''}});if(r.status!==0)throw Error('AWS_CLI_UNAVAILABLE_OR_ACTION_REFUSED: '+args.slice(0,2).join(' ')+' exit='+r.status+' '+(r.error?.code||''));return JSON.parse(r.stdout);}
try{
 const identity=JSON.parse(ssh('inspect').trim());console.log(JSON.stringify({stage:'verified_target',...identity}));
 writeFileSync(join(here,'ebs-target.json'),JSON.stringify(identity),{mode:0o600});
 if(identity.deviceBytes<64*1024**3){
  console.log('CONSOLE_FALLBACK: EC2 / us-east-2 / Volumes / '+identity.volumeId+'; verify attachment to '+identity.instanceId+'; Modify volume -> 64 GiB; preserve type, IOPS and throughput. Re-run this same command after optimizing/completed. Estimated gp3 storage increment: USD 1.92/month.');
  const v=aws(['ec2','describe-volumes','--volume-ids',identity.volumeId]).Volumes?.[0];
  if(!v||v.VolumeId!==identity.volumeId||v.VolumeType!=='gp3'||!v.Attachments?.some(a=>a.InstanceId===identity.instanceId&&a.State==='attached'))throw Error('EBS_ATTACHMENT_OR_TYPE_UNVERIFIED_NO_MODIFICATION');
  if(v.Size<64){
   const m=aws(['ec2','describe-volumes-modifications','--volume-ids',identity.volumeId]).VolumesModifications?.[0];
   if(['modifying','optimizing'].includes(m?.ModificationState)){if(m.TargetSize<64)throw Error('DIFFERENT_EBS_MODIFICATION_IN_PROGRESS_NO_DUPLICATE_REQUEST');console.log('Existing 64 GiB modification reused');}
   else{aws(['ec2','modify-volume','--volume-id',identity.volumeId,'--size','64']);console.log('EBS expansion requested once: 64 GiB');}
  }
  let ready=false;
  for(let i=0;i<60;i++){
   const m=aws(['ec2','describe-volumes-modifications','--volume-ids',identity.volumeId]).VolumesModifications?.[0];
   console.log(JSON.stringify({stage:'ebs_modification',state:m?.ModificationState,progress:m?.Progress}));
   if(m?.ModificationState==='failed')throw Error('EBS_MODIFICATION_FAILED_NO_FILESYSTEM_CHANGE');
   if(['optimizing','completed'].includes(m?.ModificationState)&&m.TargetSize>=64){ready=true;break;}
   await delay(10000);
  }
  if(!ready)throw Error('EBS_NOT_READY_YET_NO_DUPLICATE_REQUEST; rerun command after optimizing/completed');
 }
 console.log(ssh('grow'));
 const env={...process.env,ADL_LIVE_OOM_REPAIR:'0',ADL_LIVE_PERSISTENCE_REPAIR:'0',ADL_RESUME_BACKUP:'/var/backups/adl-partitioned-upgrade-oqxj48jd',ADL_FINALIZE_VERIFIED_SHUTDOWN:'1'};
 delete env.ADL_EXPECTED_LIVE_IMAGE;
 const result=spawnSync('caffeinate',['-i',process.execPath,join(here,'complete-adl-cutover.mjs'),'--pid','12811','--parent','12809','--snapshot-memory-repair'],{env,stdio:'inherit'});
 process.exitCode=result.status??2;
}catch(error){console.error(error.message);process.exitCode=2;}
