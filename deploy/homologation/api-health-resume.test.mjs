import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {spawnSync} from 'node:child_process';
import {acceptedWorkerMemoryLimits} from './resumable-adl-cutover.mjs';
test('six GiB preflight is accepted only for its protected live pipeline or snapshot-pressure repair',()=>{
 assert.deepEqual(acceptedWorkerMemoryLimits({snapshotMemoryRepair:true,livePersistenceRepair:true}),['4294967296','6442450944']);
 assert.deepEqual(acceptedWorkerMemoryLimits({snapshotMemoryRepair:true,livePersistenceRepair:false}),['4294967296']);
 assert.deepEqual(acceptedWorkerMemoryLimits({snapshotMemoryRepair:true,livePersistenceRepair:false,v8HeapOomRepair:true}),['6442450944']);
 assert.deepEqual(acceptedWorkerMemoryLimits({snapshotMemoryRepair:true,pipelineRepair:true}),['6442450944']);
 assert.deepEqual(acceptedWorkerMemoryLimits({mode:'--repair-snapshot'}),['2147483648','4294967296']);
});
test('health action bypasses readiness requirement without bypassing root gate',()=>{const s=fs.readFileSync(new URL('./execute-adl-cutover-aws.py',import.meta.url),'utf8');assert(s.indexOf("require(os.geteuid()==0")<s.indexOf("if action=='api_health'"));assert(s.indexOf("if action=='api_health'")<s.indexOf("'API_NOT_HEALTHY'"));});
test('resume branches before preflight and upgrade; requires installed correction and fresh Mac audit',()=>{const s=fs.readFileSync(new URL('./resumable-adl-cutover.mjs',import.meta.url),'utf8');const branch=s.slice(s.indexOf("if(['--api-validation-resume','--feed-validation-resume','--recovery-progress'].includes(args[4])){"),s.indexOf('// Current consumer safety'));assert(branch.includes('INSTALLED_WORKER_CORRECTIONS_UNVERIFIED_NO_RESTART'));assert(branch.includes('FRESH_MAC_ABSENCE_AUDIT_FAILED'));assert(branch.includes('validateFullRecovery'));assert(!branch.includes("remote('upgrade_partitioned'"));assert(!branch.includes("remote('start'"));});
test('readiness requires Docker healthy AND both real endpoint probes; emits no raw logs',()=>{const file=new URL('./execute-adl-cutover-aws.py',import.meta.url).pathname;const result=spawnSync('python3',['-c',`
import ast,json
from pathlib import Path
source=Path(${JSON.stringify(file)}).read_text(); tree=ast.parse(source)
functions=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='api_health_report']
class Result:
 returncode=0
 stdout=b'{"status":200}'
class Response:
 status=200
 def __enter__(self):return self
 def __exit__(self,*a):pass
import types,time
state={'health':'unhealthy'}; emitted=[]
container={'State':{'Health':{'Status':'unhealthy','Log':[{'Output':'SECRET','ExitCode':1}]}},'Config':{'Healthcheck':{}},'Image':'sha256:test'}
ns={'states':lambda service:[{'id':'abc','running':True,'health':state['health']}], 'run':lambda args:json.dumps([container]), 'json':json,'time':time,'urllib':types.SimpleNamespace(request=types.SimpleNamespace(urlopen=lambda *a,**k:Response()),error=types.SimpleNamespace(HTTPError=Exception)), 'subprocess':types.SimpleNamespace(run=lambda *a,**k:Result()),'classify':lambda data:[], 'api_private_log_summary':lambda item:{'signals':[]}, 'api_worker_installation':lambda:{'verified':True},'emit':lambda **kw:emitted.append(kw)}
exec(compile(ast.Module(body=functions,type_ignores=[]),'test','exec'),ns)
ns['api_health_report']();assert emitted[-1]['ready']==False
state['health']='healthy';ns['api_health_report']();assert emitted[-1]['ready']==True
assert 'SECRET' not in json.dumps(emitted)
`],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);});
test('spool memory repair uses deployed throughput base and gates measured cgroup headroom before mutation',()=>{const s=fs.readFileSync(new URL('./resumable-adl-cutover.mjs',import.meta.url),'utf8');assert(s.includes("args[4]==='--snapshot-throughput-repair'?'043af2e'"));assert(s.includes("includes(args[4])?'dcd644b'"));assert(s.indexOf('MEASURED_MEMORY_HEADROOM_INSUFFICIENT_NO_PATCH')<s.indexOf("phase:'prepare',files,baseHashes"));assert(s.includes('offlineSpoolMemoryVerified!==true'));assert(s.includes('spoolMemoryBefore'));});
