// One consolidated diagnostic: always collect independent local AND remote evidence.
// No signals, key transfer, consumer start, configuration writes or provider requests.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const HERE=path.dirname(fileURLToPath(import.meta.url));const root=path.resolve(HERE,'../..');const exec=promisify(execFile);
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
async function collect(action,operation){
 try{
  const {stdout}=await action();const report=JSON.parse(stdout.trim());if(report.operation!==operation||report.readOnly!==true)throw Error();return report;
 }catch(error){
  try{const report=JSON.parse(String(error.stdout||'').trim());if(report.operation===operation&&report.readOnly===true)return report;}catch{}
  return {operation,status:'unverified',readOnly:true,reason:error.killed?'COLLECTION_TIMEOUT':'COLLECTION_START_OR_REPLY_FAILED',note:'No raw stdout/stderr printed; independent collection still runs.'};
 }
}
async function local(pid){return collect(()=>exec(process.execPath,['--import','tsx','--env-file-if-exists=.env','scripts/inspect-complete-cutover.ts','--pid',pid],{cwd:root,maxBuffer:2*1024*1024,timeout:45000}),'cutover.complete_preflight.local');}
async function aws(){
 return collect(async()=>{
  const keys=(await fs.readdir(path.join(os.homedir(),'Downloads'),{withFileTypes:true})).filter(f=>f.isFile()&&/Lottery.*Key\.pem$/.test(f.name));if(keys.length!==1)throw Error();
  const common=(await fs.readFile(path.join(HERE,'resume-adl-api.py'),'utf8')).split("if __name__=='__main__':")[0];
  const source=common+'\n'+await fs.readFile(path.join(HERE,'inspect-cutover-aws.py'),'utf8');
  return exec('ssh',['-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',
   '-i',path.join(os.homedir(),'Downloads',keys[0].name),'ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n python3 -c '+quote(source)],{cwd:root,timeout:90000,maxBuffer:2*1024*1024});
 },'cutover.complete_preflight.aws');
}
async function main(){
 if(process.argv.length!==4||process.argv[2]!=='--pid'||!/^\d+$/.test(process.argv[3]))throw Error();
 const [mac,remote]=await Promise.all([local(process.argv[3]),aws()]);
 console.log(JSON.stringify({operation:'cutover.complete_preflight',status:mac.status==='collected'&&remote.status==='collected'?'collected':'incomplete',readOnly:true,
  mac,aws:remote,workerStarted:false,signalsSent:0,providerRequests:0,readyToStartAWS:false,
  nextStep:'Use this complete report to finalize one safe execution plan; no process or configuration changed.'}));
 if(mac.status!=='collected'||remote.status!=='collected')process.exitCode=2;
}
main().catch(()=>{console.log(JSON.stringify({operation:'cutover.complete_preflight',status:'blocked',readOnly:true,reason:'EXPECTED_EXPLICIT_PID',workerStarted:false,signalsSent:0}));process.exitCode=2;});
