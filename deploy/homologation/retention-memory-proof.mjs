// Synthetic dense-state acceptance, Docker --network none --memory 6g; /proof is isolated disposable test data.
import{TradeState}from'/app/apps/worker/src/state.ts';
import{fullSnapshotMemory,verifyProjectionFile}from'/app/apps/worker/src/full-snapshot.ts';
import{persistRegularCheckpoint,streamCheckpoint,restore}from'/app/apps/worker/src/persistence.ts';
import{writeJsonObject}from'/app/packages/feed-store/src/index.ts';
import{open,readFile,writeFile}from'node:fs/promises';import{createHash}from'node:crypto';import{createReadStream}from'node:fs';
const State=TradeState;
let s=new State();const n=2980,betsPer=1000,at=Date.now();const sample=stage=>{global.gc();console.log(JSON.stringify({stage,...process.memoryUsage(),maxRSSBytes:process.resourceUsage().maxRSS*1024,atUTC:new Date().toISOString()}));};
const data=(id,price)=>({fixtureId:id,fixture:{status:1,startDate:new Date(at+3600000).toISOString()},markets:[{id:1,status:1,bets:Array.from({length:betsPer},(_,b)=>({id:String(b),price,status:1,isChanged:0}))}]});
for(let id=1;id<=n;id++){s.apply('prematch',[data(id,'2.1')],at-1000);if(id%500===0)sample('seed_'+id);}
s.beginPartitionedSnapshot('prematch');sample('before_snapshot');
for(let id=1;id<=n;id++){fullSnapshotMemory();s.apply('prematch',[{...data(id,'2.2'),marketRecovery:true}],at);if(id%500===0)sample('apply_'+id);}
s.finishPartitionedSnapshot('prematch',new Set(Array.from({length:n},(_,i)=>i+1)));let fresh=0,observations=0,unique=0;for(const row of s.rows.prematch.values()){fresh+=row.freshBets?.size||0;observations+=row.snapshotBets?.size||0;unique+=new Set(row.snapshotBets?.values()).size;}
sample('applied');console.log(JSON.stringify({scope:'after',rows:n,bets:n*betsPer,fresh,observations,unique}));
{const path='/proof/projection.json';await persistRegularCheckpoint(path,s);let feed=s.projection(Date.now(),false);const file=await open(path,'w',0o600);let receipt;try{receipt=await writeJsonObject(file,{...feed,workerCheckpoint:{...streamCheckpoint(s),regularExternal:true}},s.availabilityBlocks());await file.sync();}finally{await file.close();}receipt.rows=feed.coverage.prematch.rowsPublished+feed.coverage.inplay.rowsPublished;await verifyProjectionFile(path,receipt);sample('serialized');s=undefined;feed=undefined;global.gc();const restored=new TradeState();const result=await restore(restored,path);if(result.rows!==n)throw Error('row mismatch');let count=0;for(const row of restored.rows.prematch.values())for(const market of row.markets.values())for(const bet of market.bets){if(bet.price!=='2.2')throw Error('price mismatch');count++;}if(count!==n*betsPer)throw Error('bet count mismatch');sample('readback');console.log('retention-full-cycle-ok');}
