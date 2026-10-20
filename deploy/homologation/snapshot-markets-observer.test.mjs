import{test}from'node:test';import assert from'node:assert/strict';
import{mkdtemp,mkdir,writeFile,readFile,rm,stat}from'node:fs/promises';import{tmpdir}from'node:os';import path from'node:path';import{spawn}from'node:child_process';import{fileURLToPath}from'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),image=process.env.ADL_INSPECTION_TEST_IMAGE;
for(const live of [false,true])test(`offline installed image: ${live?'capture normal download after worker unlink':'prefer retained response'}, exact field preserved without publishing values`,{skip:!image,timeout:30000},async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'adl-shape-test-')),feed=path.join(dir,'feed'),evidence=path.join(dir,'evidence');await mkdir(feed);await mkdir(evidence);
 const source=(await readFile(path.join(here,'snapshot-markets-inspection.mjs'),'utf8')).replace('export function','function')+'\n'+await readFile(path.join(here,'snapshot-markets-observer.mjs'),'utf8');
 const row={FixtureId:123,Fixture:{Status:1},Markets:live?[{Id:1,Bets:{Private:'DO_NOT_PRINT'}}]:null};
 const folder=path.join(feed,live?'.full-snapshot-test123':'.rejected-full-snapshot'),file=path.join(folder,'response.private.json');
 if(!live){await mkdir(folder);await writeFile(file,JSON.stringify({Body:[row],Header:{HttpStatusCode:200}}));}
 const child=spawn('docker',['run','--rm','-i','--network','none','--memory','384m','--read-only','--tmpfs','/tmp:size=33554432,mode=1777','--user',`${process.getuid()}:${process.getgid()}`,'--mount',`type=bind,source=${feed},target=/app/.runtime/feed,readonly`,'--mount',`type=bind,source=${evidence},target=/evidence`,'--entrypoint','node',image,'--import','tsx','--input-type=module'],{stdio:['pipe','pipe','pipe']});
 let output='',errors='',triggered=false,pending;
 child.stdout.on('data',c=>{output+=c;if(live&&!triggered&&output.includes('"watching"')){triggered=true;pending=(async()=>{await mkdir(folder);await writeFile(file,JSON.stringify({Body:[row],Header:{HttpStatusCode:200}}));await new Promise(r=>setTimeout(r,700));await rm(folder,{recursive:true});})();}});child.stderr.on('data',c=>errors+=c);child.stdin.end(source);
 try{const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});if(pending)await pending;assert.equal(exit,0,errors+output);assert.ok(!output.includes('DO_NOT_PRINT'));const report=JSON.parse(await readFile(path.join(evidence,'report.json'),'utf8'));assert.equal(report.rejection.path,live?'Markets[0].Bets':'Markets');assert.equal(report.rejection.actualType,live?'object':'null');assert.equal(report.validationRelaxed,false);assert.equal(report.providerRequests,0);assert.equal(report.workerRestarted,false);assert.deepEqual(JSON.parse(await readFile(path.join(evidence,'rejected-row.private.json'),'utf8')),row);assert.equal((await stat(path.join(evidence,'rejected-row.private.json'))).mode&0o777,0o600);}
 finally{await rm(dir,{recursive:true,force:true});}
});
