import {test} from 'node:test';import assert from 'node:assert/strict';
import {fullRecoveryResult,validateFullRecovery} from './full-recovery-validation.mjs';
const start='2026-10-19T17:00:00Z',end='2026-10-19T17:01:00Z';
function status(){const lane={phase:'connected',session:{startedAt:start},lastSnapshotAt:end,recoveryProgress:{regularSnapshotReady:true}};return{status:'snapshots_ready',validationSinceUTC:start,workers:[{running:true}],lanes:{prematch:{...lane,fullSnapshot:{method:'disk_spool_two_pass',completedAt:end,ackedDuringRecovery:10},consumerProgress:{acknowledgedMessages:11,lastAckAt:end}},inplay:{...lane,consumerProgress:{acknowledgedMessages:2,lastAckAt:end}}},selectableSelections:3};}
test('full recovery requires current snapshots, real ACK during recovery and selectable odds, not keepalive',()=>{const s=status();assert.equal(fullRecoveryResult(s).reason,'FULL_RECOVERY_FEEDS_AND_ODDS_VERIFIED');s.lanes.prematch.consumerProgress.acknowledgedMessages=0;assert.equal(fullRecoveryResult(s).reason,'NO_CURRENT_ACK_EVIDENCE');s.lanes.prematch.consumerProgress.acknowledgedMessages=11;s.selectableSelections=0;assert.equal(fullRecoveryResult(s).reason,'NO_CURRENT_SELECTABLE_ODDS');s.selectableSelections=3;s.lanes.inplay.lastSnapshotAt='2026-10-19T16:00:00Z';assert.equal(fullRecoveryResult(s).snapshotsVerified,false);});
test('validation only reads status and preserves completed migration steps',async()=>{const ledger={steps:{local_exit:{status:'ok'},journal_import:{status:'ok'}}},before=JSON.stringify(ledger.steps),calls=[];await validateFullRecovery(async action=>{calls.push(action);return status();},{},ledger,async()=>{},'/private/progress',{durationMs:100});assert.deepEqual(calls,['status']);assert.equal(JSON.stringify({local_exit:ledger.steps.local_exit,journal_import:ledger.steps.journal_import}),before);assert.equal(ledger.steps.full_validation.status,'ok');});
test('lane startup failure stops on first observation and includes live diagnostics, not an empty snapshot diagnostic',async()=>{
 const s=status();s.status='recovering';s.lanes.prematch.phase='error';s.lanes.prematch.diagnostic={operation:'amqp.prefetch',category:'network',networkCode:'ECONNRESET'};s.lanes.prematch.lastSnapshotDiagnostic={};
 const ledger={steps:{local_exit:{status:'ok'}}};let waits=0,calls=0;const original=console.log,output=[];console.log=v=>output.push(JSON.parse(v));
 try{await validateFullRecovery(async()=>{calls++;return s;},{},ledger,async()=>{},'/private/progress',{durationMs:1000,wait:async()=>{waits++;}});}finally{console.log=original;process.exitCode=0;}
 assert.equal(calls,1);assert.equal(waits,0);assert.equal(ledger.steps.local_exit.status,'ok');assert.equal(output[0].prematch.diagnostic.operation,'amqp.prefetch');assert.equal(output.at(-1).reason,'CURRENT_LANE_ERROR_SEE_DIAGNOSTIC');assert.equal(output.at(-1).snapshotsVerified,false);
});
test('no ACK in an idle lane is absence of delivery evidence, not proof of a failed subscription',()=>{const s=status();s.lanes.prematch.consumerProgress.acknowledgedMessages=0;assert.equal(fullRecoveryResult(s).consumerActiveObserved,false);assert.equal(fullRecoveryResult(s).reason,'NO_CURRENT_ACK_EVIDENCE');});

test('supplier confirmation requires distribution, registered consumers and current market updates in both lanes',()=>{
 const s=status(),options={requireSupplierOrder:true};
 assert.equal(fullRecoveryResult(s,options).reason,'DISTRIBUTION_ACTIVE_NOT_VERIFIED');
 for(const lane of Object.values(s.lanes))lane.distributionObservations=[{stage:'after_propagation',observedAtUTC:end,bodyIsDistributionOn:true,sdkIsDistributionOn:true}];
 assert.equal(fullRecoveryResult(s,options).reason,'CONSUMER_REGISTRATION_NOT_VERIFIED');
 for(const lane of Object.values(s.lanes))lane.consumerProgress={...lane.consumerProgress,active:true,registeredAt:end};
 assert.equal(fullRecoveryResult(s,options).reason,'NO_CURRENT_MARKET_UPDATE_EVIDENCE');
 for(const lane of Object.values(s.lanes))lane.updates={lastControlDecodedAt:end};
 assert.equal(fullRecoveryResult(s,options).reason,'NO_CURRENT_MARKET_UPDATE_EVIDENCE');
 for(const lane of Object.values(s.lanes))lane.updates.lastMarketDecodedAt=end;
 assert.equal(fullRecoveryResult(s,options).reason,'FULL_RECOVERY_FEEDS_AND_ODDS_VERIFIED');
 s.lanes.inplay.consumerProgress.active=false;assert.equal(fullRecoveryResult(s,options).consumerRegistrationObserved,false);
});

test('one transient forced close uses runtime reconnect, two post-fix closes stop with concrete reason without restart',async()=>{
 const first=status();first.status='recovering';first.lanes.prematch.phase='error';first.lanes.prematch.diagnostic={operation:'amqp.connection',category:'unexpected',amqpCode:320};first.lanes.prematch.sessionEnds=[{endedAt:end,diagnostic:{amqpCode:320}}];let calls=0;const ledger={steps:{}};
 await validateFullRecovery(async()=>++calls===1?first:status(),{},ledger,async()=>{},'/private/progress',{durationMs:1000,allowTransientReconnect:true,wait:async()=>{}});assert.equal(calls,2);assert.equal(ledger.steps.full_validation.status,'ok');
 first.lanes.prematch.sessionEnds.push({endedAt:'2026-10-19T17:02:00Z',diagnostic:{amqpCode:320}});const next={steps:{}};const previous=process.exitCode;
 try{await validateFullRecovery(async()=>first,{},next,async()=>{},'/private/progress',{durationMs:1000,allowTransientReconnect:true,wait:async()=>assert.fail('do not blindly wait after repeated 320')});assert.equal(next.fullRecoveryValidation.reason,'CURRENT_AMQP_320_AFTER_LOCAL_THROUGHPUT_FIX');}finally{process.exitCode=previous;}
});

test('stable recovery requires new ACK and market updates in BOTH lanes during the observation window',async()=>{
 for(const changes of [true,false]){
  let clock=0,calls=0;const ledger={steps:{}},previous=process.exitCode;
  try{await validateFullRecovery(async()=>{const s=status();calls++;for(const l of Object.values(s.lanes)){l.consumerProgress.acknowledgedMessages+=calls;l.updates={lastMarketDecodedAt:changes?new Date(Date.parse(end)+clock).toISOString():end};}return s;},{},ledger,async()=>{},'/private/progress',{durationMs:200000,stableForMs:120000,now:()=>clock,wait:async()=>{clock+=60000;}});assert.equal(calls,3);assert.equal(ledger.fullRecoveryValidation.stableConsumptionVerified===true,changes);assert.equal(ledger.fullRecoveryValidation.reason,changes?'FULL_RECOVERY_FEEDS_AND_ODDS_VERIFIED':'NO_MARKET_UPDATE_DURING_STABILITY_WINDOW');}
  finally{process.exitCode=previous;}
 }
});

test('completed snapshots but no selectable markets finish with evidence instead of another long wait',async()=>{
 let clock=0,calls=0;const ledger={steps:{}},previous=process.exitCode;
 try{await validateFullRecovery(async()=>{calls++;const s=status();s.selectableSelections=0;for(const l of Object.values(s.lanes))l.consumerProgress={...l.consumerProgress,active:true,registeredAt:end};return s;},{},ledger,async()=>{},'/private/progress',{durationMs:45*60000,allowTransientReconnect:true,now:()=>clock,wait:async()=>{clock+=60000;}});assert.equal(calls,3);assert.equal(ledger.fullRecoveryValidation.reason,'SNAPSHOTS_READY_NO_CURRENT_SELECTABLE_MARKETS');assert.equal(ledger.fullRecoveryValidation.snapshotsVerified,true);}finally{process.exitCode=previous;}
});

test('historical ACKs never label an inactive or stopped consumer active',()=>{const s=status();s.lanes.prematch.consumerProgress={...s.lanes.prematch.consumerProgress,active:false,registeredAt:end};s.lanes.inplay.consumerProgress={...s.lanes.inplay.consumerProgress,active:true,registeredAt:end};s.lanes.inplay.phase='stopped';const r=fullRecoveryResult(s);assert.equal(r.ackObserved.prematch,true);assert.equal(r.consumerActiveObserved,false);assert.equal(r.inplayConsumerActiveObserved,false);assert.equal(r.continuousConsumptionObserved,false);assert.equal(r.consumerRegistrationObserved,false);});

test('durable stability survives periodic snapshot recovery and independently verifies both lanes',async()=>{
 let clock=Date.parse(end),calls=0;const ledger={steps:{}};const out=console.log;console.log=()=>{};
 try{await validateFullRecovery(async()=>{const s=status();calls++;for(const lane of Object.values(s.lanes)){lane.consumerProgress={...lane.consumerProgress,active:true,registeredAt:end,acknowledgedMessages:100+calls,lastAckAt:new Date(clock).toISOString()};lane.updates={lastMarketDecodedAt:new Date(clock).toISOString()};lane.ingressProgress={received:100+calls,acknowledged:100+calls,processed:100+calls,backlog:0,oldestAgeMs:0,metricWindowEndUTC:new Date(clock).toISOString()};lane.distributionObservations=[{stage:'after_propagation',observedAtUTC:new Date(clock).toISOString(),bodyIsDistributionOn:true,sdkIsDistributionOn:true,queueDepth:0}];if(calls===2)lane.phase='recovering';}if(calls===2)s.status='recovering';return s;},{},ledger,async()=>{},'/private/progress',{requireIngress:true,requireSupplierOrder:true,stableForMs:90000,durationMs:180000,now:()=>clock,wait:async()=>{clock+=30000;}});}finally{console.log=out;process.exitCode=0;}
 assert.equal(ledger.steps.full_validation.status,'ok');assert.equal(ledger.ingressStability.verified,true);assert.equal(ledger.inplayIngressStability.verified,true);assert.equal(calls,4);
});
test('broker count one is separate from current worker registration and ACK evidence',()=>{
 const s=status();for(const l of Object.values(s.lanes)){l.distributionObservations=[{stage:'after_propagation',observedAtUTC:end,bodyIsDistributionOn:true,sdkIsDistributionOn:true,consumerCount:1}];l.consumerProgress={acknowledgedMessages:0};}
 let r=fullRecoveryResult(s,{requireSupplierOrder:true});
 assert.equal(r.reason,'CONSUMER_REGISTRATION_NOT_VERIFIED');assert.equal(r.registrationEvidence.prematch.brokerConsumerCount,1);assert.equal(r.registrationEvidence.prematch.checkpointActive,null);assert.equal(r.registrationEvidence.prematch.deliveryEvidence,'not_observed');
 for(const l of Object.values(s.lanes))Object.assign(l.consumerProgress,{active:true,registeredAt:end});
 r=fullRecoveryResult(s,{requireSupplierOrder:true});assert.equal(r.consumerRegistrationObserved,true);assert.equal(r.ackObserved.prematch,false);assert.equal(r.reason,'NO_CURRENT_ACK_EVIDENCE');
});

test('restored pre-activation errors and ACKs never become current failure or recovery evidence',()=>{
 const s=status();s.validationSinceUTC='2026-10-22T04:44:14.076679Z';
 for(const lane of Object.values(s.lanes)){lane.phase='error';lane.diagnostic={category:'network',operation:'distribution.status'};lane.consumerProgress.active=true;lane.consumerProgress.registeredAt=start;lane.updates={lastMarketDecodedAt:end};lane.distributionObservations=[{stage:'after_propagation',observedAtUTC:end,bodyIsDistributionOn:true,sdkIsDistributionOn:true}];}
 const result=fullRecoveryResult(s);assert.equal(result.reason,'SNAPSHOT_RECOVERY_PENDING');assert.equal(result.snapshotsVerified,false);assert.equal(result.consumerRegistrationObserved,false);assert.equal(result.marketUpdatesVerified,false);assert.equal(result.distributionActiveVerified,false);assert.deepEqual(result.ackObserved,{prematch:false,inplay:false});
 s.lanes.prematch.session.startedAt=s.validationSinceUTC;assert.equal(fullRecoveryResult(s).reason,'CURRENT_LANE_ERROR_SEE_DIAGNOSTIC');
});
