// Console performs the EBS modification; this verifies identity before any filesystem growth.
import {spawnSync} from 'node:child_process';import {readFileSync,readdirSync} from 'node:fs';
import {dirname,join} from 'node:path';import {homedir} from 'node:os';import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const keys=readdirSync(join(homedir(),'Downloads'),{withFileTypes:true}).filter(f=>f.isFile()&&/Lottery.*Key\.pem$/.test(f.name));if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE_OR_AVAILABLE');
console.log('Etapa: verificar EBS de 120 GiB, instância e filesystem; ampliar somente partição/ext4, sem sinais ou operações Docker.');
const result=spawnSync('ssh',['-i',join(homedir(),'Downloads',keys[0].name),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n bash -s -- grow'],{input:readFileSync(join(here,'grow-current-recovery-120.sh')),stdio:['pipe','inherit','inherit'],timeout:180000});
if(result.status!==0){console.log(JSON.stringify({stage:'filesystem_growth',status:'blocked',exitCode:result.status,code:result.error?.code,workerStarted:false}));process.exit(result.status??2);}
console.log('Etapa: retomar recibo e imagem preparados no backup _o9ovt74; finalização anterior será reutilizada.');
const env={...process.env,ADL_LIVE_PERSISTENCE_REPAIR:'1',ADL_PIPELINE_REPAIR:'1',ADL_RESUME_BACKUP:'/var/backups/adl-partitioned-upgrade-_o9ovt74',ADL_FINALIZE_VERIFIED_SHUTDOWN:'1'};
for(const key of ['ADL_EXPECTED_LIVE_IMAGE','ADL_SNAPSHOT_PRESSURE_REPAIR','ADL_CHECKPOINT_REPAIR_BACKUP'])delete env[key];delete env.ADL_LIVE_OOM_REPAIR;delete env.ADL_EXPECTED_OOM_PREFIX;
const r=spawnSync(process.execPath,[join(here,'complete-adl-cutover.mjs'),'--pid','12811','--parent','12809','--snapshot-memory-repair'],{env,stdio:'inherit'});process.exitCode=r.status??2;
