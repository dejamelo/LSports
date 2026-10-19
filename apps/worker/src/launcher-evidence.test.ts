import {test} from 'node:test';
import assert from 'node:assert/strict';
import {launcherEvidence,childKind} from '../../../scripts/launcher-evidence.js';
const info={pid:12809,parentPid:12799,uid:501,startedAt:'fixed',args:''};
test('shows why dedicated shell fails TSX-only policy without authorizing it',()=>{
 const result=launcherEvidence({...info,args:'sh -c node --import tsx apps/worker/src/index.ts'},'/repo','/repo',501);
 assert.equal(result.signature,'shell_with_worker_text');assert.ok(result.failedChecks.includes('nodeExecutable'));assert.ok(result.failedChecks.includes('tsxCliMarker'));assert.equal(result.acceptedByCurrentGate,false);assert.equal(result.markers.shellCommandFlag,true);
});
test('node --import tsx is distinguished from CLI, not presumed to be a safe launcher',()=>{
 const result=launcherEvidence({...info,args:'node --import tsx apps/worker/src/index.ts'},'/repo','/repo',501);
 assert.equal(result.signature,'node_import_tsx_worker');assert.deepEqual(result.failedChecks,['tsxCliMarker']);assert.equal(result.acceptedByCurrentGate,false);
});
test('recognized CLI shows original gate passing, other failed checks remain separate',()=>{
 const result=launcherEvidence({...info,args:'node /repo/node_modules/tsx/dist/cli.mjs apps/worker/src/index.ts'},'/repo','/repo',501);
 assert.equal(result.acceptedByCurrentGate,true);assert.deepEqual(result.failedChecks,[]);
 const other=launcherEvidence({...info,args:'node /repo/node_modules/tsx/dist/cli.mjs watch apps/worker/src/index.ts'},'/repo','/elsewhere',502);
 assert.ok(other.failedChecks.includes('sameUser'));assert.ok(other.failedChecks.includes('cwdInProject'));assert.ok(other.failedChecks.includes('watchAbsent'));
});
test('compound/multi-service launcher and siblings are visible without argv secrets',()=>{
 const result=launcherEvidence({...info,args:'node /repo/node_modules/concurrently/dist/bin/concurrently.js "node apps/worker/src/index.ts" "npm run dev:web" --token=SECRET https://password@host'},'/repo','/repo',501);
 assert.equal(result.signature,'concurrently_marker');assert.equal(result.safetyMarkers.otherTargetsPresent,true);assert.ok(!JSON.stringify(result).includes('SECRET'));assert.ok(!JSON.stringify(result).includes('password@'));assert.equal(childKind('node apps/api/src/index.ts --secret=SECRET'),'api_entrypoint');
});
test('relative workspace entry and unverified cwd are identified without guessing permission',()=>{
 const result=launcherEvidence({...info,args:'node /repo/node_modules/.bin/tsx src/index.ts'},'/repo',undefined,501);
 assert.equal(result.markers.workspaceRelativeEntry,true);assert.equal(result.cwdClass,'unverified');assert.equal(result.acceptedByCurrentGate,false);
});
