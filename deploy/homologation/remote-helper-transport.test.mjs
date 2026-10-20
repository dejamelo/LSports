import{test}from'node:test';import assert from'node:assert/strict';import{spawnSync}from'node:child_process';import{readFile}from'node:fs/promises';import{fileURLToPath}from'node:url';import path from'node:path';
import{assembleRemoteHelper,helperInvocation,sanitizedHelperExit}from'./remote-helper-transport.mjs';import{command}from'./resumable-adl-cutover.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
test('the previous real bundle crosses the Linux per-argument limit; new transport keeps code and request on stdin',async()=>{
 const source=await assembleRemoteHelper(here),old='sudo -n python3 -c '+quote(source);assert.ok(Buffer.byteLength(old)>=131072);
 if(process.platform==='linux'){const failed=spawnSync('/bin/true',[old]);assert.equal(failed.error.code,'E2BIG');}
 const rpc=await helperInvocation(here,source,{action:'preflight'});assert.ok(Buffer.byteLength(rpc.command)<16000);assert.ok(!rpc.command.includes('def cutover_main'));assert.equal(JSON.parse(rpc.input).source,source);assert.deepEqual(JSON.parse(rpc.input).request,{action:'preflight'});
 const parsed=spawnSync('python3',['-c',"import ast,sys,json;ast.parse(json.load(sys.stdin)['source']);print('compiled')"],{input:rpc.input,encoding:'utf8'});assert.equal(parsed.status,0,parsed.stderr);
});
test('bootstrap executes large code over stdin and retains binary request reader without leaking values',async()=>{
 const bootstrap=await readFile(path.join(here,'remote-helper-bootstrap.py'),'utf8');
 const source='#'+'x'.repeat(150000)+"\nimport sys,json\nr=json.loads(sys.stdin.buffer.read());assert r['private']=='SENSITIVE';print(json.dumps({'operation':'cutover.aws','stage':'preflight','status':'collected'}));raise SystemExit(0)";
 const child=spawnSync('python3',['-c',bootstrap],{input:JSON.stringify({source,request:{action:'preflight',private:'SENSITIVE'}}),encoding:'utf8'});assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).stage,'preflight');assert.ok(!child.stdout.includes('SENSITIVE'));assert.equal(child.stderr,'');
});
test('bootstrap reports compile and early execution failures without traceback or secret source',async()=>{
 const bootstrap=await readFile(path.join(here,'remote-helper-bootstrap.py'),'utf8');
 for(const [source,stage,type]of[["SECRET value is bad",'compile','SyntaxError'],["raise ValueError('SENSITIVE')",'execute','ValueError']]){
  const c=spawnSync('python3',['-c',bootstrap],{input:JSON.stringify({source,request:{action:'preflight'}}),encoding:'utf8'});assert.equal(c.status,2);const row=JSON.parse(c.stdout);assert.equal(row.helperStage,stage);assert.equal(row.exceptionType,type);assert.equal(c.stderr,'');assert.ok(!c.stdout.includes('SENSITIVE'));assert.ok(!c.stdout.includes('SECRET'));
 }
});
test('classification preserves exit, signal and safe stage, never raw SSH or Python text',()=>{
 for(const [stderr,reason]of[['bash: argument list too long PRIVATE','HELPER_ARGUMENT_LIMIT_EXCEEDED'],['sudo: a password is required PRIVATE','REMOTE_SUDO_AUTHORIZATION_REQUIRED'],['Permission denied (publickey) PRIVATE','SSH_AUTHENTICATION_FAILED'],['SECRET arbitrary stacktrace','HELPER_EXIT_NONZERO_NO_STRUCTURED_DIAGNOSTIC']]){
  const d=sanitizedHelperExit({stage:'remote_consumer_gate',action:'preflight',code:255,stderr});assert.equal(d.reason,reason);assert.equal(d.exitCode,255);assert.equal(d.stage,'remote_consumer_gate');assert.ok(!JSON.stringify(d).includes('PRIVATE'));assert.ok(!JSON.stringify(d).includes('SECRET'));
 }
 const d=sanitizedHelperExit({stage:'remote_consumer_gate',code:2,rows:[{status:'blocked',stage:'preflight',reason:'ROOT_REQUIRED'}]});assert.equal(d.lastStructuredStage,'preflight');assert.equal(d.reason,'ROOT_REQUIRED');
});
test('real child command failure surfaces concrete structured stage and code without stderr',async()=>{
 const log=console.log,rows=[];console.log=line=>rows.push(JSON.parse(line));
 try{await assert.rejects(command(process.execPath,['-e',"console.error('PRIVATE_SECRET');console.log(JSON.stringify({operation:'cutover.aws',stage:'preflight',status:'blocked',reason:'ROOT_REQUIRED'}));process.exit(23)"],undefined,5000,false,false,{stage:'remote_consumer_gate',action:'preflight'}),e=>e.helperExit.exitCode===23&&e.helperExit.lastStructuredStage==='preflight'&&e.message==='ROOT_REQUIRED');}
 finally{console.log=log;}
 assert.ok(!JSON.stringify(rows).includes('PRIVATE_SECRET'));assert.equal(rows.at(-1).exitCode,23);
});
test('read-only preflight branches before lease, ledger writes, audits and any mutation mode',async()=>{
 const src=await readFile(path.join(here,'resumable-adl-cutover.mjs'),'utf8');const gate=src.indexOf("if(args[4]==='--helper-preflight-report')");assert.ok(gate>0);assert.ok(gate<src.indexOf('lease=createServer'));assert.ok(gate<src.indexOf('await save();',src.indexOf('export async function run')));
});

test('full read-only CLI uses stdin transport, returns preflight and does not create migration progress',async()=>{
 const {mkdtemp,mkdir,writeFile,readdir,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {spawn}=await import('node:child_process');
 const dir=await mkdtemp(path.join(tmpdir(),'adl-readonly-cli-')),home=path.join(dir,'home'),bin=path.join(dir,'bin');await mkdir(path.join(home,'Downloads'),{recursive:true});await mkdir(bin);await writeFile(path.join(home,'Downloads','Lottery-Test-Key.pem'),'isolated test file');
 await writeFile(path.join(bin,'ssh'),`#!/usr/bin/env node\nlet body='';for await(const c of process.stdin)body+=c;const envelope=JSON.parse(body);if(envelope.request.action!=='preflight'||!envelope.source.includes('def cutover_main')||process.argv.at(-1).length>16000)process.exit(19);console.log(JSON.stringify({operation:'cutover.complete_preflight.aws',status:'collected',readOnly:true,workerStarted:false,providerRequests:0}));`,{mode:0o755});
 try{let output='',error='';const child=spawn(process.execPath,[path.join(here,'complete-adl-cutover.mjs'),'--pid','12811','--parent','12809','--helper-preflight-report'],{env:{...process.env,HOME:home,PATH:bin+path.delimiter+process.env.PATH}});child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>error+=c);const exit=await new Promise((resolve,reject)=>{child.on('close',resolve);child.on('error',reject);});assert.equal(exit,0,error+output);const rows=output.trim().split('\n').map(JSON.parse);assert.equal(rows.at(-1).stage,'helper_preflight_report');assert.equal(rows.at(-1).ledgerChanged,false);assert.deepEqual((await readdir(home)).sort(),['Downloads']);}
 finally{await rm(dir,{recursive:true,force:true});}
});

test('audit blockers propagate through actual nonzero child exit, preserving stage and exit code',async()=>{
 const log=console.log,output=[];console.log=line=>output.push(JSON.parse(line));
 try{for(const reason of ['WORKER_PROCESS_PRESENT','PROCESS_IDENTITY_INCONCLUSIVE'])await assert.rejects(command(process.execPath,['-e',`console.log(JSON.stringify({operation:'cutover.audit',status:'blocked',blockers:[{stage:'processes',reason:'${reason}'}]}));console.error('PRIVATE_SECRET');process.exit(2)`],undefined,5000,false,false,{stage:'fresh_mac_gate'}),e=>e.message===reason&&e.helperExit.exitCode===2&&e.helperExit.lastStructuredStage==='audit.processes');}
 finally{console.log=log;}
 assert.ok(!JSON.stringify(output).includes('PRIVATE_SECRET'));assert.equal(output.at(-1).reason,'PROCESS_IDENTITY_INCONCLUSIVE');
});

test('Mac audit CLI cross-checks comm and preserves unknown parent blocker through the executor',async()=>{
 const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');
 const dir=await mkdtemp(path.join(tmpdir(),'adl-audit-classification-')),bin=path.join(dir,'bin'),state=path.join(dir,'feed.json');await mkdir(bin);
 await writeFile(state,JSON.stringify({mode:'connected',connections:{prematch:{phase:'stopped'},inplay:{phase:'stopped'}}}));await writeFile(state+'.snapshot-0123456789abcdef.json',JSON.stringify({nextAt:0,due:{},failures:{}}));
 const comm='49460 /Library/Developer/CommandLineTools/usr/bin/git\n49384 /usr/local/bin/node';
 const ps='49460 49384 T /Library/Developer/CommandLineTools/usr/bin/git show HEAD:apps/worker/src/index.ts\n49384 1 T node /unknown/parent.js';
 await writeFile(path.join(bin,'ps'),`#!${process.execPath}\nconsole.log(process.argv.includes('pid=,comm=')?${JSON.stringify(comm)}:${JSON.stringify(ps)});`,{mode:0o755});
 const child=spawnSync(process.execPath,['--import','tsx',path.resolve(here,'../../scripts/audit-aws-cutover.ts')],{cwd:path.resolve(here,'../..'),env:{...process.env,LSPORTS_STATE_FILE:state,PATH:bin+path.delimiter+process.env.PATH},encoding:'utf8'});
 try{assert.equal(child.status,2);const rows=child.stdout.trim().split('\n').map(JSON.parse),audit=rows.at(-1);assert.ok(audit.blockers.some(b=>b.reason==='PROCESS_IDENTITY_INCONCLUSIVE'));assert.ok(!JSON.stringify(audit).includes('/unknown/parent.js'));const exit=sanitizedHelperExit({stage:'fresh_mac_gate',code:child.status,rows,stderr:child.stderr});assert.equal(exit.reason,'PROCESS_IDENTITY_INCONCLUSIVE');assert.equal(exit.lastStructuredStage,'audit.processes');
  const known=ps.replace('/unknown/parent.js','/tmp/run/deploy/homologation/complete-adl-cutover.mjs');
  await writeFile(path.join(bin,'ps'),`#!${process.execPath}\nconsole.log(process.argv.includes('pid=,comm=')?${JSON.stringify(comm)}:${JSON.stringify(known)});`,{mode:0o755});
  const clear=spawnSync(process.execPath,['--import','tsx',path.resolve(here,'../../scripts/audit-aws-cutover.ts')],{cwd:path.resolve(here,'../..'),env:{...process.env,LSPORTS_STATE_FILE:state,PATH:bin+path.delimiter+process.env.PATH},encoding:'utf8'});assert.equal(clear.status,0,clear.stdout);assert.equal(JSON.parse(clear.stdout.trim()).matchingWorkerProcesses,0);
  const runtime=path.join(dir,'pinned-runtime');await mkdir(path.join(runtime,'scripts'),{recursive:true});
  const {copyFile,symlink}=await import('node:fs/promises');
  for(const name of ['audit-aws-cutover.ts','cutover-diagnostics.ts','cutover-policy.ts'])await copyFile(path.resolve(here,'../../scripts',name),path.join(runtime,'scripts',name));
  await copyFile(path.resolve(here,'../../package.json'),path.join(runtime,'package.json'));await copyFile(path.resolve(here,'../../tsconfig.json'),path.join(runtime,'tsconfig.json'));await symlink(path.resolve(here,'../../node_modules'),path.join(runtime,'node_modules'),'dir');
  const pinned=spawnSync(process.execPath,['--import','tsx',path.join(runtime,'scripts/audit-aws-cutover.ts')],{cwd:path.resolve(here,'../..'),env:{...process.env,LSPORTS_STATE_FILE:state,PATH:bin+path.delimiter+process.env.PATH},encoding:'utf8'});assert.equal(pinned.status,0,pinned.stdout+pinned.stderr);assert.equal(JSON.parse(pinned.stdout.trim()).matchingWorkerProcesses,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
