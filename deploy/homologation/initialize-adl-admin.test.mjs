import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {protectedAccess} from './initialize-adl-admin.mjs';
test('first access generated outside repo with private modes; no default password',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'adl-access-'));
 try{const a=await protectedAccess(path.join(root,'Access'),' Owner@example.invalid '),b=await protectedAccess(path.join(root,'Access'),'owner@example.invalid');assert.equal(a.credentials.email,'owner@example.invalid');assert(a.credentials.password.length>=40);assert.notEqual(a.credentials.password,b.credentials.password);assert.equal((await fs.stat(a.file)).mode&0o777,0o600);assert.equal((await fs.stat(path.dirname(a.file))).mode&0o777,0o700);assert.deepEqual(JSON.parse(await fs.readFile(a.file,'utf8')),a.credentials);await assert.rejects(protectedAccess(path.join(root,'Access'),'bad'),/EMAIL_INVALID/);}
 finally{await fs.rm(root,{recursive:true,force:true});}
});
test('symlinked access folder is refused',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'adl-access-link-'));try{await fs.mkdir(path.join(root,'real'));await fs.symlink(path.join(root,'real'),path.join(root,'alias'));await assert.rejects(protectedAccess(path.join(root,'alias'),'test@example.invalid'),/ACCESS_DIRECTORY_REJECTED/);}finally{await fs.rm(root,{recursive:true,force:true});}});
