import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clients} from './provider.js';
import {SnapshotScheduler} from './snapshot-scheduler.js';
import {OperationError} from './diagnostics.js';
// IDs from the saved report, not proof of their supplier availability.
const ids=[12071254,12382367,13796395,14751373,14877001];
test('reported fixture IDs survive exact SDK wire serialization; transformation preserves rows and distinguishes empty from malformed',{timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-empty-batch-')),old=process.env.LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT;
 process.env.LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT='true';let mode='valid',eventRequests=0,applied=0;
 const server=createServer(async(req,res)=>{
  let text='';for await(const data of req)text+=data;const body=JSON.parse(text);
  res.setHeader('Content-Type','application/json');
  if(req.url==='/Fixtures/Get'){res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:{Fixtures:ids}}));return;}
  assert.equal(req.url,'/Prematch/GetEvents');assert.equal(req.method,'POST');
  assert.deepEqual(body.fixtures,ids);assert.equal(body.packageId,4511);
  assert.deepEqual(Object.keys(body).sort(),['fixtures','packageId','password','username']);eventRequests++;
  const rows=mode==='empty'?[]:ids.map(FixtureId=>mode==='malformed'?{FixtureId}:{FixtureId,Fixture:{Status:1},Markets:[]});
  res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:rows}));
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const config={lane:'prematch' as const,packageId:4511,username:'isolated',password:'isolated',hostname:'unused',vhost:'StmPreMatch',queue:'_4511_',port:5672,tls:false};
 try{for(mode of ['valid','empty','malformed']){
  const opts={root:join(dir,mode),spacingMs:0,refreshMs:0};
  const api=clients(config,{snapshotUrl:url,customersUrl:url},new SnapshotScheduler(url,4511,opts),new SnapshotScheduler(url,4511,opts));
  const action=()=>api.snapshotPartitioned!({assertOpen(){},async begin(){},async progress(){},async batch(rows){assert.deepEqual(rows.map(r=>r.fixtureId),ids);applied++;}});
  if(mode==='valid')await action();else await assert.rejects(action(),error=>{
   assert.ok(error instanceof OperationError);const v=error.diagnostic.snapshotValidation;
   assert.equal(v?.code,mode==='empty'?'batch_id_mismatch':'batch_invalid_fixture');
   if(mode==='empty'){assert.equal(v?.received,0);assert.equal(v?.missing,5);}else{assert.equal(v?.rawCount,5);assert.equal(v?.sdkCount,5);}return true;
  });
 }assert.equal(applied,1);assert.equal(eventRequests,3);
 }finally{if(old===undefined)delete process.env.LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT;else process.env.LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT=old;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
