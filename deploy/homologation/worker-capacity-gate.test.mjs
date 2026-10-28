import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workerCapacityApproved} from './worker-capacity-gate.mjs';
const model=(memory='6442450944',gates={capacityApproved:true,macStopped:true,notBeforeConfigured:true},prematch='256',inplay='128')=>({memoryLimitBytes:memory,gates,prematchCapMB:prematch,inplayCapMB:inplay});
test('accepts the installed 6 GiB profile only with saved recovery approvals',()=>{
 assert.equal(workerCapacityApproved(model()),true);
 for(const key of ['capacityApproved','macStopped','notBeforeConfigured'])assert.equal(workerCapacityApproved(model('6442450944',{capacityApproved:true,macStopped:true,notBeforeConfigured:true,[key]:false})),false);
});
test('keeps recognized fixed memory and snapshot caps; rejects unapproved increases',()=>{
 assert.equal(workerCapacityApproved(model('4294967296')),true);
 assert.equal(workerCapacityApproved(model('8589934592')),false);
 assert.equal(workerCapacityApproved(model('8589934592'),{pipelineMemoryEightGiB:true}),true);
 assert.equal(workerCapacityApproved(model('8589934592'),{snapshotMemoryEightGiB:true}),true);
 assert.equal(workerCapacityApproved(model('8589934592',{capacityApproved:true,macStopped:false,notBeforeConfigured:true}),{snapshotMemoryEightGiB:true}),false);
 assert.equal(workerCapacityApproved(model('8589934592',{capacityApproved:true,macStopped:false,notBeforeConfigured:true}),{pipelineMemoryEightGiB:true}),false);
 assert.equal(workerCapacityApproved(model('6442450944',undefined,'512')),false);
 assert.equal(workerCapacityApproved(model('6442450944',undefined,'256','512')),false);
});
test('snapshot repair mode retains its existing narrower 2/4 GiB profile',()=>{
 assert.equal(workerCapacityApproved(model('2147483648',undefined,'128','128'),{repairSnapshot:true}),true);
 assert.equal(workerCapacityApproved(model('6442450944',undefined,'128','128'),{repairSnapshot:true}),false);
});
