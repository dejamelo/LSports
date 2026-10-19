// Preserve staged/unstaged work independently; deploy only explicitly selected Git objects.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const exec=promisify(execFile);
async function git(repo,args){return (await exec('git',args,{cwd:repo,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'},encoding:'buffer',maxBuffer:32*1024*1024})).stdout;}
export function changedPaths(raw){
 const entries=raw.toString('utf8').split('\0'), result=[];
 for(let i=0;i<entries.length;i++){
  const row=entries[i];if(!row)continue;
  const status=row.slice(0,2),name=row.slice(3);
  if(status==='??')continue;
  const item={status,path:name};
  if(/[RC]/.test(status)){item.originalPath=entries[++i];if(!item.originalPath)throw Error('INVALID_STATUS_RECORD');}
  result.push(item);
 }
 return result;
}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function worktreeFile(repo,name){
 const target=path.resolve(repo,name);
 if(!target.startsWith(path.resolve(repo)+path.sep))throw Error('LOCAL_PATH_REJECTED');
 try{
  const stat=await fs.lstat(target);
  if(stat.isSymbolicLink())return {kind:'symlink',bytes:Buffer.from(await fs.readlink(target)),mode:stat.mode&0o777};
  if(!stat.isFile())throw Error('LOCAL_FILE_TYPE_REJECTED');
  return {kind:'file',bytes:await fs.readFile(target),mode:stat.mode&0o777};
 }catch(e){if(e.code==='ENOENT')return {kind:'absent'};throw e;}
}
async function blob(repo,ref,name){
 try{return await git(repo,['show',`${ref}:${name}`]);}
 catch(e){if(e.code===128||e.code===1)return null;throw e;}
}
export async function inspectLocalSource(repo,commit,backupRoot){
 const head=(await git(repo,['rev-parse','HEAD'])).toString().trim();
 const statusBefore=await git(repo,['status','--porcelain=v1','-z','--untracked-files=no']);
 const changes=changedPaths(statusBefore);
 const headDiff=(await git(repo,['diff','--name-only','-z',commit,head])).toString().split('\0').filter(Boolean);
 if(!changes.length)return {environment:'local_checkout_before_ssh',head,intendedCommit:commit,trackedChanges:[],headDiffersFromIntended:head!==commit,committedDifferences:headDiff,backup:null};
 await fs.mkdir(backupRoot,{recursive:true,mode:0o700});
 const parent=await fs.lstat(backupRoot);if(!parent.isDirectory()||parent.isSymbolicLink())throw Error('BACKUP_DIRECTORY_REJECTED');await fs.chmod(backupRoot,0o700);
 const folder=await fs.mkdtemp(path.join(backupRoot,'panel-api-local-'));await fs.chmod(folder,0o700);
 const manifest={head,intendedCommit:commit,files:{},changes:[]};
 const save=async(name,bytes)=>{await fs.writeFile(path.join(folder,name),bytes,{flag:'wx',mode:0o600});manifest.files[name]=digest(bytes);};
 await save('staged.private.patch',await git(repo,['diff','--cached','--binary','--no-ext-diff','--no-textconv','HEAD']));
 await save('unstaged.private.patch',await git(repo,['diff','--binary','--no-ext-diff','--no-textconv']));
 await save('head-vs-intended.private.patch',await git(repo,['diff','--binary','--no-ext-diff','--no-textconv',commit,head]));
 const index=(await git(repo,['rev-parse','--git-path','index'])).toString().trim();
 await save('index.private',await fs.readFile(path.resolve(repo,index)));
 const comparisons=[];
 for(let i=0;i<changes.length;i++){
  const item=changes[i],current=await worktreeFile(repo,item.path),intended=await blob(repo,commit,item.path),staged=await blob(repo,'',item.path);
  if(current.bytes)await save(`working-${i}.private`,current.bytes);
  if(intended!==null)await save(`intended-${i}.private`,intended);
  if(staged!==null)await save(`staged-${i}.private`,staged);
  const tree=(await git(repo,['ls-tree','-z',commit,'--',item.path])).toString();
  const intendedMode=/^([0-9]{6}) /.exec(tree)?.[1]||null;
  const workingMode=current.kind==='absent'?null:current.kind==='symlink'?'120000':current.mode&0o111?'100755':'100644';
  const report={...item,workingKind:current.kind,intendedMode,workingMode,workingContentEqualsIntended:current.kind==='absent'?intended===null:intended!==null&&current.bytes.equals(intended),indexContentEqualsIntended:staged===null?intended===null:intended!==null&&staged.equals(intended)};
  comparisons.push(report);manifest.changes.push({...report,posixPermissions:current.mode});
 }
 // Detect edits while the backup was made; never claim an inconsistent copy is safe.
 if(!(await git(repo,['diff','--binary','--no-ext-diff','--no-textconv'])).equals(await fs.readFile(path.join(folder,'unstaged.private.patch'))) || !(await git(repo,['diff','--cached','--binary','--no-ext-diff','--no-textconv','HEAD'])).equals(await fs.readFile(path.join(folder,'staged.private.patch'))))throw Error('LOCAL_FILES_CHANGED_DURING_BACKUP');
 if((await git(repo,['rev-parse','HEAD'])).toString().trim()!==head || !(await git(repo,['status','--porcelain=v1','-z','--untracked-files=no'])).equals(statusBefore))throw Error('LOCAL_FILES_CHANGED_DURING_BACKUP');
 await fs.writeFile(path.join(folder,'manifest.private.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
 for(const [name,hash] of Object.entries(manifest.files))if(digest(await fs.readFile(path.join(folder,name)))!==hash)throw Error('LOCAL_BACKUP_VERIFY_FAILED');
 return {environment:'local_checkout_before_ssh',head,intendedCommit:commit,trackedChanges:comparisons,headDiffersFromIntended:head!==commit,committedDifferences:headDiff,backup:folder,sha256Verified:true,workingTreeChanged:false,indexChanged:false};
}
