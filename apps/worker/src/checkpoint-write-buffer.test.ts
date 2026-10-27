import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {checkpointWriteBuffer,persistRegularCheckpoint,restore,streamCheckpoint} from './persistence.js';import {TradeState,preciseBetOrder} from './state.js';import {createPublisher} from '@lsports/feed-store';
test('checkpoint batches punctuation and fixture fragments into bounded writes with exact UTF-8 order',async()=>{
 const chunks:string[]=[];const w=checkpointWriteBuffer({async writeFile(t:any){chunks.push(t)}} as any,undefined,65536);let expected='';
 for(let i=0;i<10000;i++){const t=i%2?',':'{"nome":"São Paulo ⚽"}';expected+=t;await w.writeFile(t);}
 await w.flush();assert.equal(chunks.join(''),expected);assert(w.stats.maxBufferedBytes<=65536);assert(w.stats.writeCalls<10,'not one filesystem call per comma or fixture');assert.equal(w.stats.writeBytes,Buffer.byteLength(expected));
});
test('write failure aborts buffered checkpoint output without silently consuming more input',async()=>{
 let calls=0;const w=checkpointWriteBuffer({async writeFile(){calls++;throw Object.assign(Error('isolated'),{code:'EIO'})}} as any,undefined,65536);
 await assert.rejects(w.writeFile('x'.repeat(65536)),{code:'EIO'});assert.equal(calls,1);
});
test('buffered private checkpoint persists and restores prices, ordering and settlement state',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-checkpoint-buffer-')),path=join(dir,'feed.json');
 try{const s=new TradeState();const at=Date.parse('2026-10-24T03:00:00Z');s.apply('prematch',[{fixtureId:1,fixture:{status:1,sport:{name:'Football'}},markets:[{id:1,status:1,bets:[{id:'1',price:'2.2',status:1,isChanged:1,settlement:2,lastUpdate:new Date(at)}]}]}],at);
 const phases:string[]=[];const io=await persistRegularCheckpoint(path,s,p=>phases.push(p));assert.ok(io.serializeMs>=0);assert.ok(io.writeAwaitMs>=0);assert.ok(io.fsyncAwaitMs>=0);assert.ok(io.renameAwaitMs>=0);assert.ok(io.directorySyncAwaitMs>=0);const {regular,...saved}=streamCheckpoint(s);await createPublisher(path)(s.projection(at,false),{...saved,regularExternal:true});const restored=new TradeState();await restore(restored,path);
 const row=restored.rows.prematch.get(1)!;assert.equal(row.markets.get('1')!.bets![0].price,'2.2');assert.equal(row.markets.get('1')!.bets![0].settlement,2);assert.equal(preciseBetOrder(row,'1:1',row.markets.get('1')!.bets![0]),preciseBetOrder(s.rows.prematch.get(1)!,'1:1',s.rows.prematch.get(1)!.markets.get('1')!.bets![0]));
 assert(phases.indexOf('regular_checkpoint.write')<phases.indexOf('regular_checkpoint.fsync'));assert(phases.indexOf('regular_checkpoint.fsync')<phases.indexOf('regular_checkpoint.rename'));assert(io.writeCalls>=1);assert(io.maxBufferedBytes<=1024**2);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('record validation failure preserves the previous atomic checkpoint',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-checkpoint-limit-')),path=join(dir,'feed.json'),target=path+'.regular-checkpoint.json';
 try{await writeFile(target,'ORIGINAL_PRESERVED');const s=new TradeState();s.rows.prematch.set(1,{fixture:{name:'x'.repeat(33*1024**2)},markets:new Map(),marketAt:new Map(),betAt:new Map()} as any);await assert.rejects(persistRegularCheckpoint(path,s),/checkpoint_record_limit/);assert.equal(await readFile(target,'utf8'),'ORIGINAL_PRESERVED');}
 finally{await rm(dir,{recursive:true,force:true});}
});
