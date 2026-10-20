import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {clients} from './provider.js';
import {StartMessage} from 'trade360-nodejs-sdk';

for(const alreadyActive of [false,true])test(`distribution propagation occurs once (already active: ${alreadyActive})`,async()=>{
 let active=alreadyActive,starts=0,checks=0;
 const server=createServer(async(req,res)=>{for await(const _ of req){}res.setHeader('Content-Type','application/json');if(req.url==='/Distribution/Start'){starts++;active=true;res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:{Message:StartMessage.activated}}));}else{checks++;res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:{IsDistributionOn:active}}));}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const address=server.address() as {port:number};const url=`http://127.0.0.1:${address.port}`;
  const api=clients({lane:'prematch',packageId:4511,username:'isolated',password:'isolated',hostname:'unused',vhost:'unused',queue:'unused',port:5672,tls:false},{snapshotUrl:url,customersUrl:url});
  const start=performance.now();await api.startDistribution();const elapsed=performance.now()-start;
  assert.ok(elapsed>=2000);assert.ok(elapsed<3800,`duplicate propagation delay: ${elapsed}`);assert.equal(starts,alreadyActive?0:1);assert.equal(checks,2);
  const observation=api.distributionObservations!().at(-1)!;assert.equal(observation.stage,'after_propagation');assert.equal(observation.bodyIsDistributionOn,true);assert.equal(observation.sdkIsDistributionOn,true);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
