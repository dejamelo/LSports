import {setTimeout as delay} from 'node:timers/promises';
export function fullRecoveryResult(status,{requireSupplierOrder=false}={}){const since=Date.parse(status.validationSinceUTC),pm=status.lanes?.prematch,ip=status.lanes?.inplay,full=pm?.fullSnapshot,consumer=pm?.consumerProgress;
 const current=l=>!!l&&l.phase==='connected'&&l.recoveryProgress?.regularSnapshotReady===true&&Date.parse(l.session?.startedAt)>=since&&Date.parse(l.lastSnapshotAt)>=Date.parse(l.session?.startedAt);
 const snapshots=Number.isFinite(since)&&status.status==='snapshots_ready'&&current(pm)&&current(ip)&&full?.method==='disk_spool_two_pass'&&Date.parse(full.completedAt)>=Date.parse(pm.session?.startedAt);
 const ipConsumer=ip?.consumerProgress;const inplayConsumed=!!ipConsumer&&ipConsumer.acknowledgedMessages>0&&Date.parse(ipConsumer.lastAckAt)>=Date.parse(ip?.session?.startedAt);
 const consumed=!!consumer&&consumer.acknowledgedMessages>0&&Date.parse(consumer.lastAckAt)>=Date.parse(pm?.session?.startedAt);
 const registered=l=>['connected','recovering'].includes(l?.phase)&&l?.consumerProgress?.active===true&&Date.parse(l.consumerProgress.registeredAt)>=Date.parse(l?.session?.startedAt);
 const distribution=l=>(l?.distributionObservations||[]).some(o=>o.stage==='after_propagation'&&o.bodyIsDistributionOn===true&&o.sdkIsDistributionOn===true&&Date.parse(o.observedAtUTC)>=Date.parse(l?.session?.startedAt));
 const market=l=>Date.parse(l?.updates?.lastMarketDecodedAt)>=Date.parse(l?.session?.startedAt);
 const registrationVerified=registered(pm)&&registered(ip),distributionVerified=distribution(pm)&&distribution(ip),marketUpdatesVerified=market(pm)&&market(ip);
 return{consumerRegistrationObserved:registrationVerified,distributionActiveVerified:distributionVerified,marketUpdatesVerified,ackEvidenceMeaning:'delivery_persisted_and_acknowledged_only',snapshotsVerified:!!snapshots,continuousConsumptionObserved:registered(pm)&&consumed&&full?.ackedDuringRecovery>0,ackObserved:{prematch:consumed,inplay:inplayConsumed},consumerActiveObserved:registered(pm)&&consumed,inplayConsumerActiveObserved:registered(ip)&&inplayConsumed,projectionOddsAvailable:snapshots&&status.selectableSelections>0,selectableSelections:status.selectableSelections??0,projectionByLane:status.projectionByLane,
 newAMQP320:Object.entries(status.lanes||{}).flatMap(([lane,l])=>(l.sessionEnds||[]).filter(e=>Date.parse(e.endedAt)>=since&&e.diagnostic?.amqpCode===320).map(e=>({lane,endedAtUTC:e.endedAt,amqpCode:320}))),
 reason:Object.values(status.lanes||{}).some(l=>l.phase==='error'&&l.diagnostic?.category&&l.diagnostic.category!=='rate_limited')?'CURRENT_LANE_ERROR_SEE_DIAGNOSTIC':requireSupplierOrder&&!distributionVerified?'DISTRIBUTION_ACTIVE_NOT_VERIFIED':requireSupplierOrder&&!registrationVerified?'CONSUMER_REGISTRATION_NOT_VERIFIED':!snapshots?'SNAPSHOT_RECOVERY_PENDING':(!consumed||!inplayConsumed)?'NO_CURRENT_ACK_EVIDENCE':requireSupplierOrder&&!marketUpdatesVerified?'NO_CURRENT_MARKET_UPDATE_EVIDENCE':status.selectableSelections<=0?'NO_CURRENT_SELECTABLE_ODDS':full?.ackedDuringRecovery<=0?'NO_DELIVERY_DURING_RECOVERY_TO_VERIFY_CONTINUITY':'FULL_RECOVERY_FEEDS_AND_ODDS_VERIFIED'};}
export async function validateFullRecovery(remote,handoff,ledger,save,progress,{durationMs=45*60000,wait=delay,now=Date.now,requireSupplierOrder=false,allowTransientReconnect=false,stableForMs=0}={}){
 const until=now()+durationMs;let current,result,stable,zeroSince;
 while(now()<until){current=await remote('status',{handoff});result=fullRecoveryResult(current,{requireSupplierOrder});ledger.lastValidation=current;ledger.fullRecoveryValidation={at:new Date().toISOString(),...result};await save();
  if(allowTransientReconnect){
   if(result.newAMQP320.length>=2){result.reason='CURRENT_AMQP_320_AFTER_LOCAL_THROUGHPUT_FIX';}
   else if(result.reason==='CURRENT_LANE_ERROR_SEE_DIAGNOSTIC'&&Object.values(current.lanes||{}).filter(l=>l.phase==='error').every(l=>/^amqp\./.test(l.diagnostic?.operation||'')&&(['network','unexpected'].includes(l.diagnostic?.category))&&!l.diagnostic?.deliveryDisposition))result.reason='AUTOMATIC_SESSION_RECOVERY_PENDING';
  }
  if(stableForMs>0&&result.reason==='FULL_RECOVERY_FEEDS_AND_ODDS_VERIFIED'){
   const sessions=JSON.stringify(Object.values(current.lanes||{}).map(l=>l.session?.id||l.session?.startedAt));
   if(!stable||stable.sessions!==sessions)stable={since:now(),sessions,counts:Object.fromEntries(Object.entries(current.lanes).map(([k,l])=>[k,l.consumerProgress?.acknowledgedMessages||0])),markets:Object.fromEntries(Object.entries(current.lanes).map(([k,l])=>[k,Date.parse(l.updates?.lastMarketDecodedAt)||0]))};
   result.stabilityElapsedMs=now()-stable.since;result.stabilityRequiredMs=stableForMs;
   if(result.stabilityElapsedMs<stableForMs)result.reason='RECOVERY_STABILITY_WINDOW_PENDING';
   else if(!Object.entries(current.lanes).every(([k,l])=>(l.consumerProgress?.acknowledgedMessages||0)>stable.counts[k]))result.reason='NO_ACK_ADVANCE_DURING_STABILITY_WINDOW';
   else if(!Object.entries(current.lanes).every(([k,l])=>(Date.parse(l.updates?.lastMarketDecodedAt)||0)>stable.markets[k]))result.reason='NO_MARKET_UPDATE_DURING_STABILITY_WINDOW';
   else result.stableConsumptionVerified=true;
  }else if(result.reason!=='FULL_RECOVERY_FEEDS_AND_ODDS_VERIFIED')stable=undefined;
  if(allowTransientReconnect&&result.newAMQP320.length<2&&result.snapshotsVerified&&result.consumerRegistrationObserved&&current.selectableSelections===0){zeroSince??=now();if(now()-zeroSince>=120000)result.reason='SNAPSHOTS_READY_NO_CURRENT_SELECTABLE_MARKETS';}else zeroSince=undefined;
  ledger.fullRecoveryValidation={at:new Date().toISOString(),...result};await save();
  console.log(JSON.stringify({operation:'cutover.resumable',stage:'full_recovery_validation',...result,recentErrors:current.evidence?.recentErrors,prematch:{distributionObservations:current.lanes?.prematch?.distributionObservations,updates:current.lanes?.prematch?.updates,diagnostic:current.lanes?.prematch?.diagnostic,sessionEnds:current.lanes?.prematch?.sessionEnds,phase:current.lanes?.prematch?.phase,fullSnapshot:current.lanes?.prematch?.fullSnapshot,consumerProgress:current.lanes?.prematch?.consumerProgress,persistenceProgress:current.lanes?.prematch?.persistenceProgress,lastSnapshotDiagnostic:current.lanes?.prematch?.lastSnapshotDiagnostic},inplay:{distributionObservations:current.lanes?.inplay?.distributionObservations,updates:current.lanes?.inplay?.updates,diagnostic:current.lanes?.inplay?.diagnostic,lastSnapshotDiagnostic:current.lanes?.inplay?.lastSnapshotDiagnostic,sessionEnds:current.lanes?.inplay?.sessionEnds,phase:current.lanes?.inplay?.phase,consumerProgress:current.lanes?.inplay?.consumerProgress,persistenceProgress:current.lanes?.inplay?.persistenceProgress,lastSnapshotAt:current.lanes?.inplay?.lastSnapshotAt},workerRunning:current.workers?.length===1&&current.workers[0].running===true,macMustRemainStopped:true,posnetChanged:false,iframeAuthenticated:false,progressFile:progress}));
  if(current.workers?.length!==1||!current.workers[0].running||current.workers[0].oomKilled)throw Error('AWS_WORKER_EXITED_NO_BLIND_RESTART');
  if(['CURRENT_LANE_ERROR_SEE_DIAGNOSTIC','CURRENT_AMQP_320_AFTER_LOCAL_THROUGHPUT_FIX','NO_ACK_ADVANCE_DURING_STABILITY_WINDOW','NO_MARKET_UPDATE_DURING_STABILITY_WINDOW','SNAPSHOTS_READY_NO_CURRENT_SELECTABLE_MARKETS'].includes(result.reason))break;
  if(result.reason==='FULL_RECOVERY_FEEDS_AND_ODDS_VERIFIED')break;
  if(current.lanes?.prematch?.phase==='error'&&result.newAMQP320.length>=2){result.reason='CURRENT_AMQP_320_AFTER_CONTINUOUS_CONSUMER_FIX';break;}
  const pm=current.lanes?.prematch,d=pm?.lastSnapshotDiagnostic;
  if(Date.parse(pm?.lastSnapshotErrorAt)>=Date.parse(pm?.session?.startedAt)&&d?.category&&d.category!=='rate_limited'&&d.reason!=='memory_budget_exceeded'){result.reason='CURRENT_SNAPSHOT_REJECTED_SEE_SANITIZED_DIAGNOSTIC';break;}
  if(Object.values(current.lanes||{}).some(l=>l.phase==='error'&&l.diagnostic?.deliveryDisposition==='requeue_requested')){result.reason='MESSAGE_REQUEUED_HANDLER_REVIEW_REQUIRED';break;}
  await wait(30000);
 }
 const verified=result?.reason==='FULL_RECOVERY_FEEDS_AND_ODDS_VERIFIED';ledger.currentStage=verified?'full_recovery_verified':'full_recovery_pending';ledger.steps.full_validation={status:verified?'ok':'pending',result};await save();
 console.log(JSON.stringify({operation:'cutover.resumable',stage:ledger.currentStage,status:verified?'verified':'pending',...result,macWorkerStopped:true,posnetChanged:false,iframeAuthenticated:false,progressFile:progress}));if(!verified)process.exitCode=2;
}
