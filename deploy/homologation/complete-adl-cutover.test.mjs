import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,copyFile,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const entry=path.join(here,'complete-adl-cutover.mjs');

test('complete CLI forwards startup report and explicit owner/parent unchanged; never enters legacy migration',async()=>{
 const folder=await mkdtemp(path.join(tmpdir(),'adl-entry-'));
 try{
  await copyFile(entry,path.join(folder,'complete-adl-cutover.mjs'));
  // Replace only the executor boundary: no SSH, lock, signal, journal or provider access.
  await writeFile(path.join(folder,'resumable-adl-cutover.mjs'),`export async function run(args){console.log(JSON.stringify({operation:'test.forwarded',args}));}`);
  for(const mode of ['--startup-report','--feed-validation-resume','--recovery-progress']){
  const args=['--pid','12811','--parent','12809',mode];
  const result=spawnSync(process.execPath,[path.join(folder,'complete-adl-cutover.mjs'),...args],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stdout);
  const lines=result.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines,[{operation:'test.forwarded',args}]);
  assert.equal(result.stderr,'');
  }
 }finally{await rm(folder,{recursive:true,force:true});}
});

test('real entrypoint rejects startup report missing or invalid identity before running any executor stage',()=>{
 for(const args of [ ['--startup-report'],['--pid','not-a-pid','--parent','12809','--startup-report'] ]){
  const result=spawnSync(process.execPath,[entry,...args],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,2);
  const rows=result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length,1);
  assert.equal(rows[0].operation,'cutover.resumable');
  assert.equal(rows[0].stage,'arguments');
  assert.equal(rows[0].reason,'EXPECTED_OWNER_PARENT_RECOVERY_MODE');
  assert.equal(result.stderr,'');
 }
});

test('entrypoint routes every allowed resumable mode to the identity-checking executor',async()=>{
 const source=await readFile(path.join(here,'resumable-adl-cutover.mjs'),'utf8');
 const modes=source.match(/!\[([^\]]+)\]\.includes\(args\[4\]\)/)[1].match(/--[a-z-]+/g);
 const folder=await mkdtemp(path.join(tmpdir(),'adl-modes-'));
 try{
  await copyFile(entry,path.join(folder,'complete-adl-cutover.mjs'));
  await writeFile(path.join(folder,'resumable-adl-cutover.mjs'),`export async function run(args){console.log(JSON.stringify(args));}`);
  for(const mode of modes){
   const args=['--pid','12811','--parent','12809',mode];
   const result=spawnSync(process.execPath,[path.join(folder,'complete-adl-cutover.mjs'),...args],{encoding:'utf8',timeout:10000});
   assert.equal(result.status,0,mode+': '+result.stdout);assert.deepEqual(JSON.parse(result.stdout),args);
  }
 }finally{await rm(folder,{recursive:true,force:true});}
});
