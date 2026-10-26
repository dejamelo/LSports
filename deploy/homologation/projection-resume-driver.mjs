import {restore,streamCheckpoint} from '/app/apps/worker/src/persistence.ts';
import {TradeState} from '/app/apps/worker/src/state.ts';
import {verifyProjectionFile} from '/app/apps/worker/src/full-snapshot.ts';
import {writeJsonObject} from '/app/packages/feed-store/src/index.ts';
import {open,stat,statfs,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {getHeapStatistics} from 'node:v8';
import {readFileSync} from 'node:fs';
const mode=process.argv[2]||'serialize', started=Date.now();let stage=mode==='serialize'?'restore':'readback',lastRows=0,lastBytes=0;let s;
const io=()=>{try{return Object.fromEntries(readFileSync('/proc/self/io','utf8').trim().split('\n').map(x=>{const [k,v]=x.split(': ');return [k,Number(v)]}))}catch{return {}}};
const cpu=()=>process.cpuUsage();let cpu0=cpu(),io0=io();
const sample=async()=>{let o={};try{o=await stat('/output/projection.json')}catch{};const m=process.memoryUsage(),stfs=await statfs('/output');console.log(JSON.stringify({operation:'projection.resume.progress',mode,stage,elapsedMs:Date.now()-started,rows:lastRows,outputBytes:o.size||0,heapUsedBytes:m.heapUsed,heapLimitBytes:getHeapStatistics().heap_size_limit,rssBytes:m.rss,externalBytes:m.external,arrayBufferBytes:m.arrayBuffers,cpu:cpu(),cpuDelta:process.cpuUsage(cpu0),io:io(),ioDelta:Object.fromEntries(Object.entries(io()).map(([k,v])=>[k,v-(io0[k]||0)])),freeBytes:stfs.bavail*stfs.bsize}));};
const timer=setInterval(()=>void sample(),5000);timer.unref();
try{
 if(mode==='serialize'){
  s=new TradeState();const restored=await restore(s,'/input/trade-feed.json',p=>{stage=p.stage;lastRows=p.rows});
  stage='restore.complete';lastRows=restored.rows;await sample();
  const privateHash=createHash('sha256');for await(const chunk of createReadStream('/input/trade-feed.json.regular-checkpoint.json'))privateHash.update(chunk);
  const privateCheckpointSha256=privateHash.digest('hex');
  stage='projection.build';const buildStarted=Date.now(),buildCpu=cpu();const feed=s.projection(Date.now(),false);const buildMs=Date.now()-buildStarted,buildCpuDelta=process.cpuUsage(buildCpu);await sample();
  stage='projection.serialize';let fsyncMs=0;const out=await open('/output/projection.json','w',0o600);let writeAwaitMs=0,writeCalls=0,bytesWritten=0;const writer={writeFile:async text=>{const b=Buffer.byteLength(text),t=Date.now();await out.writeFile(text);writeAwaitMs+=Date.now()-t;writeCalls++;bytesWritten+=b;lastBytes=bytesWritten}};
  const serialStart=Date.now(),serialCpu=cpu();let result;try{result=await writeJsonObject(writer,{...feed,workerCheckpoint:{...streamCheckpoint(s),regularExternal:true}},s.availabilityBlocks());stage='projection.fsync';await sample();const syncAt=Date.now();await out.sync();fsyncMs=Date.now()-syncAt;}finally{await out.close()}
  const serialMs=Date.now()-serialStart,serialCpuDelta=process.cpuUsage(serialCpu);stage='receipt';const receipt={...result,rows:feed.coverage.prematch.rowsPublished+feed.coverage.inplay.rowsPublished,stateRows:s.rows.prematch.size+s.rows.inplay.size,privateCheckpointSha256,measurements:{buildMs,buildCpuDelta,serializeAndWriteMs:serialMs,serializeAndWriteCpu:serialCpuDelta,writeAwaitMs,writeCalls,bytesWritten,fsyncMs}};await writeFile('/output/receipt.json',JSON.stringify(receipt),{mode:0o600});console.log(JSON.stringify({operation:'projection.resume.complete',receipt}));
 }else if(mode==='readback'){
  const expected=JSON.parse(await readFile('/output/receipt.json','utf8'));stage='projection.verify';const verifyStart=Date.now(),verifyCpu=cpu();const verified=await verifyProjectionFile('/output/projection.json',expected);const verifyMs=Date.now()-verifyStart,verifyCpuDelta=process.cpuUsage(verifyCpu);await sample();
  stage='checkpoint.readback';const restored=new TradeState(),readStart=Date.now(),readCpu=cpu();const result=await restore(restored,'/output/projection.json',p=>{stage=p.stage;lastRows=p.rows});const readMs=Date.now()-readStart,readCpuDelta=process.cpuUsage(readCpu);
  if(result.source!=='checkpoint'||result.rows!==expected.stateRows)throw Error('PRIVATE_CHECKPOINT_READBACK_MISMATCH');
  const sideHash=createHash('sha256');for await(const chunk of createReadStream('/output/projection.json.regular-checkpoint.json'))sideHash.update(chunk);
  if(sideHash.digest('hex')!==expected.privateCheckpointSha256)throw Error('PRIVATE_CHECKPOINT_HASH_MISMATCH');
  stage='readback.complete';await sample();console.log(JSON.stringify({operation:'projection.resume.readback',verified:true,projection:verified,stateRows:result.rows,verifyMs,verifyCpuDelta,privateRestoreMs:readMs,privateRestoreCpu:readCpuDelta}));
 }else throw Error('INVALID_MODE');
} finally {clearInterval(timer)}
