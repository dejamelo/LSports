// Run only after normal Mac shutdown. Local reads only, no locks removed or provider calls.
import {readFile,readdir,stat} from 'node:fs/promises';
import {dirname,basename,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {statePath} from '@lsports/feed-store';
import {cutoverBarrier} from './cutover-policy.js';
try {
  const state=statePath();
  const names=await readdir(dirname(state));
  if (names.includes(basename(state)+'.lock') || names.some(n=>n.startsWith(basename(state)+'.snapshot-') && /\.(lock|reclaim)$/.test(n))) throw new Error('LOCK_PRESENT_PRESERVED');
  const processes=await promisify(execFile)('ps',['-axo','pid=,command='],{maxBuffer:8*1024*1024,timeout:5000});
  if (processes.stdout.split('\n').some(line=>/apps\/worker\/src\/index\.[tj]s|scripts\/homologation-worker\.[tj]s|npm run dev:worker/.test(line))) throw new Error('WORKER_PROCESS_PRESENT');
  const journalNames=names.filter(n=>n.startsWith(basename(state)+'.snapshot-') && /^[a-zA-Z0-9_.-]+\.json$/.test(n));
  const schedules=[];
  for (const n of journalNames) {if((await stat(join(dirname(state),n))).size>1024*1024)throw new Error('JOURNAL_SIZE');schedules.push(JSON.parse(await readFile(join(dirname(state),n),'utf8')));}
  const saved=JSON.parse(await readFile(state,'utf8'));
  if (saved.mode!=='connected') throw new Error('CONNECTED_EVIDENCE_REQUIRED');
  const refresh=Number(process.env.LSPORTS_SNAPSHOT_INTERVAL_MS || 300000);
  const capturedAt=new Date().toISOString();
  const notBeforeUTC=cutoverBarrier(schedules,saved.connections,Date.now(),refresh);
  console.log(JSON.stringify({operation:'cutover.audit',status:'ok',readOnly:true,providerRequests:0,workerLockAbsent:true,matchingWorkerProcesses:0,journals:journalNames.length,capturedAt,notBeforeUTC,
    note:'No credentials, checkpoint or ticket migration. Keep Mac stopped; preserve/import its scheduler journals before AWS startup. This is not cross-host fencing.'}));
} catch {
  console.error(JSON.stringify({operation:'cutover.audit',status:'blocked',readOnly:true,providerRequests:0,note:'Worker/process/lock or cooldown evidence not safely established. Preserve files; no locks reclaimed, no raw exceptions printed.'}));process.exitCode=2;
}
