import test from 'node:test';
import assert from 'node:assert/strict';
import {cachePreflightProvesMacStopped} from './pipeline-cache-preflight.mjs';

test('accepts absent migrated checkpoint only when process and lock audits are clean',()=>{
 assert.equal(cachePreflightProvesMacStopped({status:'blocked',matchingWorkerProcesses:0,workerLockAbsent:true,processes:{status:'ok',matching:0},locks:[],blockers:[{stage:'checkpoint',reason:'ENOENT'}]}),true);
});
test('rejects a present consumer, lock, or any additional audit blocker',()=>{
 const base={status:'blocked',matchingWorkerProcesses:0,workerLockAbsent:true,processes:{status:'ok',matching:0},locks:[],blockers:[{stage:'checkpoint',reason:'ENOENT'}]};
 assert.equal(cachePreflightProvesMacStopped({...base,matchingWorkerProcesses:1}),false);
 assert.equal(cachePreflightProvesMacStopped({...base,workerLockAbsent:false}),false);
 assert.equal(cachePreflightProvesMacStopped({...base,locks:[{}]}),false);
 assert.equal(cachePreflightProvesMacStopped({...base,blockers:[...base.blockers,{stage:'family',reason:'unverified'}]}),false);
 assert.equal(cachePreflightProvesMacStopped({...base,blockers:[{stage:'checkpoint',reason:'permission'}]}),false);
});
