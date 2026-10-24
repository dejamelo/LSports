import {test} from 'node:test';
import assert from 'node:assert/strict';
import {jsonItems,writeJsonRecord} from '@lsports/feed-store';
import {writePrivateCheckpointRecord} from './persistence.js';
test('private native fragments preserve generic encoder bytes including dates, unicode, nulls and map order',async()=>{
 const record={lane:'prematch',fixtureId:7,fixture:{value:{name:'á雪',when:new Date('2026-10-24T00:00:00Z'),missing:undefined}},markets:jsonItems(function*(){yield ['2',{bets:[{id:'a',price:'2.05',suspended:true}]}];yield ['1',{bets:[]}];}),betAt:jsonItems(function*(){yield ['2:a',1792800000000];}),missing:undefined,nullable:null};
 const render=async(fn:any)=>{const chunks:string[]=[];await fn({writeFile:async(s:string)=>{chunks.push(s);}},record);return chunks.join('');};
 assert.equal(await render(writePrivateCheckpointRecord),await render(writeJsonRecord));
});
test('native fragments reject oversized fixture and propagate storage failures',async()=>{
 await assert.rejects(writePrivateCheckpointRecord({writeFile:async()=>{}},{name:'x'.repeat(33*1024**2)}),/checkpoint_record_limit/);
 await assert.rejects(writePrivateCheckpointRecord({writeFile:async()=>{throw Error('EIO');}},{fixtureId:1}),/EIO/);
});
