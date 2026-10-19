// Local, one verified supervisor CONT, no TERM to owner; export only after verified exit.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const emit=value=>console.log(JSON.stringify({operation:'cutover.drain',workerStarted:false,awsChanged:false,...value}));
if(process.argv.length!==6||process.argv[2]!=='--pid'||!/^\d+$/.test(process.argv[3])||process.argv[4]!=='--parent'||!/^\d+$/.test(process.argv[5])){emit({stage:'arguments',status:'blocked'});process.exitCode=2;}
else{
 const child=spawn(process.execPath,['--import','tsx','--env-file-if-exists=.env','scripts/drain-mac-supervisor.ts',...process.argv.slice(2)],{cwd:root,stdio:['ignore','pipe','pipe']});
 let buffered='',complete=false;
 const consume=line=>{try{const value=JSON.parse(line);if(value.operation==='cutover.drain'){console.log(JSON.stringify(value));if(value.stage==='complete'&&value.status==='ok')complete=true;}}catch{}};
 child.stdout.on('data',chunk=>{buffered+=chunk;const lines=buffered.split('\n');buffered=lines.pop();for(const line of lines)consume(line);});child.stderr.resume();
 const timeout=setTimeout(()=>{child.kill('SIGTERM');emit({stage:'helper_timeout',status:'blocked',note:'Only helper stopped. No further signals to owner/supervisor; preserve locks and intents.'});},180000);
 child.on('error',()=>{clearTimeout(timeout);emit({stage:'helper_start',status:'blocked'});process.exitCode=2;});
 child.on('close',code=>{
  clearTimeout(timeout);consume(buffered);
  if(code!==0||!complete){emit({stage:'export_not_attempted',status:'blocked',note:'Preserve original backup/intents/checkpoint/journals. AWS unchanged; no repeated signals.'});process.exitCode=2;return;}
  const exporter=spawn(process.execPath,['deploy/homologation/prepare-adl-cutover.mjs'],{cwd:root,stdio:['ignore','inherit','pipe']});
  let errors='';exporter.stderr.on('data',chunk=>{errors+=chunk;});
  exporter.on('error',()=>{emit({stage:'export_start',status:'blocked'});process.exitCode=2;});
  exporter.on('close',result=>{for(const line of errors.split('\n'))try{const value=JSON.parse(line);if(value.operation==='cutover.prepare')console.log(JSON.stringify(value));}catch{}if(result!==0)process.exitCode=2;});
 });
}
