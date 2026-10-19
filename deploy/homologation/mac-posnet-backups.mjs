// Mac helper: read-only sizing/probe, or verified private downloads. Never stops services.
import fs from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

process.umask(0o077);
const HERE=path.dirname(fileURLToPath(import.meta.url));
const BASE=path.join(os.homedir(),'Library','Application Support','ADL','Backups','posnet-aws');
const HOST='ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com';
const MiB=1024*1024;
const quote=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
const emit=v=>console.log(JSON.stringify(v));
let stage='prepare';
let serviceMutationRequested=false;

async function main() {
  const action=process.argv[2] || 'preflight';
  if (!['preflight','copy-config','copy-volumes','stop-services','recover-services','validate-services'].includes(action)) throw Error('unsupported_action');
  if (['stop-services','recover-services'].includes(action) && (!process.argv.includes('--approved') || action==='stop-services' && !process.argv.includes('--quiesced'))) throw Error('explicit_window_approval_required');
  await fs.mkdir(BASE,{recursive:true,mode:0o700});
  if ((await fs.lstat(BASE)).isSymbolicLink()) throw Error('destination_is_symlink');
  await fs.chmod(BASE,0o700);
  const actual=await fs.realpath(BASE);
  const repo=await fs.realpath(path.resolve(HERE,'../..'));
  if (actual===repo || actual.startsWith(repo+path.sep)) throw Error('destination_inside_repository');
  const downloads=path.join(os.homedir(),'Downloads');
  const keys=(await fs.readdir(downloads,{withFileTypes:true})).filter(e=>e.isFile() && /Lottery.*Key\.pem$/.test(e.name));
  if (keys.length!==1) throw Error('expected_exactly_one_key');
  const key=path.join(downloads,keys[0].name);
  const sshArgs=['-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','Compression=no','-o','ConnectTimeout=15','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-i',key,HOST];
  const source=await fs.readFile(path.join(HERE,'posnet-backup-transfer-remote.py'),'utf8');
  const command=args=>'sudo -n python3 -c '+quote(source)+' '+args.map(quote).join(' ');
  const start=cmd=>{
    const child=spawn('ssh',[...sshArgs,cmd],{stdio:['ignore','pipe','pipe']});
    child.stderr.resume(); // Do not log raw SSH/sudo/daemon output.
    const exited=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve(code));});
    return {child,exited};
  };
  const json=async args=>{
    const {child,exited}=start(command(args));
    let data='';
    for await (const chunk of child.stdout) {
      data+=chunk;
      if (data.length>2*MiB) {child.kill();throw Error('metadata_limit');}
    }
    if (await exited!==0) throw Error('remote_query_failed');
    const result=JSON.parse(data);
    if (result.status==='failed') throw Error('remote_query_failed');
    return result;
  };
  if (['stop-services','recover-services','validate-services'].includes(action)) {
    stage=action;
    const serviceSource=await fs.readFile(path.join(HERE,'posnet-window-services.py'),'utf8');
    const mode=action==='validate-services'?'validate':action==='stop-services'?'stop':'return';
    const args=mode==='validate'?['validate']:[mode,'--approved',...(mode==='stop'?['--quiesced']:[])];
    serviceMutationRequested=mode!=='validate';
    const {child,exited}=start('sudo -n python3 -c '+quote(serviceSource)+' '+args.map(quote).join(' '));
    let text='';for await (const chunk of child.stdout) {text+=chunk;if(text.length>MiB){child.kill();throw Error('output_limit');}}
    const code=await exited;
    for (const line of text.trim().split('\n').filter(Boolean)) emit(JSON.parse(line));
    if(code!==0)process.exitCode=2;
    return;
  }
  const free=async()=>{const s=await fs.statfs(BASE,{bigint:true});return Number(s.bavail*s.bsize);};
  if (action==='preflight') {
    stage='volume_sizes';
    const remote=await json(['sizes']);
    stage='transfer_probe';
    // Eight MiB synthetic data, not certificates/application data. No remote file written.
    const count=8*MiB;
    const probe='python3 -c '+quote('import sys; sys.stdout.buffer.write(b"x" * '+count+')');
    const begin=performance.now();
    const {child,exited}=start(probe);
    let received=0;
    for await (const chunk of child.stdout) received+=chunk.length;
    if (await exited!==0 || received!==count) throw Error('probe_failed');
    const seconds=(performance.now()-begin)/1000;
    const bps=count/Math.max(seconds,0.001);
    const archiveBytes=remote.volumes.reduce((n,v)=>n+v.archiveEstimateBytes,0);
    const totalBytes=archiveBytes+remote.configBytes;
    const macFree=await free();
    const requiredMac=totalBytes*2+256*MiB;
    const requiredAws=archiveBytes*2+128*MiB;
    // Conservative planning assumptions, not a disk benchmark or performance guarantee.
    const diskLow=archiveBytes*8/(50*MiB),diskHigh=archiveBytes*8/(10*MiB);
    const transferLow=archiveBytes/bps*1.5+12,transferHigh=archiveBytes/bps*3+30;
    const low=12+(diskLow+transferLow)/60,high=30+(diskHigh+transferHigh)/60;
    const result={stage:'preflight',
      capturedAt:new Date().toISOString(),destination:BASE,readOnlyRemote:true,noStopRequested:true,
      ...remote,status:macFree>=requiredMac && remote.awsBackupFreeBytes>=requiredAws?'ok':'insufficient_space',
      macFreeBytes:macFree,macRequiredBytes:requiredMac,awsRequiredBytes:requiredAws,estimatedArchiveBytes:archiveBytes,
      probeBytes:count,probeSeconds:seconds,observedMiBPerSecond:bps/MiB,
      estimatedDowntimeMinutes:{low:Math.ceil(low),high:Math.ceil(high)},suggestedWindowMinutes:Math.max(40,Math.ceil(high/5)*5+5),
      assumptions:'Configuration copied before window; eight I/O passes at assumed 10–50 MiB/s; transfer 1.5–3x probe incl SSH overhead; quiescence 2–5 min, EC2 5–15 min, validation 5–10 min. Probe is a point sample, not a guarantee; no restore test.'};
    await fs.writeFile(path.join(BASE,'preflight-report.json'),JSON.stringify(result,null,2),{mode:0o600});
    emit(result);
    if (result.status!=='ok') process.exitCode=2;
    return;
  }
  stage='source_metadata';
  const kind=action==='copy-config'?'config':'volumes';
  const remotePath=kind==='config'?JSON.parse(await fs.readFile(path.join(BASE,'preflight-report.json'),'utf8')).configBackup:process.argv[3];
  if (!remotePath) throw Error('remote_backup_path_required');
  const metadata=await json(['exports',remotePath,kind]);
  if (await free()<metadata.totalBytes+128*MiB) throw Error('destination_space_insufficient');
  const dest=await fs.mkdtemp(path.join(BASE,kind+'-'));
  await fs.chmod(dest,0o700);
  for (const file of metadata.files) {
    stage='copy_'+kind;
    if (!/^[A-Za-z0-9_.-]+$/.test(file.name)) throw Error('unsafe_file_name');
    const part=path.join(dest,file.name+'.part');
    const {child,exited}=start(command(['read',remotePath,kind,file.name]));
    const hash=createHash('sha256');let bytes=0;
    const verifier=new Transform({transform(chunk,encoding,cb){bytes+=chunk.length;hash.update(chunk);cb(null,chunk);}});
    try {await pipeline(child.stdout,verifier,createWriteStream(part,{flags:'wx',mode:0o600}));}
    catch (e) {child.kill();throw e;}
    if (await exited!==0 || bytes!==file.bytes || hash.digest('hex')!==file.sha256) throw Error('download_hash_mismatch');
    const handle=await fs.open(part,'r+');try{await handle.sync();}finally{await handle.close();}
    const storedHash=createHash('sha256');
    for await (const chunk of createReadStream(part)) storedHash.update(chunk);
    if(storedHash.digest('hex')!==file.sha256)throw Error('stored_file_hash_mismatch');
    await fs.rename(part,path.join(dest,file.name));
  }
  await fs.writeFile(path.join(dest,'transfer-verification.json'),JSON.stringify({verifiedAt:new Date().toISOString(),...metadata,sha256Verified:true},null,2),{flag:'wx',mode:0o600});
  emit({stage:'complete',status:'ok',kind,destination:dest,files:metadata.files.length,bytes:metadata.totalBytes,sha256Verified:true,noStopRequested:true});
}
main().catch(()=>{emit({stage,status:'failed',noStopRequested:!serviceMutationRequested,serviceMutationRequested,reason:'operation_failed_sanitized',action:'Preserve private partial files; check key selection, existing SSH/host-key trust, sudo access, source completion and free space. If a window action was requested, stop/start may be partial; use the approved recovery procedure. Do not disable SSH host-key checks or print private files.'});process.exitCode=2;});
