import {setTimeout as delay} from 'node:timers/promises';
const lanes=['prematch','inplay'];
export function sampleRecovery(status){
 const result={at:status.checkpointReader?.observedAtUTC||new Date().toISOString(),workerRunning:status.workers?.length===1&&status.workers[0].running===true,lanes:{},persistedFormat:status.persistedFormat,publication:status.indexedPublication,timeline:status.timeline};
 for(const lane of lanes){
  const l=status.lanes?.[lane]||{},start=Date.parse(l.session?.startedAt);
  const logs=(status.timeline?.records||[]).filter(r=>r.lane===lane&&r.operation==='snapshot.events'&&r.status==='full_spool_progress'&&Date.parse(r.loggedAtUTC)>=start);
  const log=logs.at(-1),saved=l.fullSnapshot||{};
  const currentLog=log&&Date.parse(log.loggedAtUTC)>=Date.parse(saved.lastProgressAt||saved.startedAt||0);
  result.lanes[lane]={session:l.session?.id||l.session?.startedAt,sessionStartedAt:l.session?.startedAt,phase:l.phase,metrics:l.ingressProgress||{},snapshot:{...saved,...(currentLog?{stage:log.stage,bytes:log.bytes,validatedRows:log.validatedRows,appliedRows:log.appliedRows,lastProgressAt:log.loggedAtUTC}:{}),source:currentLog?'current_session_worker_log':'checkpoint',lastSnapshotAt:l.lastSnapshotAt,regularSnapshotReady:l.recoveryProgress?.regularSnapshotReady===true},diagnostic:l.diagnostic,lastSnapshotDiagnostic:l.lastSnapshotDiagnostic};
 }
 const persisted=status.lanes?.prematch?.persistenceProgress,livePersist=(status.timeline?.records||[]).filter(r=>r.operation==='file.persist').at(-1);
 result.persistence=livePersist&&Date.parse(livePersist.loggedAtUTC)>=Date.parse(persisted?.lastCompletedAt||0)?{...livePersist,source:'shared_worker_persistence_log'}:{...persisted,source:'shared_checkpoint_metric'};return result;
}
export function recoveryRates(samples,lane){
 const points=samples.map(s=>s.lanes[lane]),first=points[0],last=points.at(-1);
 const snapshotAdvanced=['bytes','validatedRows','appliedRows'].some(k=>(last.snapshot[k]||0)>(first.snapshot[k]||0))||last.snapshot.stage!==first.snapshot.stage;
 const snapshotSeconds=(Date.parse(last.snapshot.lastProgressAt)-Date.parse(first.snapshot.lastProgressAt))/1000;
 const snapshotRates=Object.fromEntries(['validatedRows','appliedRows'].map(k=>[k+'PerSecond',snapshotSeconds>0&&last.snapshot[k]>=first.snapshot[k]?(last.snapshot[k]-first.snapshot[k])/snapshotSeconds:null]));
 const base={snapshotAdvanced,snapshotRates,phase:last.phase,snapshot:last.snapshot,received:last.metrics.received,acknowledged:last.metrics.acknowledged,processed:last.metrics.processed,checkpointed:last.metrics.checkpointed,processingBacklog:last.metrics.processingBacklog,oldestProcessingAgeMs:last.metrics.oldestProcessingAgeMs,headersByType:last.metrics.headersByType,diagnostic:last.diagnostic,lastSnapshotDiagnostic:last.lastSnapshotDiagnostic};
 if(!first.session||points.some(p=>p.session!==first.session))return {...base,assessment:'SESSION_CHANGED_NO_COMPARABLE_RATE'};
 const seconds=(Date.parse(last.metrics.metricWindowEndUTC)-Date.parse(first.metrics.metricWindowEndUTC))/1000;
 if(!(seconds>0))return {...base,assessment:'NO_NEW_PERSISTED_METRIC_WINDOW',etaSeconds:null};
 const fields=['received','acknowledged','processed','checkpointed','processingBacklog'];
 if(points.some(p=>fields.some(k=>!Number.isFinite(p.metrics[k])))||fields.slice(0,4).some(k=>last.metrics[k]<first.metrics[k]))return {...base,assessment:'COUNTERS_INCOMPLETE_OR_RESET',etaSeconds:null};
 const rate=k=>(last.metrics[k]-first.metrics[k])/seconds,net=(first.metrics.processingBacklog-last.metrics.processingBacklog)/seconds;
 const intervals=points.slice(1).map((p,i)=>({dt:(Date.parse(p.metrics.metricWindowEndUTC)-Date.parse(points[i].metrics.metricWindowEndUTC))/1000,drop:points[i].metrics.processingBacklog-p.metrics.processingBacklog}));
 const consistent=intervals.every(i=>i.dt>0&&i.drop>0);
 return {...base,windowSeconds:seconds,receivePerSecond:rate('received'),ackPerSecond:rate('acknowledged'),processPerSecond:rate('processed'),checkpointPerSecond:rate('checkpointed'),netDrainPerSecond:net,snapshotAdvanced,assessment:net>0?'DRAINING':net<0?'BACKLOG_GROWING':rate('processed')>0?'PROCESSING_WITHOUT_NET_DRAIN':'NO_PROCESSING_ADVANCE',etaSeconds:net>0&&consistent?Math.ceil(last.metrics.processingBacklog/net):null,etaAssumption:'Observed arrival/service rates remain constant; excludes future snapshot/reconciliation work.'};
}
export async function observeRecovery(remote,handoff,ledger,save,reportPath,writeReport,{wait=delay,now=Date.now,identityRequest}={}){
 const samples=[];
 for(let i=0;i<3;i++){
  const identity=identityRequest?await remote('pipeline_identity',identityRequest):undefined;const end=now();const status=await remote('status',{handoff,timelineWindow:{fromUTC:new Date(end-10*60000).toISOString(),toUTC:new Date(end).toISOString()}});
  const sample=sampleRecovery(status);if(identity)sample.identity=identity;samples.push(sample);
  if(identity)console.log(JSON.stringify({operation:'cutover.pipeline_identity',sample:i+1,worker:identity.worker,expectedImage:identity.expectedImage,composeImage:identity.composeImage,expectedImageId:identity.expectedImageId,containerImageId:identity.containerImageId,failedChecks:identity.failedChecks,receipt:identity.receipt,sourceMatches:Object.fromEntries(Object.entries(identity.sourceComparisons||{}).map(([ref,v])=>[ref,v.allMatch])),cgroupMemory:identity.cgroupMemory}));
  ledger.recoveryProgressObservation={status:'measuring',samples,reportPath};await save();
  console.log(JSON.stringify({operation:'cutover.recovery_progress',sample:i+1,at:sample.at,workerRunning:sample.workerRunning,publication:sample.publication,lanes:Object.fromEntries(lanes.map(l=>[l,{phase:sample.lanes[l].phase,snapshot:sample.lanes[l].snapshot,processingBacklog:sample.lanes[l].metrics.processingBacklog,processed:sample.lanes[l].metrics.processed,checkpointed:sample.lanes[l].metrics.checkpointed}]))}));
  if(!sample.workerRunning)break;
  if(i<2)await wait(60000);
 }
 const result={readOnly:true,workerRestarted:false,providerRequests:0,posnetChanged:false,macWorkerStopped:true,workerRunning:samples.at(-1).workerRunning,samples: samples.length,...(identityRequest?{identity:samples.at(-1).identity,persistedFormat:samples.at(-1).persistedFormat}:{}),publication:samples.at(-1).publication,lanes:Object.fromEntries(lanes.map(l=>[l,recoveryRates(samples,l)])),persistence:samples.at(-1).persistence,ackMeaning:'durable_inbox_receipt_not_processing_completion',reportPath};
 await writeReport(reportPath,JSON.stringify({...result,observations:samples},null,2));ledger.recoveryProgressObservation={status:'collected',...result};await save();console.log(JSON.stringify({operation:'cutover.recovery_progress',...result,...(identityRequest?{identity:undefined}: {})}));return result;
}
