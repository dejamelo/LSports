// Only local evidence, no locks removed or provider calls. Detailed failures stay sanitized.
import {statePath} from '@lsports/feed-store';
import {diagnoseCutover,safeError} from './cutover-diagnostics.js';
try{
 const report=await diagnoseCutover({state:statePath(),refreshMs:Number(process.env.LSPORTS_SNAPSHOT_INTERVAL_MS||300000)});
 console.log(JSON.stringify({...report,operation:'cutover.audit',journals:report.journalCount}));
 process.exitCode=report.status==='ok'?0:2;
}catch(e){console.log(JSON.stringify({operation:'cutover.audit',status:'blocked',readOnly:true,stage:'audit_runtime',reason:safeError(e),workerStarted:false}));process.exitCode=2;}
