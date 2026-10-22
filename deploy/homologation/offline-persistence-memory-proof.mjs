import {restore,checkpoint,persistRegularCheckpoint} from '../../apps/worker/src/persistence.ts';
import {TradeState} from '../../apps/worker/src/state.ts';
import {walkSnapshot,convertSnapshotRow,fullSnapshotMemory} from '../../apps/worker/src/full-snapshot.ts';
import {createPublisher} from '../../packages/feed-store/src/index.ts';
import {performance} from 'node:perf_hooks';
// Offline benchmark only. Input is read-only; output must be a separate empty directory.
const [input,output]=process.argv.slice(2);if(!input||!output||input===output)throw Error('distinct input/output directories required');
const before=process.env.BASELINE==='1',s=new TradeState();
await restore(s,input+'/feed.json');const ids=new Set(s.rows.prematch.keys());for(const lane of ['prematch','inplay'])for(const row of s.rows[lane].values())if(row.fixture)row.fixture.value.startDate='2026-10-23T12:00:00Z';
console.log(JSON.stringify({stage:'ready',rss:process.memoryUsage().rss,rows:ids.size}));
let copies=0,updates=0;const oldRows=new Map(s.rows.prematch),publish=createPublisher(output+'/feed.json');const began=performance.now();
let entered;const started=new Promise(r=>entered=r);
const operation=async()=>{const feed=s.projection(Date.now(),before);entered();await persistRegularCheckpoint(output+'/feed.json',s);await publish(feed,{...checkpoint(s,false),regularExternal:true},s.availabilityBlocks());};
const saved=before?operation():s.exclusive(operation);
await started;
const updatesTask=(async()=>{for(let id=1;id<=8192;id++){
 const apply=()=>{s.apply('prematch',[{fixtureId:id,markets:[{id:1,status:1,bets:[{id:'1',status:1,price:'2.9'}]}]}],Date.now());updates++;};
 if(before)apply();else await s.exclusive(apply);
 if(id%100===0)await new Promise(r=>setImmediate(r));
}})();
await saved;const writeMs=performance.now()-began;await updatesTask;
for(const [id,row]of oldRows)if(s.rows.prematch.get(id)!==row)copies++;
const result={variant:before?'before':'exclusive-native-records',rows:ids.size,updates,copies,writeMs,maxRSSBytes:process.resourceUsage().maxRSS*1024,heapUsed:process.memoryUsage().heapUsed,containerLimitBytes:4294967296,nodeOldSpaceMiB:2560,awsValidated:false};
console.log(JSON.stringify(result));
if(!before&&copies!==0)throw Error('shadow rows retained');
