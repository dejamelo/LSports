import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash,randomUUID} from 'node:crypto';import {execFileSync} from 'node:child_process';import {fileURLToPath,pathToFileURL} from 'node:url';import {dirname} from 'node:path';
import {TradeState} from '../apps/worker/src/state.js';import {persistRegularCheckpoint as buffered} from '../apps/worker/src/persistence.js';
const root=dirname(dirname(fileURLToPath(import.meta.url))),modulePath=join(root,'apps/worker/src/.checkpoint-benchmark-'+randomUUID()+'.ts');
const original=execFileSync('git',['show','3cd74e4:apps/worker/src/persistence.ts'],{cwd:root,encoding:'utf8'});
const needle="observe?.('regular_checkpoint.write');await file.writeFile(text)";
if(!original.includes(needle))throw Error('BASELINE_WRITER_SHAPE_CHANGED');
await writeFile(modulePath,'export let baselineCalls=0;\n'+original.replace(needle,"observe?.('regular_checkpoint.write');baselineCalls++;await file.writeFile(text)"),{flag:'wx'});
const old=await import(pathToFileURL(modulePath).href);const baseline=old.persistRegularCheckpoint;

const dir=await mkdtemp(join(tmpdir(),'adl-buffer-bench-'));try{
 const s=new TradeState(),at=Date.parse('2026-10-24T00:00:00Z');
 const bets=()=>Array.from({length:80},(_,i)=>({id:String(i),name:'Selection '+i,price:String(2+i/100),status:1,lastUpdate:new Date(at)}));
 for(let id=1;id<=1000;id++){
  s.apply('prematch',[{fixtureId:id,fixture:{status:1,sport:{name:'Football'},name:'Representative UTF-8 São Paulo'},markets:[{id:1,status:1,bets:bets()}]}],at);
  s.apply('prematch',[{fixtureId:id,marketRecovery:true,markets:[{id:1,status:1,bets:bets()}]}],at,{source:'snapshot',receivedAt:at});
 }
 let t=performance.now();await baseline(join(dir,'baseline'),s);const oldMs=performance.now()-t;t=performance.now();const io=await buffered(join(dir,'buffered'),s);const newMs=performance.now()-t;
 const a=await readFile(join(dir,'baseline.regular-checkpoint.json')),b=await readFile(join(dir,'buffered.regular-checkpoint.json'));const hash=(v:Buffer)=>createHash('sha256').update(v).digest('hex');if(hash(a)!==hash(b))throw Error('BYTE_DIFFERENCE');
 console.log(JSON.stringify({fixtures:1000,bets:80000,bytes:a.length,byteIdentical:true,baselineWrites:old.baselineCalls,bufferedWrites:io.writeCalls,baselineMs:oldMs,bufferedMs:newMs,maxBufferedBytes:io.maxBufferedBytes,maxRssBytes:process.resourceUsage().maxRSS*1024,io,scope:'isolated local filesystem, not AWS throughput'}));
}finally{await rm(modulePath,{force:true});await rm(dir,{recursive:true,force:true})}
