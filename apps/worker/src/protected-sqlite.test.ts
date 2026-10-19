import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
test('read-only backup includes committed WAL and preserves two settled ticket bodies/accepted odds exactly',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-protected-sqlite-'));const source=join(dir,'source.sqlite'),target=join(dir,'backup.sqlite');const db=new DatabaseSync(source);
 try{
  db.exec('PRAGMA journal_mode=WAL;CREATE TABLE tickets(id TEXT PRIMARY KEY, body TEXT NOT NULL);');
  const rows=[['isolated-one',JSON.stringify({status:'LOST',revision:1,acceptedOdds:'2.6233',returnMinor:'0'})],['isolated-two',JSON.stringify({status:'LOST',revision:1,acceptedOdds:'1.9',returnMinor:'0'})]];
  for(const row of rows)db.prepare('INSERT INTO tickets VALUES (?,?)').run(...row);
  const original=db.prepare('SELECT * FROM tickets ORDER BY id').all();
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','scripts/protected-sqlite.ts','--source',source,'--destination',target],{timeout:10000});
  const result=JSON.parse(stdout);assert.equal(result.backupVerified,true);assert.equal(result.rows,2);assert.equal(result.integrity,'ok');assert.ok(!stdout.includes('2.6233'));
  const copied=new DatabaseSync(target,{readOnly:true});try{assert.deepEqual(copied.prepare('SELECT * FROM tickets ORDER BY id').all(),original);}finally{copied.close();}
  assert.deepEqual(db.prepare('SELECT * FROM tickets ORDER BY id').all(),original);assert.equal((await stat(target)).mode&0o777,0o600);
  const before=await readFile(target);await assert.rejects(promisify(execFile)(process.execPath,['--import','tsx','scripts/protected-sqlite.ts','--source',source,'--destination',target]));assert.deepEqual(await readFile(target),before);
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});
