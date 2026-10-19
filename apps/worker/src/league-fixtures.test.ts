import {test} from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import type amqp from 'amqplib';import type {ConsumeMessage} from 'amqplib';
import {decodeMessage} from './messages.js';import {TradeState} from './state.js';import {checkpoint,restore} from './persistence.js';import {session} from './connected.js';
import {knownEntityKeys} from 'trade360-nodejs-sdk';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const stamp='2026-10-19T06:00:00.0173136';
const body=()=>({Competition:{Id:9001,Name:'ISOLATED league',Type:3,Competitions:[{Id:9002,Name:'ISOLATED season',Events:[{FixtureId:9003,OutrightLeague:{FixtureName:'ISOLATED winner',Status:1,Sport:{Id:1,Name:'Football'},LastUpdate:stamp,StartDate:'2026-10-20T00:00:00Z',Season:{Id:9002,Name:'ISOLATED season'}}}]}]}});
const wire=(b:unknown=body())=>Buffer.from(JSON.stringify({Header:{Type:38,MsgGuid:'isolated38',ServerTimestamp:Date.parse('2026-10-19T06:00:01Z')},Body:b}));
test('official type38 hierarchy preserves metadata, prior participants, odds and settlement across checkpoint restore',async()=>{
 assert.equal(knownEntityKeys.get(38),'OutrightLeagueFixtureUpdate');const decoded=decodeMessage(wire(),{});assert.equal(decoded.events.length,1);assert.equal(decoded.events[0].outright?.fixture?.fixtureName,'ISOLATED winner');
 const state=new TradeState(),at=Date.parse('2026-10-19T05:00:00Z');state.apply('prematch',[{fixtureId:9003,outright:{competitionId:9001,fixture:{participants:[{id:33,name:'ISOLATED runner'}]}},markets:[{id:160,status:3,bets:[{id:'settled',isChanged:1,price:'2.6233',settlement:1,status:3}]}]}],at);
 state.apply('prematch',decoded.events,decoded.at);const row=state.rows.prematch.get('outright:9001:9003')!;
 assert.equal(row.fixture?.value.participants?.length,1);assert.equal(row.markets.get('160')?.bets?.[0].settlement,1);assert.equal(row.markets.get('160')?.bets?.[0].price,'2.6233');assert.equal(row.outright?.leagueSeason?.id,9002);
 const dir=await mkdtemp(join(tmpdir(),'adl-type38-'));try{const path=join(dir,'feed.json');await writeFile(path,JSON.stringify({...state.feed(),workerCheckpoint:checkpoint(state)}));const next=new TradeState();await restore(next,path);assert.equal(next.rows.prematch.get('outright:9001:9003')?.markets.get('160')?.bets?.[0].settlement,1);assert.equal(next.rows.prematch.get('outright:9001:9003')?.fixture?.value.participants?.[0].id,33);}finally{await rm(dir,{recursive:true,force:true});}
});
test('malformed, flat fixture hierarchy and invalid dates are rejected, never acknowledged as supported',()=>{
 assert.throws(()=>decodeMessage(wire({Competition:{Id:9001,Events:[]}}),{}));const invalid=body();invalid.Competition.Competitions[0].Events[0].OutrightLeague.LastUpdate='not-a-date';assert.throws(()=>decodeMessage(wire(invalid),{}));
});
test('type38 redelivery is durably applied before ACK; persistence failure requeues without ACK',{timeout:10000},async()=>{
 for(const fail of [false,true]){
  const state=new TradeState(),abort=new AbortController();let callback:(m:ConsumeMessage|null)=>void=()=>{};let persisted=false,acks=0,nacks=0;
  const channel=Object.assign(new EventEmitter(),{async prefetch(){},async consume(_queue:string,cb:typeof callback){callback=cb;return {consumerTag:'isolated'};},ack(){assert.ok(persisted);acks++;},nack(){nacks++;}});
  const connection=Object.assign(new EventEmitter(),{async createChannel(){return channel;},async close(){connection.emit('close');}});
  const msg={content:wire(),fields:{redelivered:true},properties:{headers:{}}} as ConsumeMessage;
  const pkg={lane:'prematch' as const,packageId:4511,username:'isolated',password:'',hostname:'unused',vhost:'StmPreMatch',queue:'_4511_',port:5672,tls:false};
  const task=session(pkg,{packages:[pkg],snapshotUrl:'https://unused.invalid',customersUrl:'https://unused.invalid',recoveryMs:300000,staleMs:90000},state,async()=>{
   if(state.rows.prematch.has('outright:9001:9003')){if(fail)throw Error('isolated persist failure');persisted=true;}
   if(state.connections.prematch.phase==='connected')abort.abort();
  },abort.signal,{connect:(async()=>connection) as unknown as typeof amqp.connect,clientFactory:()=>({async startDistribution(){},async distributionStatus(){return {isDistributionOn:true,consumers:[],numberMessagesInQueue:0,messagesPerSecond:0};},async catalog(){return [];},async snapshot(){callback(msg);return [];}})});
  if(fail)await assert.rejects(task);else await task;
  assert.equal(acks,fail?0:1);assert.equal(nacks,fail?1:0);abort.abort();
 }
});

test('partition baseline serializes live ACKs and older HTTP rows without reopening availability early',{timeout:10000},async()=>{
 const state=new TradeState(),abort=new AbortController();let callback:(m:ConsumeMessage|null)=>void=()=>{};let acks=0,persisted=0;const now=Date.now(),older=now-1000;
 const channel=Object.assign(new EventEmitter(),{async prefetch(){},async consume(_q:string,cb:typeof callback){callback=cb;return {consumerTag:'isolated'};},ack(){assert.ok(persisted);assert.ok(state.feed().events.every(e=>(e.markets||[]).every(m=>m.selections.every(s=>!s.available))));acks++;},nack(){assert.fail('Valid messages must not be discarded');}});
 const connection=Object.assign(new EventEmitter(),{async createChannel(){return channel;},async close(){connection.emit('close');}});
 const pkg={lane:'prematch' as const,packageId:4511,username:'isolated',password:'',hostname:'unused',vhost:'StmPreMatch',queue:'_4511_',port:5672,tls:false};
 const market={content:Buffer.from(JSON.stringify({Header:{Type:3,MsgGuid:'live-market-isolated',ServerTimestamp:now},Body:{Events:[{FixtureId:11,Markets:[{Id:1,Status:1,Bets:[{Id:9004,Status:1,Price:'4.00',LastUpdate:new Date(now).toISOString()}]}]}]}})),fields:{redelivered:false},properties:{headers:{}}} as ConsumeMessage;
 await session(pkg,{packages:[pkg],snapshotUrl:'https://unused.invalid',customersUrl:'https://unused.invalid',recoveryMs:300000,staleMs:90000},state,async()=>{
  persisted++;if(state.connections.prematch.phase==='connected'){assert.equal(acks,2);assert.equal(state.rows.prematch.get(11)?.markets.get('1')?.bets?.[0].price,'4.00');abort.abort();}
 },abort.signal,{connect:(async()=>connection) as unknown as typeof amqp.connect,clientFactory:()=>({async startDistribution(){},async distributionStatus(){return {isDistributionOn:true,consumers:[],numberMessagesInQueue:0,messagesPerSecond:0};},async snapshot(){assert.fail('Partition mode must not call unfiltered snapshot');},async snapshotPartitioned(sink){
  callback({content:wire(),fields:{redelivered:true},properties:{headers:{}}} as ConsumeMessage);await sink.begin([11]);assert.equal(acks,1);
  callback(market);for(let n=0;n<100&&acks<2;n++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(acks,2,JSON.stringify(state.connections.prematch.diagnostic));
  await sink.batch([{fixtureId:11,fixture:{status:1,sport:{name:'Football'}},markets:[{id:1,status:1,bets:[{id:'9004',isChanged:1,status:1,price:'2.00',lastUpdate:new Date(older)}]}]}],older);
  return {recoveryId:'isolated',stage:'complete',inventory:1,completedFixtures:1,batches:1,maxResponseBytes:16777216};
 },async catalog(){return [];}})});
 assert.equal(state.rows.prematch.get('outright:9001:9003')?.outright?.leagueSeason?.id,9002);
});
