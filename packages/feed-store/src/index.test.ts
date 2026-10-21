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
test('nested checkpoint arrays are written incrementally without stringify of an aggregate',async()=>{
  const {writeJsonObject,jsonItems}=await import('./index.js');
  const chunks:string[]=[],value={workerCheckpoint:{version:1,outright:jsonItems(function*(){for(let i=0;i<10000;i++)yield {fixtureId:i,markets:[{id:160,bets:[{id:'1',price:'2.1'}]}]};})}};
  const stringify=JSON.stringify;
  try{
    JSON.stringify=((input:unknown,...rest:any[])=>{assert.ok(input===null||typeof input!=='object','aggregate stringify retains a full graph');return (stringify as any)(input,...rest);}) as typeof JSON.stringify;
    await writeJsonObject({writeFile:async(s:string)=>{assert.ok(Buffer.byteLength(s)<66000);chunks.push(s);}} as any,value);
  }finally{JSON.stringify=stringify;}
  const parsed=JSON.parse(chunks.join(''));
  assert.equal(parsed.workerCheckpoint.outright.length,10000);
  assert.deepEqual(parsed.workerCheckpoint.outright[9999],{fixtureId:9999,markets:[{id:160,bets:[{id:'1',price:'2.1'}]}]});
});
