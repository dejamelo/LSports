import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,symlink,lstat,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
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

for(const alias of [false,true])test(`CLI entrypoint executes through ${alias?'directory alias (macOS /var equivalent)':'canonical path'} and always saves an explicit result`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'checkpoint-cli-entry-'));
 try{
  const real=join(dir,'real source'),link=join(dir,'directory alias'),home=join(dir,'isolated-home'),tmp=join(dir,'isolated-tmp');
  await mkdir(real);await mkdir(join(home,'Downloads'),{recursive:true});await mkdir(tmp);
  const source=join(real,'analyze-publication-execution.mjs');await copyFile(fileURLToPath(new URL('./analyze-publication-execution.mjs',import.meta.url)),source);await symlink(real,link,'dir');
  const result=spawnSync(process.execPath,[alias?join(link,'analyze-publication-execution.mjs'):source],{encoding:'utf8',timeout:10000,env:{...process.env,HOME:home,TMPDIR:tmp}});
  assert.equal(result.status,2,result.stderr);const rows=result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].stage,'collector_start');assert.equal(rows.at(-1).stage,'collector_exit');assert.equal(rows.at(-1).status,'blocked');
  assert.ok(rows.some(r=>r.status==='blocked'&&typeof r.reason==='string'));assert.equal(rows.at(-1).reportAvailable,true);assert.equal(rows.at(-1).exitReportSaved,true);
  const folder=rows[0].reportDirectory;assert.ok(folder.startsWith(home));
  const error=JSON.parse(await readFile(join(folder,'collector-error.json'),'utf8'));assert.equal(error.errorReportSaved,true);
  const exit=JSON.parse(await readFile(join(folder,'collector-exit.json'),'utf8'));assert.equal(exit.exitCode,2);
  assert.equal((await lstat(join(folder,'collector-error.json'))).mode&0o777,0o600);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('CLI reports directory creation failure instead of silently exiting or claiming a saved report',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'checkpoint-cli-report-failure-'));
 try{
  const home=join(dir,'not-a-directory');await writeFile(home,'isolated test');
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./analyze-publication-execution.mjs',import.meta.url))],{encoding:'utf8',timeout:10000,env:{...process.env,HOME:home}});
  assert.equal(result.status,2,result.stderr);const rows=result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].stage,'collector_start');assert.equal(rows.at(-1).reportAvailable,false);
  assert.ok(rows.some(r=>r.status==='blocked'&&r.systemCode==='ENOTDIR'));assert.equal(rows.at(-1).exitCode,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('importing the analyzer does not start discovery or SSH',()=>{
 const url=pathToFileURL(fileURLToPath(new URL('./analyze-publication-execution.mjs',import.meta.url))).href;
 const result=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(url)});console.log('import-only');`],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'import-only');
});

test('aliased CLI performs the existing-report analysis and saves a successful end-to-end result with isolated SSH fixture',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'checkpoint-cli-complete-'));
 try{
  const real=join(dir,'real'),alias=join(dir,'alias'),home=join(dir,'home'),tmp=join(dir,'tmp'),bin=join(dir,'bin');
  await mkdir(real);await mkdir(tmp);await mkdir(bin);await mkdir(join(home,'Downloads'),{recursive:true});await symlink(real,alias,'dir');
  for(const name of ['analyze-publication-execution.mjs','checkpoint-write-probe.py'])await copyFile(fileURLToPath(new URL('./'+name,import.meta.url)),join(real,name));
  await writeFile(join(home,'Downloads','Lottery-Isolated-Key.pem'),'not-a-real-key');
  const folder=join(tmp,'adl-publication-repair.ABC123','deploy','homologation');await mkdir(folder,{recursive:true});
  await writeFile(join(folder,'apply-publication-reserve-repair.mjs'),execFileSync('git',['show','2bd97d2:deploy/homologation/apply-publication-reserve-repair.mjs']));
  const rows=[{operation:'cutover.resumable',stage:'full_feed_validation',status:'blocked',reason:'EXAMPLE_FAILURE_CODE'},
   {stage:'post_update_retirement',deploymentExitCode:2},{stage:'worker_identity',id:'a'.repeat(64)},
   {stage:'executor_complete',deploymentExitCode:2,observationExitCode:0}];
  await writeFile(join(folder,'publication-reserve-repair-'+Date.now()+'.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const ssh=join(bin,'ssh');await writeFile(ssh,`#!/usr/bin/env node
let raw='';for await(const part of process.stdin)raw+=part;if(!raw.startsWith('PROBE_CONFIG={"expectedId":"${'a'.repeat(64)}"}'))process.exit(3);console.log(JSON.stringify({stage:'checkpoint_io_result',recentPublicationLogs:[],readOnly:true,integrationVerified:false}));
`);await chmod(ssh,0o755);
  const result=spawnSync(process.execPath,[join(alias,'analyze-publication-execution.mjs')],{encoding:'utf8',timeout:10000,env:{...process.env,HOME:home,TMPDIR:tmp,PATH:bin+':'+process.env.PATH}});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);const output=result.stdout.trim().split('\n').map(JSON.parse);
  const analysis=output.find(r=>r.stage==='existing_execution_analysis');assert.equal(analysis.terminalFailure.reason,'EXAMPLE_FAILURE_CODE');
  assert.equal(output.at(-1).stage,'collector_exit');assert.equal(output.at(-1).status,'complete');assert.equal(output.at(-1).exitReportSaved,true);
  const saved=JSON.parse(await readFile(join(output[0].reportDirectory,'analysis.json'),'utf8'));assert.equal(saved.terminalFailure.stage,'full_feed_validation');
  assert.equal(JSON.parse(await readFile(join(output[0].reportDirectory,'checkpoint-write-probe.json'),'utf8')).exitCode,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
