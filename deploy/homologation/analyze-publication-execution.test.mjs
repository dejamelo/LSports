import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {deploymentFailure,extractCounters,classifyCounterDrops,terminalErrorSignals,findExecution} from './analyze-publication-execution.mjs';
test('deployment terminal cause is selected before successful observation, not an earlier transient or later observer row',()=>{
 const rows=[{stage:'offline',status:'blocked',reason:'OLD_TRANSIENT'},
 {operation:'cutover.aws',stage:'partitioned_upgrade.offline_pipeline_load',status:'blocked',reason:'PIPELINE_LOAD_ACCEPTANCE_FAILED_NO_STOP'},
 {operation:'cutover.resumable',stage:'throughput_upgrade',status:'blocked',reason:'PIPELINE_LOAD_ACCEPTANCE_FAILED_NO_STOP',helperExit:{lastStructuredStage:'partitioned_upgrade.offline_pipeline_load',exitCode:2}},
 {stage:'post_update_retirement',deploymentExitCode:2},
 {stage:'observer',status:'blocked',reason:'UNRELATED'},
 {stage:'executor_complete',deploymentExitCode:2,observationExitCode:0}];
 const result=deploymentFailure(rows);
 assert.equal(result.stageVerified,true);assert.equal(result.terminalFailure.stage,'throughput_upgrade');
 assert.equal(result.terminalFailure.helperExit.lastStructuredStage,'partitioned_upgrade.offline_pipeline_load');
 assert.equal(result.deploymentExitCode,2);assert.equal(result.observationExitCode,0);
 assert.ok(!JSON.stringify(result).includes('UNRELATED'));
});
test('an exit code without structured cause remains unverified',()=>{
 const r=deploymentFailure([{stage:'post_update_retirement',deploymentExitCode:2},{stage:'executor_complete',deploymentExitCode:2,observationExitCode:0}]);
 assert.equal(r.stageVerified,false);assert.equal(r.terminalFailure,null);
});
const sample=(processed,extra={})=>({lane:'prematch',processed,source:'direct_actor',sessionId:null,metricWindowEndUTC:'2026-10-23T01:43:32Z',...extra});
test('32768 then 20480 in an older persisted window is not classified as replay or session reset',()=>{
 const drops=classifyCounterDrops([sample(32768),sample(20480,{metricWindowEndUTC:'2026-10-23T01:42:00Z'})]);
 assert.equal(drops[0].classification,'older_metric_window');
 assert.equal(classifyCounterDrops([sample(32768),sample(20480,{source:'saved_or_unspecified'})])[0].classification,'different_metric_origins');
});
test('only explicit session/container identity proves reset; otherwise report uncertainty',()=>{
 assert.equal(classifyCounterDrops([sample(32768,{sessionId:'one'}),sample(20480,{sessionId:'two'})])[0].classification,'session_changed');
 assert.equal(classifyCounterDrops([sample(32768,{containerId:'a'}),sample(20480,{containerId:'b'})])[0].classification,'container_changed');
 assert.equal(classifyCounterDrops([sample(32768),sample(20480)])[0].classification,'session_or_origin_unverified');
});
test('extract direct actor vs nested persisted counters without treating counters as retirement',()=>{
 const samples=extractCounters([{stage:'worker_identity',id:'a'.repeat(64)},
 {stage:'recent_lifecycle',record:{lane:'prematch',operation:'inbox.processing_progress',atUTC:'2026-10-23T01:43:33Z',ingress:{processed:32768,checkpointed:0,metricWindowEndUTC:'2026-10-23T01:43:32Z'}}},
 {stage:'snapshot',lanes:{prematch:{ingress:{processed:20480,checkpointed:0,metricWindowEndUTC:'2026-10-23T01:42:00Z'}}}}]);
 assert.equal(samples[0].source,'direct_actor');assert.equal(samples[1].source,'saved_or_unspecified');assert.equal(samples[0].checkpointed,0);assert.equal(samples[0].containerId,'a'.repeat(64));
});
test('raw payloads and private paths are not returned as terminal stack messages',()=>{
 const r=terminalErrorSignals('TypeError: cannot process SECRET_TOKEN=private\n at run (/private/user/deploy/homologation/worker.mjs:21:9)');
 assert.equal(r[0].errorType,'TypeError');assert.deepEqual(r[1],{file:'worker.mjs',line:21,column:9});
 assert.ok(!JSON.stringify(r).includes('SECRET_TOKEN'));assert.ok(!JSON.stringify(r).includes('/private/user'));
 assert.equal(terminalErrorSignals('Error: SUPERSECRET123')[0].knownCode,null);
});
test('discovery rejects newer unrelated wrapper and selects only completed immutable 2bd97d2 exit 2/0 execution',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'checkpoint-discovery-test-'));
 try{
  const old=join(dir,'adl-publication-repair.ABC123','deploy','homologation');const unrelated=join(dir,'adl-publication-repair.ZZZ999','deploy','homologation');
  await mkdir(old,{recursive:true});await mkdir(unrelated,{recursive:true});
  const wrapper=execFileSync('git',['show','2bd97d2:deploy/homologation/apply-publication-reserve-repair.mjs']);
  await writeFile(join(old,'apply-publication-reserve-repair.mjs'),wrapper);
  await writeFile(join(unrelated,'apply-publication-reserve-repair.mjs'),'different executor');
  const finish=JSON.stringify({stage:'executor_complete',deploymentExitCode:2,observationExitCode:0})+'\n';
  await writeFile(join(old,'publication-reserve-repair-1792718599939.jsonl'),finish);
  await writeFile(join(unrelated,'publication-reserve-repair-1999999999999.jsonl'),finish);
  const result=await findExecution([dir]);assert.equal(result.folder,old);assert.equal(result.matchingCompletedReports,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
