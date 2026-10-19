import {readFile,lstat,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {Identity} from './stop-owned-worker.js';
import {supervisorPolicy} from './drain-supervisor.js';
const exec=promisify(execFile);
export async function verifiedSupervisorPolicy(parent:Identity,directory:string){
 const words=parent.args.split(/\s+/);if(!/^(?:\S*\/)?node(?:js)?$/.test(words[0])||!words[1])throw Error('SUPERVISOR_EXECUTABLE_UNVERIFIED');
 const cli=await realpath(resolve(directory,words[1]));const packageRoot=await realpath(join(directory,'node_modules/concurrently'));
 if(cli!==join(packageRoot,'dist/bin/concurrently.js'))throw Error('SUPERVISOR_NOT_PROJECT_CONCURRENTLY');
 const config=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));const defaultFile=join(packageRoot,'dist/src/defaults.js');
 const defaults=await readFile(defaultFile,'utf8');const started=Date.parse(parent.startedAt);
 for(const file of [cli,defaultFile,join(packageRoot,'package.json')])if(!Number.isFinite(started)||(await lstat(file)).mtimeMs>started+1000)throw Error('SUPERVISOR_INSTALLED_CODE_CHANGED_SINCE_START');
 // ps is captured only in memory. No raw environment/argv is printed or saved.
 const envText=(await exec('ps',['eww','-p',String(parent.pid),'-o','command='],{timeout:5000,maxBuffer:4*1024*1024})).stdout.trim().replace(/\s+/g,' ');
 if(!envText.startsWith(parent.args+' '))throw Error('SUPERVISOR_ENVIRONMENT_UNVERIFIED');
 const env=envText.slice(parent.args.length);if(!/(?:^|\s)(?:PATH|HOME|USER)=/.test(env))throw Error('SUPERVISOR_ENVIRONMENT_UNVERIFIED');
 const envNames=[...env.matchAll(/(?:^|\s)(CONCURRENTLY_[A-Za-z0-9_]+)=/g)].map(match=>match[1]);
 const policy=supervisorPolicy(parent.args,envNames,String(config.version),defaults);
 // Explicit timeout/escalation can never be inherited unnoticed; no restart or queued work.
 let fds='';try{fds=(await exec('lsof',['-nP','-a','-p',String(parent.pid),'-d','1,2','-Ftn'],{timeout:5000,maxBuffer:65536})).stdout;}catch{throw Error('SUPERVISOR_OUTPUT_UNVERIFIED');}
 const terminals=[...new Set(fds.split('\n').filter(line=>/^n\/dev\/(?:ttys?\d+|pts\/\d+)$/.test(line)).map(line=>line.slice(1)))];
 for(const device of terminals){const settings=(await exec('stty',[process.platform==='darwin'?'-f':'-F',device,'-a'],{timeout:5000,maxBuffer:16384})).stdout;if(/(?:^|[\s;])tostop(?:[\s;]|$)/.test(settings))throw Error('SUPERVISOR_TERMINAL_TOSTOP_ENABLED');}
 return policy;
}
