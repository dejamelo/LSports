import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {diagnoseCutover,processMatches} from '../../../scripts/cutover-diagnostics.js';
const now=Date.parse('2026-10-19T02:00:00Z');
async function fixture(action:(dir:string,state:string,journal:string)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'adl-cutover-diagnostics-'));const state=join(dir,'feed.json');const journal=state+'.snapshot-0123456789abcdef.json';
 try{
  await writeFile(state,JSON.stringify({mode:'connected',connections:{prematch:{phase:'stopped'},inplay:{phase:'stopped'}}}));
  await writeFile(journal,JSON.stringify({nextAt:0,due:{'4511:snapshot.events':now+600000},failures:{}}));
  await action(dir,state,journal);
 }finally{await rm(dir,{recursive:true,force:true});}
}
const options=(state:string)=>({state,now,refreshMs:300000,ps:async()=>''});
test('valid local evidence preserves cooldown and performs no writes',()=>fixture(async(dir,state)=>{
 const before=await readdir(dir);const result=await diagnoseCutover(options(state));
 assert.equal(result.status,'ok');assert.equal(result.notBeforeUTC,'2026-10-19T02:10:05.000Z');assert.deepEqual(await readdir(dir),before);
}));
test('dead-owner lock is identified and preserved byte-for-byte',()=>fixture(async(dir,state)=>{
 const lock=state+'.lock';await writeFile(lock,'96162');
 const result=await diagnoseCutover({...options(state),alive:()=> 'not_running'});
 assert.equal(result.status,'blocked');assert.equal(result.locks[0].owner,'not_running');assert.equal(result.locks[0].ownerPid,96162);
 assert.equal(await readFile(lock,'utf8'),'96162');assert.ok(result.blockers.some(b=>b.stage==='locks'));
}));
test('worker guard and scheduler locks are independently reported, never reclaimed',()=>fixture(async(dir,state,journal)=>{
 await writeFile(state+'.lock.reclaim','raw-secret-not-a-pid');await writeFile(journal+'.lock','42');
 const result=await diagnoseCutover({...options(state),alive:()=> 'running'});
 assert.equal(result.locks.length,2);assert.equal(result.status,'blocked');assert.ok(!JSON.stringify(result).includes('raw-secret'));
}));
test('reports processes with PID/kind only, no command or embedded secret',()=>fixture(async(dir,state)=>{
 const result=await diagnoseCutover({...options(state),ps:async()=> ' 123 1 node apps/worker/src/index.ts --secret=DO_NOT_PRINT'});
 assert.equal(result.matchingWorkerProcesses,1);assert.equal(result.status,'blocked');assert.ok(!JSON.stringify(result).includes('DO_NOT_PRINT'));
 assert.deepEqual(processMatches('999 1 node scripts/diagnose-cutover.ts'),[]);
}));
test('invalid checkpoint and invalid journal both surface without raw parse text',()=>fixture(async(dir,state,journal)=>{
 await writeFile(state,'{"sensitive-value":');await writeFile(journal,'private-payload-not-json');
 const result=await diagnoseCutover(options(state));
 assert.ok(result.blockers.some(b=>b.stage==='checkpoint'&&b.reason==='INVALID_JSON'));
 assert.ok(result.blockers.some(b=>b.stage==='journals'&&b.reason==='INVALID_JSON'));
 assert.ok(!JSON.stringify(result).includes('sensitive-value'));assert.ok(!JSON.stringify(result).includes('private-payload'));
}));
test('missing journal, missing lane and ps denied are diagnosed independently',()=>fixture(async(dir,state,journal)=>{
 await rm(journal);await writeFile(state,JSON.stringify({mode:'connected',connections:{prematch:{}}}));
 const result=await diagnoseCutover({...options(state),ps:async()=>{throw Object.assign(Error('secret error text'),{code:'EACCES'});}});
 assert.ok(result.blockers.some(b=>b.reason==='JOURNALS_MISSING'));assert.ok(result.blockers.some(b=>b.reason==='LANE_EVIDENCE_MISSING'));
 assert.ok(result.blockers.some(b=>b.stage==='processes'&&b.reason==='EACCES'));assert.ok(!JSON.stringify(result).includes('secret error text'));
}));
test('ambiguous retry date is rejected without echoing provider fields',()=>fixture(async(dir,state)=>{
 await writeFile(state,JSON.stringify({mode:'connected',connections:{prematch:{diagnostic:{retryAt:'2026-10-19T02:00:00'}},inplay:{}}}));
 const result=await diagnoseCutover(options(state));assert.ok(result.blockers.some(b=>b.reason==='INVALID_COOLDOWN_DATE'));
}));
test('symlinked journals block instead of reading their target',()=>fixture(async(dir,state,journal)=>{
 await rm(journal);const secret=join(dir,'private-file');await writeFile(secret,'SECRET');await symlink(secret,journal);
 const result=await diagnoseCutover(options(state));assert.ok(result.blockers.some(b=>b.reason==='NOT_REGULAR_FILE'));assert.equal(await readFile(secret,'utf8'),'SECRET');
}));

test('suspended concurrently is not a second consumer; running supervisor and stopped worker still block',()=>{
 const command='node /repo/node_modules/concurrently/dist/bin/concurrently.js node --import tsx apps/worker/src/index.ts';
 assert.equal(processMatches('12809 12799 T '+command).length,0);
 assert.equal(processMatches('12809 12799 S '+command).length,1);
 assert.equal(processMatches('12811 12809 T node --import tsx apps/worker/src/index.ts').length,1);
 assert.equal(processMatches('12811 12809 Z node --import tsx apps/worker/src/index.ts').length,0);
});

test('Mac git show mentioning worker source is not a consumer; independently verify the node parent',()=>fixture(async(_dir,state)=>{
 const ps='49460 49384 T /Library/Developer/CommandLineTools/usr/bin/git show b89f5df:apps/worker/src/index.ts\n49384 1 T node /tmp/run/deploy/homologation/complete-adl-cutover.mjs --pid 12811 --parent 12809 --durable-ingress-repair';
 const comm='49460 /Library/Developer/CommandLineTools/usr/bin/git\n49384 /usr/local/bin/node';
 const report=await diagnoseCutover({...options(state),ps:async()=>ps,executables:async()=>comm});
 assert.equal(report.status,'ok');assert.equal(report.matchingWorkerProcesses,0);
 const unknown=await diagnoseCutover({...options(state),ps:async()=>ps.replace('/tmp/run/deploy/homologation/complete-adl-cutover.mjs','/tmp/unknown.js'),executables:async()=>comm});
 assert.equal(unknown.status,'blocked');assert.ok(unknown.blockers.some(b=>b.reason==='PROCESS_IDENTITY_INCONCLUSIVE'));
 assert.deepEqual((unknown.processes as any).matches,[{pid:49384,parentPid:1,kind:'identity_inconclusive'}]);
}));
test('Git and worker references in arguments cannot hide real entrypoints, dynamic loaders or failed executable lookup',()=>fixture(async(_dir,state)=>{
 for(const args of ['node --import tsx apps/worker/src/index.ts','node /repo/node_modules/tsx/dist/cli.mjs apps/worker/src/index.ts','node --eval=consumer apps/worker/src/index.ts','node --import apps/worker/src/index.ts /tmp/deploy/homologation/complete-adl-cutover.mjs']){
  const r=await diagnoseCutover({...options(state),ps:async()=>`12811 1 T ${args}`,executables:async()=>'12811 /usr/local/bin/node'});assert.equal(r.status,'blocked');assert.equal(r.matchingWorkerProcesses,1);
 }
 const mismatched=processMatches('49460 1 T git show apps/worker/src/index.ts','49460 /usr/local/bin/node');assert.equal(mismatched[0].kind,'identity_inconclusive');
 const r=await diagnoseCutover({...options(state),executables:async()=>{throw Error('PRIVATE');}});assert.equal(r.status,'blocked');assert.ok(r.blockers.some(b=>b.reason==='PROCESS_EXECUTABLE_QUERY_FAILED'));assert.ok(!JSON.stringify(r).includes('PRIVATE'));
}));
