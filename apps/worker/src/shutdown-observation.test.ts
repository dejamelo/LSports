import {test} from 'node:test';
import assert from 'node:assert/strict';
import {socketSummary,descriptorSummary,shutdownLogSignals} from '../../../scripts/shutdown-observation.js';
import {diagnoseCutover} from '../../../scripts/cutover-diagnostics.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('socket diagnostic classifies AMQP/HTTPS without endpoint disclosure',()=>{
 const result=socketSummary('p12811\nf10\nn10.0.0.1:50000->secret-provider:5672\nTST=ESTABLISHED\nf11\nn10.0.0.1:50001->private-api:443\nTST=CLOSE_WAIT');
 assert.deepEqual(result,[{portClass:'amqp',state:'ESTABLISHED'},{portClass:'https',state:'CLOSE_WAIT'}]);
 assert.ok(!JSON.stringify(result).includes('secret-provider'));assert.ok(!JSON.stringify(result).includes('10.0.0.1'));
});
test('stdout descriptor classification does not require reading a terminal or pipe',()=>{
 const result=descriptorSummary('p12811\nf1\ntCHR\nn/dev/ttys001\nf2\ntFIFO\nnpipe');
 assert.equal(result[0].kind,'terminal_or_character_device');assert.equal(result[1].kind,'pipe');
 const publicResult=result.map(d=>({fd:d.fd,kind:d.kind}));assert.ok(!JSON.stringify(publicResult).includes('/dev/'));
});
test('only fixed shutdown log counters are published, never raw errors/secrets',()=>{
 const result=shutdownLogSignals(JSON.stringify({operation:'worker.shutdown',status:'stopping',password:'secret'})+'\n'+JSON.stringify({operation:'worker.shutdown',status:'ok',lock:'released'})+'\n'+JSON.stringify({operation:'worker.shutdown',status:'error',error:'private endpoint'}));
 assert.equal(result.stopping,1);assert.equal(result.complete,1);assert.equal(result.error,1);assert.ok(!JSON.stringify(result).includes('secret'));assert.ok(!JSON.stringify(result).includes('private endpoint'));
});
test('persisted stopped phases are classified while arbitrary provider fields stay private',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-shutdown-observe-'));const state=join(dir,'feed.json');
 try{
  await writeFile(state,JSON.stringify({mode:'connected',connections:{prematch:{phase:'stopped',recoveryProgress:{stage:'handoff',regularSnapshotReady:false},message:'do not print'},inplay:{phase:'sensitive-unknown'}}}));
  await writeFile(state+'.snapshot-0123456789abcdef.json',JSON.stringify({nextAt:0,due:{},failures:{}}));
  const result=await diagnoseCutover({state,refreshMs:300000,ps:async()=>''});
  assert.deepEqual(result.checkpoint.laneState,{prematch:{phase:'stopped',recoveryStage:'handoff',regularSnapshotReady:false},inplay:{phase:'unknown',recoveryStage:'unknown',regularSnapshotReady:null}});
  assert.ok(!JSON.stringify(result).includes('do not print'));assert.ok(!JSON.stringify(result).includes('sensitive-unknown'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
