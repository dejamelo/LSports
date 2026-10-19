// Explicit authorized graceful stop, then export only after success. No SSH or AWS start.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile,spawn} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
if(process.argv.length!==5||process.argv[2]!=='--pid'||!/^\d+$/.test(process.argv[3])||process.argv[4]!=='--prior-term-confirmed'){console.log(JSON.stringify({operation:'cutover.resume',status:'blocked',stage:'arguments'}));process.exitCode=2;}
else execFile(process.execPath,['--import','tsx','--env-file-if-exists=.env','scripts/recover-stopped-mac-worker.ts',...process.argv.slice(2)],{cwd:root,timeout:180000,maxBuffer:1024*1024},(error,stdout)=>{
 let complete=false;
 for(const line of stdout.trim().split('\n')){
  try{const report=JSON.parse(line);if(report.operation==='cutover.resume'){console.log(JSON.stringify(report));if(report.stage==='complete'&&report.status==='ok')complete=true;}}catch{}
 }
 if(error||!complete){console.log(JSON.stringify({operation:'cutover.resume',status:'blocked',stage:'stop_launcher',workerStarted:false,note:'No export/start attempted. Preserve locks and backups; inspect sanitized recovery evidence above. No raw stderr printed.'}));process.exitCode=2;return;}
 const child=spawn(process.execPath,['deploy/homologation/prepare-adl-cutover.mjs'],{cwd:root,stdio:['ignore','inherit','pipe']});
 child.stderr.on('data',chunk=>{for(const line of String(chunk).split('\n'))try{const report=JSON.parse(line);if(report.operation==='cutover.prepare')console.error(JSON.stringify(report));}catch{}});
 child.on('error',()=>{console.log(JSON.stringify({operation:'cutover.resume',status:'blocked',stage:'export_launch',workerStarted:false}));process.exitCode=2;});
 child.on('close',code=>{if(code!==0)process.exitCode=2;});
});
