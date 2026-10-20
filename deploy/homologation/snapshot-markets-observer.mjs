// Run offline in the installed image, with feed volume mounted READ ONLY.
import{readdir,open,stat,writeFile,chmod}from'node:fs/promises';
import{createHash}from'node:crypto';import{setTimeout as wait}from'node:timers/promises';
import{walkSnapshot}from'/app/apps/worker/src/full-snapshot.ts';
import{TransformerUtil,GetEventsResultElement}from'trade360-nodejs-sdk';
const root='/app/.runtime/feed',until=Date.now()+10*60000;
const emit=value=>console.log(JSON.stringify({operation:'snapshot.markets_evidence',...value}));
const kind=v=>v===null?'null':Array.isArray(v)?'array':typeof v;
const shape=v=>({type:kind(v),...(Array.isArray(v)?{length:v.length}:{})});
let inspected=0;const seen=new Set();
async function inspectFile(file,live){
 let fd;try{fd=await open(file,'r');}catch(e){if(e.code==='ENOENT')return false;throw e;}
 try{
  // An open descriptor survives worker unlink: no write, lock or interference.
  // Live spools are read only after the worker finished and unlinked them.
  if(live){while(Date.now()<until){try{await stat(file);await wait(100);}catch(e){if(e.code==='ENOENT')break;throw e;}}try{await stat(file);return false;}catch(e){if(e.code!=='ENOENT')throw e;}}
  let rejection=null,firstRaw=null,rows=0;
  try{await walkSnapshot(`/proc/self/fd/${fd.fd}`,async raw=>{rows++;if(!rejection){const r=marketsShapeRejection(raw);if(r){rejection=r;firstRaw=raw;}}});}catch{emit({status:'not_complete',reason:'CAPTURE_NOT_A_COMPLETE_ENVELOPE',rows});return false;}
  inspected++;
  if(!rejection){emit({status:'inspected',rows,invalidMarketsShape:false});return false;}
  const text=JSON.stringify(firstRaw),bytes=Buffer.byteLength(text);if(bytes>16*1024*1024)throw Error('ROW_EVIDENCE_BOUND_EXCEEDED');
  await writeFile('/evidence/rejected-row.private.json',text,{flag:'wx',mode:0o600});
  let sdk={conversion:'failed'};try{const converted=TransformerUtil.transform(firstRaw,GetEventsResultElement);sdk={conversion:'succeeded',markets:shape(converted.markets),...(rejection.marketIndex!==undefined&&Array.isArray(converted.markets)?{market:shape(converted.markets[rejection.marketIndex]),bets:shape(converted.markets[rejection.marketIndex]?.bets)}:{})};}catch{}
  const report={status:'collected',capturedAtUTC:new Date().toISOString(),rows,invalidMarketsShape:true,rejection,sdk,rawRowPreserved:true,rawRowBytes:bytes,rawRowSha256:createHash('sha256').update(text).digest('hex'),providerFaultProven:false,validationRelaxed:false,providerRequests:0,workerRestarted:false};
  await writeFile('/evidence/report.json',JSON.stringify(report),{flag:'wx',mode:0o600});emit(report);return true;
 }finally{await fd.close();}
}
try{
 // Prefer preserved rejected responses, if one exists. No credentials are read.
 const retained=`${root}/.rejected-full-snapshot/response.private.json`;
 if(await inspectFile(retained,false))process.exit(0);
 emit({status:'watching',question:'exact Markets/Bets field and type rejected',previousVersion:'removes_spool_in_finally',providerRequests:0,workerRestarted:false,timeoutSeconds:600});
 let found=false;
 while(Date.now()<until&&!found){for(const name of await readdir(root)){if(!/^\.full-snapshot-[A-Za-z0-9_-]+$/.test(name)||seen.has(name))continue;const file=`${root}/${name}/response.private.json`;try{await stat(file);}catch{continue;}seen.add(name);found=await inspectFile(file,true);if(found)break;}if(!found)await wait(100);}
 if(!found){emit({status:'blocked',reason:'NO_REJECTED_COMPLETE_RESPONSE_OBSERVED',inspected,providerRequests:0,workerRestarted:false});process.exitCode=2;}
}catch{emit({status:'blocked',reason:'PRIVATE_CAPTURE_FAILED_NO_RAW_ERROR',providerRequests:0,workerRestarted:false});process.exitCode=2;}
