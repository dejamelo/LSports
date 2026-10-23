"""Read-only exact-checkpoint probe: existing logs plus three file/FD samples, 5s apart.
Never opens checkpoint contents, starts containers, signals processes, changes cache,
or connects to the supplier. PROBE_CONFIG is supplied by the local report analyzer.
"""
import datetime,hashlib,json,os,re,subprocess,time
from pathlib import Path

def emit(**row):print(json.dumps(row),flush=True)
def run(args):
 p=subprocess.run(args,capture_output=True,timeout=15)
 if p.returncode:raise RuntimeError('READ_ONLY_'+args[1].upper().replace('-','_')+'_FAILED')
 return p.stdout+p.stderr if args[1]=='logs' else p.stdout

def inspect_worker(expected):
 c=json.loads(run(['docker','inspect','adl-homologation-worker-1']))[0]
 labels=c['Config'].get('Labels') or {}
 if c['Id']!=expected or labels.get('com.docker.compose.project')!='adl-homologation' or labels.get('com.docker.compose.service')!='worker':raise RuntimeError('CURRENT_CONTAINER_DOES_NOT_MATCH_EXECUTION_NO_PROBE')
 return c

EXPECTED_SOURCE_HASHES={
 'apps/worker/src/state.ts':'b4b7866d8ef75b9eb593950589c58ad5442a2a935be251911c9b4324255bce51',
 'apps/worker/src/connected.ts':'4df72468955d11b0c51f95483c5c6b8c97623d1f1a27909133ce8de11da3090d',
 'apps/worker/src/persistence.ts':'7bd3c8f00dacd17f352f30db573eb2f59c75d6e78a7b6c9dbef3c90385a1901f',
 'packages/feed-store/src/index.ts':'bd4aabc83427ef07ed3438be1bdbb5ae873d61d1006fd12417bb717514336800'
}
def installed_sources(container):
 pid=container['State']['Pid'];root=Path('/proc',str(pid),'root','app');result=[]
 # No docker exec/run. Read only the four fixed source paths via container root.
 for name,expected in EXPECTED_SOURCE_HASHES.items():
  code=Path('/app')/name
  masked=any(str(code)==m['Destination'] or str(code).startswith(m['Destination'].rstrip('/')+'/') for m in container['Mounts'])
  actual=None
  try:
   path=root/name
   if path.stat().st_size<=1024**2:actual=hashlib.sha256(path.read_bytes()).hexdigest()
  except (OSError,PermissionError):pass
  result.append({'file':name,'expectedSha256':expected,'installedSha256':actual,'matches':actual==expected,'sourceCoveredByExternalMount':masked})
 tag=container['Config'].get('Image');tag_identity={'available':False}
 if isinstance(tag,str) and re.fullmatch('adl-worker-partitioned:[a-f0-9]{24}',tag):
  try:
   image=json.loads(run(['docker','image','inspect',tag]))[0]
   tag_identity={'available':True,'tag':tag,'tagImageId':image['Id'],'containerImageId':container['Image'],'matches':image['Id']==container['Image']}
  except Exception as e:tag_identity={'available':False,'errorType':type(e).__name__}
 label=(container['Config'].get('Labels') or {}).get('eu.adl.partitioned.patch');receipt={'found':False}
 if re.fullmatch('[a-f0-9]{64}',str(label)):
  path=Path('/etc/adl-homologation')/('partitioned-upgrade-'+label[:24]+'.json')
  try:
   st=path.lstat()
   if path.is_symlink() or not path.is_file() or st.st_uid!=0 or st.st_mode&0o077 or st.st_size>1024**2:raise RuntimeError('PREPARATION_RECEIPT_NOT_PROTECTED')
   value=json.loads(path.read_text());backup=value.get('backup');image=value.get('image')
   receipt={'found':True,'protected':True,'name':path.name,'digestMatches':value.get('digest')==label,'imageMatches':image==container['Config']['Image'],'phase':value.get('phase') if value.get('phase') in ('prepared','stop_requested','stopped','started') else 'unverified','offlineRestoreVerified':value.get('oomRestoreVerified') is True}
   if isinstance(backup,str) and re.fullmatch('/var/backups/adl-partitioned-upgrade-[A-Za-z0-9_-]+',backup):receipt['backup']=backup;receipt['backupExists']=Path(backup).is_dir()
  except FileNotFoundError:pass
  except Exception as e:receipt={'found':True,'verificationErrorType':type(e).__name__}
 return {'expectedCommit':'2bd97d2f924d628be3b344a56cc35b25bcb940d2','files':result,'intendedSourceInstalled':all(r['matches'] and not r['sourceCoveredByExternalMount'] for r in result),'receipt':receipt,'sourcePatchLabel':label if re.fullmatch('[a-f0-9]{64}',str(label)) else None,'tagIdentity':tag_identity}

def file_meta(path):
 try:
  st=path.lstat()
  if path.is_symlink():raise RuntimeError('CHECKPOINT_SYMLINK_REJECTED')
  if not path.is_file():raise RuntimeError('CHECKPOINT_NOT_REGULAR_FILE')
  return {'name':path.name,'device':st.st_dev,'inode':st.st_ino,'bytes':st.st_size,'allocatedBytes':st.st_blocks*512,'mtimeNs':st.st_mtime_ns}
 except FileNotFoundError:return None

def temp_paths(target):
 pattern=re.compile(re.escape(target.name)+r'\.[0-9]+\.tmp$')
 return [p for p in target.parent.iterdir() if pattern.fullmatch(p.name)][:16]

def cgroup_sample(pid,container):
 text=Path('/proc',str(pid),'cgroup').read_text();match=re.search(r'^0::(/[^\n]*)$',text,re.M)
 if not match:return {'available':False}
 root=Path('/sys/fs/cgroup');base=(root/match[1].lstrip('/')).resolve()
 if root not in base.parents or container[:12] not in str(base):raise RuntimeError('CGROUP_IDENTITY_UNVERIFIED')
 result={}
 for name in ('memory.current','memory.max','memory.stat','memory.events','memory.pressure','io.stat','io.max','io.pressure','cpu.max','cpu.stat'):
  p=base/name
  if not p.is_file():continue
  raw=p.read_text()[:8192]
  if name in ('memory.current','memory.max'):result[name]=int(raw) if raw.strip().isdigit() else raw.strip()
  elif name=='memory.stat':result[name]={k:int(v) for k,v in re.findall(r'^(anon|file|file_dirty|file_writeback|inactive_file|active_file) ([0-9]+)$',raw,re.M)}
  else:result[name]=raw.strip()
 return result

def processes(container):
 lines=run(['docker','top',container,'-eo','pid,ppid,comm']).decode().splitlines()[1:]
 return [(int(p[0]),p[2]) for line in lines if len(p:=line.split(None,2))==3 and p[0].isdigit()][:16]

def checkpoint_syscall(raw,architecture,fdset):
 # Never emit pointer/buffer arguments. Only decode calls whose FD was matched
 # by inode/device to this exact checkpoint. FD numbers are process-local.
 calls={'x86_64':{1:'write',18:'pwrite64',20:'writev',74:'fsync',75:'fdatasync'},'aarch64':{64:'write',68:'pwrite64',66:'writev',82:'fsync',83:'fdatasync'}}.get(architecture,{})
 parts=raw.split()
 try:
  number=int(parts[0]);operation=calls.get(number)
  if not operation or len(parts)<2:return None
  fd=int(parts[1],0)
  if fd not in fdset:return None
  result={'operation':operation,'fd':fd}
  if operation in ('write','pwrite64') and len(parts)>3:result['requestedBytes']=int(parts[3],0)
  return result
 except (ValueError,IndexError):return None

def sample(target,container):
 files=[m for path in [target,*temp_paths(target)] if (m:=file_meta(path))]
 identities={(m['device'],m['inode']) for m in files};fds=[];procs=[]
 for pid,comm in processes(container):
  proc=Path('/proc',str(pid));record={'pid':pid,'executableKind':comm if comm in ('node','MainThread','docker-init','esbuild') else 'other'}
  try:
   io=proc.joinpath('io').read_text();record['io']={k:int(v) for k,v in re.findall(r'^(wchar|syscw|write_bytes|cancelled_write_bytes):\s+([0-9]+)$',io,re.M)}
   record['threads']=[]
   for thread in sorted(proc.joinpath('task').iterdir())[:16]:
    try:
     w=thread.joinpath('wchan').read_text().strip();status=thread.joinpath('status').read_text();state=re.search(r'^State:\s+([A-Z])',status,re.M)
     record['threads'].append({'tid':int(thread.name),'state':state[1] if state else None,'waitChannel':w if re.fullmatch(r'[a-zA-Z0-9_]{1,80}',w) else 'unavailable'})
    except (FileNotFoundError,ProcessLookupError,PermissionError):continue
   for fd in proc.joinpath('fd').iterdir():
    try:
     st=fd.stat()
     if (st.st_dev,st.st_ino) not in identities:continue
     info=proc.joinpath('fdinfo',fd.name).read_text();pos=re.search(r'^pos:\s+([0-9]+)',info,re.M)
     fds.append({'pid':pid,'fd':int(fd.name),'device':st.st_dev,'inode':st.st_ino,'positionBytes':int(pos[1]) if pos else None})
    except (FileNotFoundError,ProcessLookupError,PermissionError):continue
   record['activeCheckpointIo']=[];fdset={v['fd'] for v in fds if v['pid']==pid}
   for thread in sorted(proc.joinpath('task').iterdir())[:64]:
    try:
     active=checkpoint_syscall(thread.joinpath('syscall').read_text(),os.uname().machine,fdset)
     if active:record['activeCheckpointIo'].append({'tid':int(thread.name),**active})
    except (FileNotFoundError,ProcessLookupError,PermissionError,OSError):continue
  except (FileNotFoundError,ProcessLookupError,PermissionError):record['inspection']='process_changed_or_unreadable'
  procs.append(record)
 return {'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':files,'checkpointDescriptors':fds[:16],'processes':procs}

def progress(first,last,target_name):
 def by_identity(s):return {(m['device'],m['inode']):m for m in s['files']}
 a,b=by_identity(first),by_identity(last);changes=[]
 for key,new in b.items():
  old=a.get(key)
  if old:changes.append({'inode':new['inode'],'name':new['name'],'bytesAdvanced':new['bytes']-old['bytes'],'sizeShrank':new['bytes']<old['bytes']})
 target_before=next((m for m in first['files'] if m['name']==target_name),None)
 target_after=next((m for m in last['files'] if m['name']==target_name),None)
 temp_before={k for k,m in a.items() if m['name']!=target_name};temp_after={k for k,m in b.items() if m['name']!=target_name}
 renamed=bool(target_after and (target_after['device'],target_after['inode']) in temp_before)
 target_changed=bool(target_before and target_after and (target_before['device'],target_before['inode'])!=(target_after['device'],target_after['inode']))
 advanced=any(c['bytesAdvanced']>0 for c in changes)
 return {'sameInodeChanges':changes,'temporaryInodeAdvancedToTarget':renamed,'targetInodeChanged':target_changed,'temporaryAttemptChanged':bool(temp_before!=temp_after),'assessment':'private_checkpoint_rename_observed' if renamed or target_changed else 'file_size_advancing' if advanced else 'no_file_change_in_short_window_not_proof_of_stall','directoryFsyncVerified':False,'publicProjectionCommitVerified':False,'durableInboxRetirementVerified':False}

def logs(container,since):
 raw=run(['docker','logs','--timestamps','--since',since,'--tail','2000',container])[-4*1024**2:]
 rows=[]
 allowed={'file.persist','state.publication_wait','inbox.checkpoint','inbox.processing_progress','worker.start','worker.shutdown','amqp.connection','amqp.channel','distribution.start','distribution.stop'}
 for line in raw.decode(errors='replace').splitlines():
  try:stamp,body=line.split(' ',1);r=json.loads(body)
  except (ValueError,TypeError):
   flags=[name for name,pattern in [('ENOSPC',r'\bENOSPC\b|no space left'),('EIO',r'\bEIO\b|input/output error'),('EACCES',r'\bEACCES\b|permission denied'),('NODE_HEAP_EXHAUSTED',r'heap out of memory|Ineffective mark-compacts') ] if re.search(pattern,line,re.I)]
   if flags:
    stamp=re.match(r'^(\d{4}-\d\d-\d\dT[0-9:.]+Z)',line);rows.append({'signals':flags,**({'atUTC':stamp[1]} if stamp else {})})
   continue
  if r.get('operation') not in allowed:continue
  if not re.fullmatch(r'\d{4}-\d\d-\d\dT[0-9:.]+Z',stamp):continue
  row={'atUTC':stamp}
  for k in ('lane','operation','stage','status','publicationStage','category','reason'):
   if isinstance(r.get(k),str) and re.fullmatch('[A-Za-z0-9_.-]{1,160}',r[k]):row[k]=r[k]
  for k in ('writes','elapsedMs','publicationElapsedMs','waitedMs','rows','lastDurationMs','regularDurationMs','captureDurationMs','publishDurationMs','heapHeadroomBytes','heapUsedBytes','rssBytes'):
   if type(r.get(k)) in (int,float):row[k]=r[k]
  if isinstance(r.get('ingress'),dict):
   row['ingress']={k:v for k,v in r['ingress'].items() if k in ('received','acknowledged','processed','checkpointed','backlog','processingBacklog','oldestProcessingAgeMs') and type(v) in (int,float)}
   row['ingress']['metricWindowEndUTC']=r['ingress'].get('metricWindowEndUTC') if re.fullmatch(r'\d{4}-\d\d-\d\dT[0-9:.]+Z',str(r['ingress'].get('metricWindowEndUTC'))) else None
  rows.append(row)
 rows.sort(key=lambda r:datetime.datetime.fromisoformat(r['atUTC'].replace('Z','+00:00')) if r.get('atUTC') else datetime.datetime.max.replace(tzinfo=datetime.timezone.utc))
 return rows[-120:]

def main(config):
 expected=config.get('expectedId')
 if not re.fullmatch('[a-f0-9]{64}',str(expected)):raise RuntimeError('EXPECTED_EXECUTION_CONTAINER_REQUIRED')
 c=inspect_worker(expected);s=c['State']
 emit(stage='checkpoint_probe_identity',id=c['Id'],imageId=c['Image'],running=s['Running'],oomKilled=s['OOMKilled'],startedAtUTC=s['StartedAt'],memoryLimitBytes=c['HostConfig']['Memory'])
 if not s['Running']:raise RuntimeError('WORKER_STOPPED_NO_WAIT_NO_RESTART')
 emit(stage='installed_publication_correction',**installed_sources(c))
 env=dict(v.split('=',1) for v in c['Config'].get('Env',[]) if '=' in v)
 state=Path(env.get('LSPORTS_STATE_FILE','.runtime/trade-feed.json'))
 if not state.is_absolute():state=Path(c['Config'].get('WorkingDir') or '/app')/state
 mounts=[m for m in c['Mounts'] if str(state).startswith(m['Destination'].rstrip('/')+'/')]
 if len(mounts)!=1:raise RuntimeError('CHECKPOINT_MOUNT_UNVERIFIED')
 mount=mounts[0];host=Path(mount['Source'])/state.relative_to(mount['Destination']);target=Path(str(host)+'.regular-checkpoint.json')
 root=Path(mount['Source']).resolve()
 if target.parent.resolve()!=root and root not in target.parent.resolve().parents:raise RuntimeError('CHECKPOINT_OUTSIDE_MOUNT')
 since=config.get('sinceUTC')
 if not isinstance(since,str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT[0-9:.]+Z',since):since=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=3)).isoformat()
 began=time.monotonic();samples=[]
 for number in range(3):
  if number:time.sleep(5)
  current=inspect_worker(expected)
  if not current['State']['Running']:raise RuntimeError('WORKER_STOPPED_DURING_READ_ONLY_PROBE')
  row=sample(target,expected);row['cgroup']=cgroup_sample(current['State']['Pid'],expected);samples.append(row)
  emit(stage='checkpoint_file_sample',sample=number+1,**row)
 history=logs(expected,since)
 emit(stage='checkpoint_io_result',logsSinceUTC=since,elapsedSeconds=time.monotonic()-began,**progress(samples[0],samples[-1],target.name),recentPublicationLogs=history,readOnly=True,providerRequests=0,signalsToWorker=0,workerRestarted=False,integrationVerified=False,limit='No JS per-write operation ID/duration in installed telemetry. File/FD progress identifies advancing bytes and observed renames; it cannot alone prove fsync, publication commit or inbox retirement.')

if __name__=='__main__':
 try:main(globals().get('PROBE_CONFIG',{}))
 except Exception as e:
  reason=str(e) if isinstance(e,RuntimeError) and re.fullmatch('[A-Z_0-9]+',str(e)) else type(e).__name__
  emit(stage='checkpoint_write_probe',status='blocked',reason=reason,rawErrorsPrinted=False,workerMutationRequested=False);raise SystemExit(2)
