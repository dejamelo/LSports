// API/panel only. Upload committed source, never local runtime/.env/demo credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
const HERE=path.dirname(fileURLToPath(import.meta.url)),ROOT=path.resolve(HERE,'../..');
const exec=promisify(execFile),quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
export function productionSource(name){
 return ['package.json','package-lock.json','tsconfig.json'].includes(name) ||
 (/^(apps|packages)\//.test(name)&& !/(^|\/)(node_modules|dist|\.runtime|\.local-synthetic-demo|backups)(\/|$)|(^|\/)\.env|\.test\.|synthetic|\.(sqlite|pem|key|log)(\.|$)/i.test(name)) ||
 ['scripts/bootstrap-platform.ts','scripts/recover-platform-access.ts'].includes(name);
}
async function main(){
 const sha=(await exec('git',['rev-parse','HEAD'],{cwd:ROOT})).stdout.trim();
 if(!/^[a-f0-9]{40}$/.test(sha))throw Error('COMMIT_INVALID');
 if((await exec('git',['status','--porcelain','--untracked-files=no'],{cwd:ROOT})).stdout.trim())throw Error('TRACKED_CHANGES_PRESERVED');
 const keys=(await fs.readdir(path.join(os.homedir(),'Downloads'),{withFileTypes:true})).filter(x=>x.isFile()&&/Lottery.*Key\.pem$/.test(x.name));
 if(keys.length!==1)throw Error('EXACTLY_ONE_SSH_KEY_REQUIRED');
 const source=await fs.readFile(path.join(HERE,'update-adl-api.py'),'utf8');
 const args=['-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-i',path.join(os.homedir(),'Downloads',keys[0].name),'ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com'];
 const lines=[];
 const ssh=spawn('ssh',[...args,'sudo -n python3 -c '+quote(source)+' '+quote(sha)],{stdio:['pipe','pipe','pipe']});
 ssh.stderr.resume();let pending='';
 ssh.stdout.on('data',chunk=>{pending+=chunk;let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);try{const d=JSON.parse(line);lines.push(d);console.log(JSON.stringify(d));}catch{/* no raw SSH output */}}});
 const names=(await exec('git',['ls-tree','-r','--name-only',sha],{cwd:ROOT,maxBuffer:4*1024*1024})).stdout.trim().split('\n').filter(productionSource);
 const archive=spawn('git',['archive','--format=tar',sha,...names],{cwd:ROOT,stdio:['ignore','pipe','pipe']});archive.stderr.resume();
 const exit=p=>new Promise((r,j)=>{p.on('error',j);p.on('close',r);});
 const finished=Promise.all([exit(ssh),exit(archive)]);ssh.stdin.on('error',()=>{});archive.stdout.pipe(ssh.stdin);
 const codes=await finished;
 if(codes.some(c=>c!==0)||!lines.some(l=>l.stage==='complete'&&l.status==='ok'))throw Error('REMOTE_UPDATE_NOT_CONFIRMED');
 const result=lines.findLast(l=>l.stage==='complete');
 const origin='https://sportbook.apuestadeportiva.lat';
 const page=await fetch(origin+'/control',{signal:AbortSignal.timeout(15000)});
 const access=await fetch(origin+'/api/control/status',{signal:AbortSignal.timeout(15000)});
 const accessBody=access.ok?await access.json():{};
 const verified=page.status===200 && access.status===200 && accessBody.financialMode==='simulation';
 console.log(JSON.stringify({stage:'mac_domain_access',status:verified?'ok':'blocked',panelHttpStatus:page.status,apiHttpStatus:access.status,adminAccessVerified:verified,note:verified?'Use existing administrator.': 'Existing Caddy administrative CIDR may reject this Mac network; no access restrictions were changed.'}));
 if(!verified){process.exitCode=2;return;}
 if(result.initializationRequired){
  if(!process.stdin.isTTY){console.log(JSON.stringify({stage:'first_access',status:'initialization_required',action:'Run same executor interactively; existing administrators are never reset.'}));return;}
  const rl=createInterface({input:process.stdin,output:process.stdout});let email;
  try{email=(await rl.question('Sem administrador na AWS. Email do administrador a criar (Enter para deixar pendente): ')).trim();}finally{rl.close();}
  if(!email){console.log(JSON.stringify({stage:'first_access',status:'initialization_pending'}));return;}
  const directory=path.join(os.homedir(),'Library','Application Support','ADL','Access');await fs.mkdir(directory,{recursive:true,mode:0o700});await fs.chmod(directory,0o700);
  const credentials={email,password:randomBytes(30).toString('base64url')};const file=path.join(directory,'aws-admin-'+Date.now()+'.json');await fs.writeFile(file,JSON.stringify(credentials,null,2)+'\n',{mode:0o600,flag:'wx'});
  const init=spawn('ssh',[...args,'sudo -n python3 -c '+quote(source)+' --bootstrap'],{stdio:['pipe','inherit','pipe']});init.stderr.resume();const done=exit(init);init.stdin.end(JSON.stringify(credentials));
  if(await done!==0){console.log(JSON.stringify({stage:'first_access',status:'unconfirmed',protectedFile:file,note:'Do not assume credentials were accepted. Never reset an existing administrator.'}));process.exitCode=2;return;}
  console.log(JSON.stringify({stage:'first_access',status:'ok',protectedFile:file,note:'Read locally, do not paste into chat. Change password in panel after login.'}));
 }
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({operation:'adl.api_update',status:'blocked',reason:/^[A-Z_]+$/.test(e.message)?e.message:'EXECUTION_FAILED_SEE_REMOTE_STAGE',note:'No raw errors/secrets. Preserve private backup and inspect reported rollback; workers are never targeted.'}));process.exitCode=2;});
