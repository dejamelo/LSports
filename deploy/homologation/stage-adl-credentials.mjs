// Read only the known provider secrets from the Mac .env; encrypted stdin transfer, never argv/log.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {parseEnv} from 'node:util';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
async function main(){
 if(process.argv.length!==2)throw Error();
 const location=path.resolve(HERE,'../..','.env');
 const stat=await fs.lstat(location);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error();
 const input=parseEnv(await fs.readFile(location,'utf8'));const payload={};
 for(const lane of ['PREMATCH','INPLAY'])for(const kind of ['USERNAME','PASSWORD','MQ_USERNAME','MQ_PASSWORD']){
  const key=`LSPORTS_${lane}_${kind}`;if(input[key]!==undefined)payload[key]=input[key];
 }
 for(const lane of ['PREMATCH','INPLAY'])for(const kind of ['USERNAME','PASSWORD'])if(!payload[`LSPORTS_${lane}_${kind}`])throw Error();
 for(const value of Object.values(payload))if(/[\r\n\0]/.test(value)||value.length>4096)throw Error();
 const keys=(await fs.readdir(path.join(os.homedir(),'Downloads'),{withFileTypes:true})).filter(f=>f.isFile()&&/Lottery.*Key\.pem$/.test(f.name));
 if(keys.length!==1)throw Error();
 const common=(await fs.readFile(path.join(HERE,'resume-adl-api.py'),'utf8')).split("if __name__=='__main__':")[0];
 const source=common+'\n'+await fs.readFile(path.join(HERE,'stage-adl-credentials.py'),'utf8');
 const child=spawn('ssh',['-o','BatchMode=yes','-o','IdentitiesOnly=yes','-i',path.join(os.homedir(),'Downloads',keys[0].name),
  'ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n python3 -c '+quote(source)],{stdio:['pipe','inherit','pipe']});
 child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(payload));
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
 if(code!==0)process.exitCode=2;
}
main().catch(()=>{console.error(JSON.stringify({operation:'adl.stage_credentials',status:'blocked',note:'Check local .env presence/format and SSH. No secret values or raw errors printed; no worker start requested.'}));process.exitCode=2;});
