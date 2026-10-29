import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import amqp from 'amqplib';
import { createPublisher, readConnectedFeed } from '@lsports/feed-store';
import { TradeState, betVersionAt } from './state.js';
import { checkpoint, restore, persistRegularCheckpoint, persistCheckpointDelta, compactCheckpointJournal, privateCheckpointFileAllowed, MAX_PRIVATE_REGULAR_CHECKPOINT_BYTES } from './persistence.js';
import { session } from './connected.js';
import { createApp } from '../../api/src/app.js';
import type { PackageConfig } from './config.js';

const fixtureId = 20540377;

test('restore compacts legacy betAt entries that exactly match LastUpdate', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'adl-betat-compact-')),path=join(dir,'feed.json');
  try{
    const state=new TradeState(),version=Date.parse('2026-10-22T12:00:00.123Z');
    state.apply('prematch',[{fixtureId:1,fixture:{status:1},markets:[{id:1,bets:[{id:'1',price:'2',lastUpdate:new Date(version)}]}]} as any],version);
    const saved=checkpoint(state);(saved.regular[0] as any).betAt=[['1:1',version]];
    await writeFile(path,JSON.stringify({...state.feed(),workerCheckpoint:saved}));
    const restored=new TradeState();await restore(restored,path);const row=restored.rows.prematch.get(1)!;
    assert.equal(row.betAt.size,0);assert.equal(betVersionAt(row,'1',row.markets.get('1')!.bets![0]),version);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('bounded streamed restore accepts measured >2 GiB sidecars without relaxing record or memory guards',()=>{
 const measuredBytes=2_202_771_778;
 assert.ok(measuredBytes>2*1024**3);
 assert.ok(measuredBytes<MAX_PRIVATE_REGULAR_CHECKPOINT_BYTES);
 assert.equal(privateCheckpointFileAllowed(measuredBytes,true,false),true);
 assert.equal(privateCheckpointFileAllowed(MAX_PRIVATE_REGULAR_CHECKPOINT_BYTES,true,false),true);
 assert.equal(privateCheckpointFileAllowed(MAX_PRIVATE_REGULAR_CHECKPOINT_BYTES+1,true,false),false);
 assert.equal(privateCheckpointFileAllowed(measuredBytes,false,false),false);
 assert.equal(privateCheckpointFileAllowed(measuredBytes,true,true),false);
});
function seed() {
  const state = new TradeState();
  for (const lane of ['prematch', 'inplay'] as const) {
    state.apply(lane, [{ fixtureId, outright: { competitionId: 90,
      fixture: { fixtureName: 'Synthetic San Isidro restart fixture', sport: { name: 'Horse Racing' }, status: 1,
        participants: Array.from({ length: 9 }, (_, i) => ({ id: i + 1, name: `Test runner ${i + 1}`, position: String(i + 1) })) } },
      marketMessageType: 41,
      markets: [{ id: 160, name: 'Race Winner', status: 1, bets: [{ id: '9223372036854775807', participantId: 1, price: '3.25', status: 1, isChanged: 0 }] }],
    }, { fixtureId: 777, outright: { competitionId: 90 }, markets: [{ id: 160, bets: [{ id: 'orphan', price: '5', isChanged: 0 }] }] }], 1700000000000);
    state.set(lane, { phase: 'connected' });
  }
  return state;
}
test('restart restores old outright checkpoint before initial empty snapshot, persists again and finds provider fixture ID through HTTP', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adl-restart-'));
  const path = join(dir, 'feed.json');
  try {
    const original = seed();
    await createPublisher(path)(original.feed(1700000000000), checkpoint(original));
    // API expiry is deliberately independent of worker recovery after downtime.
    assert.equal((await readConnectedFeed(path)).events.length, 0);
    const restarted = new TradeState();
    assert.deepEqual(await restore(restarted, path), { source: 'checkpoint', rows: 4 });
    assert.equal(restarted.connections.prematch.phase, 'starting');
    const publish = createPublisher(path);
    const abort = new AbortController();
    const pkg: PackageConfig = { lane: 'prematch', packageId: 4511, username: 'test', password: '',
      hostname: 'stm-prematch.lsports.eu', vhost: 'StmPreMatch', queue: '_4511_', port: 5672, tls: false };
    const channel = Object.assign(new EventEmitter(), {
      async prefetch() {}, async consume() { return { consumerTag: 'test' }; },
      ack() { assert.fail('Restart must need no supplier message'); },
    });
    const connection = Object.assign(new EventEmitter(), { async createChannel() { return channel; }, async close() { connection.emit('close'); } });
    await session(pkg, { packages: [pkg], snapshotUrl: 'https://stm-snapshot.lsports.eu', customersUrl: 'https://stm-api.lsports.eu', recoveryMs: 300000, staleMs: 90000 },
      restarted, async () => {
        await publish(restarted.feed(), checkpoint(restarted));
        if (restarted.connections.prematch.phase === 'connected') abort.abort();
      }, abort.signal, { connect: (async () => connection) as unknown as typeof amqp.connect,
        clientFactory: () => ({ async startDistribution() {},
          async distributionStatus() { return { isDistributionOn: true, consumers: [], numberMessagesInQueue: 0, messagesPerSecond: 0 }; },
          async snapshot() { return []; }, async catalog() { return []; } }) });
    // Regular soccer snapshot remains authoritative; it cannot clear restored outrights.
    restarted.replace('inplay', [{ fixtureId: 123, fixture: { sport: { name: 'Football' }, status: 1 } }], Date.now());
    restarted.set('prematch', { phase: 'connected' });
    restarted.set('inplay', { phase: 'connected' });
    await publish(restarted.feed(), checkpoint(restarted));
    const source = { getEvents: () => readConnectedFeed(path) };
    const server = createApp(source).listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    try {
      const address = server.address(); assert(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;
      const diagnostic = await (await fetch(`${base}/api/diagnostics/outright/${fixtureId}`)).json();
      assert.equal(diagnostic.observation, 'observed');
      assert.equal(diagnostic.matches.length, 2);
      assert(diagnostic.matches.every((m: {participantCount: number; restored: boolean}) => m.participantCount === 9 && m.restored));
      const feed = await (await fetch(`${base}/api/events`)).json();
      assert.equal(feed.workerCheckpoint, undefined); // private raw SDK state never leaks through API
      assert.equal(feed.events.filter((e: {kind: string}) => e.kind === 'outright').length, 2);
      const race = feed.events.find((e: {source: string; kind: string}) => e.source === 'prematch' && e.kind === 'outright');
      assert.equal(race.selections[0].odds, 3.25);
      assert.equal(race.selections[0].available, false); // old price is preserved, not freshly validated
      assert.equal(feed.events.find((e: {sport: string}) => e.sport === 'futbol').id, 'inplay:123');
    } finally { await new Promise<void>(r => server.close(() => r())); }
    const twice = new TradeState();
    await restore(twice, path);
    assert.equal(twice.rows.prematch.get('outright:90:777')?.markets.size, 1);
    // Ordering survives restart: delayed messages cannot replace a newer price.
    twice.apply('prematch', [{ fixtureId, outright: { competitionId: 90 }, markets: [{ id: 160, bets: [{ id: '9223372036854775807', price: '9', isChanged: 0 }] }] }], 1699999999999);
    assert.equal(twice.feed().events[0].selections[0].odds, 3.25);
    twice.set('prematch', { phase: 'connected' });
    twice.apply('prematch', [{ fixtureId, outright: { competitionId: 90 }, marketMessageType: 41, markets: [{ id: 160, bets: [{ id: '9223372036854775807', price: '3.5', status: 1, isChanged: 0 }] }] }], Date.now());
    assert.equal(twice.feed().events[0].selections[0].available, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('legacy projection migrates all nine participants and exposed markets with original backup, even when stale', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adl-migrate-')); const path = join(dir, 'feed.json');
  try {
    const legacy = JSON.stringify(seed().feed(1700000000000));
    await writeFile(path, legacy);
    const state = new TradeState();
    assert.deepEqual(await restore(state, path), { source: 'legacy_projection', rows: 2 });
    assert.equal(state.feed().events[0].participants?.length, 9);
    assert.equal(state.feed().events[0].selections[0].odds, 3.25);
    assert.equal(state.feed().events[0].marketDiagnostic?.messagesByType['41'], 1);
    assert.equal(await readFile(`${path}.pre-checkpoint.bak`, 'utf8'), legacy);
    await createPublisher(path)(state.feed(), checkpoint(state));
    const next = new TradeState(); await restore(next, path);
    assert.equal(next.feed().events[0].participants?.length, 9);
    assert.equal(await readFile(`${path}.pre-checkpoint.bak`, 'utf8'), legacy);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid or unsupported saved state aborts restoration without changing original file or partially restoring rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adl-corrupt-')); const path = join(dir, 'feed.json');
  try {
    for (const body of ['invalid JSON', JSON.stringify({ mode: 'connected', events: [], workerCheckpoint: { version: 99, outright: [] } }),
      JSON.stringify({ ...seed().feed(), workerCheckpoint: { ...checkpoint(seed()), outright: [...checkpoint(seed()).outright, { lane: 'prematch' }] } })]) {
      await writeFile(path, body);
      const state = new TradeState();
      await assert.rejects(() => restore(state, path));
      assert.equal(state.rows.prematch.size, 0);
      assert.equal(await readFile(path, 'utf8'), body);
    }
    await rm(path);
    assert.deepEqual(await restore(new TradeState(), path), { source: 'missing', rows: 0 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('real worker bootstrap restores before its first write and shutdown, without contacting supplier', async () => {
  const { runConnected } = await import('./connected.js');
  const dir = await mkdtemp(join(tmpdir(), 'adl-bootstrap-')); const path = join(dir, 'feed.json');
  const bindings = { LSPORTS_STATE_FILE: path, LSPORTS_PREMATCH_USERNAME: 'synthetic-test', LSPORTS_PREMATCH_PASSWORD: 'synthetic-test',
    LSPORTS_INPLAY_USERNAME: 'synthetic-test', LSPORTS_INPLAY_PASSWORD: 'synthetic-test' };
  const prior = Object.fromEntries(Object.keys(bindings).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, bindings);
    const original = seed();
    await createPublisher(path)(original.feed(1700000000000), checkpoint(original));
    const signal = new AbortController(); signal.abort();
    // Already-aborted signal skips all network sessions, but runs actual init/persistence/shutdown.
    await runConnected(signal.signal);
    await runConnected(signal.signal);
    const result = new TradeState();
    assert.equal((await restore(result, path)).rows, 4);
    assert.equal(result.feed().events[0].participants?.length, 9);
    assert.equal(result.feed().events[0].selections[0].odds, 3.25);
    assert.equal(result.connections.prematch.phase, 'starting');
    await assert.rejects(() => readFile(`${path}.lock`), { code: 'ENOENT' });
  } finally {
    for (const key of Object.keys(bindings)) {
      if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('market-before-fixture delivery survives restart in private regular checkpoint, without exposing odds or restoring availability',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-regular-pending-')),path=join(dir,'feed.json');
 try{const original=new TradeState();original.apply('prematch',[{fixtureId:100,markets:[{id:1,status:1,bets:[{id:'123',price:'2.8',status:1,isChanged:1}]}]}],Date.now());
  assert.equal(original.feed().events.length,0);await createPublisher(path)(original.feed(),checkpoint(original));
  const restarted=new TradeState();await restore(restarted,path);
  assert.equal(restarted.rows.prematch.get(100)?.markets.get('1')?.bets?.[0].price,'2.8');assert.equal(restarted.feed().events.length,0);
  restarted.apply('prematch',[{fixtureId:100,fixture:{status:1,sport:{name:'Football'}}}],Date.now());
  assert.ok(restarted.feed().events[0].selections.every(s=>!s.available));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('private regular sidecar restores an acknowledged market orphan while public JSON omits its payload; missing sidecar blocks restore',async()=>{
 const{persistRegularCheckpoint}=await import('./persistence.js');const dir=await mkdtemp(join(tmpdir(),'adl-sidecar-')),path=join(dir,'feed.json');
 try{const original=new TradeState();original.apply('prematch',[{fixtureId:100,markets:[{id:1,status:1,bets:[{id:'123',price:'2.8',status:1,isChanged:1}]}]}],Date.now());
 const{regular,...saved}=checkpoint(original);await persistRegularCheckpoint(path,regular);await createPublisher(path)(original.feed(),{...saved,regularExternal:true});
 assert.ok(!String(await readFile(path,'utf8')).includes('2.8'));
 const restarted=new TradeState();await restore(restarted,path);assert.equal(restarted.rows.prematch.get(100)?.markets.get('1')?.bets?.[0].price,'2.8');assert.equal(restarted.feed().events.length,0);
 await rm(path+'.regular-checkpoint.json');await assert.rejects(restore(new TradeState(),path));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('both lanes persist concurrently through one writer; private checkpoint and lock survive clean shutdown/restart', {timeout:10000},async()=>{
 const{runConnected}=await import('./connected.js');const dir=await mkdtemp(join(tmpdir(),'adl-two-lane-writer-')),path=join(dir,'feed.json');const abort=new AbortController();let committed=0;
 const packages=(['prematch','inplay'] as const).map((lane,i)=>({lane,packageId:4511-i,username:'isolated',password:'',hostname:'unused',vhost:'unused',port:5672,tls:false,queue:'unused'}));
 try{await runConnected(abort.signal,{path,ticketPath:join(dir,'tickets.sqlite'),config:{packages,snapshotUrl:'https://unused.invalid',customersUrl:'https://unused.invalid',recoveryMs:300000,staleMs:90000},session:async(pkg,_cfg,state,save)=>{
  state.apply(pkg.lane,[{fixtureId:pkg.packageId,markets:[{id:1,status:1,bets:[{id:'123',price:'2.1',status:1,isChanged:1}]}]}],Date.now());await save();
  const journal=(await readFile(path+'.checkpoint-journal.jsonl','utf8')).trim().split('\n').map(line=>JSON.parse(line) as {op:string;lane:string});assert.ok(journal.some(r=>['upsert','merge'].includes(r.op)&&r.lane===pkg.lane));
  if(++committed===2)abort.abort();
 }});
 const restarted=new TradeState();await restore(restarted,path);assert.equal(restarted.rows.prematch.size,1);assert.equal(restarted.rows.inplay.size,1);assert.equal(committed,2);
 await assert.rejects(readFile(path+'.lock'),(e:{code:string})=>e.code==='ENOENT');
 }finally{abort.abort();await rm(dir,{recursive:true,force:true});}
});

test('append-only checkpoint journal survives restart, compacts atomically and rejects a torn tail without changing the source',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-checkpoint-journal-')),path=join(dir,'feed.json');
 try{
  const state=new TradeState();state.apply('prematch',[{fixtureId:501,fixture:{status:1},markets:[{id:1,status:1,bets:[{id:'A',price:'2.4',status:1,isChanged:1}]}]}],Date.now());
  const first=state.projectionChanges();const saved=await persistCheckpointDelta(path,state,first);assert.equal(saved.rows,1);state.acknowledgeProjectionChanges(first);
  let restored=new TradeState();assert.equal((await restore(restored,path)).source,'checkpoint_journal');assert.equal(restored.rows.prematch.get(501)?.markets.get('1')?.bets?.[0].price,'2.4');
  state.apply('prematch',[{fixtureId:501,markets:[{id:1,status:1,bets:[{id:'A',price:'2.9',status:1,isChanged:1}]}]}],Date.now()+1);
  await persistCheckpointDelta(path,state,state.projectionChanges());
  const compacted=await compactCheckpointJournal(path,state);assert.equal(compacted.rows,1);
  restored=new TradeState();assert.equal((await restore(restored,path)).rows,1);assert.equal(restored.rows.prematch.get(501)?.markets.get('1')?.bets?.[0].price,'2.9');
  const journal=path+'.checkpoint-journal.jsonl',valid=await readFile(journal,'utf8');await writeFile(journal,valid+'{"op":"upsert"');
  const before=await readFile(path);await assert.rejects(restore(new TradeState(),path),/Truncated checkpoint journal/);assert.deepEqual(await readFile(path),before);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('market-level checkpoint journal merges partial rows and restores untouched markets after interruption',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-checkpoint-market-delta-')),path=join(dir,'feed.json');
 try{
  const state=new TradeState(),at=Date.now();
  state.apply('prematch',[{fixtureId:777,fixture:{status:1},markets:[
   {id:1,status:1,bets:[{id:'a',price:'1.8',status:1,isChanged:1,lastUpdate:new Date(at)}]},
   {id:2,status:1,bets:[{id:'b',price:'2.2',status:1,isChanged:1,lastUpdate:new Date(at)}]},
  ]}],at);
  state.rows.prematch.get(777)!.deferredTimestampBets=new Map([
   ['1:a',{marketId:1,selectionId:'a',bet:{id:'a'},inspection:{},receivedAt:new Date(at).toISOString()}],
   ['2:b',{marketId:2,selectionId:'b',bet:{id:'b'},inspection:{},receivedAt:new Date(at).toISOString()}],
  ]) as any;
  let changes=state.projectionChanges();const initial=await persistCheckpointDelta(path,state,changes);state.acknowledgeProjectionChanges(changes);
  state.apply('prematch',[{fixtureId:777,markets:[{id:1,status:1,bets:[{id:'a',price:'2.4',status:1,isChanged:1,lastUpdate:new Date(at+1000)}]}]}],at+1000);
  changes=state.projectionChanges();const partial=await persistCheckpointDelta(path,state,changes);state.acknowledgeProjectionChanges(changes);
  const records=(await readFile(path+'.checkpoint-journal.jsonl','utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(records[0].op,'merge');assert.equal(records[0].entry.markets.length,2);
  assert.equal(records[1].op,'merge');assert.equal(records[1].entry.markets.length,1,'one changed market is journaled instead of the full fixture market set');
  assert.ok(partial.bytes<initial.bytes,'partial journal bytes scale with the changed market');
  state.apply('prematch',[{fixtureId:777,fixture:{status:2}}],at+2000);
  changes=state.projectionChanges();await persistCheckpointDelta(path,state,changes);
  const restored=new TradeState();await restore(restored,path);const row=restored.rows.prematch.get(777)!;
  assert.equal(row.fixture?.value.status,2);assert.equal(row.markets.get('1')?.bets?.[0].price,'2.4');assert.equal(row.markets.get('2')?.bets?.[0].price,'2.2');
  assert.equal(row.deferredTimestampBets?.has('1:a'),false,'partial market replacement applies tombstones for removed per-selection state');
  assert.equal(row.deferredTimestampBets?.has('2:b'),true,'untouched market selection state remains recoverable');
}finally{await rm(dir,{recursive:true,force:true});}
});

test('repeated full snapshot confirms receipt metadata without journaling unchanged market graphs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-periodic-snapshot-delta-')),path=join(dir,'feed.json');
 try{
  const state=new TradeState(),at=Date.now();
  const event={fixtureId:778,fixture:{status:1},markets:[
   {id:10,status:1,bets:[{id:'a',price:'1.9',status:1,isChanged:1,lastUpdate:new Date(at)}]},
   {id:11,status:1,bets:[{id:'b',price:'2.1',status:1,isChanged:1,lastUpdate:new Date(at)}]},
  ]};
  state.apply('prematch',[event],at);
  let changes=state.projectionChanges();const first=await persistCheckpointDelta(path,state,changes);state.acknowledgeProjectionChanges(changes);
  state.apply('prematch',[{...event,marketRecovery:true}],at+60000,{source:'snapshot',receivedAt:at+60000});
  changes=state.projectionChanges();assert.deepEqual(changes.map(change=>change.marketIds),[[]]);
  const repeat=await persistCheckpointDelta(path,state,changes);state.acknowledgeProjectionChanges(changes);
  const records=(await readFile(path+'.checkpoint-journal.jsonl','utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(records[1].op,'merge');assert.deepEqual(records[1].marketIds,[]);assert.equal(records[1].entry.markets.length,0);
  assert.ok(repeat.bytes<2048,`repeated snapshot ${repeat.bytes}B should be metadata-only, without market or selection payloads`);
  state.apply('prematch',[{fixtureId:778,markets:[{id:10,status:1,bets:[{id:'a',price:'2.4',status:1,isChanged:1,lastUpdate:new Date(at+120000)}]}]}],at+120000);
  changes=state.projectionChanges();const newer=await persistCheckpointDelta(path,state,changes);state.acknowledgeProjectionChanges(changes);
  assert.equal(newer.rows,1);assert.deepEqual(state.projectionChanges(),[]);
  const restored=new TradeState();await restore(restored,path);const row=restored.rows.prematch.get(778)!;
  assert.equal(row.markets.get('10')?.bets?.[0].price,'2.4');assert.equal(row.markets.get('11')?.bets?.[0].price,'2.1');
}finally{await rm(dir,{recursive:true,force:true});}
});

test('12,321-fixture periodic refresh keeps unchanged market deltas out of the checkpoint journal',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-periodic-snapshot-volume-')),path=join(dir,'feed.json');
 try{
  const state=new TradeState(),at=Date.now();
  const events=Array.from({length:12321},(_,index)=>({fixtureId:index+1,markets:Array.from({length:3},(_,marketIndex)=>({
   id:marketIndex+1,status:1,bets:Array.from({length:4},(_,betIndex)=>({id:`s${betIndex+1}`,price:`${2+betIndex/10}`,status:1,isChanged:0,lastUpdate:new Date(at)})),
  }))}));
  state.apply('prematch',events,at);let changes=state.projectionChanges();
  const initial=await persistCheckpointDelta(path,state,changes);state.acknowledgeProjectionChanges(changes);
  assert.ok(initial.writeCalls<changes.length/20,`batched journal should avoid one filesystem await per row (${initial.writeCalls} writes for ${changes.length} rows)`);
  assert.ok(initial.maxBufferedBytes<=1024*1024,`journal staging is bounded (${initial.maxBufferedBytes} bytes)`);
  state.apply('prematch',events.map(event=>({...event,marketRecovery:true})),at+60000,{source:'snapshot',receivedAt:at+60000});
  changes=state.projectionChanges();assert.equal(changes.length,12321);assert.ok(changes.every(change=>change.marketIds?.length===0));
  const refresh=await persistCheckpointDelta(path,state,changes);
  assert.ok(refresh.writeCalls<changes.length/20,`periodic metadata journal should batch writes (${refresh.writeCalls} writes for ${changes.length} rows)`);
  assert.ok(refresh.bytes<initial.bytes/2,`repeat metadata delta ${refresh.bytes}B should be materially smaller than full market state ${initial.bytes}B`);
  const records=(await readFile(path+'.checkpoint-journal.jsonl','utf8')).trim().split('\n');
  const sample=JSON.parse(records.at(-1)!);assert.deepEqual(sample.marketIds,[]);assert.equal(sample.entry.markets.length,0);
  state.acknowledgeProjectionChanges(changes);
  const recovered=new TradeState();const recovery=await restore(recovered,path);
  assert.equal(recovery.rows,12321,'the batched journal remains a complete recoverable prefix after restart');
  assert.equal(recovered.rows.prematch.get(1)?.markets.size,3);
  const compacted=await compactCheckpointJournal(path,state);
  assert.equal(compacted.rows,12321,'snapshot compaction includes the full validated state');
  assert.equal(compacted.bytes,compacted.accountedBytes,'the bounded writer accounts for every checkpoint byte');
  assert.ok(compacted.writeCalls<compacted.bytes/(1024*1024)*2,`compaction coalesces record fragments across rows (${compacted.writeCalls} writes for ${compacted.bytes} bytes)`);
  assert.ok(compacted.maxBufferedBytes<=1024*1024,'compaction memory remains bounded');
  const afterCompaction=new TradeState();assert.equal((await restore(afterCompaction,path)).rows,12321,'the atomically installed baseline remains independently recoverable');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('incremental private checkpoint and projection preserve full rows; truncated sidecar never commits partial restore', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-incremental-')),path=join(dir,'feed.json');
 try{
  const state=new TradeState();
  for(let id=1;id<=200;id++)state.apply('prematch',[{fixtureId:id,fixture:{status:1},markets:[{id:1,status:1,bets:[{id:'A',price:'2.1',status:1,isChanged:1}]}]}],Date.now());
  await persistRegularCheckpoint(path,state);
  await createPublisher(path)(state.feed(),{...checkpoint(state,false),regularExternal:true});
  const restored=new TradeState();assert.equal((await restore(restored,path)).rows,200);
  assert.ok([...restored.rows.prematch.values()].every(r=>r.restored));
  const original=await readFile(path+'.regular-checkpoint.json','utf8');
  await writeFile(path+'.regular-checkpoint.json',original.slice(0,-2));
  const protectedState=new TradeState();protectedState.apply('inplay',[{fixtureId:999,fixture:{status:1}}],Date.now());
  await assert.rejects(restore(protectedState,path));assert.equal(protectedState.rows.prematch.size,0);assert.ok(protectedState.rows.inplay.has(999));
  assert.equal(await readFile(path+'.regular-checkpoint.json','utf8'),original.slice(0,-2));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('embedded checkpoint larger than record cap streams fixtures and commits only a fully valid document', {timeout:120000}, async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-embedded-')),path=join(dir,'feed.json');
 try{
  const {open,stat}=await import('node:fs/promises');const {createHash}=await import('node:crypto');
  const {createReadStream}=await import('node:fs');
  const hash=async()=>{const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');};
  const file=await open(path,'w');
  try{
   await file.writeFile('{"mode":"connected","events":[],"workerCheckpoint":{"version":1,"outright":[],"regular":[');
   for(let i=0;i<140;i++)await file.writeFile((i?',':'')+JSON.stringify({lane:'prematch',fixtureId:i+1,fixture:{value:{name:'x'.repeat(256*1024)},at:1700000000000},markets:[],marketAt:[],betAt:[]}));
   await file.writeFile(']}}');
  }finally{await file.close();}
  assert.ok((await stat(path)).size>32*1024**2);const before=await hash();
  const state=new TradeState();assert.equal((await restore(state,path)).rows,140);
  assert.equal(state.rows.prematch.size,140);assert.ok([...state.rows.prematch.values()].every(r=>r.restored));assert.equal(await hash(),before);
  await writeFile(path,',"bad":true}',{flag:'a'});const sentinel=new TradeState();
  await assert.rejects(restore(sentinel,path));assert.equal(sentinel.rows.prematch.size,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('large root projection collections are validated incrementally, not as one checkpoint item', {timeout:120000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-root-metadata-')),path=join(dir,'feed.json');
 try{
  const {open,stat}=await import('node:fs/promises');const original=seed(),file=await open(path,'w');
  try{
   await file.writeFile(JSON.stringify({mode:'connected',events:[],workerCheckpoint:checkpoint(original)}).slice(0,-1)+',"ticketOutcomes":[');
   for(let i=0;i<140;i++)await file.writeFile((i?',':'')+JSON.stringify({auditId:String(i),description:'x'.repeat(256*1024)}));
   await file.writeFile(']}');
  }finally{await file.close();}
  assert.ok((await stat(path)).size>32*1024**2);const state=new TradeState();
  assert.equal((await restore(state,path)).rows,4);assert.ok([...state.rows.prematch.values()].every(r=>r.restored));
  await writeFile(path,',oops',{flag:'a'});const untouched=new TradeState();await assert.rejects(restore(untouched,path));assert.equal(untouched.rows.prematch.size,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
