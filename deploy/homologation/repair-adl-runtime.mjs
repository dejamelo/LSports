// Inspect (default) or conditionally repair the known tmpfs defect; never build/stop worker/POSNET.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
async function main(){
 const apply=process.argv.includes('--apply');
 if(process.argv.slice(2).some(a=>a!=='--apply'))throw Error();
 const keys=(await fs.readdir(path.join(os.homedir(),'Downloads'),{withFileTypes:true})).filter(f=>f.isFile()&&/Lottery.*Key\.pem$/.test(f.name));
 if(keys.length!==1)throw Error();
 const common=(await fs.readFile(path.join(HERE,'resume-adl-api.py'),'utf8')).split("if __name__=='__main__':")[0];
 const source=common+'\n'+await fs.readFile(path.join(HERE,'repair-adl-runtime.py'),'utf8');
 const ssh=spawn('ssh',['-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-i',path.join(os.homedir(),'Downloads',keys[0].name),
  'ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n python3 -c '+quote(source)+(apply?' --apply':'')],{stdio:['ignore','inherit','pipe']});
 ssh.stderr.resume();
 const code=await new Promise((resolve,reject)=>{ssh.on('error',reject);ssh.on('close',resolve);});
 if(code!==0)process.exitCode=2;
}
main().catch(()=>{console.error(JSON.stringify({status:'failed',operation:'adl.runtime_repair',note:'SSH/selection failed; no raw errors printed. A requested apply may be partial: preserve state, inspect before retry. Worker/POSNET are never targeted.'}));process.exitCode=2;});
