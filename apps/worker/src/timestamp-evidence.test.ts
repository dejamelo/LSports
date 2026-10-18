import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {root} from '@lsports/feed-store';
import {inspectTimestamp,requireTimestamp} from './timestamp-evidence.js';
import {OperationError} from './diagnostics.js';

// Run the actual SDK/parser in separate Node processes, not a mocked timezone offset.
function run(zone:string){
 const script=`
 import {TransformerUtil,OutrightFixtureMarketUpdate} from 'trade360-nodejs-sdk';
 import {normalizeSdkTimestamps} from './apps/worker/src/timestamp-contract.ts';
 import {decodeMessage} from './apps/worker/src/messages.ts';
 import {inspectTimestamp,requireTimestamp} from './apps/worker/src/timestamp-evidence.ts';
 import {inspectSettlements} from './apps/worker/src/settlement-evidence.ts';
 import {TradeState} from './apps/worker/src/state.ts';
 const at=Date.parse('2026-10-18T14:03:00Z');
 const state=new TradeState();state.apply('prematch',[{fixtureId:900283,outright:{competitionId:900111,fixture:{sport:{name:'Horse Racing'},status:1,participants:[{id:1,name:'ISOLATED runner'}]}}}],at-10000);state.set('prematch',{phase:'connected'});
 const body=(LastUpdate,Price='2.63')=>({Competition:{Id:900111,Events:[{FixtureId:900283,Markets:[{Id:160,Status:1,Bets:[{Id:'1',Price,Status:1,LastUpdate}]}]}]}});
 const amqp=(last,price)=>{const d=decodeMessage(Buffer.from(JSON.stringify({Header:{Type:41,MsgGuid:'isolated-time-'+last,ServerTimestamp:at},Body:body(last,price)})));state.apply('prematch',d.events,d.at);};
 const snapshot=(last,price)=>{const raw=body(last,price);const sdk=TransformerUtil.transform(normalizeSdkTimestamps(raw),OutrightFixtureMarketUpdate).competition.events[0];const settlementInspection=inspectSettlements(raw.Competition.Events[0].Markets,sdk.markets,'snapshot');state.apply('prematch',[{fixtureId:900283,outright:{competitionId:900111},markets:sdk.markets,marketRecovery:true,settlementInspection}],at);};
 amqp('2026-10-18T14:02:17.025Z','2.63');
 state.rows.prematch.get('outright:900111:900283').restored=true;
 snapshot('2026-10-18T11:02:17.025-03:00','2.63');
 const equal=state.feed().outrightDiagnostics[0].markets[0].selections[0].settlementTrace.lastSnapshot;
 const equalAvailable=state.feed().events[0].selections[0].available;
 amqp('2026-10-18T14:02:18.025Z','3.10');
 snapshot('2026-10-18T14:02:17.025Z','9.99');
 const afterOldSnapshot=state.feed().events[0].selections[0].odds;
 amqp('2026-10-18T14:02:19.025Z','3.25');
 const beforeAmbiguous=state.feed().events[0].selections[0].odds;
 snapshot('2026-10-18T14:02:17.025','8.88');
 const blocked={timestampInspection:state.feed().outrightDiagnostics[0].markets[0].selections[0].settlementTrace.lastSnapshot.timestamp};
 const afterAmbiguous=state.feed().events[0].selections[0].odds;
 amqp('2026-10-18T14:02:20.025Z','3.50');
 const final=state.feed().events[0].selections[0];
 const raw=body('2026-10-18T14:02:17.025');const sdk=TransformerUtil.transform(raw,OutrightFixtureMarketUpdate).competition.events[0].markets[0].bets[0];
 const naive=inspectTimestamp(raw.Competition.Events[0].Markets[0].Bets[0].LastUpdate,sdk.lastUpdate);
 console.log(JSON.stringify({equal,equalAvailable,afterOldSnapshot,beforeAmbiguous,afterAmbiguous,final,blocked,naive}));`;
 const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:root,env:{...process.env,TZ:zone},encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
test('SDK host drift is corrected before conversion under UTC, Brazil and Berlin; older snapshots remain rejected',()=>{
 const results=['UTC','America/Sao_Paulo','Europe/Berlin'].map(run);
 for(const r of results){
  assert.equal(r.equal.versionAt,'2026-10-18T14:02:17.025Z');assert.equal(r.equal.timestamp.rawLastUpdate,'2026-10-18T11:02:17.025-03:00');assert.equal(r.equal.timestamp.timezone,'explicit');assert.equal(r.equal.timestamp.orderingSafe,true);
  assert.equal(r.equalAvailable,true);assert.equal(r.afterOldSnapshot,3.1);assert.equal(r.final.odds,3.5);assert.equal(r.final.available,true);
  assert.equal(r.beforeAmbiguous,r.afterAmbiguous);assert.equal(r.blocked.timestampInspection.rawLastUpdate,'2026-10-18T14:02:17.025');assert.equal(r.naive.normalizedUtc,'2026-10-18T14:02:17.025Z');
 }
 assert.equal(results[0].naive.sdkUtc,'2026-10-18T14:02:17.025Z');assert.equal(results[1].naive.sdkUtc,'2026-10-18T17:02:17.025Z');assert.equal(results[1].naive.wallClockToSdkDeltaMinutes,180);assert.equal(results[2].naive.sdkUtc,'2026-10-18T12:02:17.025Z');
});
test('timestamp inspection distinguishes fallback from explicit offsets, masks non-date input and uses confirmed UTC contract for missing timezone',()=>{
 const missing=inspectTimestamp(undefined,undefined);assert.equal(missing.orderingSource,'envelope_or_snapshot_start');assert.equal(missing.orderingSafe,true);assert.equal(missing.rawType,'missing');
 const explicit=inspectTimestamp('2026-10-18T14:02:17.025-03:00',new Date('2026-10-18T17:02:17.025Z'));assert.equal(explicit.normalizedUtc,'2026-10-18T17:02:17.025Z');assert.equal(explicit.orderingSafe,true);
 const wrong=inspectTimestamp('2026-10-18T14:02:17.025Z',new Date('2026-10-18T17:02:17.025Z'));assert.equal(wrong.orderingSafe,false);assert.throws(()=>requireTimestamp(wrong,'snapshot'),e=>e instanceof OperationError&&e.diagnostic.reason==='invalid_timestamp');
 const invalid=inspectTimestamp('private-non-date-value',new Date(NaN));assert.equal(invalid.rawLastUpdate,null);assert(!JSON.stringify(invalid).includes('private-non-date-value'));assert.throws(()=>requireTimestamp(invalid,'amqp'));
});
test('real snapshot client accepts contract-UTC items without quarantining valid timestamps',async()=>{
 const {createServer}=await import('node:http');const {clients}=await import('./provider.js');
 const http=createServer(async(req,res)=>{for await(const _chunk of req){}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:[{Id:900111,Events:[{FixtureId:900283,Markets:[{Id:160,Bets:[{Id:'1',Price:'2.63',LastUpdate:'2026-10-18T14:39:04.0173136'}]}]}]}]}));});
 await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));const a=http.address();assert(a&&typeof a!=='string');const url=`http://127.0.0.1:${a.port}`;
 try{
  const api=clients({lane:'prematch',packageId:4511,username:'isolated',password:'isolated-not-a-credential',hostname:'unused',port:5672,tls:false,vhost:'StmPreMatch',queue:'_4511_'},{snapshotUrl:url,customersUrl:url},{run:async(_op,action)=>action()});
  const result=await api.outrightMarkets!([900283]);
  assert.equal(result[0].markets![0].bets!.length,1);
  const inspection=result[0].settlementInspection!.fields[0].timestamp!;
  assert.equal(inspection.normalizedUtc,'2026-10-18T14:39:04.017Z');assert.equal(inspection.orderingSafe,true);assert.equal(inspection.orderingKey,'1792334344017313600');
  const rejected=api.outrightTimestampRejections!();assert.equal(rejected.length,0);
  assert(!JSON.stringify(rejected).includes('isolated-not-a-credential'));

 }finally{await new Promise<void>(r=>http.close(()=>r()));}
});
test('envelope fallback interprets zone-less timestamps as UTC per confirmed contract',async()=>{
 const {decodeMessage}=await import('./messages.js');
 const wire=(CreationDate:string)=>Buffer.from(JSON.stringify({Header:{Type:41,MsgGuid:'isolated-clock',CreationDate},Body:{Competition:{Id:900111,Events:[{FixtureId:900283,Markets:[]}]}}}));
 assert.equal(decodeMessage(wire('2026-10-18T14:02:17.025')).at,Date.parse('2026-10-18T14:02:17.025Z'));assert.throws(()=>decodeMessage(wire('2026-02-30T14:02:17.025')),e=>e instanceof OperationError&&e.diagnostic.reason==='missing_timestamp');
 assert.equal(decodeMessage(wire('2026-10-18T14:02:17.025Z')).at,Date.parse('2026-10-18T14:02:17.025Z'));
});
