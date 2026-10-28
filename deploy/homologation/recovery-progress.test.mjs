import {test} from 'node:test';import assert from 'node:assert/strict';
import {sampleRecovery,recoveryRates,observeRecovery} from './recovery-progress.mjs';
const time=n=>new Date(Date.UTC(2026,9,22,12,0,n)).toISOString();
function status(n,backlog=1000-n*100){const l={phase:'recovering',session:{id:'session',startedAt:time(0)},fullSnapshot:{stage:'apply',appliedRows:n*100,lastProgressAt:time(n*60)},ingressProgress:{metricWindowEndUTC:time(n*60),received:1000+n*60,acknowledged:1000+n*60,processed:500+n*160,checkpointed:400+n*150,processingBacklog:backlog,oldestProcessingAgeMs:10000}};return {workers:[{running:true}],lanes:{prematch:structuredClone(l),inplay:structuredClone(l)}};}
test('ETA uses measured net backlog decline, not ACK rate or oldest age',()=>{const r=recoveryRates([0,1,2].map(n=>sampleRecovery(status(n))),'prematch');assert.equal(r.assessment,'DRAINING');assert.equal(r.etaSeconds,480);assert.equal(r.receivePerSecond,1);assert.equal(r.processPerSecond,160/60);assert.equal(r.checkpointPerSecond,2.5);assert.equal(r.snapshotAdvanced,true);});
test('growth while snapshot advances is not stalled and has no drain ETA',()=>{const r=recoveryRates([0,1,2].map(n=>sampleRecovery(status(n,1000+n*100))),'prematch');assert.equal(r.assessment,'BACKLOG_GROWING');assert.equal(r.snapshotAdvanced,true);assert.equal(r.etaSeconds,null);});
test('counter resets, missing windows and session changes cannot fabricate a rate',()=>{
 const s=[0,1,2].map(n=>sampleRecovery(status(n)));s[2].lanes.prematch.metrics.processed=0;assert.equal(recoveryRates(s,'prematch').assessment,'COUNTERS_INCOMPLETE_OR_RESET');
 s[2].lanes.prematch.session='new';assert.equal(recoveryRates(s,'prematch').assessment,'SESSION_CHANGED_NO_COMPARABLE_RATE');
 const same=[0,1,2].map(n=>sampleRecovery(status(n)));for(const p of same)p.lanes.prematch.metrics.metricWindowEndUTC=time(0);assert.equal(recoveryRates(same,'prematch').assessment,'NO_NEW_PERSISTED_METRIC_WINDOW');assert.equal(recoveryRates(same,'prematch').snapshotAdvanced,true);
});
test('ETA withheld when interval direction is inconsistent',()=>{const s=[1000,1100,800].map((b,n)=>sampleRecovery(status(n,b)));assert.equal(recoveryRates(s,'prematch').etaSeconds,null);});
test('historical snapshot progress is excluded; live current-session log wins',()=>{
 const s=status(0);s.timeline={records:[{lane:'prematch',operation:'snapshot.events',status:'full_spool_progress',stage:'complete',loggedAtUTC:'2026-10-21T12:00:00Z'},{lane:'prematch',operation:'snapshot.events',status:'full_spool_progress',stage:'validate',validatedRows:1234,loggedAtUTC:time(10)}]};
 const r=sampleRecovery(s);assert.equal(r.lanes.prematch.snapshot.stage,'validate');assert.equal(r.lanes.prematch.snapshot.validatedRows,1234);assert.equal(r.lanes.prematch.snapshot.source,'current_session_worker_log');
});
test('three bounded read-only observations save indexed publication without modifying completed migration',async()=>{
 let calls=0,waits=0,written=0;const ledger={steps:{journal_import:{status:'ok'}}};const log=console.log;console.log=()=>{};const publication={revision:17,updatedAt:time(2),marketCount:9,pages:{prematch:{events:10,selectableSelections:2},inplay:{events:0}}};
 try{const result=await observeRecovery(async(action,extra)=>{assert.equal(action,'status');assert.ok(extra.timelineWindow);return {...status(calls++),indexedPublication:publication};},{},ledger,async()=>{},'/private/report',async()=>{written++;},{wait:async ms=>{assert.equal(ms,60000);waits++;}});assert.equal(result.samples,3);assert.equal(result.publication.revision,17);assert.equal(result.workerRestarted,false);assert.equal(waits,2);assert.equal(written,1);assert.equal(ledger.steps.journal_import.status,'ok');}finally{console.log=log;}
});

test('pipeline collector correlates identity and memory for each sample and preserves complete sanitized timeline',async()=>{
 const calls=[],ledger={steps:{journal_import:{status:'ok'}}};let i=0,saved;const identity={worker:{running:true},sourceComparisons:{},failedChecks:['imageReferenceMatches'],cgroupMemory:{'memory.current':123}};const log=console.log;console.log=()=>{};
 try{const result=await observeRecovery(async action=>{calls.push(action);if(action==='pipeline_identity')return identity;return {...status(i++),persistedFormat:{version:1,regularExternal:true},timeline:{records:[{operation:'file.persist',stage:'regular_checkpoint',rssBytes:100}]}};},{},ledger,async()=>{},'/private/report',async(_p,text)=>saved=JSON.parse(text),{identityRequest:{expectedImage:'previous'},wait:async()=>{}});
 assert.deepEqual(calls,['pipeline_identity','status','pipeline_identity','status','pipeline_identity','status']);assert.equal(saved.observations.length,3);assert.equal(saved.observations[2].identity.cgroupMemory['memory.current'],123);assert.equal(saved.observations[2].timeline.records[0].stage,'regular_checkpoint');assert.equal(result.persistedFormat.version,1);assert.equal(ledger.steps.journal_import.status,'ok');}finally{console.log=log;}
});
