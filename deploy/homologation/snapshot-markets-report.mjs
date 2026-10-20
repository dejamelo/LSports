import fs from'node:fs/promises';import os from'node:os';import path from'node:path';import{fileURLToPath}from'node:url';import{spawn}from'node:child_process';
const here=path.dirname(fileURLToPath(import.meta.url));
try{
 const keys=(await fs.readdir(path.join(os.homedir(),'Downloads'),{withFileTypes:true})).filter(f=>f.isFile()&&/Lottery.*Key\.pem$/.test(f.name));if(keys.length!==1)throw Error('SSH_KEY_NOT_UNIQUE_OR_AVAILABLE');
 const inspector=(await fs.readFile(path.join(here,'snapshot-markets-inspection.mjs'),'utf8')).replace('export function','function');
 const code=inspector+'\n'+await fs.readFile(path.join(here,'snapshot-markets-observer.mjs'),'utf8');
 const python=await fs.readFile(path.join(here,'snapshot-markets-report.py'),'utf8');const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 const args=['-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-i',path.join(os.homedir(),'Downloads',keys[0].name),'ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n python3 -c '+quote(python)];
 const child=spawn('ssh',args,{stdio:['pipe','pipe','pipe']});let buffer='',errors='';
 const heartbeat=setInterval(()=>console.log(JSON.stringify({operation:'snapshot.markets_report',status:'observing_existing_worker',providerRequests:0,workerRestarted:false})),30000);
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stderr.on('data',c=>{if(errors.length<8192)errors+=c;});
 const row=line=>{try{const data=JSON.parse(line);if(['snapshot.markets_report','snapshot.markets_evidence'].includes(data.operation))console.log(JSON.stringify(data));}catch{}};
 child.stdout.on('data',c=>{buffer+=c;if(buffer.length>1024*1024){child.kill('SIGTERM');return;}const rows=buffer.split('\n');buffer=rows.pop();rows.forEach(row);});
 child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({code}));
 child.on('error',()=>{clearInterval(heartbeat);console.log(JSON.stringify({operation:'snapshot.markets_report',status:'blocked',reason:'SSH_START_FAILED'}));process.exitCode=2;});
 child.on('close',exit=>{clearInterval(heartbeat);row(buffer);if(exit!==0){console.log(JSON.stringify({operation:'snapshot.markets_report',status:'blocked',reason:/Permission denied/.test(errors)?'SSH_AUTHENTICATION_FAILED':'SEE_SANITIZED_STAGE',workerRestarted:false}));process.exitCode=2;}});
}catch(e){console.log(JSON.stringify({operation:'snapshot.markets_report',status:'blocked',reason:/^[A-Z_]+$/.test(e.message)?e.message:'LOCAL_CAPTURE_PREPARATION_FAILED'}));process.exitCode=2;}
