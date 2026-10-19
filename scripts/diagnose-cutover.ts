import {statePath} from '@lsports/feed-store';
import {diagnoseCutover,safeError} from './cutover-diagnostics.js';
try{
 const report=await diagnoseCutover({state:statePath(),refreshMs:Number(process.env.LSPORTS_SNAPSHOT_INTERVAL_MS||300000)});
 console.log(JSON.stringify({...report,stateLocationSource:process.env.LSPORTS_STATE_FILE?'configured':'default'}));
 process.exitCode=report.status==='ok'?0:2;
}catch(e){console.log(JSON.stringify({operation:'cutover.diagnose',status:'blocked',readOnly:true,stage:'diagnostic_runtime',reason:safeError(e),workerStarted:false}));process.exitCode=2;}
