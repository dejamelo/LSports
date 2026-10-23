import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('reserve wait holds neither decoded graph nor state gate; WAL rows retire only after durable checkpoint',()=>{
 const code=`
 import assert from 'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
 import{TradeState}from'./apps/worker/src/state.ts';import{decodeApplyTurn,publicationCaptureTurn}from'./apps/worker/src/connected.ts';
 import{openInbox}from'./apps/worker/src/durable-ingress.mjs';import{persistRegularCheckpoint,streamCheckpoint,restore}from'./apps/worker/src/persistence.ts';import{createPublisher}from'@lsports/feed-store';
 const dir=await mkdtemp(join(tmpdir(),'publication-cycle-')),path=join(dir,'feed.json'),db=openInbox(join(dir,'inbox.sqlite'));
 try{
 const state=new TradeState(),now=Date.now();
 const message={content:Buffer.from(JSON.stringify({Header:{Type:3,MsgGuid:'isolated-update',ServerTimestamp:now},Body:{Events:[{FixtureId:1,Markets:[{Id:1,Status:1,Bets:[{Id:'1',Price:'2.80',Status:1,IsChanged:1}]}]}]}})),properties:{headers:{}},fields:{redelivered:false}};
 const ids=db.append([{...message,received:now}]);assert.equal(db.stats().backlog,1); // committed raw receipt precedes business processing
 const held=await state.exclusive(()=>state.capturePublication());let applied=false;
 const applying=decodeApplyTurn(state,'prematch',message,new Set()).then(result=>{assert.equal('events'in result,false);applied=true;return result;});
 await new Promise(r=>setTimeout(r,20));assert.equal(applied,false);assert.equal(state.metrics.prematch.messages,0,'decode/record must not run before reserve clears');
 // The old implementation holds the gate here until release: this reproduces the defect.
 await Promise.race([state.exclusive(()=>assert.equal(state.rows.prematch.size,0)),new Promise((_,j)=>setTimeout(()=>j(Error('state gate retained by reserve wait')),500))]);
 assert.equal(db.stats().backlog,1);held.release();await applying;
 assert.equal(state.metrics.prematch.messages,1);assert.equal(db.stats().backlog,1);
 const publish=createPublisher(path),phases=[];
 await publicationCaptureTurn(state,async stable=>{const{regular,...saved}=streamCheckpoint(stable);await persistRegularCheckpoint(path,stable,p=>phases.push(p));assert.equal(db.stats().backlog,1);await publish(stable.projection(Date.now(),false),{...saved,regularExternal:true},undefined,p=>phases.push(p));});
 assert.ok(phases.includes('regular_checkpoint.fsync'));assert.ok(phases.includes('projection.directory_fsync'));
 const restored=new TradeState();await restore(restored,path);assert.equal(restored.rows.prematch.get(1).markets.get('1').bets[0].price,'2.80');
 db.complete(ids);assert.equal(db.stats().backlog,0);db.append([{...message,received:now+1}]);assert.equal(db.stats().backlog,1,'capacity restored without losing rows');
 console.log(JSON.stringify({cycle:'process_persist_restore_retire_capacity',passed:true,maxRssBytes:process.resourceUsage().maxRSS*1024,awsVerified:false}));
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
 `;
 const child=spawnSync(process.execPath,['--max-old-space-size=256','--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),encoding:'utf8',timeout:20000});
 assert.equal(child.status,0,child.stdout+'\n'+child.stderr);assert.match(child.stdout,/"passed":true/);
});
