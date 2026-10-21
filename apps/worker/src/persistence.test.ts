import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import amqp from 'amqplib';
import { createPublisher, readConnectedFeed } from '@lsports/feed-store';
import { TradeState } from './state.js';
import { checkpoint, restore, persistRegularCheckpoint } from './persistence.js';
import { session } from './connected.js';
import { createApp } from '../../api/src/app.js';
import type { PackageConfig } from './config.js';

const fixtureId = 20540377;
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
  const side=JSON.parse(await readFile(path+'.regular-checkpoint.json','utf8'));assert.ok(side.regular.some((r:{lane:string})=>r.lane===pkg.lane));
  if(++committed===2)abort.abort();
 }});
 const restarted=new TradeState();await restore(restarted,path);assert.equal(restarted.rows.prematch.size,1);assert.equal(restarted.rows.inplay.size,1);assert.equal(committed,2);
 await assert.rejects(readFile(path+'.lock'),(e:{code:string})=>e.code==='ENOENT');
 }finally{abort.abort();await rm(dir,{recursive:true,force:true});}
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
