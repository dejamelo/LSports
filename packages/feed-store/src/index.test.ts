import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublisher, readConnectedFeed, unavailable } from "./index.js";
test("connected mode never falls back to demo when state missing, stale or invalid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trade-store-"));
  const path = join(dir, "feed.json");
  try {
    assert.deepEqual((await readConnectedFeed(path)).events, []);
    const publish = createPublisher(path);
    const feed = {
      ...unavailable("Test"),
      updatedAt: new Date().toISOString(),
    };
    await Promise.all([publish(feed), publish({ ...feed, notice: "latest" })]);
    assert.equal((await readConnectedFeed(path)).notice, "latest");
    assert.equal(
      (await readConnectedFeed(path, Date.now() + 21000)).health,
      "unavailable",
    );
    assert.deepEqual(
      (await readConnectedFeed(path, Date.now() + 21000)).events,
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('nested checkpoint arrays remain incremental with bounded native leaf encoding',async()=>{
  const {writeJsonObject,jsonItems}=await import('./index.js');
  const chunks:string[]=[],value={workerCheckpoint:{version:1,outright:jsonItems(function*(){for(let i=0;i<10000;i++)yield {fixtureId:i,markets:[{id:160,bets:[{id:'1',price:'2.1'}]}]};})}};
  const stringify=JSON.stringify;
  try{
    JSON.stringify=((input:unknown,...rest:any[])=>{const encoded=(stringify as any)(input,...rest);if(input!==null&&typeof input==='object')assert.ok(Buffer.byteLength(encoded)<=32768,'unbounded aggregate stringify retains a full graph');return encoded;}) as typeof JSON.stringify;
    await writeJsonObject({writeFile:async(s:string)=>{assert.ok(Buffer.byteLength(s)<66000);chunks.push(s);}} as any,value);
  }finally{JSON.stringify=stringify;}
  const parsed=JSON.parse(chunks.join(''));
  assert.equal(parsed.workerCheckpoint.outright.length,10000);
  assert.deepEqual(parsed.workerCheckpoint.outright[9999],{fixtureId:9999,markets:[{id:160,bets:[{id:'1',price:'2.1'}]}]});
});

test('API read rejects an oversized complete projection without allocating its contents',async()=>{
  const {open}=await import('node:fs/promises');
  const {API_FEED_READ_LIMIT_BYTES,apiFeedReadBudget}=await import('./index.js');
  const dir=await mkdtemp(join(tmpdir(),'api-feed-budget-')),path=join(dir,'feed.json');
  try{
    const f=await open(path,'w');await f.truncate(API_FEED_READ_LIMIT_BYTES+1);await f.close();
    const result=await readConnectedFeed(path);
    assert.equal(result.health,'unavailable');assert.deepEqual(result.events,[]);
    assert.match(result.notice!,/capacidad segura/);
    assert.equal(apiFeedReadBudget(128*1024*1024,1),0);
    assert.ok(apiFeedReadBudget(512*1024*1024,80*1024*1024)<=8*1024*1024);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('concurrent API reads share one complete parse and retain no checkpoint or stale cache',async()=>{
  const {writeFile}=await import('node:fs/promises');
  const dir=await mkdtemp(join(tmpdir(),'api-feed-single-')),path=join(dir,'feed.json');
  try{
    await writeFile(path,JSON.stringify({...unavailable('first'),updatedAt:new Date().toISOString(),workerCheckpoint:{private:true}}));
    const results=await Promise.all(Array.from({length:20},()=>readConnectedFeed(path)));
    assert.ok(results.every(x=>x===results[0]));assert.equal('workerCheckpoint' in results[0],false);
    await writeFile(path,JSON.stringify({...unavailable('second'),updatedAt:new Date().toISOString()}));
    assert.equal((await readConnectedFeed(path)).notice,'second');
    assert.equal((await readConnectedFeed(path,Date.now()+21000)).events.length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});
