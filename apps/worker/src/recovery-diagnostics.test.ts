import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {TradeState} from './state.js';
import {createPublisher} from '@lsports/feed-store';
import {checkpoint} from './persistence.js';
import {decodeMessage} from './messages.js';
import {applyTimestampRecovery} from './timestamp-recovery.js';
import {RecoveryAbort,sanitizedCause,reportRecoveryError} from './recovery-diagnostics.js';
import {inspectRecovery} from './inspect-recovery.js';
async function setup(){
 const dir=await mkdtemp(join(tmpdir(),'adl-abort-diagnostics-')),path=join(dir,'feed.json'),database=join(dir,'tickets.sqlite'),now=Date.now();const state=new TradeState();
 state.apply('prematch',[{fixtureId:9001,outright:{competitionId:9002,fixture:{sport:{name:'Horse Racing'},status:1}}}],now);
 const apply=(version:number,at:number,settlement?:number)=>{const decoded=decodeMessage(Buffer.from(JSON.stringify({Header:{Type:41,MsgGuid:'isolated-clock-'+at,ServerTimestamp:at},Body:{Competition:{Id:9002,Events:[{FixtureId:9001,Markets:[{Id:160,Bets:[{Id:'1',Status:1,Price:'2.63',LastUpdate:new Date(version).toISOString(),Settlement:settlement}]}]}]}}})));state.apply('prematch',decoded.events,decoded.at);};
 apply(now+3600000,now-10000);const row=state.rows.prematch.get('outright:9002:9001')!;const trace=row.settlementAudit!.get('160:1')!;trace.lastSnapshot={...trace.last41!,source:'snapshot.outright.markets'};delete trace.lastSnapshot.timestamp;apply(now-1000,now);
 await createPublisher(path)(state.feed(),checkpoint(state));return {dir,path,database,now};
}
test('existing stale lock is identified without removal; failure reports that no checkpoint or ticket write happened',async()=>{
 const s=await setup();try{const original=await readFile(s.path);await writeFile(`${s.path}.lock`,'999999999');
  await assert.rejects(()=>applyTimestampRecovery(s.path,s.database,9001,160,s.now),e=>{assert(e instanceof RecoveryAbort);assert.equal(e.diagnostic.stage,'worker.lock_check');assert.equal(e.diagnostic.writes.lockCreated,false);assert.equal(e.diagnostic.writes.checkpointReplaced,false);return true;});
  assert.equal(await readFile(`${s.path}.lock`,'utf8'),'999999999');assert.deepEqual(await readFile(s.path),original);
  const before=(await readdir(s.dir)).sort();const inspection=await inspectRecovery(s.path,s.database);assert.equal(inspection.readOnly,true);assert.equal(inspection.lock.owner,'not_running');assert.equal(inspection.lock.action,'preserved');assert.deepEqual((await readdir(s.dir)).sort(),before);assert.deepEqual(await readFile(s.path),original);
 }finally{await rm(s.dir,{recursive:true,force:true});}
});
test('missing database aborts at SQLite open, keeps partial backup and original checkpoint, releases only its own lock',async()=>{
 const s=await setup();try{const original=await readFile(s.path);let backup='';
  await assert.rejects(()=>applyTimestampRecovery(s.path,s.database,9001,160,s.now),e=>{assert(e instanceof RecoveryAbort);const d=e.diagnostic;assert.equal(d.stage,'sqlite.open_readonly');assert.equal(d.writes.checkpointBackupComplete,true);assert.equal(d.writes.sqliteBackupStarted,false);assert.equal(d.writes.checkpointReplaced,false);assert.equal(d.writes.lockReleased,true);assert.equal(d.writes.ticketBodiesWritten,false);backup=d.backup!;return true;});
  assert.deepEqual(await readFile(s.path),original);assert.deepEqual(await readFile(join(backup,'feed.before.json')),original);
  const inspection=await inspectRecovery(s.path,s.database);assert.equal(inspection.backupCount,1);assert.equal(inspection.backups[0].checkpointMatchesBackup,true);assert.equal(inspection.backups[0].auditFile.exists,false);assert.equal(inspection.backups[0].sqliteBackup.exists,false);
 }finally{await rm(s.dir,{recursive:true,force:true});}
});
test('invalid SQLite schema is reported without dumping SQL/body/secrets; inspection never replays or repairs',async()=>{
 const s=await setup();try{const db=new DatabaseSync(s.database);db.exec('CREATE TABLE private_data(value TEXT)');db.prepare('INSERT INTO private_data VALUES(?)').run('private-secret-must-not-leak');db.close();const original=await readFile(s.path),database=await readFile(s.database);
  await assert.rejects(()=>applyTimestampRecovery(s.path,s.database,9001,160,s.now),e=>{assert(e instanceof RecoveryAbort);assert.equal(e.diagnostic.stage,'sqlite.fingerprint');assert.equal(e.diagnostic.writes.sqliteBackupStarted,false);assert(!JSON.stringify(reportRecoveryError(e)).includes('private-secret'));return true;});
  const inspection=await inspectRecovery(s.path,s.database);assert.equal(inspection.tickets.readable,false);assert(!JSON.stringify(inspection).includes('private-secret'));assert.deepEqual(await readFile(s.path),original);assert.deepEqual(await readFile(s.database),database);
 }finally{await rm(s.dir,{recursive:true,force:true});}
});
test('sanitization exposes only known error codes and SQLite primary reason, never raw exception messages',()=>{
 const e=Object.assign(new Error('secret=password https://user:password@host'),{code:'ERR_SQLITE_ERROR',errcode:8,errstr:'attempt to write a readonly database'});const report=sanitizedCause(e);assert.equal(report.sqliteReason,'readonly');assert.equal(report.sqliteCode,8);assert(!JSON.stringify(report).includes('password'));assert.equal(sanitizedCause({code:'SECRET_TOKEN',errstr:'password'}).code,'UNCLASSIFIED');
});
test('port preflight reports another listener independently of pgrep and rejects invalid configuration',async()=>{
 const {createServer}=await import('node:net');const {probeRecoveryPort}=await import('./recovery-preflight.js');const server=createServer(s=>s.end());await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert(a&&typeof a!=='string');
 assert.equal((await probeRecoveryPort(a.port)).state,'listening');await new Promise<void>(r=>server.close(()=>r()));assert.equal((await probeRecoveryPort(a.port)).state,'closed');assert.equal((await probeRecoveryPort(NaN)).state,'unknown');
});
