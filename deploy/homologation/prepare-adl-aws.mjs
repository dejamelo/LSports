// Transfer source, build and start only isolated ADL API. No secrets/runtime transfer, worker start, POSNET changes or Caddy reload.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn,execFile} from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import {promisify} from 'node:util';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../..');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
async function main(){
 const {stdout}=await promisify(execFile)('git',['rev-parse','HEAD'],{cwd:REPO});
 const sha=stdout.trim();if(!/^[0-9a-f]{40}$/.test(sha))throw Error();
 const {stdout:dirty}=await promisify(execFile)('git',['status','--porcelain','--untracked-files=no'],{cwd:REPO});
 // Do not alter/stash/reset Mac changes. A local deletion of the prior pricing helper is irrelevant to HEAD.
 if(dirty.trim() && dirty.trim()!=='D deploy/homologation/diagnose-aws-resize.py')throw Error('tracked_changes_need_review');
 const keys=(await fs.readdir(path.join(os.homedir(),'Downloads'),{withFileTypes:true})).filter(f=>f.isFile()&&/Lottery.*Key\.pem$/.test(f.name));
 if(keys.length!==1)throw Error();
 const dns=new Resolver({timeout:2000,tries:1});
 const answers=await Promise.allSettled([dns.resolve4('sportbook.apuestadeportiva.lat'),dns.resolve6('sportbook.apuestadeportiva.lat')]);
 console.log(JSON.stringify({operation:'adl.dns',domain:'sportbook.apuestadeportiva.lat',A:answers[0].status==='fulfilled'?answers[0].value:[],AAAA:answers[1].status==='fulfilled'?answers[1].value:[],dnsConfirmed:answers[0].status==='fulfilled'&&answers[0].value.length>0&&answers[0].value.every(ip=>ip==='77.113.150.100')&&(answers[1].status==='fulfilled'?answers[1].value.length===0:['ENODATA','ENOTFOUND'].includes(answers[1].reason.code)),dnsErrors:answers.map(a=>a.status==='rejected'?a.reason.code:null),requiredRecord:{type:'A',name:'sportbook',zone:'apuestadeportiva.lat',value:'77.113.150.100'},note:'Image/API preparation does not change DNS or publish Caddy.'}));
 const source=await fs.readFile(path.join(HERE,'prepare-adl-release.py'),'utf8');
 const ssh=spawn('ssh',['-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-i',path.join(os.homedir(),'Downloads',keys[0].name),
 'ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com','sudo -n python3 -c '+quote(source)+' '+quote(sha)+' "$SSH_CONNECTION"'],{stdio:['pipe','inherit','pipe']});
 ssh.stderr.resume();
 const archive=spawn('git',['archive','--format=tar',sha],{cwd:REPO,stdio:['ignore','pipe','pipe']});
 archive.stderr.resume();
 const exit=p=>new Promise((resolve,reject)=>{p.on('error',reject);p.on('close',resolve);});
 const a=exit(archive),b=exit(ssh);
 ssh.stdin.on('error',()=>archive.kill());archive.stdout.pipe(ssh.stdin);
 const [ac,sc]=await Promise.all([a,b]);if(ac!==0||sc!==0)throw Error();
}
main().catch(()=>{console.error(JSON.stringify({status:'failed',operation:'adl.prepare_release',workerStarted:false,action:'Review sanitized remote stage and private build log; preserve Mac changes. Do not print secrets or reset the checkout.'}));process.exitCode=2;});
