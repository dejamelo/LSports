"""One pinned read-only check for the prepared partial-prefix update."""
import datetime,hashlib,json,os,re,shutil,subprocess,time
from pathlib import Path
BACKUP=Path('/var/backups/adl-partitioned-upgrade-xwk889pt')
IMAGE='adl-worker-partitioned:ebc0547eb004ccf340fa6e11'
RECEIPT=Path('/etc/adl-homologation/partitioned-upgrade-ebc0547eb004ccf340fa6e11.json')
CID='3d39db9870208e6cbdbaedb25fcad2b774f9a59a66f2dc5acb8c4a2868f61739'
def run(args,timeout=20):
 r=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
 if r.returncode:raise RuntimeError('READ_FAILED_'+args[0].upper())
 return r.stdout

def protected(path):
 return path.is_file() and not path.is_symlink() and path.stat().st_uid==os.geteuid() and path.stat().st_mode&0o077==0 and path.stat().st_size<2*1024**2

def kind(name):
 if name.endswith('.inbox.sqlite-wal'):return 'inbox_wal'
 if name.endswith('.inbox.sqlite-shm'):return 'inbox_shm'
 if name.endswith('.inbox.sqlite'):return 'inbox_database'
 if name=='response.private.json':return 'http_spool'
 if name.endswith('.tmp'):return 'temporary_unverified'
 if name=='trade-feed.json.regular-checkpoint.json':return 'private_checkpoint'
 if name=='trade-feed.json':return 'public_projection'
 return 'other_preserved'

def storage_action(filesystem,devices,free,required):
 roots=filesystem.get('filesystems',[])
 if len(roots)!=1 or roots[0].get('fstype')!='ext4' or roots[0].get('target')!='/':return {'status':'filesystem_identity_unverified_no_action'}
 source=roots[0].get('source');matches=[]
 def visit(nodes,disk=None):
  for node in nodes:
   parent=node if node.get('type')=='disk' else disk
   if '/dev/'+str(node.get('name'))==source and parent:matches.append(parent)
   visit(node.get('children',[]),parent)
 visit(devices.get('blockdevices',[]))
 if len(matches)!=1 or matches[0].get('serial')!='vol03fa30ff2fc37a28e':return {'status':'volume_serial_unverified_no_action'}
 size=int(matches[0]['size']);gib=1024**3;current=(size+gib-1)//gib;short=max(0,required-free);minimum=current+(short+gib-1)//gib
 target=((minimum+8+15)//16)*16 if short else current
 return {'status':'console_candidate_only','region':'us-east-2','expectedInstanceId':'i-04690a17692088df9','volumeId':'vol-03fa30ff2fc37a28e','device':'/dev/'+matches[0]['name'],'currentEbsGiB':current,'minimumEbsGiB':minimum,'suggestedEbsGiB':target,'additionalGiB':target-current,'planningMarginGiB':8,'ebsAttachmentMustBeConfirmedBeforeModification':True,'capacityChangeExecuted':False}

def inputs(directory):
 rows=[]
 for p in directory.rglob('*'):
  if not p.is_file() or p.is_symlink() or not(p.name.startswith('trade-feed.json') or p.name=='response.private.json'):continue
  st=p.stat();rows.append({'path':str(p.relative_to(directory)),'kind':kind(p.name),'logicalBytes':st.st_size,'allocatedBytes':st.st_blocks*512,'modifiedAtUTC':datetime.datetime.fromtimestamp(st.st_mtime,datetime.timezone.utc).isoformat(),'safeToDelete':False})
  if len(rows)>1000:raise RuntimeError('FEED_FILE_LIST_LIMIT')
 return rows

def connection_metadata(path):
 with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb') as f:text=f.read(1024**2).decode('utf8',errors='ignore')
 decoder=json.JSONDecoder();pos=1
 if not text.startswith('{'):raise RuntimeError('PUBLICATION_PREFIX_UNVERIFIED')
 for _ in range(32):
  while text[pos].isspace() or text[pos]==',':pos+=1
  key,pos=decoder.raw_decode(text,pos)
  while text[pos].isspace():pos+=1
  if text[pos]!=':':raise RuntimeError('PUBLICATION_PREFIX_COLON')
  pos+=1
  while text[pos].isspace():pos+=1
  if key=='events':raise RuntimeError('CONNECTIONS_NOT_IN_PREFIX')
  value,pos=decoder.raw_decode(text,pos)
  if key=='connections':
   c=value.get('prematch',{});i=c.get('ingressProgress') or {}
   return {'phase':c.get('phase'),'session':c.get('session'),'consumerProgress':c.get('consumerProgress'),'ingress':{k:i.get(k) for k in ('received','acknowledged','processed','checkpointed','backlog','bytes','intakePaused','lastReceiveAt','lastAckAt','metricWindowStartUTC','metricWindowEndUTC')},'evidenceIsPersistedMetadataNotLiveActor':True}
 raise RuntimeError('CONNECTIONS_PREFIX_MISSING')

def transport(raw):
 wanted={'inbox.intake_capacity','inbox.actor_failure','inbox.actor_lifecycle','inbox.processing_progress','inbox.checkpoint','amqp.connection','distribution.status','distribution.recovery_gate','worker.start'}
 rows=[]
 for line in raw.splitlines():
  try:at,body=line.split(' ',1);r=json.loads(body)
  except (ValueError,TypeError):continue
  if not isinstance(r,dict) or r.get('lane')!='prematch' or r.get('operation') not in wanted:continue
  if not re.fullmatch(r'\d{4}-\d\d-\d\dT[0-9:.]+Z',at):continue
  out={'atUTC':at}
  for k in ('operation','stage','status','reason','ingressStage','sessionId','ingressActorId','batchId','networkCode','errorType'):
   v=r.get(k)
   if isinstance(v,str) and re.fullmatch('[A-Za-z0-9_.-]{1,120}',v):out[k]=v
  for k in ('bytes','rows','publicationId','timeoutMs','elapsedMs','errorCode','waitedMs','workerEventLoopMaxMs'):
   if type(r.get(k)) in (int,float):out[k]=r[k]
  if isinstance(r.get('ingress'),dict):out['ingress']={k:v for k,v in r['ingress'].items() if k in ('received','acknowledged','processed','checkpointed','backlog','processingBacklog','oldestProcessingAgeMs','metricWindowStartUTC','metricWindowEndUTC')}
  rows.append(out)
 return {'recentProgress':[r for r in rows if r['operation']=='inbox.processing_progress'][-8:],'capacityEvents':[r for r in rows if r['operation']=='inbox.intake_capacity'][-12:],'lifecycleAndErrors':[r for r in rows if r['operation'] not in ('inbox.processing_progress','inbox.checkpoint','inbox.intake_capacity')][-24:],'checkpoints':[r for r in rows if r['operation']=='inbox.checkpoint'][-12:],'emptyCapacityEventsDoNotProveUnpaused':True}

def main():
 if not protected(RECEIPT) or BACKUP.is_symlink() or not BACKUP.is_dir() or BACKUP.stat().st_uid!=os.geteuid() or BACKUP.stat().st_mode&0o077:raise RuntimeError('PINNED_PREPARATION_NOT_PROTECTED')
 receipt=json.loads(RECEIPT.read_bytes());c=json.loads(run(['docker','inspect','adl-homologation-worker-1']))[0]
 if receipt.get('backup')!=str(BACKUP) or receipt.get('image')!=IMAGE or receipt.get('phase')!='prepared':raise RuntimeError('PREPARATION_PHASE_OR_IDENTITY_CHANGED_NO_ACTION')
 if c['Id']!=CID or c['Image']!='sha256:2290a217604632cc4340e3444e0b0beda38805e2c165832648024cbe3472a789' or not c['State']['Running'] or c['State']['OOMKilled']:raise RuntimeError('ORIGINAL_RUNNING_CONTAINER_CHANGED_NO_ACTION')
 candidate=json.loads(run(['docker','image','inspect',IMAGE]))[0]
 if (candidate['Config'].get('Labels') or {}).get('eu.adl.partitioned.patch')!=receipt.get('digest'):raise RuntimeError('PREPARED_IMAGE_DIGEST_MISMATCH')
 print(json.dumps({'stage':'prepared_identity','backup':str(BACKUP),'receipt':str(RECEIPT),'preparedImage':IMAGE,'preparedImageId':candidate['Id'],'phase':receipt['phase'],'currentContainerId':c['Id'],'currentImage':c['Config']['Image'],'currentImageId':c['Image'],'running':True,'startedAtUTC':c['State']['StartedAt'],'signalsSent':0}),flush=True)
 mounts=[m for m in c['Mounts'] if m.get('Destination')=='/app/.runtime/feed' and m.get('Type')=='volume']
 if len(mounts)!=1:raise RuntimeError('FEED_VOLUME_MOUNT_UNVERIFIED')
 try:print(json.dumps({'stage':'persisted_transport_flags',**connection_metadata(Path(mounts[0]['Source'])/'trade-feed.json')}),flush=True)
 except Exception as e:print(json.dumps({'stage':'persisted_transport_flags','status':'unavailable','exceptionType':type(e).__name__}),flush=True)
 files=inputs(Path(mounts[0]['Source']));total=sum(r['logicalBytes'] for r in files);free=shutil.disk_usage(BACKUP).free;required=total*10+4*1024**3
 fs=json.loads(run(['findmnt','--json','--bytes','--target',str(BACKUP),'--output','SOURCE,TARGET,FSTYPE,SIZE,AVAIL']))
 devices=json.loads(run(['lsblk','--json','--bytes','--output','NAME,SIZE,TYPE,PKNAME,SERIAL,MOUNTPOINTS']))
 print(json.dumps({'stage':'storage_action',**storage_action(fs,devices,free,required)}),flush=True)
 print(json.dumps({'stage':'exact_storage_inputs','freeDiskBytes':free,'requiredFreeBytes':required,'missingBytes':max(0,required-free),'inputBytes':total,'formula':'10 * current logical input bytes + 4 GiB; conservative reserve, not measured peak','filesystem':fs,'devices':devices,'files':files,'capacityIncreaseNotYetProvenNecessaryByMeasuredPeak':True}),flush=True)
 allocated=[];began=time.monotonic();count=0
 for folder in sorted(Path('/var/backups').glob('adl-partitioned-upgrade-*')):
  if folder.is_symlink() or not folder.is_dir():continue
  buckets={};logical=0
  for root,dirs,names in os.walk(folder,followlinks=False):
   dirs[:]=[d for d in dirs if not(Path(root)/d).is_symlink()]
   for name in names:
    p=Path(root)/name;st=p.lstat()
    if p.is_symlink():continue
    part=p.relative_to(folder).parts[0];buckets[part]=buckets.get(part,0)+st.st_blocks*512;logical+=st.st_size;count+=1
    if count>100000 or time.monotonic()-began>20:raise RuntimeError('BACKUP_METADATA_WALK_BOUNDED_LIMIT')
  allocated.append({'path':str(folder),'allocatedBytes':sum(buckets.values()),'logicalBytes':logical,'groups':[{'name':k,'allocatedBytes':v} for k,v in buckets.items() if v>=1024**2],'deletionAuthorized':False})
 print(json.dumps({'stage':'preserved_copy_allocation','backups':allocated,'note':'Metadata only; existence, age or tmp suffix does not authorize deletion.'}),flush=True)
 # Docker logs can use stderr; capture both streams for the structured filter.
 r=subprocess.run(['docker','logs','--timestamps','--since','2026-10-24T03:20:00Z','--tail','3000',CID],capture_output=True,text=True,timeout=25)
 if r.returncode:raise RuntimeError('TRANSPORT_LOG_READ_FAILED')
 raw=r.stdout+'\n'+r.stderr
 if len(raw)>8*1024**2:raise RuntimeError('TRANSPORT_LOG_WINDOW_LIMIT')
 print(json.dumps({'stage':'current_transport_condition',**transport(raw),'providerRequests':0,'logsMayBeTruncated':len(raw.splitlines())>=3000}),flush=True)
 print(json.dumps({'stage':'complete','readOnly':True,'signalsSent':0,'workerRestarted':False,'providerRequests':0,'integrationVerified':False}),flush=True)
if __name__=='__main__':
 try:main()
 except Exception as e:
  print(json.dumps({'stage':'targeted_pre_stop_inspection','status':'blocked','reason':str(e) if isinstance(e,RuntimeError) else 'BOUNDED_INSPECTION_FAILED','exceptionType':type(e).__name__,'signalsSent':0}),flush=True);raise SystemExit(2)
