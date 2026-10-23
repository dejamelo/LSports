import {test} from 'node:test';import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {createRequire} from 'node:module';
import {setTimeout as sleep} from 'node:timers/promises';
import {clients} from './provider.js';import {sdkAxios} from './diagnostics.js';
// Actual installed SDK and Axios transport, isolated local endpoint; no LSports request.
test('SDK distribution timeout is one HTTP attempt; event-loop delay can exceed configured timeout',{timeout:10000},async()=>{
 let requests=0;const server=createServer((_req,_res)=>{requests++});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address() as {port:number};
 const original=sdkAxios.defaults.timeout;sdkAxios.defaults.timeout=40;
 try{
  const api=clients({lane:'prematch',packageId:4511,username:'isolated',password:'isolated'} as any,{customersUrl:`http://127.0.0.1:${address.port}`,snapshotUrl:'https://unused.invalid'});
  const began=performance.now();const task=api.distributionStatus();const observed=task.catch(e=>e);
  // Wait for the local endpoint to receive the single request, then stall the
  // same JS loop that must execute Axios' timeout callback.
  const end=Date.now()+1000;while(!requests&&Date.now()<end)await sleep(1);
  const blockUntil=performance.now()+140;while(performance.now()<blockUntil){}
  const error=await observed;assert.equal(requests,1);assert.equal(error.diagnostic.timeoutMs,40);
  assert.equal(error.diagnostic.networkCode,'ECONNABORTED');assert.ok(error.diagnostic.elapsedMs>=140);
  assert.ok(performance.now()-began<3000,'no hidden SDK retry/backoff');
  const req=createRequire(createRequire(import.meta.url).resolve('trade360-nodejs-sdk'));
  assert.equal(req('axios').defaults.timeout,40,'same CJS Axios singleton as SDK');
 }finally{sdkAxios.defaults.timeout=original;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
