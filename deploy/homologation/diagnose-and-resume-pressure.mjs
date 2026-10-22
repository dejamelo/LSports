import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
console.log('Etapa: identificar listeners locais na porta exclusiva 43761; nenhum sinal será enviado.');
const probe=spawnSync('/usr/sbin/lsof',['-nP','-t','-iTCP:43761','-sTCP:LISTEN'],{encoding:'utf8',timeout:5000});
if(probe.error||![0,1].includes(probe.status)){console.log(JSON.stringify({reason:'LOCAL_LISTENER_CHECK_FAILED',exitCode:probe.status,code:probe.error?.code}));process.exit(2);}
const pids=[...new Set(probe.stdout.trim().split(/\s+/).filter(x=>/^\d+$/.test(x)))];
const processes=pids.map(pid=>{const r=spawnSync('/bin/ps',['-p',pid,'-o','ppid=,state=,comm='],{encoding:'utf8',timeout:5000});const m=r.stdout.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);return{pid:Number(pid),...(m?{parentPid:Number(m[1]),state:m[2],executable:basename(m[3])}:{identity:'unverified'})};});
const report={operation:'local_executor_preflight',reason:pids.length?'EXECUTOR_ALREADY_RUNNING_OR_PORT_43761_IN_USE':'NO_LOCAL_LISTENER',processes,signalsSent:0,providerRequests:0,workerRestarted:false};
const reportFile=join(here,'local-executor-'+Date.now()+'.json');writeFileSync(reportFile,JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({...report,reportFile}));
if(pids.length)process.exit(2);
const env={...process.env};for(const name of ['ADL_RESUME_BACKUP','ADL_FINALIZE_VERIFIED_SHUTDOWN','ADL_LIVE_OOM_REPAIR','ADL_EXPECTED_OOM_PREFIX'])delete env[name];
Object.assign(env,{ADL_LIVE_PERSISTENCE_REPAIR:'1',ADL_SNAPSHOT_PRESSURE_REPAIR:'1',ADL_EXPECTED_LIVE_IMAGE:'adl-worker-partitioned:184df259e1da7f2d92408106'});
console.log('Etapa: executor com diagnóstico de inicialização corrigido; imagem, backup e ensaio continuam obrigatórios.');
const r=spawnSync(process.execPath,[join(here,'complete-adl-cutover.mjs'),'--pid','12811','--parent','12809','--snapshot-memory-repair'],{env,stdio:'inherit'});process.exitCode=r.status??2;
