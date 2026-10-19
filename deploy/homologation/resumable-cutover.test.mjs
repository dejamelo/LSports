import {test} from 'node:test';
import assert from 'node:assert/strict';
import {step} from './resumable-adl-cutover.mjs';
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
