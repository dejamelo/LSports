import { demoSource } from '@lsports/demo';
import type {EventSource} from '@lsports/contracts';
// Future TRADE adapter belongs here; demo data never impersonates a supplier response.
if(process.env.DATA_MODE && process.env.DATA_MODE!=='demo') throw new Error('Real integration is not implemented; refusing to start.');
const source:EventSource=demoSource;
const interval=Number(process.env.WORKER_POLL_INTERVAL_MS||30000);
if(!Number.isFinite(interval)||interval<1000) throw new Error('WORKER_POLL_INTERVAL_MS must be >= 1000');
console.log(JSON.stringify({worker:'starting',mode:'demo',futureTrade:{environment:process.env.LSPORTS_ENVIRONMENT||'Test',prematch:process.env.LSPORTS_PREMATCH_PACKAGE_ID||'4511',inplay:process.env.LSPORTS_INPLAY_PACKAGE_ID||'4510'}}));
let stopping=false;
let wake:()=>void=()=>{};
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{stopping=true;wake()});
while(!stopping){
 try{const feed=await source.getEvents();console.log(JSON.stringify({worker:'heartbeat',mode:feed.mode,eventCount:feed.events.length,at:new Date().toISOString()}));}
 catch(error){console.error('Worker cycle failed:',error instanceof Error?error.message:'unknown error')}
 if(!stopping)await new Promise<void>(resolve=>{const timer=setTimeout(resolve,interval);wake=()=>{clearTimeout(timer);resolve()}});
}
console.log('Worker stopped gracefully');
