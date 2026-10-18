import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,access,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {TicketStore} from '@lsports/feed-store/tickets';
import {demoSource} from '@lsports/demo';
import {recoverStaleLock} from './recover-stale-lock.js';
import {RecoveryAbort} from './recovery-diagnostics.js';
const deadPid=999999999;
async function setup(){const dir=await mkdtemp(join(tmpdir(),'adl-reclaim-lock-'));const path=join(dir,'feed.json'),database=join(dir,'tickets.sqlite');await writeFile(path,'{"isolatedCheckpoint":"must remain byte-identical"}');await writeFile(`${path}.lock`,String(deadPid));return {dir,path,database};}
test('verified dead lock is archived only after consistent backup of checkpoint and both tickets; originals stay identical',async()=>{
 const s=await setup();const store=new TicketStore(s.database);try{
  const feed=await demoSource.getEvents(),event=feed.events[0];const request={stakeMinor:10000,selections:[{eventId:event.id,marketId:event.markets?.[0]?.id||'demo',selectionId:event.selections[0].id,expectedOdds:event.selections[0].odds}]};
  store.create(request,'isolated-first-ticket',()=>feed);store.create(request,'isolated-second-ticket',()=>feed);const tickets=store.list(),checkpoint=await readFile(s.path),original=await readFile(`${s.path}.lock`);
  const result=await recoverStaleLock(s.path,s.database,deadPid);assert.equal(result.status,'stale_lock_archived');assert.equal(result.ticketsModified,false);assert.equal(result.checkpointModified,false);
  const backup=String(result.backup);assert.deepEqual(await readFile(s.path),checkpoint);assert.deepEqual(store.list(),tickets);assert.deepEqual(await readFile(join(backup,'feed.before.json')),checkpoint);assert.deepEqual(await readFile(join(backup,'worker.lock.archived')),original);assert.deepEqual(await readFile(join(backup,'worker.lock.before')),original);
  const saved=new DatabaseSync(join(backup,'tickets.before.sqlite'),{readOnly:true});try{assert.equal((saved.prepare('SELECT count(*) AS n FROM tickets').get() as {n:number}).n,2);}finally{saved.close();}
  const audit=JSON.parse(await readFile(join(backup,'audit.json'),'utf8'));assert.equal(audit.ticketCount,2);assert.equal(audit.beforeSha256,audit.afterSha256);await assert.rejects(()=>access(`${s.path}.lock`));await assert.rejects(()=>access(`${s.path}.lock.reclaim`));
 }finally{store.close();await rm(s.dir,{recursive:true,force:true});}
});
test('live/reused PID and mismatched PID cannot be reclaimed and create no backups',async()=>{
 const s=await setup();try{
  await assert.rejects(()=>recoverStaleLock(s.path,s.database,deadPid-1),e=>e instanceof RecoveryAbort&&e.diagnostic.stage==='lock.verify_owner');assert.equal(await readFile(`${s.path}.lock`,'utf8'),String(deadPid));
  await writeFile(`${s.path}.lock`,String(process.pid));await assert.rejects(()=>recoverStaleLock(s.path,s.database,process.pid));assert.equal(await readFile(`${s.path}.lock`,'utf8'),String(process.pid));assert.equal((await readdir(s.dir)).filter(n=>n.startsWith('timestamp-recovery-')).length,0);
 }finally{await rm(s.dir,{recursive:true,force:true});}
});
test('backup failure leaves stale lock, checkpoint and partial backup untouched; concurrent guard is never removed',async()=>{
 const s=await setup();try{
  const original=await readFile(s.path);await assert.rejects(()=>recoverStaleLock(s.path,s.database,deadPid),e=>{assert(e instanceof RecoveryAbort);assert.equal(e.diagnostic.stage,'sqlite.open_readonly');assert.equal(e.diagnostic.writes.staleLockArchived,undefined);assert.equal(e.diagnostic.writes.checkpointBackupComplete,true);return true;});
  assert.equal(await readFile(`${s.path}.lock`,'utf8'),String(deadPid));assert.deepEqual(await readFile(s.path),original);assert.equal((await readdir(s.dir)).filter(n=>n.startsWith('timestamp-recovery-')).length,1);
  await writeFile(`${s.path}.lock.reclaim`,'other-owner');await assert.rejects(()=>recoverStaleLock(s.path,s.database,deadPid),e=>e instanceof RecoveryAbort&&e.diagnostic.stage==='lock.reclaim_guard');assert.equal(await readFile(`${s.path}.lock.reclaim`,'utf8'),'other-owner');assert.equal(await readFile(`${s.path}.lock`,'utf8'),String(deadPid));
 }finally{await rm(s.dir,{recursive:true,force:true});}
});
