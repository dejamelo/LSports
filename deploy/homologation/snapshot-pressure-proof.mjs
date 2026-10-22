// Isolated candidate-image proof; loopback only, synthetic fixtures, no credentials.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {fullSnapshot} from '/app/apps/worker/src/full-snapshot.ts';
const dir=await mkdtemp('/tmp/spool-pressure-'),previous=process.availableMemory;
let calls=0,low=false,applied=0,ticks=0;
const server=createServer((_req,res)=>{calls++;res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:Array.from({length:23},(_,i)=>({FixtureId:i+1,Fixture:{Status:1},Markets:null}))}));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const timer=setInterval(()=>ticks++,2);
try{
 process.availableMemory=()=>low?264994816:512*1024**2;
 const result=await fullSnapshot({url:'http://127.0.0.1:'+server.address().port,credentials:{packageId:4511,username:'isolated',password:'isolated'},directory:dir,assertOpen(){},limits:{responseBytes:1048576,memoryWaitMs:1000,memoryRetryMs:20},downloadGate:async action=>{await action();low=true;setTimeout(()=>{assert.equal(applied,0);low=false;},120);},async apply(){assert.equal(low,false);applied++;}});
 assert.equal(calls,1);assert.equal(result.rows,23);assert.equal(applied,23);assert.ok(ticks>2);assert.deepEqual(await readdir(dir),[]);
 console.log('snapshot-pressure-offline-ok');
}finally{clearInterval(timer);process.availableMemory=previous;server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
