// Read-only classification. No argv, paths, unknown option values or environment are returned.
import {join} from 'node:path';
import type {Identity} from './stop-owned-worker.js';
import {workerIdentity} from './stop-owned-worker.js';
export function launcherEvidence(info:Identity,root:string,cwd:string|undefined,uid:number){
 const args=info.args;
 const node=/^(?:\S*\/)?(?:node|nodejs)(?:\s|$)/.test(args);
 const shell=/^(?:\S*\/)?(?:sh|bash|zsh|dash)(?:\s|$)/.test(args);
 const npm=/^(?:\S*\/)?(?:npm|npx)(?:\s|$)/.test(args);
 const tsx=/^(?:\S*\/)?tsx(?:\s|$)/.test(args);
 const entry=/\b(?:apps\/worker\/src\/index\.[tj]s|scripts\/homologation-worker\.[tj]s)(?:\s|$)/.test(args);
 const cli=/(?:^|\/)(?:tsx\/dist\/cli\.[cm]?js|node_modules\/\.bin\/tsx)(?:\s|$)/.test(args);
 const watch=/(?:^|\s)watch(?:\s|$)/.test(args);
 const imported=/(?:^|\s)--import(?:=|\s+)tsx(?:\s|$)/.test(args);
 const loader=/tsx\/dist\/(?:loader\.mjs|preflight\.cjs)/.test(args);
 const concurrently=/(?:concurrently\/|\bconcurrently\b)/.test(args);
 const otherTargets={api:/apps\/api\//.test(args)||/dev:api\b/.test(args),web:/apps\/web\//.test(args)||/dev:web\b/.test(args),vite:/\bvite\b/.test(args)};
 const checks={sameUser:info.uid===uid,cwdInProject:cwd===root||cwd===join(root,'apps/worker'),nodeExecutable:node,workerEntryInArgs:entry,tsxCliMarker:cli,watchAbsent:!watch};
 const failedChecks=Object.entries(checks).filter(([,pass])=>!pass).map(([key])=>key);
const shape=args.trim().split(/\s+/).map(token=>{
  const plain=token.replace(/^["']|["']$/g,'');
  if(['node','nodejs','tsx','sh','bash','zsh','dash','-c','exec','--import','--loader','--require','watch','--watch','--enable-source-maps','--no-warnings','-e','--eval','-p','--print'].includes(plain))return plain;
  if(/(?:^|\/)node(?:js)?$/.test(plain))return '[node-executable]';
  if(/(?:^|\/)(?:sh|bash|zsh|dash)$/.test(plain))return '[shell-executable]';
  if(/tsx\/dist\/cli\.[cm]?js$/.test(plain))return '[tsx-cli]';
  if(/node_modules\/\.bin\/tsx$/.test(plain))return '[tsx-cli-symlink]';
  if(/(?:apps\/worker\/src\/index\.[tj]s|scripts\/homologation-worker\.[tj]s|^src\/index\.[tj]s)$/.test(plain))return '[worker-entry]';
  if(/^--env-file(?:-if-exists)?=/.test(plain))return plain.startsWith('--env-file-if-exists=')?'--env-file-if-exists=[hidden]':'--env-file=[hidden]';
  if(/tsx\/dist\/(?:loader\.mjs|preflight\.cjs)$/.test(plain))return '[tsx-loader-or-preflight]';
  return '[redacted]';
 });
 const signature=concurrently?'concurrently_marker':node&&imported&&entry?'node_import_tsx_worker':node&&cli&&entry?'node_tsx_cli_worker':shell&&entry?'shell_with_worker_text':node&&entry?'node_with_worker_text':npm?'npm_or_npx':shell?'shell':tsx?'tsx_executable':'other';
 return {pid:info.pid,parentPid:info.parentPid,binaryKind:node?'node':shell?'shell':npm?'npm_or_npx':tsx?'tsx':'other',signature,
  cwdClass:cwd===undefined?'unverified':cwd===root?'repository_root':cwd===join(root,'apps/worker')?'worker_workspace':'other',checks,failedChecks,
  acceptedByCurrentGate:cwd!==undefined&&workerIdentity(info,root,cwd,uid)&&cli&&!watch,
  argumentShape:shape.slice(0,48),argumentShapeTruncated:shape.length>48,argumentShapeIsApproximate:true,
  safetyMarkers:{shellControlOrExpansion:/[;&|<>`$()\r\n]/.test(args),evalOrPrint:/(?:^|\s)(?:-e|--eval|-p|--print)(?:=|\s|$)/.test(args),otherTargetsPresent:Object.values(otherTargets).some(Boolean)},
  markers:{nodeImportTsx:imported,tsxLoaderOrPreflight:loader,workspaceRelativeEntry:/(?:^|\s)src\/index\.[tj]s(?:\s|$)/.test(args),shellCommandFlag:shell&&/(?:^|\s)-c(?:\s|$)/.test(args),concurrently,otherTargets},
  note:'Signature classifies observed text; it does not authorize resuming a shell, supervisor or unknown launcher.'};
}
export function childKind(args:string){
 if(/apps\/worker\/src\/index\.[tj]s/.test(args))return 'worker_entrypoint';
 if(/apps\/api\/src\/index\.[tj]s|dev:api\b/.test(args))return 'api_entrypoint';
 if(/apps\/web\/|dev:web\b|\bvite\b/.test(args))return 'web_entrypoint';
 return 'other';
}
