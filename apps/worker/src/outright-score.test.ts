import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import amqp, {type ConsumeMessage} from 'amqplib';
import {knownEntityKeys,OutrightScoreStatus} from 'trade360-nodejs-sdk';
import {decodeMessage} from './messages.js';
import {OperationError} from './diagnostics.js';
import {TradeState} from './state.js';
import {checkpoint,restore} from './persistence.js';
import {session} from './connected.js';
import {createPublisher,readConnectedFeed} from '@lsports/feed-store';
import {TicketStore} from '@lsports/feed-store/tickets';
import {createApp} from '../../api/src/app.js';
import type {PackageConfig} from './config.js';
const fixtureId=900564,competitionId=900144,at=1700000000000;
const score={Status:3,ParticipantResults:[{ParticipantId:1,Name:'ISOLATED runner',Result:1},{ParticipantId:2,Name:'ISOLATED runner 2',Result:2}]};
function wire(value:unknown=score,type=39,guid='score-39',time=at+100){return gzipSync(Buffer.from(JSON.stringify({Header:{Type:type,MsgGuid:guid,ServerTimestamp:time},Body:{Competition:{Id:competitionId,Events:[{FixtureId:fixtureId,OutrightScore:value}]}}})));}
function seed(){
 const state=new TradeState();state.apply('prematch',[{fixtureId,outright:{competitionId,fixture:{fixtureName:'ISOLATED score test',sport:{name:'Horse Racing'},status:1,participants:[{id:1,name:'ISOLATED runner'},{id:2,name:'ISOLATED runner 2'}]}},markets:[{id:160,status:1,name:'Race Winner',bets:[{id:'bet-1',participantId:1,price:'2.63',status:1,isChanged:0}]}]}],at);
 state.set('prematch',{phase:'connected'});return state;
}
test('official type 39 score contract preserves raw participant results, ordering and checkpoint, without changing odds, fixture status or ticket settlement',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-outright-score-'));const path=join(dir,'feed.json');const tickets=new TicketStore(join(dir,'tickets.sqlite'));
 try{
  assert.equal(knownEntityKeys.get(39),'OutrightScoreUpdate');assert.equal(OutrightScoreStatus.Completed,3);
  const state=seed(),before=state.feed().events[0];const ticket=tickets.create({stakeMinor:10000,selections:[{eventId:before.id,marketId:before.markets![0].id,selectionId:before.selections[0].id,expectedOdds:2.63}]},'isolated-score-ticket',()=>state.feed());
  const decoded=decodeMessage(wire(),{}, {contentEncoding:'gzip'},true);assert.equal(decoded.metadata.redelivered,true);assert.equal(decoded.type,39);assert.equal(decoded.events.length,1);
  assert.equal(decoded.events[0].markets,undefined);assert.equal(decoded.events[0].fixture,undefined);
  state.apply('prematch',decoded.events,decoded.at);state.apply('prematch',decoded.events,decoded.at);tickets.reconcile(state.feed());
  const after=state.feed().events[0];assert.deepEqual(after.participants,before.participants);assert.deepEqual(after.markets,before.markets);assert.equal(after.status,1);
  assert.deepEqual(after.outrightScore?.participantResults,[{participantId:1,name:'ISOLATED runner',result:1},{participantId:2,name:'ISOLATED runner 2',result:2}]);assert.equal(after.outrightScore?.statusName,'Completed');
  assert.deepEqual(tickets.get(ticket.id),ticket);assert.equal(state.feed().ticketOutcomes?.length,0);
  state.apply('prematch',decodeMessage(wire({Status:1,ParticipantResults:[]},39,'older',at+99)).events,at+99);assert.equal(state.feed().events[0].outrightScore?.status,3);
  await createPublisher(path)(state.feed(),checkpoint(state));const restarted=new TradeState();await restore(restarted,path);
  assert.deepEqual(restarted.feed().events[0].outrightScore,after.outrightScore);
  restarted.set('prematch',{phase:'connected'});assert.equal(restarted.feed().events[0].selections[0].available,false);
  restarted.apply('prematch',decodeMessage(wire({Status:99},39,'correction',at+101)).events,at+101);assert.equal(restarted.feed().events[0].outrightScore?.statusName,'Unrecognized');assert.equal(restarted.feed().events[0].outrightScore?.participantResults.length,2);
  const source={getEvents:()=>readConnectedFeed(path)};const server=createApp(source).listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  try{const a=server.address();assert(a&&typeof a!=='string');const d=await(await fetch(`http://127.0.0.1:${a.port}/api/diagnostics/outright/${fixtureId}`)).json();assert.deepEqual(d.matches[0].outrightScore,after.outrightScore);}finally{await new Promise<void>(r=>server.close(()=>r()));}
  const saved=JSON.parse(await readFile(path,'utf8'));saved.workerCheckpoint.outright[0].outrightScore.value.participantResults='invalid';const invalid=JSON.stringify(saved);await writeFile(path,invalid);
  await assert.rejects(()=>restore(new TradeState(),path),/Invalid saved outright score/);assert.equal(await readFile(path,'utf8'),invalid);
 }finally{tickets.close();await rm(dir,{recursive:true,force:true});}
});
test('malformed score messages are rejected, not converted to successful empty updates',()=>{
 for(const value of [null,[],{Status:'Completed'},{ParticipantResults:{}},{ParticipantResults:[null]},{ParticipantResults:[{ParticipantId:0}]},{ParticipantResults:[{Result:'winner'}]}]){
  assert.throws(()=>decodeMessage(wire(value)),e=>e instanceof OperationError&&e.diagnostic.reason==='invalid_event_body');
 }
});
test('redelivered 39 is stored before ACK; consumer resumes snapshot recovery and next football update without dropping the score', {timeout:10000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-score-consumer-'));const path=join(dir,'feed.json');const publish=createPublisher(path);const state=seed();const abort=new AbortController();
 let callback: (m:ConsumeMessage|null)=>void=()=>{};let acks=0;let connected=false;let persistedScore=false;
 const scoreMessage={content:wire(),properties:{contentEncoding:'gzip'},fields:{redelivered:true}} as ConsumeMessage;
 const footballMessage={content:Buffer.from(JSON.stringify({Header:{Type:3,MsgGuid:'next-football',ServerTimestamp:at+200},Body:{Events:[{FixtureId:900777,Markets:[{Id:1,Status:1,Bets:[{Id:'900778',Price:'2.10',Status:1}]}]}]}})),properties:{},fields:{redelivered:false}} as ConsumeMessage;
 const channel=Object.assign(new EventEmitter(),{async prefetch(){},async consume(queue:string,cb:typeof callback){assert.equal(queue,'_4511_');callback=cb;return {consumerTag:'existing-test-queue'};},ack(msg:ConsumeMessage){assert(persistedScore);if(msg===footballMessage)assert.equal(state.feed().events.find(e=>e.id==='prematch:900777')?.selections[0].odds,2.1);acks++;},nack(){assert.fail('Valid score must not be discarded/requeued');}});
 const connection=Object.assign(new EventEmitter(),{async createChannel(){return channel;},async close(){connection.emit('close');}});
 const pkg:PackageConfig={lane:'prematch',packageId:4511,username:'synthetic-user',password:'',hostname:'unused',vhost:'StmPreMatch',queue:'_4511_',port:5672,tls:false};
 try{
  await session(pkg,{packages:[pkg],snapshotUrl:'https://unused.invalid',customersUrl:'https://unused.invalid',recoveryMs:300000,staleMs:90000},state,async()=>{
   await publish(state.feed(),checkpoint(state));persistedScore=!!JSON.parse(await readFile(path,'utf8')).workerCheckpoint.outright.find((r:{fixtureId:number})=>r.fixtureId===fixtureId)?.outrightScore;
   if(state.connections.prematch.phase==='connected'){connected=true;assert.equal(acks,3);abort.abort();}
  },abort.signal,{connect:(async()=>connection) as unknown as typeof amqp.connect,clientFactory:()=>({async startDistribution(){},async distributionStatus(){return {isDistributionOn:true,consumers:[],numberMessagesInQueue:0,messagesPerSecond:0};},async catalog(){return [];},async snapshot(){callback(scoreMessage);callback(scoreMessage);callback(footballMessage);return [{fixtureId:900777,fixture:{sport:{name:'Football'},status:1}}];}})});
  assert(connected);assert.equal(acks,3);const restored=new TradeState();await restore(restored,path);assert.equal(restored.feed().events.find(e=>e.kind==='outright')?.outrightScore?.status,3);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('score persistence failure never ACKs the message and requests requeue', {timeout:10000},async()=>{
 const state=seed();const abort=new AbortController();let callback:(m:ConsumeMessage|null)=>void=()=>{};let nacks=0;
 const message={content:wire(),properties:{contentEncoding:'gzip'},fields:{redelivered:true}} as ConsumeMessage;
 const channel=Object.assign(new EventEmitter(),{async prefetch(){},async consume(_queue:string,cb:typeof callback){callback=cb;return {consumerTag:'test'};},ack(){assert.fail('Unpersisted score must never be ACKed');},nack(msg:ConsumeMessage,all:boolean,requeue:boolean){assert.equal(msg,message);assert.equal(all,false);assert.equal(requeue,true);nacks++;}});
 const connection=Object.assign(new EventEmitter(),{async createChannel(){return channel;},async close(){connection.emit('close');}});
 const pkg:PackageConfig={lane:'prematch',packageId:4511,username:'synthetic',password:'',hostname:'unused',vhost:'StmPreMatch',queue:'_4511_',port:5672,tls:false};
 await assert.rejects(()=>session(pkg,{packages:[pkg],snapshotUrl:'https://unused.invalid',customersUrl:'https://unused.invalid',recoveryMs:300000,staleMs:90000},state,async()=>{
  if(state.rows.prematch.get(`outright:${competitionId}:${fixtureId}`)?.outrightScore)throw new Error('isolated persistence failure');
 },abort.signal,{connect:(async()=>connection) as unknown as typeof amqp.connect,clientFactory:()=>({async startDistribution(){},async distributionStatus(){return {isDistributionOn:true,consumers:[],numberMessagesInQueue:0,messagesPerSecond:0};},async catalog(){return [];},async snapshot(){callback(message);return [];}})}));
 assert.equal(nacks,1);
});
test('score received before fixture metadata survives restart and attaches to the later fixture without inventing participants or markets',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-orphan-score-'));const path=join(dir,'feed.json');
 try{
  const state=new TradeState(),decoded=decodeMessage(wire());state.apply('prematch',decoded.events,decoded.at);
  assert.equal(state.feed().events.length,0);assert.equal(state.feed().outrightDiagnostics![0].hasFixture,false);
  await createPublisher(path)(state.feed(),checkpoint(state));const restarted=new TradeState();await restore(restarted,path);
  assert.equal(restarted.feed().outrightDiagnostics![0].outrightScore?.participantResults.length,2);
  restarted.apply('prematch',[{fixtureId,outright:{competitionId,fixture:{fixtureName:'ISOLATED later metadata',sport:{name:'Horse Racing'},status:1,participants:[{id:1,name:'Metadata name'}]}}}],at+200);
  assert.equal(restarted.feed().events[0].outrightScore?.status,3);assert.deepEqual(restarted.feed().events[0].participants,[{id:1,name:'Metadata name'}]);assert.equal(restarted.feed().events[0].markets?.length,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
