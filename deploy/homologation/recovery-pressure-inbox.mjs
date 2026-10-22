// Read-only SQL aggregate probe; never decode content or modify/retire inbox rows.
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
const start=Number(process.argv[1]),previous=JSON.parse(process.argv[2]||'{}');
if(!Number.isSafeInteger(start)||start<=0)throw Error('INVALID_WORKER_START');
const lanes={};
for(const lane of ['prematch','inplay']){
 const db=new DatabaseSync('/app/.runtime/feed/trade-feed.json.'+lane+'.inbox.sqlite',{readOnly:true});
 try{
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000');
  db.exec('BEGIN');
  const high=Number(db.prepare('SELECT coalesce(max(id),0) AS n FROM inbox').get().n),boundary=previous[lane]??high;
  const row=db.prepare('SELECT count(*) AS pendingCheckpointRows, coalesce(sum(received < ?),0) AS receivedBeforeWorkerStart,coalesce(sum(received >= ?),0) AS receivedSinceWorkerStart,coalesce(sum(id > ?),0) AS arrivedSinceFirstSample,min(received) AS oldestReceived FROM inbox').get(start,start,boundary);
  db.exec('COMMIT');lanes[lane]={...row,baselineHighId:boundary,oldestPendingAgeMs:row.oldestReceived===null?0:Math.max(0,Date.now()-Number(row.oldestReceived))};delete lanes[lane].oldestReceived;
 }finally{db.close();}
}
const cgroup={};for(const key of ['memory.current','memory.peak','memory.max','memory.events'])try{const raw=readFileSync('/sys/fs/cgroup/'+key,'utf8').trim();cgroup[key]=key==='memory.events'?Object.fromEntries(raw.split('\n').map(s=>s.split(/\s+/)).map(([k,v])=>[k,Number(v)])):raw==='max'?null:Number(raw);}catch{}
try{cgroup.stat=Object.fromEntries(readFileSync('/sys/fs/cgroup/memory.stat','utf8').trim().split('\n').map(s=>s.split(/\s+/)).filter(([k])=>['anon','file','kernel','slab','sock','inactive_file','active_file','file_dirty','file_writeback','slab_reclaimable'].includes(k)).map(([k,v])=>[k,Number(v)]));}catch{}
const installedSourceHashes={};for(const file of ['full-snapshot.ts','snapshot-capacity.ts','diagnostics.ts','durable-ingress.mjs','connected.ts','persistence.ts'])installedSourceHashes[file]=createHash('sha256').update(readFileSync('/app/apps/worker/src/'+file)).digest('hex');
console.log(JSON.stringify({lanes,cgroup,installedSourceHashes,scope:'pending durable rows, including processed but not checkpointed; not a second processing counter',readOnly:true}));
