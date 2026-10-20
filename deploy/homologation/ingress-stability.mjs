// Current-session evidence only; a quiet broker alone is never sufficient.
export function ingressStability(status,previous,now,requiredMs=1800000,laneName='prematch'){
 const lane=status.lanes?.[laneName],m=lane?.ingressProgress,session=lane?.session?.id||lane?.session?.startedAt;
 const latest=(lane?.distributionObservations||[]).filter(o=>Date.parse(o.observedAtUTC)>=Date.parse(lane?.session?.startedAt)).at(-1);
 const queueAvailable=typeof latest?.queueDepth==='number'&&now-Date.parse(latest.observedAtUTC)<90000;
 const snapshot=Date.parse(lane?.lastSnapshotAt)>=Date.parse(lane?.session?.startedAt);
 const markets=Date.parse(lane?.updates?.lastMarketDecodedAt)>=Date.parse(lane?.session?.startedAt);
 const metricCurrent=m&&Date.parse(m.metricWindowEndUTC)>=Date.parse(lane?.session?.startedAt)&&now-Date.parse(m.metricWindowEndUTC)<90000;
 const healthy=metricCurrent&&lane?.consumerProgress?.active===true&&['connected','recovering'].includes(lane.phase)&&snapshot&&markets&&m.oldestAgeMs<=5000&&m.backlog<=500&&(!queueAvailable||latest.queueDepth<=500);
 if(!healthy)return{verified:false,session,reason:!metricCurrent?'INGRESS_METRICS_NOT_CURRENT':!snapshot?'CURRENT_SNAPSHOT_PENDING':!markets?'CURRENT_MARKET_UPDATE_PENDING':'BACKLOG_OR_CONSUMER_NOT_HEALTHY',queueMetricAvailable:queueAvailable,queueAlert:queueAvailable&&latest.queueDepth>500,requiredMs};
 const continuing=previous?.since&&previous.session===session&&now-previous.lastAt<=90000;
 const state=continuing?{...previous}:{since:now,session,startReceived:m.received,startAcknowledged:m.acknowledged,startProcessed:m.processed,startMarkets:Date.parse(lane.updates.lastMarketDecodedAt),startBacklog:m.backlog,peakBacklog:m.backlog};
 const rising=continuing&&m.backlog>previous.lastBacklog?(previous.risingSamples||0)+1:0;
 if(rising>=5)return{verified:false,session,reason:'CONTINUOUS_INTERNAL_BACKLOG_GROWTH',queueMetricAvailable:queueAvailable,requiredMs};
 const elapsedMs=now-state.since,advanced=m.acknowledged>state.startAcknowledged&&m.processed>state.startProcessed&&Date.parse(lane.updates.lastMarketDecodedAt)>state.startMarkets;
 return{...state,lastAt:now,lastBacklog:m.backlog,risingSamples:rising,peakBacklog:Math.max(state.peakBacklog,m.backlog),elapsedMs,requiredMs,verified:elapsedMs>=requiredMs&&advanced&&m.backlog<=state.startBacklog+50,reason:elapsedMs<requiredMs?'PREMATCH_STABILITY_WINDOW_PENDING':!advanced?'NO_REAL_PROCESSING_OR_MARKET_ADVANCE':'PREMATCH_STABILITY_VERIFIED',queueMetricAvailable:queueAvailable,queueAlert:false};
}
