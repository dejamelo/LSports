import {test} from 'node:test';
import assert from 'node:assert/strict';
import {step,validateFeeds} from './resumable-adl-cutover.mjs';
test('completed stages are reused; failure stays pending and does not erase previous results',async()=>{
 const ledger={steps:{}};let saves=0,actions=0;
 const save=async()=>{saves++;};
 assert.equal(await step(ledger,'backup',save,async()=>{actions++;return 'verified';}),'verified');
 assert.equal(await step(ledger,'backup',save,async()=>{throw Error('must not rerun');}),'verified');
 await assert.rejects(step(ledger,'image',save,async()=>{throw Error('docker failure');}));
 assert.equal(ledger.steps.backup.status,'ok');assert.equal(ledger.steps.image.status,'started');
 assert.equal(await step(ledger,'image',save,async()=>{actions++;return 'patched';}),'patched');
 assert.equal(actions,2);assert.ok(saves>=5);
});

test('validation resumes with status only, preserves completed migration and saves current evidence',async()=>{
 const ledger={steps:{local_exit:{status:'ok'},aws_start:{status:'ok'},journal_import:{status:'ok'}}};const before=JSON.stringify(ledger.steps);const calls=[];let saved=0;
 await validateFeeds(async(action)=>{calls.push(action);return {status:'snapshots_ready',selectableSelections:3,workers:[{state:'running'}]};},{},ledger,async()=>{saved++;},'/protected/progress');
 assert.deepEqual(calls,['status']);assert.equal(JSON.stringify(ledger.steps),before);assert.equal(ledger.currentStage,'complete');assert.ok(saved>=1);
});
test('validation preserves failure evidence without restarting an exited worker',async()=>{
 const ledger={steps:{aws_start:{status:'ok'}}};const calls=[];
 await assert.rejects(validateFeeds(async(action)=>{calls.push(action);return {status:'recovering',workers:[{state:'exited'}],evidence:{readOnly:true}};},{},ledger,async()=>{},'/protected/progress'),/AWS_WORKER_EXITED/);
 assert.deepEqual(calls,['status']);assert.equal(ledger.lastValidation.evidence.readOnly,true);assert.equal(ledger.steps.aws_start.status,'ok');
});
