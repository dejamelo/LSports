// Offline only: /recovery is a writable COPY, /output is separate; no networking.
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readFile,writeFile,open} from 'node:fs/promises';
import {setImmediate as turn} from 'node:timers/promises';
import {getHeapStatistics} from 'node:v8';
import {restore,checkpoint,persistRegularCheckpoint} from '/app/apps/worker/src/persistence.ts';
import {TradeState} from '/app/apps/worker/src/state.ts';
import {decodeMessage} from '/app/apps/worker/src/messages.ts';
import {fullSnapshotMemory,verifyProjectionFile} from '/app/apps/worker/src/full-snapshot.ts';
import {writeJsonObject} from '/app/packages/feed-store/src/index.ts';
// Compare persisted entities by identity, not Map insertion order. Arrays retain order.
function* entries(s){for(const lane of ['prematch','inplay'])for(const key of [...s.rows[lane].keys()].sort((a,b)=>String(a).localeCompare(String(b),'en'))){const view=Object.create(s);view.rows={prematch:new Map(),inplay:new Map()};view.rows[lane].set(key,s.rows[lane].get(key));yield {lane,identity:createHash('sha256').update(String(key)).digest('hex'),value:JSON.parse(JSON.stringify(checkpoint(view,true)))};}}
const kind=v=>v===null?'null':Array.isArray(v)?'array':typeof v;
function difference(a,b,path='$'){
 if(kind(a)!==kind(b))return {path,expectedType:kind(a),actualType:kind(b)};
 if(a&&typeof a==='object'){
  const ak=Object.keys(a).sort(),bk=Object.keys(b).sort();
  if(JSON.stringify(ak)!==JSON.stringify(bk))return {path,expectedType:kind(a),actualType:kind(b),expectedCount:ak.length,actualCount:bk.length,fieldMembershipMismatch:true};
  for(const k of ak){const d=difference(a[k],b[k],path+(Array.isArray(a)?'['+k+']':'.'+(/^[a-zA-Z]{1,40}$/.test(k)?k:'field')));if(d)return d;}
 }else if(a!==b)return {path,expectedType:kind(a),actualType:kind(b),valueMismatch:true};
}
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
async function stateDigest(s,compare=false){
 const hash=createHash('sha256');let lines,file;
 if(compare)lines=createInterface({input:createReadStream('/output/expected-state.jsonl'),crlfDelay:Infinity})[Symbol.asyncIterator]();
 else file=await open('/output/expected-state.jsonl','wx',0o600);
 try{for(const entry of entries(s)){
  if(compare){const next=await lines.next();const expected=next.done?undefined:JSON.parse(next.value);const d=difference(expected,entry);if(d){const report={reason:'PRE_EXIT_STATE_ROUNDTRIP_MISMATCH',entity:entry.identity,lane:entry.lane,...d};await writeFile('/output/divergence.json',JSON.stringify(report),{mode:0o600});console.log(JSON.stringify({operation:'pre_exit.divergence',...report}));throw Error(report.reason);}}
  const line=JSON.stringify(canonical(entry))+'\n';hash.update(line);if(file)await file.write(line);
 }if(compare&&!(await lines.next()).done)throw Error('PRE_EXIT_ROW_COUNT_MISMATCH');if(file)await file.sync();return hash.digest('hex');}
 finally{if(file)await file.close();if(lines)await lines.return();}
}
function failureReason(error){
 if(/^PRE_EXIT_[A-Z_]+$/.test(error.message||''))return error.message;
 if(/^[a-z_]{1,100}$/.test(error.diagnostic?.reason||''))return error.diagnostic.reason;
 if(/^ERR_SQLITE_/.test(error.code||''))return 'PRE_EXIT_SQLITE_VALIDATION_FAILED';
 if(error.message==='Private checkpoint incremental memory guard; original preserved')return 'PRE_EXIT_CHECKPOINT_MEMORY_BUDGET_REJECTED';
 if(['Invalid saved TRADE state; original file preserved','Unsupported TRADE checkpoint; original file preserved','Invalid outright checkpoint; original file preserved','Invalid checkpoint envelope'].includes(error.message))return 'PRE_EXIT_CHECKPOINT_SCHEMA_INVALID';
 return 'PRE_EXIT_UNCLASSIFIED_VALIDATION_FAILURE';
}
let phase='restore',processed=0;
const memory=()=>{const m=process.memoryUsage();return {rssBytes:m.rss,heapUsedBytes:m.heapUsed,heapLimitBytes:getHeapStatistics().heap_size_limit,maxRSSBytes:process.resourceUsage().maxRSS*1024};};
const sample=()=>console.log(JSON.stringify({operation:'pre_exit.proof',status:'progress',phase,processed,...memory()}));
try{
 if(process.argv[2]==='readback'){
  phase='readback';const receipt=JSON.parse(await readFile('/output/receipt.json','utf8'));
  await verifyProjectionFile('/output/projection.json',receipt);
  phase='restore_replayed_checkpoint';const s=new TradeState(),r=await restore(s,'/output/projection.json');
  if(r.source!=='checkpoint'||r.rows!==receipt.stateRows)throw Error('PRE_EXIT_ROW_COUNT_MISMATCH');const stateSha256=await stateDigest(s,true);if(stateSha256!==receipt.stateSha256)throw Error('PRE_EXIT_STATE_ROUNDTRIP_MISMATCH');
  await writeFile('/output/readback.json',JSON.stringify({verified:true,stateRows:r.rows,stateSha256,projectionSha256:receipt.sha256,...memory()}),{mode:0o600});
 }else{
  const s=new TradeState();const restored=await restore(s,'/recovery/trade-feed.json',p=>{phase=p.stage;sample();});if(restored.source!=='checkpoint')throw Error('PRE_EXIT_CHECKPOINT_SOURCE_UNVERIFIED');
  const inboxes=[];
  for(const lane of ['prematch','inplay']){
   phase='inbox_integrity_'+lane;sample();
   const db=new DatabaseSync('/recovery/trade-feed.json.'+lane+'.inbox.sqlite');
   try{
    db.exec('PRAGMA busy_timeout=5000');const integrity=db.prepare('PRAGMA integrity_check').all();
    if(integrity.length!==1||Object.values(integrity[0])[0]!=='ok')throw Error('PRE_EXIT_INBOX_INTEGRITY_FAILED');
    const count=Number(db.prepare('SELECT count(*) AS n FROM inbox').get().n);
    const sequence=Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='inbox'").get()?.seq||0);
    const hash=createHash('sha256'),seen=new Set();let rows=0,lastId=0,bytes=0;const types={};
    phase='inbox_replay_'+lane;
    s.set(lane,{phase:'recovering'});
    for(const row of db.prepare('SELECT id,received,content,properties,fields FROM inbox ORDER BY id').iterate()){
     if(!Number.isSafeInteger(Number(row.id))||Number(row.id)<=lastId||row.content.byteLength>16*1024**2)throw Error('PRE_EXIT_INBOX_ROW_INVALID');
     lastId=Number(row.id);bytes+=row.content.byteLength;
     hash.update(JSON.stringify([Number(row.id),Number(row.received),row.properties,row.fields])+'\n');hash.update(row.content);
     const revive=(_k,v)=>v?.type==='Buffer'&&Array.isArray(v.data)?Buffer.from(v.data):v;
     const properties=JSON.parse(row.properties,revive),fields=JSON.parse(row.fields,revive);
     const decoded=decodeMessage(Buffer.from(row.content),properties.headers||{},properties,fields.redelivered);
     types[decoded.type]=(types[decoded.type]||0)+1;
     s.recordMessage(lane,decoded.type,decoded.events.length,seen.has(decoded.guid),decoded.keepAliveActiveEvents,Number(row.received),Number(row.received));
     if(!seen.has(decoded.guid))s.apply(lane,decoded.events,decoded.at,{source:'amqp',receivedAt:Number(row.received)});
     if(decoded.interrupted)s.set(lane,{phase:'error'}); // Recorded control; availability stays blocked.
     seen.add(decoded.guid);if(seen.size>10000)seen.delete(seen.values().next().value);
     rows++;processed++;if(rows%64===0){fullSnapshotMemory();await turn();}if(rows%1000===0)sample();
    }
    if(rows!==count)throw Error('PRE_EXIT_INBOX_REPLAY_COUNT_MISMATCH');
    inboxes.push({lane,pendingCommittedRows:count,replayedRows:rows,committedSequence:sequence,lastReplayedId:lastId,bytes,rawRecordSha256:hash.digest('hex'),types});
   }finally{db.close();}
  }
  phase='replayed_checkpoint';sample();fullSnapshotMemory();
  await persistRegularCheckpoint('/output/projection.json',s);
  phase='projection_serialize';const feed=s.projection(Date.now(),false);const file=await open('/output/projection.json','wx',0o600);let receipt;
  try{receipt=await writeJsonObject(file,{...feed,workerCheckpoint:{...checkpoint(s,false),regularExternal:true}},s.availabilityBlocks());await file.sync();}finally{await file.close();}
  await writeFile('/output/receipt.json',JSON.stringify({...receipt,rows:feed.coverage.prematch.rowsPublished+feed.coverage.inplay.rowsPublished,stateRows:s.rows.prematch.size+s.rows.inplay.size,stateSha256:await stateDigest(s),inboxes}),{mode:0o600});
 }
 phase='complete';sample();console.log('pre-exit-proof-ok');
}catch(error){console.log(JSON.stringify({operation:'pre_exit.proof',status:'blocked',phase,processed,validationCode:/^[a-z_]{1,100}$/.test(error.diagnostic?.snapshotValidation?.code||'')?error.diagnostic.snapshotValidation.code:undefined,validationDetail:/^[a-z_]{1,100}$/.test(error.diagnostic?.snapshotValidation?.detail||'')?error.diagnostic.snapshotValidation.detail:undefined,reason:failureReason(error),...memory()}));process.exitCode=1;}
