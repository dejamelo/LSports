// First administrator only. No image, Compose, data import or worker action.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {isEntrypoint} from './update-adl-api.mjs';
const exec=promisify(execFile),quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const BOOTSTRAP_COMMIT='d6d3d3ae971f44dc828ae3e92eaf51e419a81543';
export async function protectedAccess(directory,email){
 email=email.trim().toLowerCase();
 if(email.length>254||!/^\S+@\S+\.\S+$/.test(email))throw Error('EMAIL_INVALID');
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 const info=await fs.lstat(directory);
 if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid())throw Error('ACCESS_DIRECTORY_REJECTED');
 await fs.chmod(directory,0o700);
 const credentials={email,password:randomBytes(30).toString('base64url')};
 const file=path.join(directory,'aws-admin-'+Date.now()+'-'+randomBytes(4).toString('hex')+'.json');
 await fs.writeFile(file,JSON.stringify(credentials,null,2)+'\n',{flag:'wx',mode:0o600});
 return {file,credentials};
}
async function main(){
 const options=process.argv.slice(2);
 if(options.length!==2||options[0]!=='--repo')throw Error('EXPECTED_EXPLICIT_REPOSITORY');
 const repo=path.resolve(options[1]);
 if(!process.stdin.isTTY)throw Error('INTERACTIVE_TTY_REQUIRED');
 const source=(await exec('git',['show',BOOTSTRAP_COMMIT+':deploy/homologation/update-adl-api.py'],{cwd:repo,maxBuffer:1024*1024})).stdout;
 const keys=(await fs.readdir(path.join(os.homedir(),'Downloads'),{withFileTypes:true})).filter(x=>x.isFile()&&/Lottery.*Key\.pem$/.test(x.name));
 if(keys.length!==1)throw Error('EXACTLY_ONE_SSH_KEY_REQUIRED');
 const rl=createInterface({input:process.stdin,output:process.stdout});let email;
 try{email=await rl.question('Email do primeiro administrador AWS (Enter cancela): ');}finally{rl.close();}
 if(!email.trim()){console.log(JSON.stringify({stage:'administrator_initialization',status:'cancelled',serverChanged:false}));return;}
 const {file,credentials}=await protectedAccess(path.join(os.homedir(),'Library','Application Support','ADL','Access'),email);
 console.log(JSON.stringify({stage:'protected_access_file',status:'saved',protectedFile:file,confirmation:'pending',passwordPrinted:false}));
 const child=spawn('ssh',['-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-i',path.join(os.homedir(),'Downloads',keys[0].name),'ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n python3 -c '+quote(source)+' --bootstrap'],{stdio:['pipe','pipe','pipe']});
 child.stderr.resume();let pending='',confirmed=false;
 child.stdout.on('data',chunk=>{pending+=chunk;let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);try{const result=JSON.parse(line);if(result.stage==='administrator_initialization'){console.log(JSON.stringify(result));if(result.status==='ok')confirmed=true;}}catch{/* never print raw remote output */}}});
 const finished=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
 child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(credentials));
 const code=await finished;
 if(code!==0||!confirmed){console.log(JSON.stringify({stage:'first_access',status:'unconfirmed',protectedFile:file,note:'Keep this file. An existing administrator is never reset. Do not assume a new password was accepted.'}));process.exitCode=2;return;}
 await fs.writeFile(file+'.confirmed.json',JSON.stringify({initialized:true,at:new Date().toISOString(),panel:'https://sportbook.apuestadeportiva.lat/control'})+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({stage:'first_access',status:'ok',protectedFile:file,panel:'https://sportbook.apuestadeportiva.lat/control',passwordPrinted:false,deploymentRepeated:false,workersChanged:false,note:'Read the protected file locally; do not paste it into chat. Change password after login.'}));
}
if(await isEntrypoint(process.argv[1],import.meta.url))try{await main();}catch(e){console.error(JSON.stringify({stage:'administrator_initialization',status:'blocked',reason:/^[A-Z_]+$/.test(e.message)?e.message:'INITIALIZATION_NOT_CONFIRMED',passwordPrinted:false,note:'No deployment or worker action. Preserve any protected access file already reported.'}));process.exitCode=2;}
