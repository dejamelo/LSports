import{readFileSync,readdirSync,writeFileSync,appendFileSync}from'node:fs';
import{homedir}from'node:os';import{dirname,join}from'node:path';import{fileURLToPath}from'node:url';import{spawn}from'node:child_process';import{createInterface}from'node:readline';
import{assembleRemoteHelper,helperInvocation,sanitizedHelperExit}from'./remote-helper-transport.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const keys=readdirSync(join(homedir(),'Downloads')).filter(n=>/Lottery.*Key\.pem$/.test(n));if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE');
const defs=(await assembleRemoteHelper(here)).replace("if __name__=='__main__':raise SystemExit(cutover_main())",'');
const memory=readFileSync(join(here,'current-memory-pressure.py'),'utf8').split('try:current_memory_main()')[0];
const source=defs+'\n'+memory+'\n'+readFileSync(join(here,'relieve-current-memory.py'),'utf8');
const rpc=await helperInvocation(here,source,{});const report=join(here,'memory-relief-'+Date.now()+'.jsonl');writeFileSync(report,'',{mode:0o600,flag:'wx'});
console.log('Resultado: '+report+'; ajuste persistente para 6 GiB; verificação Docker/cgroup/Compose; sem limpeza de cache ou reinício.');
const child=spawn('ssh',['-i',join(homedir(),'Downloads',keys[0]),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com',rpc.command],{stdio:['pipe','pipe','pipe']});
let final,blocked,stderr='';child.stdin.on('error',()=>{});child.stdin.end(rpc.input);child.stderr.on('data',b=>{if(stderr.length<65536)stderr+=b;});
createInterface({input:child.stdout}).on('line',line=>{let row;try{row=JSON.parse(line);}catch{return;}appendFileSync(report,JSON.stringify(row)+'\n');console.log(JSON.stringify(row));if(row.operation==='memory_relief_complete')final=row;if(row.status==='blocked')blocked=row;});
const timer=setTimeout(()=>child.kill('SIGTERM'),90000);
const code=await new Promise(resolve=>{child.once('error',()=>resolve(2));child.once('close',c=>resolve(c));});clearTimeout(timer);
if(code!==0||!final){console.log(JSON.stringify({report,helperExit:sanitizedHelperExit({stage:'memory_relief',action:'bounded_live_update',code,stderr,rows:blocked?[blocked]:[]})}));process.exit(2);}
// Observe only bounded metadata after actual relief, before a long stability window.
console.log('Verificando avanço em quatro amostras de 20 segundos; sem consultas ao fornecedor.');
const observe=spawn(process.execPath,[join(here,'collect-current-memory-pressure.mjs')],{stdio:['ignore','pipe','inherit'],env:process.env});let observation;
createInterface({input:observe.stdout}).on('line',line=>{console.log(line);try{const r=JSON.parse(line);if(r.reportFile&&r.rates)observation=JSON.parse(readFileSync(r.reportFile,'utf8'));}catch{}});
const observedCode=await new Promise(resolve=>{observe.once('error',()=>resolve(2));observe.once('close',c=>resolve(c??2));});
if(observedCode!==0||!observation||observation.workerId!==final.containerId){console.log(JSON.stringify({reason:'POST_RELIEF_OBSERVATION_FAILED_NO_RESTART',report}));process.exit(2);}
const a=observation.samples[0].lanes.prematch,b=observation.samples.at(-1).lanes.prematch;
const advancedInWindow=['validatedRows','appliedRows'].some(k=>(b.snapshot?.[k]??0)>(a.snapshot?.[k]??0))||b.lastSnapshotAt&&b.lastSnapshotAt!==a.lastSnapshotAt;
const snapshotProgressAt=Date.parse(b.snapshot?.lastProgressAt??b.lastSnapshotAt??'');
const advanced=advancedInWindow&&snapshotProgressAt>=Date.parse(final.appliedAtUTC);
const rates=observation.rates.prematch;
if(!advanced&&!(rates.comparableMetricWindows&&rates.processedPerSecond>rates.receivedPerSecond)){
 console.log(JSON.stringify({reason:'POST_RELIEF_SNAPSHOT_OR_SUSTAINED_DRAIN_NOT_YET_VERIFIED',report,snapshotBefore:a.snapshot,snapshotAfter:b.snapshot,diagnostic:b.diagnostic,rates,workerRestarted:false,integrationVerified:false}));process.exit(2);
}
// Existing verifier checks current snapshots, durable processing, fresh prices and both lanes;
// it does not deploy, signal or start a worker. It preserves the existing progress ledger.
console.log('Memória efetivamente disponível confirmada. Retomando somente validação existente; progresso a cada amostra, ACK não equivale a processamento.');
const validation=spawn(process.execPath,[join(here,'complete-adl-cutover.mjs'),'--pid','12811','--parent','12809','--feed-validation-resume'],{stdio:'inherit',env:{...process.env,ADL_EXPECTED_WORKER_ID:final.containerId}});
process.exitCode=await new Promise(resolve=>{validation.once('error',()=>resolve(2));validation.once('close',c=>resolve(c??2));});
