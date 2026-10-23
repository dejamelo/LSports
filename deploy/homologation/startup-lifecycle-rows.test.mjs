import {test} from 'node:test';import assert from 'node:assert/strict';import {startupLifecycleRows} from './startup-lifecycle-rows.mjs';
test('startup failure is retained even when publication and InPlay fill the last eight rows',()=>{
 const failure={stage:'recent_lifecycle',record:{operation:'inbox.actor_failure',lane:'prematch',ingressStage:'amqp.consume',errorCode:403}};
 const rows=[failure,...Array.from({length:98},()=>({stage:'recent_lifecycle',record:{operation:'file.persist'}}))];
 const selected=startupLifecycleRows(rows);assert.equal(selected.length,9);assert.equal(selected[0],failure);
});
