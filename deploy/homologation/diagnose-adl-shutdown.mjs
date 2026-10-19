// Local only. Captures loader failures without echoing stderr/commands/env.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const args=['--import','tsx','--env-file-if-exists=.env','scripts/diagnose-shutdown.ts'];
if(process.argv.length!==2){console.log(JSON.stringify({operation:'shutdown.diagnose',status:'blocked',stage:'arguments',readOnly:true}));process.exitCode=2;}
else execFile(process.execPath,args,{cwd:root,timeout:30000,maxBuffer:1024*1024},(error,stdout,stderr)=>{
 try{
  const result=JSON.parse(stdout.trim());
  if(result.operation!=='shutdown.diagnose'||result.readOnly!==true)throw Error();
  console.log(JSON.stringify(result));process.exitCode=result.status==='ready_for_export'?0:2;
 }catch{
  const raw=String(stderr||'');
  const reason=raw.includes('ERR_MODULE_NOT_FOUND')?'MODULE_NOT_FOUND':/bad option|unknown option/.test(raw)?'NODE_OPTION_UNSUPPORTED':raw.includes('SyntaxError')?'LOADER_OR_ENV_SYNTAX_ERROR':error?.killed?'DIAGNOSTIC_TIMEOUT':'DIAGNOSTIC_START_FAILED';
  console.log(JSON.stringify({operation:'shutdown.diagnose',status:'blocked',stage:'diagnostic_start',reason,nodeVersion:process.version,readOnly:true,providerRequests:0,workerStarted:false,note:'No raw stderr or secrets printed. No workers/locks/AWS resources changed.'}));process.exitCode=2;
 }
});
