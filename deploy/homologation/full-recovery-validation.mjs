import {ingressStability} from './ingress-stability.mjs';
import {setTimeout as delay} from 'node:timers/promises';
const currentSession=(lane,since)=>Number.isFinite(since)&&Date.parse(lane?.session?.startedAt)>=since;
export function fullRecoveryResult(status,{requireSupplierOrder=false}={}){const since=Date.parse(status.validationSinceUTC),pm=status.lanes?.prematch,ip=status.lanes?.inplay,full=pm?.fullSnapshot,consumer=pm?.consumerProgress;
 const current=l=>!!l&&l.phase==='connected'&&l.recoveryProgress?.regularSnapshotReady===true&&Date.parse(l.session?.startedAt)>=since&&Date.parse(l.lastSnapshotAt)>=Date.parse(l.session?.startedAt);
 const snapshots=Number.isFinite(since)&&status.status==='snapshots_ready'&&current(pm)&&current(ip)&&full?.method==='disk_spool_two_pass'&&Date.parse(full.completedAt)>=Date.parse(pm.session?.startedAt);
 const ipConsumer=ip?.consumerProgress;const inplayConsumed=currentSession(ip,since)&&!!ipConsumer&&ipConsumer.acknowledgedMessages>0&&Date.parse(ipConsumer.lastAckAt)>=Date.parse(ip?.session?.startedAt);
 const consumed=currentSession(pm,since)&&!!consumer&&consumer.acknowledgedMessages>0&&Date.parse(consumer.lastAckAt)>=Date.parse(pm?.session?.startedAt);
 const registered=l=>currentSession(l,since)&&['connected','recovering'].includes(l?.phase)&&l?.consumerProgress?.active===true&&Date.parse(l.consumerProgress.registeredAt)>=Date.parse(l?.session?.startedAt);
 const distribution=l=>currentSession(l,since)&&(l?.distributionObservations||[]).some(o=>o.stage==='after_propagation'&&o.bodyIsDistributionOn===true&&o.sdkIsDistributionOn===true&&Date.parse(o.observedAtUTC)>=Date.parse(l?.session?.startedAt));
 const market=l=>currentSession(l,since)&&Date.parse((l?.updates?.lastMarketReceivedAt??l?.updates?.lastMarketDecodedAt))>=Date.parse(l?.session?.startedAt);
 const registrationVerified=registered(pm)&&registered(ip),distributionVerified=distribution(pm)&&distribution(ip),marketUpdatesVerified=market(pm)&&market(ip);
 const registrationEvidence=Object.fromEntries(Object.entries(status.lanes||{}).map(([lane,l])=>[lane,{phase:l.phase,brokerConsumerCount:l.distributionObservations?.at(-1)?.consumerCount??null,checkpointActive:l.consumerProgress?.active??null,registeredAt:l.consumerProgress?.registeredAt??null,sessionStartedAt:l.session?.startedAt??null,registrationTimeCurrent:Date.parse(l.consumerProgress?.registeredAt)>=Date.parse(l.session?.startedAt),acknowledgedMessages:l.consumerProgress?.acknowledgedMessages??null,lastAckAt:l.consumerProgress?.lastAckAt??null,registrationVerified:registered(l),deliveryEvidence:(lane==='prematch'?consumed:inplayConsumed)?'persisted_and_acknowledged':'not_observed'}]));
 return{registrationEvidence,consumerRegistrationObserved:registrationVerified,distributionActiveVerified:distributionVerified,marketUpdatesVerified,ackEvidenceMeaning:'delivery_persisted_and_acknowledged_only',snapshotsVerified:!!snapshots,continuousConsumptionObserved:registered(pm)&&consumed&&full?.ackedDuringRecovery>0,ackObserved:{prematch:consumed,inplay:inplayConsumed},consumerActiveObserved:registered(pm)&&consumed,inplayConsumerActiveObserved:registered(ip)&&inplayConsumed,projectionOddsAvailable:snapshots&&status.selectableSelections>0,selectableSelections:status.selectableSelections??0,projectionByLane:status.projectionByLane,
 newAMQP320:Object.entries(status.lanes||{}).flatMap(([lane,l])=>(l.sessionEnds||[]).filter(e=>Date.parse(e.endedAt)>=since&&e.diagnostic?.amqpCode===320).map(e=>({lane,endedAtUTC:e.endedAt,amqpCode:320}))),
 reason:Object.values(status.lanes||{}).some(l=>currentSession(l,since)&&l.phase==='error'&&l.diagnostic?.category&&l.diagnostic.category!=='rate_limited')?'CURRENT_LANE_ERROR_SEE_DIAGNOSTIC':requireSupplierOrder&&!distributionVerified?'DISTRIBUTION_ACTIVE_NOT_VERIFIED':requireSupplierOrder&&!registrationVerified?'CONSUMER_REGISTRATION_NOT_VERIFIED':!snapshots?'SNAPSHOT_RECOVERY_PENDING':(!consumed||!inplayConsumed)?'NO_CURRENT_ACK_EVIDENCE':requireSupplierOrder&&!marketUpdatesVerified?'NO_CURRENT_MARKET_UPDATE_EVIDENCE':status.selectableSelections<=0?'NO_CURRENT_SELECTABLE_ODDS':full?.ackedDuringRecovery<=0?'NO_DELIVERY_DURING_RECOVERY_TO_VERIFY_CONTINUITY':'FULL_RECOVERY_FEEDS_AND_ODDS_VERIFIED'};}
export async function validateFullRecovery(remote,handoff,ledger,save,progress,{durationMs=45*60000,wait=delay,now=Date.now,requireSupplierOrder=false,allowTransientReconnect=false,stableForMs=0,requireIngress=false,compact=false,retirementDeadlineMs=0}={}){
 const until=now()+durationMs;let current,result,stable,zeroSince,retirement;
 while(now()<until){current=await remote('status',{handoff});result=fullRecoveryResult(current,{requireSupplierOrder});ledger.lastValidation=current;ledger.fullRecoveryValidation={at:new Date().toISOString(),...result};await save();
  if(allowTransientReconnect){
   if(result.newAMQP320.length>=2){result.reason='CURRENT_AMQP_320_AFTER_LOCAL_THROUGHPUT_FIX';}
   else if(result.reason==='CURRENT_LANE_ERROR_SEE_DIAGNOSTIC'&&Object.values(current.lanes||{}).filter(l=>l.phase==='error').every(l=>/^amqp\./.test(l.diagnostic?.operation||'')&&(['network','unexpected'].includes(l.diagnostic?.category))&&!l.diagnostic?.deliveryDisposition))result.reason='AUTOMATIC_SESSION_RECOVERY_PENDING';
  }
  if(!requireIngress&&stableForMs>0&&result.reason==='FULL_RECOVERY_FEEDS_AND_ODDS_VERIFIED'){
   const sessions=JSON.stringify(Object.values(current.lanes||{}).map(l=>l.session?.id||l.session?.startedAt));
   if(!stable||stable.sessions!==sessions)stable={since:now(),sessions,counts:Object.fromEntries(Object.entries(current.lanes).map(([k,l])=>[k,l.consumerProgress?.acknowledgedMessages||0])),markets:Object.fromEntries(Object.entries(current.lanes).map(([k,l])=>[k,Date.parse((l.updates?.lastMarketReceivedAt??l.updates?.lastMarketDecodedAt))||0]))};
   result.stabilityElapsedMs=now()-stable.since;result.stabilityRequiredMs=stableForMs;
   if(result.stabilityElapsedMs<stableForMs)result.reason='RECOVERY_STABILITY_WINDOW_PENDING';
   else if(!Object.entries(current.lanes).every(([k,l])=>(l.consumerProgress?.acknowledgedMessages||0)>stable.counts[k]))result.reason='NO_ACK_ADVANCE_DURING_STABILITY_WINDOW';
   else if(!Object.entries(current.lanes).every(([k,l])=>(Date.parse((l.updates?.lastMarketReceivedAt??l.updates?.lastMarketDecodedAt))||0)>stable.markets[k]))result.reason='NO_MARKET_UPDATE_DURING_STABILITY_WINDOW';
   else result.stableConsumptionVerified=true;
  }else if(result.reason!=='FULL_RECOVERY_FEEDS_AND_ODDS_VERIFIED')stable=undefined;
  if(!requireIngress&&allowTransientReconnect&&result.newAMQP320.length<2&&result.snapshotsVerified&&result.consumerRegistrationObserved&&current.selectableSelections===0){zeroSince??=now();if(now()-zeroSince>=120000)result.reason='SNAPSHOTS_READY_NO_CURRENT_SELECTABLE_MARKETS';}else zeroSince=undefined;
  if(requireIngress){
    ledger.ingressStability=ingressStability(current,ledger.ingressStability,now(),stableForMs);
    ledger.inplayIngressStability=ingressStability(current,ledger.inplayIngressStability,now(),stableForMs,'inplay');
    result.prematchStability=ledger.ingressStability;
    result.inplayStability={...ledger.inplayIngressStability,reason:ledger.inplayIngressStability.reason?.replaceAll('PREMATCH','INPLAY')};
    result.ingressProgress=Object.fromEntries(Object.entries(current.lanes||{}).map(([k,l])=>[k,l.ingressProgress]));
    if(result.reason==='FULL_RECOVERY_FEEDS_AND_ODDS_VERIFIED'){
      if(!ledger.ingressStability.verified)result.reason='INGRESS_STABILITY_PENDING';
      else if(!ledger.inplayIngressStability.verified)result.reason='INPLAY_STABILITY_PENDING';
      else result.stableConsumptionVerified=true;
    }
    if(ledger.ingressStability.queueAlert)result.queueAlertThreshold=500;
  }
  if(retirementDeadlineMs>0){
   const pm=current.lanes?.prematch,m=pm?.ingressProgress;
   if(m&&Number.isFinite(m.backlog)&&m.backlog>0&&Date.parse(m.metricWindowEndUTC)>=Date.parse(current.validationSinceUTC)){
    const actor=m.ingressActorId||pm.session?.id||pm.session?.startedAt;
    if(!retirement)retirement={at:now(),backlog:m.backlog,actor,checkpointed:m.checkpointed||0};
    const advanced=m.backlog<retirement.backlog||actor===retirement.actor&&(m.checkpointed||0)>retirement.checkpointed;
    if(advanced)retirement={at:now(),backlog:m.backlog,actor,checkpointed:m.checkpointed||0};
    else if(now()-retirement.at>=retirementDeadlineMs)result.reason='DURABLE_PREMATCH_RETIREMENT_NOT_VERIFIED_WITHIN_DEADLINE';
    result.retirementEvidence={unadvancedForMs:now()-retirement.at,deadlineMs:retirementDeadlineMs,backlog:m.backlog,checkpointed:m.checkpointed||0};
   }
  }
  ledger.fullRecoveryValidation={at:new Date().toISOString(),...result};await save();
  if(compact)console.log(JSON.stringify({operation:'cutover.resumable',stage:'full_recovery_validation',reason:result.reason,checkpointReader:current.checkpointReader,registrationEvidence:result.registrationEvidence,snapshotsVerified:result.snapshotsVerified,marketUpdatesVerified:result.marketUpdatesVerified,stableConsumptionVerified:result.stableConsumptionVerified??false,selectableSelections:result.selectableSelections,workerRunning:current.workers?.length===1&&current.workers[0].running===true,workerRestarted:false,posnetChanged:false}));
  else console.log(JSON.stringify({operation:'cutover.resumable',stage:'full_recovery_validation',...result,recentErrors:current.evidence?.recentErrors,prematch:{distributionObservations:current.lanes?.prematch?.distributionObservations,updates:current.lanes?.prematch?.updates,diagnostic:current.lanes?.prematch?.diagnostic,sessionEnds:current.lanes?.prematch?.sessionEnds,phase:current.lanes?.prematch?.phase,fullSnapshot:current.lanes?.prematch?.fullSnapshot,consumerProgress:current.lanes?.prematch?.consumerProgress,persistenceProgress:current.lanes?.prematch?.persistenceProgress,lastSnapshotDiagnostic:current.lanes?.prematch?.lastSnapshotDiagnostic},inplay:{distributionObservations:current.lanes?.inplay?.distributionObservations,updates:current.lanes?.inplay?.updates,diagnostic:current.lanes?.inplay?.diagnostic,lastSnapshotDiagnostic:current.lanes?.inplay?.lastSnapshotDiagnostic,sessionEnds:current.lanes?.inplay?.sessionEnds,phase:current.lanes?.inplay?.phase,consumerProgress:current.lanes?.inplay?.consumerProgress,persistenceProgress:current.lanes?.inplay?.persistenceProgress,lastSnapshotAt:current.lanes?.inplay?.lastSnapshotAt},workerRunning:current.workers?.length===1&&current.workers[0].running===true,macMustRemainStopped:true,posnetChanged:false,iframeAuthenticated:false,progressFile:progress}));
  if(current.workers?.length!==1||!current.workers[0].running||current.workers[0].oomKilled)throw Error('AWS_WORKER_EXITED_NO_BLIND_RESTART');
  if(['DURABLE_PREMATCH_RETIREMENT_NOT_VERIFIED_WITHIN_DEADLINE','CURRENT_LANE_ERROR_SEE_DIAGNOSTIC','CURRENT_AMQP_320_AFTER_LOCAL_THROUGHPUT_FIX','NO_ACK_ADVANCE_DURING_STABILITY_WINDOW','NO_MARKET_UPDATE_DURING_STABILITY_WINDOW','SNAPSHOTS_READY_NO_CURRENT_SELECTABLE_MARKETS'].includes(result.reason))break;
  if(result.reason==='FULL_RECOVERY_FEEDS_AND_ODDS_VERIFIED')break;
  if(requireIngress&&ledger.ingressStability?.verified&&!result.marketUpdatesVerified){result.reason='PREMATCH_STABLE_INPLAY_MARKET_UPDATES_PENDING';break;}
  if(current.lanes?.prematch?.phase==='error'&&result.newAMQP320.length>=2){result.reason='CURRENT_AMQP_320_AFTER_CONTINUOUS_CONSUMER_FIX';break;}
  const pm=current.lanes?.prematch,d=pm?.lastSnapshotDiagnostic;
  if(currentSession(pm,Date.parse(current.validationSinceUTC))&&Date.parse(pm?.lastSnapshotErrorAt)>=Date.parse(pm?.session?.startedAt)&&d?.category&&d.category!=='rate_limited'&&d.reason!=='memory_budget_exceeded'){result.reason='CURRENT_SNAPSHOT_REJECTED_SEE_SANITIZED_DIAGNOSTIC';break;}
  if(Object.values(current.lanes||{}).some(l=>currentSession(l,Date.parse(current.validationSinceUTC))&&l.phase==='error'&&l.diagnostic?.deliveryDisposition==='requeue_requested')){result.reason='MESSAGE_REQUEUED_HANDLER_REVIEW_REQUIRED';break;}
  await wait(Math.max(0,30000-(current.checkpointReader?.readDurationMs||0)));
 }
 const verified=result?.reason==='FULL_RECOVERY_FEEDS_AND_ODDS_VERIFIED';ledger.currentStage=verified?'full_recovery_verified':'full_recovery_pending';ledger.steps.full_validation={status:verified?'ok':'pending',result};await save();
 console.log(JSON.stringify({operation:'cutover.resumable',stage:ledger.currentStage,status:verified?'verified':'pending',...result,macWorkerStopped:true,posnetChanged:false,iframeAuthenticated:false,progressFile:progress}));if(!verified)process.exitCode=2;
}
