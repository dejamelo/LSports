import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cutoverBarrier} from '../../../scripts/cutover-policy.js';
test('cutover honors shared/per-operation cooldown and both lane Retry-After instead of a fixed wait',()=>{
 const now=Date.parse('2026-10-19T01:00:00Z');
 const schedule={nextAt:now+600000,due:{'4511:snapshot.events':now+1200000},failures:{}};
 const lane={prematch:{lastSnapshotAttemptAt:'2026-10-19T00:59:00Z'},inplay:{diagnostic:{retryAt:'2026-10-19T01:30:00Z'}}};
 assert.equal(cutoverBarrier([schedule],lane,now,300000),'2026-10-19T01:30:05.000Z');
});
test('cutover rejects absent/corrupt journals, incomplete lanes and ambiguous retry dates',()=>{
 const s={nextAt:0,due:{},failures:{}};
 assert.throws(()=>cutoverBarrier([],{prematch:{},inplay:{}},0,300000));
 assert.throws(()=>cutoverBarrier([{...s,due:{bad:NaN}}],{prematch:{},inplay:{}},0,300000));
 assert.throws(()=>cutoverBarrier([s],{prematch:{}},0,300000));
 assert.throws(()=>cutoverBarrier([s],{prematch:{diagnostic:{retryAt:'2026-10-19T01:30:00'}},inplay:{}},0,300000));
});
test('old checkpoints never allow startup before a fresh full configured interval',()=>{
 const now=Date.parse('2026-10-19T01:00:00Z');
 assert.equal(cutoverBarrier([{nextAt:0,due:{},failures:{}}],{prematch:{},inplay:{}},now,600000),'2026-10-19T01:10:05.000Z');
});
