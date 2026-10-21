import {test} from 'node:test';import assert from 'node:assert/strict';import {ingressStability} from './ingress-stability.mjs';
const start=Date.parse('2026-10-20T10:00:00Z');
function status(time,n=10){return{lanes:{prematch:{phase:'connected',session:{id:'one',startedAt:new Date(start-1000).toISOString()},lastSnapshotAt:new Date(start).toISOString(),updates:{lastMarketDecodedAt:new Date(time).toISOString()},consumerProgress:{active:true},ingressProgress:{received:n,acknowledged:n,processed:n,backlog:0,oldestAgeMs:0,metricWindowEndUTC:new Date(time).toISOString()},distributionObservations:[{observedAtUTC:new Date(time).toISOString(),queueDepth:0}]}}};}
test('30min requires real processing, market advance and no observation gaps; not mere ACK or queue empty',()=>{let state;for(let i=0;i<=60;i++)state=ingressStability(status(start+i*30000,10+i),state,start+i*30000);assert.equal(state.verified,true);const s=status(start+1830000,100);s.lanes.prematch.session.id='two';assert.equal(ingressStability(s,state,start+1830000).verified,false);assert.equal(ingressStability(status(start+2000000,100),state,start+2000000).verified,false);});
test('broker 501 warns; internal lag and rising backlog prevent stable result',()=>{const s=status(start);s.lanes.prematch.distributionObservations[0].queueDepth=501;assert.equal(ingressStability(s,null,start).queueAlert,true);s.lanes.prematch.distributionObservations[0].queueDepth=0;s.lanes.prematch.ingressProgress.oldestAgeMs=6000;assert.equal(ingressStability(s,null,start).verified,false);});

test('applied and checkpointed are separate; retained WAL prefix is not an unprocessed market gap',()=>{
 let previous;
 for(let i=0;i<=60;i++){
  const now=start+i*30000,s=status(now,1000+i*69),m=s.lanes.prematch.ingressProgress;
  Object.assign(m,{backlog:800,oldestAgeMs:10000,processingBacklog:0,oldestProcessingAgeMs:0,checkpointed:100+i*69});
  previous=ingressStability(s,previous,now);
 }
 assert.equal(previous.verified,true);
 const now=start+1830000,s=status(now,10000),m=s.lanes.prematch.ingressProgress;
 Object.assign(m,{backlog:1000,oldestAgeMs:11000,processingBacklog:900,oldestProcessingAgeMs:6000,checkpointed:5000});
 assert.equal(ingressStability(s,previous,now).verified,false);
 Object.assign(m,{processingBacklog:0,oldestProcessingAgeMs:0,oldestAgeMs:70000});
 assert.equal(ingressStability(s,previous,now).verified,false);
});

test('old inbox market replay is not a live market update merely because decode ran in the new session',()=>{
 const s=status(start),pm=s.lanes.prematch;pm.updates.lastMarketReceivedAt=new Date(start-60000).toISOString();
 assert.equal(ingressStability(s,null,start).reason,'CURRENT_MARKET_UPDATE_PENDING');
});
