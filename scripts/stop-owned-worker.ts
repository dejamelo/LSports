// Signal exactly the verified local lock owner, once; never signal a group or reclaim a lock.
import {lstat,readFile,readdir,readlink} from 'node:fs/promises';
import {realpath} from 'node:fs/promises';
import {dirname,basename,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
export type Identity={pid:number;parentPid:number;uid:number;startedAt:string;args:string};
export type Lock={pid:number;ino:number;dev:number;uid:number};
export function workerIdentity(info:Identity,root:string,cwd:string,uid:number){
 const entry=/\b(?:apps\/worker\/src\/index\.[tj]s|scripts\/homologation-worker\.[tj]s)(?:\s|$)/.test(info.args);
 const node=/^(?:\S*\/)?(?:node|nodejs)(?:\s|$)/.test(info.args);
 return entry&&node&&info.uid===uid&&[root,join(root,'apps/worker')].includes(cwd);
}
export function sameIdentity(a:Identity,b:Identity){return a.pid===b.pid&&a.uid===b.uid&&a.startedAt===b.startedAt&&a.args===b.args;}
export async function processIdentity(pid:number):Promise<Identity|undefined>{
 try{
  const {stdout}=await promisify(execFile)('ps',['-p',String(pid),'-o','pid=,ppid=,uid=,lstart=,state=,command='],{timeout:5000,maxBuffer:1024*1024,env:{...process.env,LC_ALL:'C'}});
  const fields=stdout.trim().split(/\s+/);
  if(fields.length<10||Number(fields[0])!==pid)throw Error('PROCESS_IDENTITY_UNVERIFIED');
  if(/^Z/.test(fields[8]))return undefined; // Unreaped child has exited; caller still requires lock release.
  return {pid,parentPid:Number(fields[1]),uid:Number(fields[2]),startedAt:fields.slice(3,8).join(' '),args:fields.slice(9).join(' ')};
 }catch(e){if((e as {code?:unknown;stdout?:unknown}).code===1&&!String((e as {stdout?:unknown}).stdout||'').trim())return undefined;throw e;}
}
export async function processStateCode(pid:number){
 const {stdout}=await promisify(execFile)('ps',['-p',String(pid),'-o','state='],{timeout:5000,maxBuffer:4096});
 const value=stdout.trim();if(!/^[A-Za-z+<NsWTsl-]{1,12}$/.test(value))throw Error('PROCESS_STATE_UNVERIFIED');return value;
}
export async function processCwd(pid:number){
 if(process.platform==='linux')return realpath(await readlink('/proc/'+pid+'/cwd'));
 if(process.platform!=='darwin')throw Error('PLATFORM_UNSUPPORTED');
 const {stdout}=await promisify(execFile)('lsof',['-a','-p',String(pid),'-d','cwd','-Fn'],{timeout:5000,maxBuffer:1024*1024});
 const paths=stdout.split('\n').filter(line=>line.startsWith('n')).map(line=>line.slice(1));
 if(paths.length!==1)throw Error('CWD_UNVERIFIED');return realpath(paths[0]);
}
export async function readOwner(lockPath:string):Promise<Lock>{
 const info=await lstat(lockPath);
 if(!info.isFile()||info.isSymbolicLink()||info.size>64)throw Error('LOCK_UNVERIFIED');
 const raw=(await readFile(lockPath,'utf8')).trim();
 if(!/^[1-9]\d{0,9}$/.test(raw))throw Error('LOCK_OWNER_UNVERIFIED');
 return {pid:Number(raw),ino:info.ino,dev:info.dev,uid:info.uid};
}
const sameLock=(a:Lock,b:Lock)=>a.pid===b.pid&&a.ino===b.ino&&a.dev===b.dev&&a.uid===b.uid;
export async function stopOwnedWorker(io:{lock:()=>Promise<Lock>;identity:(pid:number)=>Promise<Identity|undefined>;cwd:(pid:number)=>Promise<string>;signal:(pid:number)=>void;absent:()=>Promise<boolean>;pause:()=>Promise<void>;now:()=>number;verified?:(pid:number,parentPid:number)=>void;osState?:(pid:number)=>Promise<string>},root:string,uid:number,timeoutMs=120000){
 const lock=await io.lock();const info=await io.identity(lock.pid);
 if(!info||lock.uid!==uid||!workerIdentity(info,root,await io.cwd(lock.pid),uid))throw Error('LOCK_OWNER_NOT_VERIFIED_LSPORTS_WORKER');
 const fresh=await io.identity(lock.pid);
 if(!fresh||!sameIdentity(info,fresh)||!sameLock(lock,await io.lock())||!workerIdentity(fresh,root,await io.cwd(lock.pid),uid))throw Error('IDENTITY_CHANGED_BEFORE_SIGNAL');
 if(io.osState&&/^T/.test(await io.osState(lock.pid)))throw Error('WORKER_OS_STOPPED_REQUIRES_RESUME_RECOVERY');
 io.verified?.(lock.pid,info.parentPid);
 io.signal(lock.pid); // Only one SIGTERM to a positive PID. No parent/group/broad process matching.
 const deadline=io.now()+timeoutMs;
 while(io.now()<deadline){
  const absent=await io.absent();
  const current=await io.identity(lock.pid);
  if(absent&&!current)return {ownerPid:lock.pid,parentPid:info.parentPid,signal:'SIGTERM',lockReleased:true};
  if(current&&!sameIdentity(info,current))throw Error('IDENTITY_CHANGED_WHILE_WAITING');
  await io.pause();
 }
 throw Error('GRACEFUL_SHUTDOWN_TIMEOUT_LOCK_PRESERVED');
}
export async function pathAbsent(file:string){try{await lstat(file);return false;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return true;throw e;}}
export async function journalHashes(state:string){
 const folder=dirname(state);const names=(await readdir(folder)).filter(n=>n.startsWith(basename(state)+'.snapshot-')&&/^[a-zA-Z0-9_.-]+\.json$/.test(n)).sort();
 if(!names.length)throw Error('JOURNALS_MISSING');const hashes=[];
 for(const name of names){const file=join(folder,name);const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw Error('JOURNAL_UNVERIFIED');hashes.push(createHash('sha256').update(await readFile(file)).digest('hex'));}
 return JSON.stringify(hashes);
}
export const normalPause=()=>delay(500);
