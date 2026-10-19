import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyShutdownEvidence} from '../../../scripts/shutdown-attempt-evidence.js';
test('post TERM stop is distinguished without claiming job-control cause from background group alone',()=>{
 const result=classifyShutdownEvidence({ownerAlive:true,osState:'T',termIntentVerified:true,group:12799,foregroundGroup:18495});
 assert.equal(result.finding,'os_stopped_after_directed_term');assert.equal(result.causeProven,false);assert.equal(result.backgroundGroup,true);
});
test('suspended parent and socket stdout indicate possible backpressure, not a proven hung Promise',()=>{
 const result=classifyShutdownEvidence({ownerAlive:true,osState:'S',termIntentVerified:true,parentStopped:true,outputSocketOrPipe:true});
 assert.equal(result.finding,'owner_alive_after_term');assert.equal(result.supervisorBackpressurePossible,true);assert.equal(result.causeProven,false);
});
test('exited owner still requires lock release and stable journals',()=>{
 assert.equal(classifyShutdownEvidence({ownerAlive:false,termIntentVerified:true}).next,'require_lock_release_and_stable_journals_before_export');
});
