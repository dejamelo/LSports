import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {inspectLocalSource,changedPaths} from './api-local-source.mjs';
test('status parser preserves filenames and rename source with spaces',()=>{
 assert.deepEqual(changedPaths(Buffer.from('R  new name\0old name\0 D removed\0')),[{status:'R ',path:'new name',originalPath:'old name'},{status:' D',path:'removed'}]);
});
test('protect staged, unstaged, deleted, symlink and mode changes without modifying checkout; compare intended commit',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'adl-source-test-')),repo=path.join(root,'repo');await fs.mkdir(repo);
 const git=(...a)=>execFileSync('git',a,{cwd:repo,encoding:'utf8'});
 try{
  git('init','-q');git('config','user.name','Isolated Test');git('config','user.email','isolated@example.invalid');
  await fs.writeFile(path.join(repo,'changed.txt'),'original\n');await fs.writeFile(path.join(repo,'deleted.txt'),'preserve deletion\n');await fs.writeFile(path.join(repo,'mode.sh'),'echo local\n');await fs.symlink('changed.txt',path.join(repo,'link'));
  git('add','.');git('commit','-qm','intended');const sha=git('rev-parse','HEAD').trim();
  await fs.writeFile(path.join(repo,'changed.txt'),'staged\n');git('add','changed.txt');await fs.writeFile(path.join(repo,'changed.txt'),'PRIVATE unstaged\n');await fs.unlink(path.join(repo,'deleted.txt'));await fs.chmod(path.join(repo,'mode.sh'),0o755);await fs.unlink(path.join(repo,'link'));await fs.symlink('deleted.txt',path.join(repo,'link'));
  const before=git('status','--porcelain=v1','-z'),indexBefore=await fs.readFile(path.join(repo,'.git/index'));
  const report=await inspectLocalSource(repo,sha,path.join(root,'protected'));
  assert.equal(report.environment,'local_checkout_before_ssh');assert.equal(report.sha256Verified,true);assert.equal(report.trackedChanges.length,4);assert.equal(git('status','--porcelain=v1','-z'),before);assert((await fs.readFile(path.join(repo,'.git/index'))).equals(indexBefore));
  assert.equal(await fs.readFile(path.join(repo,'changed.txt'),'utf8'),'PRIVATE unstaged\n');assert(!JSON.stringify(report).includes('PRIVATE'));
  const manifest=JSON.parse(await fs.readFile(path.join(report.backup,'manifest.private.json'),'utf8'));
  const changed=report.trackedChanges.findIndex(f=>f.path==='changed.txt');
  assert.equal(await fs.readFile(path.join(report.backup,`working-${changed}.private`),'utf8'),'PRIVATE unstaged\n');assert.equal(await fs.readFile(path.join(report.backup,`staged-${changed}.private`),'utf8'),'staged\n');assert.equal(await fs.readFile(path.join(report.backup,`intended-${changed}.private`),'utf8'),'original\n');
  assert.equal((await fs.stat(report.backup)).mode&0o777,0o700);for(const name of Object.keys(manifest.files))assert.equal((await fs.stat(path.join(report.backup,name))).mode&0o777,0o600);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('clean checkout reports different committed HEAD without copying local files',async()=>{
 const repo=await fs.mkdtemp(path.join(os.tmpdir(),'adl-source-clean-'));const git=(...a)=>execFileSync('git',a,{cwd:repo,encoding:'utf8'});
 try{git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');await fs.writeFile(path.join(repo,'a'),'one');git('add','.');git('commit','-qm','one');const sha=git('rev-parse','HEAD').trim();await fs.writeFile(path.join(repo,'a'),'two');git('commit','-qam','two');const r=await inspectLocalSource(repo,sha,path.join(repo,'unused'));assert.equal(r.backup,null);assert.equal(r.headDiffersFromIntended,true);assert.deepEqual(r.committedDifferences,['a']);}finally{await fs.rm(repo,{recursive:true,force:true});}
});
test('full entrypoint from separate directory honors explicit repo/commit and inspect-only without SSH',async()=>{
 const repo=await fs.mkdtemp(path.join(os.tmpdir(),'adl-source-entry-'));const git=(...a)=>execFileSync('git',a,{cwd:repo,encoding:'utf8'});
 try{git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');await fs.writeFile(path.join(repo,'a'),'one');git('add','.');git('commit','-qm','one');const sha=git('rev-parse','HEAD').trim();
 const runner=path.join(repo,'separate-runner');await fs.mkdir(runner);for(const name of ['update-adl-api.mjs','api-local-source.mjs'])await fs.copyFile(new URL(name,import.meta.url),path.join(runner,name));
 const output=execFileSync(process.execPath,[path.join(runner,'update-adl-api.mjs'),'--repo',repo,'--commit',sha,'--preserve-local-changes','--inspect-local'],{cwd:os.tmpdir(),encoding:'utf8'});
 const result=JSON.parse(output.trim());assert.equal(result.environment,'local_checkout_before_ssh');assert.equal(result.intendedCommit,sha);assert.equal(result.remoteChangesRequested,false);assert.equal(result.backup,null);
 }finally{await fs.rm(repo,{recursive:true,force:true});}
});
