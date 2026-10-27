export function cachePreflightProvesMacStopped(report){
 if(report?.status==='ok')return report.matchingWorkerProcesses===0&&report.workerLockAbsent===true;
 return report?.status==='blocked'&&report.matchingWorkerProcesses===0&&report.workerLockAbsent===true&&
  report.processes?.status==='ok'&&report.processes?.matching===0&&Array.isArray(report.locks)&&report.locks.length===0&&
  Array.isArray(report.blockers)&&report.blockers.length===1&&report.blockers[0]?.stage==='checkpoint'&&report.blockers[0]?.reason==='ENOENT';
}
