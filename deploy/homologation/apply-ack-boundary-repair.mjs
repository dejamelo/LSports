// One guarded ACK-after-durable-receipt correction. No cache, migration or limits changes.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {writeFileSync,appendFileSync} from 'node:fs';
import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),report=join(here,'ack-boundary-repair-'+Date.now()+'.jsonl');writeFileSync(report,'',{mode:0o600,flag:'wx'});
const emit=row=>{console.log(JSON.stringify(row));appendFileSync(report,JSON.stringify(row)+'\n');};
let activated=false,latestFailure,retirement,lastMetric;const deferred=[];
emit({stage:'ack_boundary_activation',status:'starting',report,note:'Closed-channel broker ACK after capacity retry is separated from committed SQLite receipt; preserve source identity, backups and real-copy recovery gates.'});
const child=spawn(process.execPath,[join(here,'apply-transport-cleanup-repair.mjs')],{stdio:['inherit','pipe','inherit']});
createInterface({input:child.stdout}).on('line',line=>{console.log(line);try{const row=JSON.parse(line);appendFileSync(report,JSON.stringify(row)+'\n');if(row.applicationActivated===true)activated=true;const record=row.record||row;if(record.operation==='inbox.actor_failure'&&record.lane==='prematch')latestFailure=record;if(record.operation==='inbox.transport_ack'&&record.lane==='prematch')deferred.push(record);if(record.operation==='inbox.processing_progress'&&record.lane==='prematch')lastMetric=record;if(row.stage==='inbox_retirement_result'&&row.lane==='prematch')retirement=row;}catch{}});
const code=await new Promise(resolve=>{child.once('error',()=>resolve(2));child.once('close',c=>resolve(c??2));});
emit({stage:'ack_boundary_result',workflowExitCode:code,applicationActivated:activated,preMatchStartupFailure:latestFailure??null,preMatchRetirement:retirement??null,report,preMatchDeferredBrokerAcks:deferred.slice(-8),preMatchLatestActorMetric:lastMetric??null,preMatchOldRowsRetired:(retirement?.oldCohortDurablyRetiredRows??0)>0,preMatchPendingDecreased:retirement?retirement.pendingRowsEnd<retirement.pendingRowsStart:false,integrationVerified:false,note:'Real inbox retirement and feed validation remain required. A deferred broker ACK never retires the raw row; retirement follows successful business persistence. No repeat restart on failure.'});process.exitCode=code;
