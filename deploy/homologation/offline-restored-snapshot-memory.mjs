import{restore,persistRegularCheckpoint,checkpoint,streamCheckpoint}from'/app/apps/worker/src/persistence.ts';import{TradeState}from'/app/apps/worker/src/state.ts';import{writeJsonObject}from'/app/packages/feed-store/src/index.ts';import{open,writeFile}from'node:fs/promises';import{getHeapStatistics}from'node:v8';
const s=new TradeState();let rows=0;const sample=stage=>console.log(JSON.stringify({stage,rows,...process.memoryUsage(),heapLimit:getHeapStatistics().heap_size_limit}));await restore(s,process.env.ADL_RESTORED_INPUT||'/data/complete-cold-fixture/feed.json');global.gc?.();sample('restored');s.beginPartitionedSnapshot('prematch');const ids=new Set();
for(const[id,row]of s.rows.prematch){if(typeof id!=='number')continue;const incoming=structuredClone({fixtureId:id,fixture:row.fixture?.value,markets:[...row.markets.values()],marketRecovery:true});const now=Date.now();s.apply('prematch',[incoming],now,{source:'snapshot',receivedAt:now});ids.add(id);if(++rows%1000===0){sample('snapshot.apply');await new Promise(setImmediate);}}
s.finishPartitionedSnapshot('prematch',ids);global.gc?.();sample('applied.live');
if(process.env.ADL_DENSE_OUTRIGHTS==='1'){
 const template=s.rows.prematch.values().next().value;const source=[...template.markets.values()];
 for(const row of s.rows.prematch.values()){row.betOrder ||=new Map();for(const[k,t]of row.betAt)row.betOrder.set(k,(BigInt(t)*1000000n+100n).toString());}
 let extra=186814;
 for(let i=0;i<1457;i++){
  const fixtureId=1000000+i,row={fixture:structuredClone(template.fixture),outright:{competitionId:99,fixtureName:'Synthetic memory profile'},markets:new Map(),marketAt:new Map(),betAt:new Map(),betOrder:new Map()};
  const count=Math.ceil(extra/(1457-i));extra-=count;
  for(let j=0;j<count;j++){const id=String(j+1),market=j<12?structuredClone(source[j]):{id:j+1,status:1,bets:[]};
   if(j<12){while(market.bets.length<19)market.bets.push({...market.bets[0],id:String(market.bets.length+1)});}
   row.markets.set(id,market);row.marketAt.set(id,Date.now());for(const b of market.bets){const k=id+':'+b.id,t=Date.now();row.betAt.set(k,t);row.betOrder.set(k,(BigInt(t)*1000000n+100n).toString());}
  }s.rows.prematch.set('outright:99:'+fixtureId,row);
 }
 for(let i=0;i<10;i++)s.rows.inplay.set(2000000+i,{markets:new Map(),marketAt:new Map(),betAt:new Map()});
 global.gc?.();sample('indexed.final.live');
}
await persistRegularCheckpoint((process.env.ADL_RESTORED_OUTPUT||'/data/restored-apply-result')+'/feed.json',s);const feed=s.projection(Date.now(),false);const f=await open((process.env.ADL_RESTORED_OUTPUT||'/data/restored-apply-result')+'/feed.json','w',0o600);let receipt;try{receipt=await writeJsonObject(f,{...feed,workerCheckpoint:{...streamCheckpoint(s),regularExternal:true}},s.availabilityBlocks());await f.sync();}finally{await f.close();}sample('persisted');await writeFile((process.env.ADL_RESTORED_RESULT||'/results/restored-apply-result.json')+'.receipt',JSON.stringify({...receipt,rows:feed.coverage.prematch.rowsPublished+feed.coverage.inplay.rowsPublished}));await writeFile(process.env.ADL_RESTORED_RESULT||'/results/restored-apply-result.json',JSON.stringify({rows,...process.memoryUsage(),peak:process.resourceUsage().maxRSS*1024}));
