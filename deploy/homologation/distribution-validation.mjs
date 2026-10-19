// Read-only AWS status validation. No provider requests, consumer starts or credentials.
import fs from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
const FIX='2aa06f7';
const utc=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(v)&&Number.isFinite(Date.parse(v))?v:undefined;
const number=v=>Number.isSafeInteger(v)&&v>=0?v:undefined;
export function collectDistribution(status,previous={}){
 const since=utc(status.validationSinceUTC);if(!since)throw Error('DISTRIBUTION_REFERENCE_MISSING');
 const result={fixCommit:FIX,sinceUTC:since,observations:[],closes:[],lanes:{},events:number(status.events),markets:number(status.markets),selectableSelections:number(status.selectableSelections)};
 const observations=new Map(),closes=new Map();
 const addObservation=(lane,o)=>{
  if(!o||!utc(o.observedAtUTC)||Date.parse(o.observedAtUTC)<Date.parse(since)||!['before_start','start_response','after_propagation'].includes(o.stage))return;
  const item={lane,packageId:lane==='prematch'?4511:4510,stage:o.stage,observedAtUTC:o.observedAtUTC};
  for(const key of ['bodyIsDistributionOn','sdkIsDistributionOn'])if(typeof o[key]==='boolean')item[key]=o[key];
  for(const key of ['elapsedSinceStartMs','propagationDelayMs'])if(number(o[key])!==undefined&&o[key]<=3600000)item[key]=o[key];
  if(utc(o.startReturnedAtUTC))item.startReturnedAtUTC=o.startReturnedAtUTC;
  if(['activated','already_active','missing','unrecognized'].includes(o.startMessage))item.startMessage=o.startMessage;
  observations.set(lane+o.stage+o.observedAtUTC,item);
 };
 const addClose=(lane,at,source='checkpoint')=>{
  if(!utc(at)||Date.parse(at)<Date.parse(since))return;
  const nearby=[...closes.entries()].find(([_key,c])=>c.lane===lane&&Math.abs(Date.parse(c.endedAtUTC)-Date.parse(at))<=2000);
  if(nearby){if(source!=='checkpoint'||nearby[1].source==='checkpoint')return;closes.delete(nearby[0]);}
  closes.set(lane+at,{lane,packageId:lane==='prematch'?4511:4510,endedAtUTC:at,amqpCode:320,signal:'connection_forced',source});
 };
 if(previous.sinceUTC===since){for(const o of previous.observations||[])if(['prematch','inplay'].includes(o.lane))addObservation(o.lane,o);for(const c of previous.closes||[])if(['prematch','inplay'].includes(c.lane))addClose(c.lane,c.endedAtUTC,c.source==='log'?'log':'checkpoint');}
 for(const lane of ['prematch','inplay']){
  const source=status.lanes?.[lane]||{};const sessionAt=utc(source.session?.startedAt);
  for(const o of source.distributionObservations||[])addObservation(lane,o);
  const current=[...observations.values()].filter(o=>o.lane===lane&&sessionAt&&Date.parse(o.observedAtUTC)>=Date.parse(sessionAt)).sort((a,b)=>Date.parse(a.observedAtUTC)-Date.parse(b.observedAtUTC));
  const latest=[...current].reverse().find(o=>['before_start','after_propagation'].includes(o.stage)&&typeof o.sdkIsDistributionOn==='boolean');
  const afterDelay=latest?.stage==='after_propagation'&&latest.propagationDelayMs===2000&&latest.elapsedSinceStartMs>=2000;
  const on=latest?.bodyIsDistributionOn===true&&latest?.sdkIsDistributionOn===true&&(latest.stage==='before_start'||afterDelay);
  const offAfterDelay=latest?.stage==='after_propagation'&&latest.bodyIsDistributionOn===false&&latest.sdkIsDistributionOn===false&&latest.propagationDelayMs===2000&&latest.elapsedSinceStartMs>=2000;
  result.lanes[lane]={phase:['starting','recovering','connected','error','stopped'].includes(source.phase)?source.phase:'unknown',sessionAtUTC:sessionAt,lastSnapshotAtUTC:utc(source.lastSnapshotAt),distributionOn:on,offAfterDelay:!!offAfterDelay,rawStatusMissing:!!latest&&typeof latest.bodyIsDistributionOn!=='boolean',statusMismatch:typeof latest?.bodyIsDistributionOn==='boolean'&&latest.bodyIsDistributionOn!==latest.sdkIsDistributionOn,regularSnapshotReady:source.recoveryProgress?.regularSnapshotReady===true};
  const diagnostic=source.diagnostic;
  if(diagnostic&&['distribution.start','distribution.status','amqp.connection','snapshot.events','subscriptions.list'].includes(diagnostic.operation)){
   const d={operation:diagnostic.operation};
   if(['rate_limited','invalid_response','authentication_rejected','permission_denied','supplier_error','unexpected','network','response_limit','sdk_error','configuration'].includes(diagnostic.category))d.category=diagnostic.category;
   if(['distribution_still_off','connection_closed','invalid_snapshot','timeout','response_size_limit','memory_budget_exceeded','application_error','null_response_body','missing_response_body','sdk_conversion','sdk_validation'].includes(diagnostic.reason))d.reason=diagnostic.reason;
   if(Number.isSafeInteger(diagnostic.httpStatus)&&diagnostic.httpStatus>=100&&diagnostic.httpStatus<=599)d.httpStatus=diagnostic.httpStatus;
   if(diagnostic.amqpCode===320)d.amqpCode=320;result.lanes[lane].diagnostic=d;
  }
  for(const end of source.sessionEnds||[])if(end.diagnostic?.amqpCode===320)addClose(lane,end.endedAt);
 }
 for(const event of status.evidence?.recentErrors||[])if(['prematch','inplay'].includes(event.lane)&&event.amqpCode===320)addClose(event.lane,event.loggedAt,'log');
 result.observations=[...observations.values()].sort((a,b)=>Date.parse(a.observedAtUTC)-Date.parse(b.observedAtUTC)).slice(-256);
 result.closes=[...closes.values()].sort((a,b)=>Date.parse(a.endedAtUTC)-Date.parse(b.endedAtUTC)).slice(-64);
 result.distributionVerified=Object.values(result.lanes).every(l=>l.distributionOn);
 const singleton=status.workers?.length===1&&status.workers[0].running===true&&status.workers[0].state!=='exited'&&!status.workers[0].oomKilled;
 const baselines=Object.values(result.lanes).every(l=>l.phase==='connected'&&l.regularSnapshotReady&&Date.parse(l.sessionAtUTC)>=Date.parse(since)&&Date.parse(l.lastSnapshotAtUTC)>=Date.parse(l.sessionAtUTC));
 result.snapshotsVerified=status.status==='snapshots_ready'&&result.distributionVerified&&singleton&&baselines;
 result.oddsAvailable=result.snapshotsVerified&&result.selectableSelections>0;
 return result;
}
export function renderDistributionSupport(evidence,reason){
 const lines=['Subject: Ticket #217525 — POST-FIX distribution / broker evidence, Test packages 4511 and 4510','','Hello Szymon / LSports Support,','',
  'We have applied the distribution timing correction from commit 2aa06f7 to the AWS worker, with additional sanitized observations. The Mac consumer remains stopped. No queues or subscriptions were changed.',
  `Only evidence at/after ${evidence.sinceUTC||'an unverified start reference'} is considered post-fix. All times below are UTC.`,
  `Validation result: ${reason}. Distribution confirmed in both current sessions: ${!!evidence.distributionVerified}; full current-session snapshots verified: ${!!evidence.snapshotsVerified}; selectable odds confirmed: ${!!evidence.oddsAvailable}. Container running alone is not recovery.`,
  '', 'SDK 3.10.10: POST /Package/GetDistributionStatus; POST /Distribution/Start; then the official 2000 ms propagation wait before rechecking. Body.Message is not treated as an activation boolean. No extra provider probes or forced retries were performed.',
  '', '| UTC observed | Package | Stage | Body.IsDistributionOn | SDK boolean | Elapsed after Start response (ms) | Start message class |','|---|---|---|---|---|---|---|'];
 for(const o of evidence.observations||[])lines.push(`| ${o.observedAtUTC} | ${o.packageId} | ${o.stage} | ${o.bodyIsDistributionOn===undefined?'not captured':String(o.bodyIsDistributionOn)} | ${o.sdkIsDistributionOn===undefined?'not captured':String(o.sdkIsDistributionOn)} | ${o.elapsedSinceStartMs??'—'} | ${o.startMessage??'—'} |`);
 if(!evidence.observations?.length)lines.push('| No post-fix distribution response observed yet | — | — | — | — | — | — |');
 lines.push('', 'New AMQP 320 / connection_forced observations (checkpoint/log entries within 2 seconds are correlated, not counted as separate closures):');
 for(const c of evidence.closes||[])lines.push(`- Package ${c.packageId}: ${c.endedAtUTC}. Broker reason beyond code 320 is not proven by this capture.`);
 if(!evidence.closes?.length)lines.push('- None recorded in this validation window; this is not proof that future closures cannot occur.');
 lines.push('', 'Current sessions:');
 for(const [lane,s] of Object.entries(evidence.lanes||{})){lines.push(`- ${lane} (${lane==='prematch'?4511:4510}): phase=${s.phase}, started=${s.sessionAtUTC||'unknown'}, lastSnapshot=${s.lastSnapshotAtUTC||'none'}, regularSnapshotReady=${s.regularSnapshotReady}.`);if(s.diagnostic)lines.push(`  Current sanitized diagnostic: ${JSON.stringify(s.diagnostic)}.`);}
 lines.push('', 'If distribution remains false after the measured propagation interval, please correlate the Start operation and package restrictions in your logs. For AMQP 320, please provide the broker-side cause/event IDs and any relationship with distribution state. AWS public egress IP: 77.113.150.100. PreMatch host stm-prematch.lsports.eu, vhost StmPreMatch, existing queue _4511_.',
 'If distribution is on but snapshots or selectable odds remain unverified, those are separate issues; we are not claiming distribution is off or that existing stored prices are current.',
 'Please preserve existing subscriptions and queues. No credentials, tokens, authenticated URLs or raw provider messages are included. This is a prepared support draft, not an automatically sent ticket.', '');
 return lines.join('\n');
}
export async function writeProtectedReport(file,text){
 try{const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077))throw Error('SUPPORT_REPORT_NOT_PROTECTED');}catch(e){if(e.code!=='ENOENT')throw e;}
 const tmp=file+'.'+process.pid+'.tmp';const f=await fs.open(tmp,'wx',0o600);try{await f.writeFile(text);await f.sync();}finally{await f.close();}await fs.rename(tmp,file);
}
export async function validateDistribution(remote,handoff,ledger,save,progress,reportFile,{durationMs=45*60000,wait=delay,now=Date.now,write=writeProtectedReport}={}){
 const until=now()+durationMs;let evidence=ledger.distributionEvidence||{},reason='VALIDATION_TIMEOUT',status,lastPrinted='';
 const finish=async()=>{
  ledger.distributionEvidence=evidence;ledger.currentStage=evidence.oddsAvailable?'complete':'distribution_validation_pending';
  ledger.steps.distribution_validation={status:evidence.oddsAvailable?'ok':'pending',reason,reportFile,fixCommit:FIX};await save();
  await write(reportFile,renderDistributionSupport(evidence,reason));
  console.log(JSON.stringify({operation:'cutover.resumable',stage:ledger.currentStage,status:evidence.oddsAvailable?'verified':'pending',reason,reportFile,progressFile:progress,macWorkerStopped:true,distributionVerified:!!evidence.distributionVerified,fullFeedSnapshotsVerified:!!evidence.snapshotsVerified,projectionOddsAvailable:!!evidence.oddsAvailable,iframeAuthenticated:false,posnetChanged:false}));
  if(!evidence.oddsAvailable)process.exitCode=2;
 };
 try{
  while(now()<until){
   status=await remote('status',{handoff});evidence=collectDistribution(status,evidence);ledger.distributionEvidence=evidence;ledger.lastValidation=status;await save();
   const summary={observations:evidence.observations.slice(-6),newAMQP320:evidence.closes.slice(-4),lanes:evidence.lanes,snapshotsVerified:evidence.snapshotsVerified,selectableSelections:evidence.selectableSelections};
   const fingerprint=JSON.stringify(summary);if(fingerprint!==lastPrinted){console.log(JSON.stringify({operation:'cutover.resumable',stage:'post_fix_observation',fixCommit:FIX,...summary,progressFile:progress}));lastPrinted=fingerprint;}

   if(status.workers?.some(w=>w.state==='exited'||w.oomKilled)){reason='AWS_WORKER_EXITED_NO_BLIND_RESTART';break;}
   if(Object.values(evidence.lanes).some(l=>l.statusMismatch||l.rawStatusMissing)){reason='RAW_SDK_DISTRIBUTION_STATUS_UNVERIFIED';break;}
   if(Object.values(evidence.lanes).some(l=>l.offAfterDelay)){reason='DISTRIBUTION_OFF_AFTER_MEASURED_PROPAGATION';break;}
   if(evidence.snapshotsVerified){reason=evidence.oddsAvailable?'CURRENT_FEEDS_AND_ODDS_VERIFIED':'SNAPSHOTS_VERIFIED_NO_SELECTABLE_ODDS';break;}
   if(Object.entries(evidence.lanes).some(([lane,s])=>s.phase==='error'&&evidence.closes.filter(c=>c.lane===lane).length>=2)){reason='REPEATED_AMQP_320_AFTER_FIX';break;}
   if(Object.values(status.lanes||{}).some(s=>s.phase==='error'&&['distribution.start','distribution.status'].includes(s.diagnostic?.operation)&&Date.parse(s.session?.startedAt)>=Date.parse(evidence.sinceUTC))){reason='DISTRIBUTION_REQUEST_FAILED_AFTER_FIX';break;}
   if(Object.values(status.lanes||{}).some(s=>s.phase==='error'&&s.diagnostic?.retryPolicy==='restart_required')){reason='MESSAGE_REQUEUED_HANDLER_REVIEW_REQUIRED';break;}
   const pm=status.lanes?.prematch;if(pm?.lastSnapshotDiagnostic?.snapshotValidation&&Date.parse(pm.lastSnapshotErrorAt)>=Date.parse(pm.session?.startedAt)){reason='DISTRIBUTION_REVIEW_SNAPSHOT_CONTRACT_REJECTED';break;}
   await wait(30000);
  }
 }catch(error){reason=/^[A-Z_]+$/.test(error?.message||'')?error.message:'READ_ONLY_STATUS_COLLECTION_FAILED';}
 await finish();return evidence;
}
