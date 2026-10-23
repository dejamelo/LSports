import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createServer} from 'node:net';
import {connectDurableMq,ingressFailureDetails} from './durable-ingress.mjs';
const pkg={lane:'prematch',packageId:4511,username:'private-user',password:'private-password',hostname:'127.0.0.1',queue:'unused',vhost:'unused',tls:false,port:1};
test('sanitized startup failure retains exact stage/code without private message or path',()=>{
 const error=Object.assign(new TypeError('amqp://private-user:private-password@secret payload'),{code:'SQLITE_BUSY',errcode:5,stack:'TypeError: private-password\n at secret (/private/credential/durable-ingress.mjs:99:3)'});
 const safe=ingressFailureDetails(error,'inbox.open');assert.equal(safe.ingressStage,'inbox.open');assert.equal(safe.errorCode,'SQLITE_BUSY');assert.equal(safe.sqliteErrcode,5);assert.equal(safe.errorType,'TypeError');assert.deepEqual(safe.stackFrames,[{file:'durable-ingress.mjs',line:99,column:3}]);assert.doesNotMatch(JSON.stringify(safe),/private|credential|secret|payload/);
 assert.equal(ingressFailureDetails(Object.assign(Error('secret'),{code:'SECRET_CREDENTIAL'}),'amqp.connect').errorCode,null);
});
async function capture(fn){const events=[];const old=console.error;console.error=(line)=>{try{events.push(JSON.parse(line));}catch{}};try{await fn();}finally{console.error=old;}return events;}
test('real inbox open failure reports inbox.open and does not retain actor lease',{timeout:10000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-open-failure-'));const invalid=join(dir,'file');await writeFile(invalid,'preserved');
 try{const events=await capture(async()=>{await assert.rejects(connectDurableMq(pkg,join(invalid,'inbox.sqlite'),()=>{},{offline:true}));});assert.ok(events.some(e=>e.operation==='inbox.actor_failure'&&e.ingressStage==='inbox.open'&&['EEXIST','ENOTDIR'].includes(e.errorCode)));}finally{await rm(dir,{recursive:true,force:true});}
});
test('real AMQP connection refusal reports connect stage and permits offline inbox recovery',{timeout:10000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-connect-failure-')),path=join(dir,'inbox.sqlite');const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=(server.address()).port;await new Promise(r=>server.close(()=>r()));
 try{const events=await capture(async()=>{await assert.rejects(connectDurableMq({...pkg,port},path));});assert.ok(events.some(e=>e.ingressStage==='amqp.connect'&&e.errorCode==='ECONNREFUSED'));const recovered=await connectDurableMq(pkg,path,()=>{},{offline:true});await recovered.close();}finally{await rm(dir,{recursive:true,force:true});}
});
