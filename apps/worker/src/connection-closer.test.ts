import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {connectionCloser} from './connection-closer.js';

test('actual amqplib ChannelModel: socket close without CloseOk leaves SDK promise pending, but cleanup finishes',async()=>{
 const require=createRequire(import.meta.url);const {ChannelModel}=require('amqplib/lib/channel_model.js');
 const transport=Object.assign(new EventEmitter(),{calls:0,close(_callback:()=>void){this.calls++;queueMicrotask(()=>transport.emit('close'));}});
 const model=new ChannelModel(transport);let sdkSettled=false;const original=model.close.bind(model);
 model.close=()=>{const promise=original();void promise.then(()=>{sdkSettled=true;});return promise;};
 const close=connectionCloser(model);const first=close();assert.equal(close(),first);
 await first;assert.equal(transport.calls,1);assert.equal(sdkSettled,false);
 assert.equal(model.listenerCount('close'),0);
});
test('transport already closed never calls SDK close again',async()=>{
 let calls=0;const connection=Object.assign(new EventEmitter(),{async close(){calls++;}});const close=connectionCloser(connection);connection.emit('close');await close();assert.equal(calls,0);
});
test('no early completion before transport event or normal SDK completion',async()=>{
 let complete!:()=>void;let resolved=false;const connection=Object.assign(new EventEmitter(),{close:()=>new Promise<void>(r=>{complete=r;})});const close=connectionCloser(connection);const pending=close().then(()=>{resolved=true;});await new Promise(r=>setImmediate(r));assert.equal(resolved,false);complete();await pending;assert.equal(resolved,true);
});

test('durable resources are explicitly joined once even after the transport close event',async()=>{
 let calls=0,release!:()=>void;const connection=Object.assign(new EventEmitter(),{close(){calls++;return new Promise<void>(r=>release=r);}});
 const close=connectionCloser(connection,{joinLocalResources:true});connection.emit('close');let done=false;const first=close();assert.equal(close(),first);void first.then(()=>done=true);
 await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.equal(done,false);release();await first;assert.equal(done,true);
});
