import ast,contextlib,copy,datetime,hashlib,io,json,os,subprocess,tempfile,types,unittest
from pathlib import Path
HERE=Path(__file__).parent
NS={'__name__':'tested'}
for name in ('resume-adl-api.py','repair-adl-snapshot.py','upgrade-partitioned-worker.py','execute-adl-cutover-aws.py'):exec((HERE/name).read_text().split("if __name__=='__main__':")[0],NS)
class Upgrade(unittest.TestCase):
 def test_v8_compaction_plan_preserves_existing_six_gib_container_and_heap(self):
  progress={'memoryLimitBytes':6442450944,'snapshotMemoryRepair':True,'v8HeapOomRepair':True,'heapBudgetPlan':{'evidenceVerified':True,'v8HeapCompactionPreserve':True,'previousOldSpaceMiB':4608,'oldSpaceMiB':4608,'containerLimitUnchanged':True,'measuredRedundantTimestampBytes':319*1024*1024}}
  self.assertEqual(NS['partition_memory'](progress),6442450944);self.assertEqual(NS['partition_heap_mib'](progress),4608)
  for changed in ({'oldSpaceMiB':4096},{'containerLimitUnchanged':False},{'measuredRedundantTimestampBytes':1}):
   bad={**progress,'heapBudgetPlan':{**progress['heapBudgetPlan'],**changed}}
   with self.assertRaises(Exception):NS['partition_heap_mib'](bad)
  with self.assertRaises(Exception):NS['partition_memory']({**progress,'v8HeapOomRepair':False})

 def test_v8_oom_lock_archive_preserves_owner_bytes_only_for_exact_verified_container(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);directory=root/'feed';backup=root/'backup';directory.mkdir();backup.mkdir();lock=directory/'trade-feed.json.lock';lock.write_bytes(b'1234')
   worker={'id':'05e3b610fa1b'+'a'*52,'name':'/adl-homologation-worker-1','running':False,'exitCode':134,'oomKilled':False};progress={'oomContainerId':worker['id'],'v8HeapOomRepair':True,'expectedOomPrefix':'05e3b610fa1b'}
   old_run,old_states,old_subprocess=NS['run'],NS['states'],NS['subprocess'].run
   try:
    NS['run']=lambda *a,**k:b'';NS['states']=lambda service:[worker]
    NS['subprocess'].run=lambda *a,**k:types.SimpleNamespace(returncode=0,stdout=b'Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory',stderr=b'')
    NS['archive_oom_locks'](directory,backup,progress,[worker])
   finally:NS['run'],NS['states'],NS['subprocess'].run=old_run,old_states,old_subprocess
   self.assertFalse(lock.exists());self.assertEqual((backup/'oom-preserved-trade-feed.json.lock').read_bytes(),b'1234');self.assertEqual((backup/'oom-archived-trade-feed.json.lock').read_bytes(),b'1234')
   bad={**worker,'id':'f'*64}
   with self.assertRaises(Exception):NS['archive_oom_locks'](directory,backup,progress,[bad])

 def test_v8_rehearsal_disk_budget_uses_measured_projection_and_checkpoint_with_growth_reserve(self):
  with tempfile.TemporaryDirectory() as tmp:
   backup=Path(tmp);public=backup/'trade-feed.json';regular=backup/'trade-feed.json.regular-checkpoint.json';public.write_bytes(b'p'*100);regular.write_bytes(b'r'*200)
   dst=backup/'rehearsal'/'trade-feed.json';src=public;progress={'v8HeapOomRepair':True};calls=[]
   old={k:NS.get(k) for k in ('run','shutil','oom_restore_log_summary','write_recovery_attempt_report')}
   def run(args,**kwargs):
    if args[0]=='findmnt':return json.dumps({'filesystems':[{'source':'/dev/nvme0n1p1','target':'/','fstype':'ext4','size':100000000000,'avail':30000000000}]}).encode()
    if args[0]=='lsblk':return json.dumps({'blockdevices':[{'name':'nvme0n1','type':'disk','size':'107374182400','children':[{'name':'nvme0n1p1','type':'part','size':'100000000000'}]}]}).encode()
    raise AssertionError(args[0])
   try:
    NS.update(run=run,shutil=types.SimpleNamespace(**{**NS['shutil'].__dict__,'disk_usage':lambda _:types.SimpleNamespace(total=100000000000,free=30000000000)}),oom_restore_log_summary=lambda _: {'signals':[]},write_recovery_attempt_report=lambda path,data:Path(path))
    output=io.StringIO()
    with contextlib.redirect_stdout(output):NS['offline_rehearsal_disk_plan'](backup,[(src,dst,'0'*64)],progress,'a'*64)
    row=json.loads(output.getvalue())
   finally:
    for key,value in old.items():NS[key]=value
   measured=public.stat().st_size+regular.stat().st_size
   self.assertEqual(row['outputReserveBytes'],measured*2);self.assertIn('equal growth reserve',row['budgetBasis']);self.assertEqual(row['copyMissingBytes'],100);self.assertEqual(row['status'],'verified')

 def test_v8_heap_oom_repair_requires_exact_stopped_container_and_log_signature(self):
  request={'snapshotMemoryRepair':True,'v8HeapOomRepair':True,'expectedOomPrefix':'05e3b610fa1b'}
  worker={'oomKilled':False,'exitCode':134,'running':False,'name':'/adl-homologation-worker-1','id':'05e3b610fa1b'+'a'*52}
  original=NS['subprocess'].run
  try:
   NS['subprocess'].run=lambda *a,**k:types.SimpleNamespace(returncode=0,stdout=b'Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory',stderr=b'')
   NS['verify_live_v8_heap_oom_identity'](worker,request)
   for changed in ({'running':True},{'oomKilled':True},{'name':'/adl-homologation-api-1'},{'id':'b'*64},{'exitCode':137}):
    with self.assertRaises(Exception):NS['verify_live_v8_heap_oom_identity']({**worker,**changed},request)
   NS['subprocess'].run=lambda *a,**k:types.SimpleNamespace(returncode=0,stdout=b'JavaScript heap out of memory',stderr=b'')
   with self.assertRaises(Exception):NS['verify_live_v8_heap_oom_identity'](worker,request)
   NS['subprocess'].run=lambda *a,**k:types.SimpleNamespace(returncode=1,stdout=b'',stderr=b'')
   with self.assertRaises(Exception):NS['verify_live_v8_heap_oom_identity'](worker,request)
  finally:NS['subprocess'].run=original
  NS['verify_stopped_upgrade_worker']({**worker,'exitCode':0},{'snapshotMemoryRepair':True},'blocked')
  with self.assertRaises(Exception):NS['verify_stopped_upgrade_worker']({**worker,'exitCode':137},{'snapshotMemoryRepair':True,'expectedOomPrefix':request['expectedOomPrefix']},'blocked')

 def test_live_oom_repair_rejects_identity_and_source_scope_changes(self):
  request={'snapshotMemoryRepair':True,'expectedOomPrefix':'7f43cb2939c7'}
  worker={'oomKilled':True,'exitCode':137,'running':False,'name':'/adl-homologation-worker-1','id':'7f43cb2939c7'+'a'*52}
  NS['verify_live_oom_identity'](worker,request)
  for changed in ({'running':True},{'oomKilled':False},{'name':'/adl-homologation-api-1'},{'id':'b'*64},{'exitCode':1}):
   with self.assertRaises(Exception):NS['verify_live_oom_identity']({**worker,**changed},request)
  old={name:'original' for name in NS['PARTITION_FILES']};legacy={name:value for name,value in old.items() if name!='apps/worker/src/timestamp-recovery.ts'};digest=hashlib.sha256(json.dumps(legacy,sort_keys=True,separators=(',',':')).encode()).hexdigest()
  new={**old,'apps/worker/src/state.ts':'bounded','apps/worker/src/timestamp-recovery.ts':'derived timestamp'}
  NS['verify_live_oom_sources'](old,new,digest)
  for candidate,source_hash in ((old,digest),({**new,'apps/worker/src/messages.ts':'unexpected'},digest),(new,'0'*64)):
   with self.assertRaises(Exception):NS['verify_live_oom_sources'](old,candidate,source_hash)
 def test_live_persistence_identity_requires_exact_running_worker_image(self):
  image='adl-worker-partitioned:'+'a'*24;worker={'running':True,'oomKilled':False,'name':'/adl-homologation-worker-1'};request={'snapshotMemoryRepair':True,'expectedLiveImage':image}
  NS['verify_live_persistence_identity'](worker,request,image)
  for changed in ({'running':False},{'oomKilled':True},{'name':'/api'}):
   with self.assertRaises(Exception):NS['verify_live_persistence_identity']({**worker,**changed},request,image)
  with self.assertRaises(Exception):NS['verify_live_persistence_identity'](worker,request,image+'b')
 def test_persistence_mismatch_identifies_comparison_without_secrets(self):
  image='adl-worker-partitioned:'+'a'*24;request={'snapshotMemoryRepair':True,'expectedLiveImage':image};worker={'running':True,'oomKilled':False,'name':'/adl-homologation-worker-1'}
  output=io.StringIO()
  with contextlib.redirect_stdout(output):
   with self.assertRaises(Exception):NS['verify_live_persistence_identity'](worker,request,'PRIVATE_DO_NOT_PRINT')
  record=json.loads(output.getvalue());self.assertEqual(record['failedChecks'],['imageReferenceMatches']);self.assertEqual(record['expectedImage'],image);self.assertEqual(record['composeImage'],'unverified_reference');self.assertNotIn('PRIVATE_DO_NOT_PRINT',output.getvalue())
 def test_shutdown_observer_progress_then_exit_never_sends_signals(self):
  clock=[0];saved=[];count=[0]
  def sample():
   count[0]+=1;return {'running':count[0]<3,'files':[{'bytes':count[0]}],'records':[]}
  result=NS['watch_upgrade_stop'](sample,saved.append,now=lambda:clock[0],sleep=lambda sec:clock.__setitem__(0,clock[0]+sec))
  self.assertEqual(len(result),3);self.assertEqual(result[-1]['assessment'],'exited');self.assertTrue(result[1]['progressSincePreviousSample']);self.assertTrue(all(r['forceStopEvidenceVerified'] is False for r in saved))
 def test_shutdown_no_evidence_is_not_called_a_proven_deadlock(self):
  clock=[0];saved=[]
  with self.assertRaisesRegex(RuntimeError,'UPGRADE_STOP_NO_OBSERVABLE_PROGRESS_NO_MORE_SIGNALS'):
   NS['watch_upgrade_stop'](lambda:{'running':True,'files':[],'records':[]},saved.append,now=lambda:clock[0],sleep=lambda sec:clock.__setitem__(0,clock[0]+sec))
  self.assertEqual(clock[0],90);self.assertIn('does not prove a deadlock',saved[-1]['note']);self.assertFalse(saved[-1]['forceStopEvidenceVerified'])
 def test_shutdown_progress_has_a_finite_deadline(self):
  clock=[0];saved=[]
  with self.assertRaisesRegex(RuntimeError,'UPGRADE_STOP_OBSERVATION_DEADLINE_NO_MORE_SIGNALS'):
   NS['watch_upgrade_stop'](lambda:{'running':True,'files':[{'bytes':clock[0]}]},saved.append,timeout=30,now=lambda:clock[0],sleep=lambda sec:clock.__setitem__(0,clock[0]+sec))
  self.assertEqual(clock[0],30)
 def test_readback_failure_resumes_without_repeating_serialization(self):
  self.test_prepare_activate_reuse_preserves_every_non_worker_field(oom=True,readback_fails=True)
 def test_pipeline_proof_revision_gets_immutable_content_addressed_backup(self):
  first='synthetic proof revision one';second='synthetic proof revision two'
  with tempfile.TemporaryDirectory() as tmp:
   backup=Path(tmp);backup.chmod(0o700)
   for check in (first,second):
    revision=NS['pipeline_proof_revision'](check);name='pipeline-load-proof-'+revision[:16]+'.mjs'
    NS['durable_ingress_proof_command'](backup,'existing-image',check,name)
   files=sorted(p.name for p in backup.iterdir())
   self.assertEqual(len(files),2)
   self.assertEqual((backup/files[0]).read_text(),first if NS['pipeline_proof_revision'](first)[:16] in files[0] else second)
   self.assertEqual((backup/files[1]).read_text(),first if NS['pipeline_proof_revision'](first)[:16] in files[1] else second)
  self.assertNotEqual(NS['pipeline_proof_revision'](first),NS['pipeline_proof_revision'](second))
 @unittest.skipUnless(os.environ.get('ADL_OFFLINE_PROOF_IMAGE'),'opt-in isolated Docker proof')
 def test_real_docker_proof_and_both_previous_harness_failures(self):
  image=os.environ['ADL_OFFLINE_PROOF_IMAGE'];repo=HERE.resolve().parents[1]
  check=next(n.value.value for n in ast.walk(ast.parse((HERE/'upgrade-partitioned-worker.py').read_text())) if isinstance(n,ast.Assign) and isinstance(n.value,ast.Constant) and isinstance(n.value.value,str) and 'durable-ingress-offline-ok' in n.value.value)
  with tempfile.TemporaryDirectory() as tmp:
   backup=Path(tmp);backup.chmod(0o700);args=NS['durable_ingress_proof_command'](backup,image,check)
   args[2:2]=['--mount','type=bind,source='+str(repo)+',target=/app,readonly']
   result=subprocess.run(args,capture_output=True,timeout=45);self.assertEqual(result.returncode,0);self.assertIn(b'durable-ingress-offline-ok',result.stdout)
   small=[v.replace('268435456','67108864') for v in args]
   result=subprocess.run(small,capture_output=True,timeout=45);self.assertNotEqual(result.returncode,0);self.assertIn(b'not durable ahead of processing',result.stderr)
   inherited=args[:-1]+['--input-type=module','-e',check]
   result=subprocess.run(inherited,capture_output=True,timeout=45);self.assertNotEqual(result.returncode,0);self.assertIn(b'ERR_INPUT_TYPE_NOT_ALLOWED',result.stderr)
 def test_durable_proof_uses_file_entry_and_sufficient_bounded_disk(self):
  with tempfile.TemporaryDirectory() as tmp:
   backup=Path(tmp);backup.chmod(0o700)
   args=NS['durable_ingress_proof_command'](backup,'existing-image','console.log(1)')
   self.assertNotIn('--input-type=module',args);self.assertEqual(args[-2:],['existing-image','/offline-proof.mjs'])
   self.assertIn('/tmp:size=268435456,mode=1777',args);self.assertIn('none',args);self.assertIn('512m',args)
   self.assertEqual(args,NS['durable_ingress_proof_command'](backup,'existing-image','console.log(1)'))
   with self.assertRaises(Exception):NS['durable_ingress_proof_command'](backup,'existing-image','changed')
   log=backup/'durable-ingress-test.private.log';log.write_bytes(b'PRIVATE_SECRET ERR_INPUT_TYPE_NOT_ALLOWED INBOX_CAPACITY_EXCEEDED')
   summary=NS['durable_ingress_log_summary'](backup)
   self.assertEqual(summary['signals'],['worker_inherited_input_type','inbox_disk_reserve_unavailable']);self.assertNotIn('PRIVATE_SECRET',json.dumps(summary))
 def test_prepare_activate_reuse_preserves_every_non_worker_field(self,resume_stopped=False,distribution=False,full=False,supplier=False,nullable=False,throughput=False,spool=False,parser=False,durable=False,oom=False,read_access_fails=False,readback_fails=False):
  readback_attempts=2 if readback_fails else 1
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);secure=root/'secure';secure.mkdir();backups=root/'backups';backups.mkdir();releases=root/'releases';release=releases/('a'*40);release.mkdir(parents=True);volume=root/'volume';volume.mkdir()
   evidence=backups/'adl-snapshot-shape-example';evidence.mkdir(mode=0o700);raw=json.dumps({'FixtureId':20563979,'Fixture':{'Status':1},'Markets':None}).encode();(evidence/'rejected-row.private.json').write_bytes(raw);(evidence/'rejected-row.private.json').chmod(0o600);(evidence/'report.json').write_text(json.dumps({'rawRowSha256':hashlib.sha256(raw).hexdigest(),'rawRowBytes':len(raw),'rejection':{'path':'Markets','actualType':'null'},'sdk':{'conversion':'succeeded','markets':{'type':'null'}}}));(evidence/'report.json').chmod(0o600)
   original=secure/'old.json';original.write_text('{}');meta={'release':str(release),'composeOverrides':[str(original)]};(secure/'deployment.json').write_text(json.dumps(meta))
   (volume/'trade-feed.json').write_text('{"preserved":"checkpoint"}');journal=volume/'trade-feed.json.snapshot-aaaaaaaaaaaaaaaa.json';journal.write_text('{"nextAt":9999999999999,"due":{},"failures":{}}');journal_before=journal.read_bytes();regular=volume/'trade-feed.json.regular-checkpoint.json';regular.write_text('PRIVATE_REGULAR_PRESERVED');regular_before=regular.read_bytes()
   handoff={'audit':{'status':'ok','workerLockAbsent':True,'matchingWorkerProcesses':0}};d=hashlib.sha256(json.dumps(handoff,sort_keys=True,separators=(',',':')).encode()).hexdigest();migration=secure/('cutover-'+d+'.json');migration.write_text(json.dumps({'digest':d,'startRequestedAtUTC':'2026-01-01T00:00:00Z','notBeforeUTC':'2026-01-01T00:00:00Z','journals':['preserved']}))
   files={path:'export const isolated=true;' for path in NS['PARTITION_FILES']};hashes={path:None for path in files};digest=hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest();image='adl-worker-partitioned:'+digest[:24]
   images={'base':{'Id':'sha256:'+('b'*64),'Config':{'User':'node','Labels':{}}}};running=not oom;selected='base';calls=[]
   def model(args):
    result={'services':{'api':{'image':'api-unchanged'},'worker':{'image':'base','mem_limit':'4294967296','environment':{'NODE_OPTIONS':'--max-old-space-size=3072','LSPORTS_PASSWORD':'MUST_NEVER_PRINT','LSPORTS_INPLAY_SNAPSHOT_MAX_RESPONSE_MB':'128'}}},'networks':{'preserved':{}},'volumes':{'preserved':{}}}
    for arg in args:
     if str(arg).startswith(str(secure/'compose.partitioned-')) or str(arg).startswith(str(secure/'compose.worker-rollback-')):patch=json.loads(Path(arg).read_bytes())['services']['worker'];result['services']['worker']['image']=patch['image'];result['services']['worker']['environment'].update(patch.get('environment',{}))
    return result
   def states(service):return [{'id':'old-worker' if selected=='base' else 'new-worker','running':running,**({'exitCode':137,'oomKilled':True} if oom and not running and selected=='base' else {})}] if service=='worker' else [{'id':'api','health':'healthy'}]
   def run(args,**kw):
    nonlocal running,selected
    calls.append(args)
    if args[:3]==['docker','image','inspect']:return json.dumps([images[args[3]]]).encode()
    if args[:2]==['docker','tag']:images[args[3]]=images['base'];return b''
    if args[:2]==['docker','run'] and any('process.getuid()' in str(a) for a in args):return json.dumps({'uid':os.getuid() or 1000,'gid':os.getgid() or 1000,'groups':[os.getgid() or 1000],'opened':not read_access_fails,'readBytes':0 if read_access_fails else 1,'code':'EACCES' if read_access_fails else None,'chain':[]}).encode()
    if args[:2]==['docker','run'] and readback_fails and any('verifyProjectionFile' in str(v) for v in args):raise subprocess.CalledProcessError(1,args)
    if args[:2]==['docker','run'] and any('projection-serialize-ok' in str(v) for v in args):
     target=next(v for v in args if 'target=/output' in str(v));folder=Path(target.split('source=')[1].split(',target=')[0]);(folder/'receipt.json').write_text('{}');return b'projection-serialize-ok'
    if args[:2]==['docker','run']:return b'partitioned-offline-ok distribution-propagation-offline-ok full-recovery-offline-ok supplier-order-offline-ok nullable-markets-offline-ok throughput-offline-ok spool-memory-offline-ok snapshot-throughput-offline-ok planned-distribution-stop-ok durable-ingress-offline-ok snapshot-memory-offline-ok oom-checkpoint-restore-ok' if '--input-type=module' in args or any(str(a).endswith('-proof.mjs') for a in args) else json.dumps(hashes).encode()
    if args[:2]==['docker','build']:images[image]={'Id':'sha256:'+('c'*64),'Config':{'User':'node','Labels':{'eu.adl.partitioned.patch':digest}}};return b''
    if args[:2]==['docker','inspect']:
     return json.dumps([{'Image':images[selected]['Id'],'HostConfig':{'Memory':4294967296,'RestartPolicy':{'Name':'no'}},'Config':{'Env':['LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT=true','LSPORTS_INPLAY_STREAMED_SNAPSHOT=true',*(['NODE_OPTIONS=--max-old-space-size=2560'] if oom and selected==image else [])]},'Mounts':[{'Destination':'/app/.runtime/feed','Type':'volume','RW':False,'Name':'feed'}]}]).encode()
    if args[:3]==['docker','volume','inspect']:return json.dumps([{'Mountpoint':str(volume),'Labels':{'com.docker.compose.project':'adl-homologation'}}]).encode()
    if args[:2]==['docker','kill']:running=False;return b''
    if 'up' in args:running=True;selected=image;return b''
    if 'create' in args:running=False;selected='base';return b''
    raise AssertionError('Unexpected operation')
   keys=('SECURE','BACKUPS','RELEASES','run','model','states','control_status','snapshot_host_memory','shutil','os','verify_oom_inboxes','archive_oom_locks','oom_restore_log_summary','offline_rehearsal_disk_plan','streamed_rehearsal_run');old={k:NS.get(k) for k in keys}
   NS.update(streamed_rehearsal_run=run,offline_rehearsal_disk_plan=lambda *args:None,oom_restore_log_summary=lambda backup:{'present':False},verify_oom_inboxes=lambda directory:[{'lane':'prematch','pendingRows':13526}],archive_oom_locks=lambda *args:None,SECURE=secure,BACKUPS=backups,RELEASES=releases,run=run,model=model,states=states,control_status=lambda:200,snapshot_host_memory=lambda:12*1024**3,shutil=types.SimpleNamespace(**{**NS['shutil'].__dict__,'disk_usage':lambda _:types.SimpleNamespace(free=10*1024**3)}),os=types.SimpleNamespace(**{**os.__dict__,'geteuid':lambda:0}))
   def invoke(phase,base_hashes=hashes,verify_only=False):
    out=io.StringIO();request={'phase':phase,'files':files,'baseHashes':base_hashes,'handoff':handoff,'freshAuditAt':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')}
    if distribution:request['fixCommit']='2aa06f7'
    if full:request['fullRecovery']=True
    if supplier:request['supplierOrder']=True
    if nullable:request['nullableEvidence']=str(evidence)
    if throughput:request['throughputFix']=True
    if spool:request['spoolMemoryFix']=True
    if parser:request['snapshotThroughputFix']=True
    if durable:request['durableIngress']=True
    if oom:request['snapshotMemoryRepair']=True
    if verify_only:request['verifyOnly']=True
    with contextlib.redirect_stdout(out):code=NS['upgrade_partitioned'](request)
    self.assertNotIn('MUST_NEVER_PRINT',out.getvalue());return code,json.loads(out.getvalue().splitlines()[-1])
   try:
    code,result=invoke('prepare',{**hashes,next(iter(hashes)):'bad'});self.assertEqual(code,2);self.assertEqual(result['reason'],'UPGRADE_BASE_SOURCES_CHANGED_NO_BLIND_PATCH');self.assertFalse(any('up' in c or c[:2]==['docker','kill'] for c in calls))
    if nullable:
     proof=(evidence/'report.json').read_bytes();bad=json.loads(proof);bad['rawRowSha256']='0'*64;(evidence/'report.json').write_text(json.dumps(bad));code,result=invoke('prepare');self.assertEqual(code,2);self.assertEqual(result['reason'],'CAPTURED_EVIDENCE_HASH_MISMATCH');self.assertEqual(running,not oom);self.assertFalse(any(c[:2]==['docker','kill'] for c in calls));(evidence/'report.json').write_bytes(proof)
    code,result=invoke('prepare');self.assertEqual(code,0,result);self.assertTrue(result['offlineType38Verified']);self.assertEqual(result['offlineDurableIngressVerified'],durable);self.assertEqual(result['offlineFullRecoveryVerified'],full);self.assertEqual(result['offlinePropagationVerified'],distribution);self.assertEqual(result['offlineSupplierOrderVerified'],supplier);self.assertEqual(result['offlineNullableMarketsVerified'],nullable);self.assertEqual(result['offlineThroughputVerified'],throughput);self.assertEqual(result['offlineSpoolMemoryVerified'],spool);self.assertEqual(result['offlineSnapshotThroughputVerified'],parser);self.assertEqual(running,not oom);self.assertFalse(any('up' in c or c[:2]==['docker','kill'] for c in calls))
    if supplier:
     rollback=Path(result['backup'])/'rollback.worker.private.json';self.assertEqual(rollback.stat().st_mode&0o777,0o600);self.assertEqual(set(json.loads(rollback.read_bytes())['services']),{'worker'})
    if resume_stopped:
     progress_file=next(secure.glob('partitioned-upgrade-*.json'));progress=json.loads(progress_file.read_bytes());progress['phase']='stop_requested';progress['oldContainer']='old-worker';progress_file.write_text(json.dumps(progress));running=False
    if oom:
     if readback_fails:
      code,failed=invoke('activate',verify_only=True);self.assertEqual(code,2);self.assertEqual(failed['stage'],'partitioned_upgrade.projection_readback');self.assertFalse(running);self.assertIn('offlineRehearsal',failed);readback_fails=False
     code,verified=invoke('activate',verify_only=True)
     if read_access_fails:
      self.assertEqual(code,2);self.assertEqual(verified['reason'],'REHEARSAL_READ_ACCESS_NOT_VERIFIED_NO_START');self.assertFalse(any('oom-checkpoint-restore-ok' in str(a) for c in calls for a in c));self.assertFalse(any('up' in c for c in calls));return
     self.assertEqual(code,0,verified);self.assertTrue(verified['offlineRestoreVerified']);self.assertFalse(running);self.assertFalse(any('up' in c for c in calls));self.assertEqual(len([c for c in calls if any('oom-checkpoint-restore-ok' in str(a) for a in c)]),readback_attempts)
    code,result=invoke('activate');self.assertEqual(code,0,result);self.assertTrue(running);self.assertEqual(selected,image);
    if oom:self.assertEqual(len([c for c in calls if any('oom-checkpoint-restore-ok' in str(a) for a in c)]),readback_attempts)
    self.assertEqual(journal.read_bytes(),journal_before);self.assertEqual(regular.read_bytes(),regular_before);self.assertEqual((Path(result['backup'])/regular.name).read_bytes(),regular_before)
    if full and not oom:
     stop=next(i for i,c in enumerate(calls) if c[:2]==['docker','run'] and any('planned-distribution-stop-ok' in str(x) for x in c))
     term=next(i for i,c in enumerate(calls) if c[:2]==['docker','kill']);self.assertLess(stop,term)
    self.assertEqual(len([c for c in calls if c[:2]==['docker','kill']]),0 if resume_stopped or oom else 1);self.assertEqual(len([c for c in calls if 'up' in c]),1)
    after=json.loads((secure/'deployment.json').read_bytes());self.assertEqual(after['composeOverrides'][0],str(original));self.assertEqual(len(after['composeOverrides']),2)
    activated_model=model(NS['partition_base'](after));self.assertEqual(activated_model['services']['worker']['environment']['LSPORTS_INPLAY_SNAPSHOT_MAX_RESPONSE_MB'],'128');self.assertEqual(activated_model['services']['worker']['environment']['LSPORTS_INPLAY_STREAMED_SNAPSHOT'],'true');self.assertEqual(activated_model['services']['worker']['environment']['LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT'],'true');self.assertEqual(json.loads(migration.read_bytes())['journals'],['preserved'])
    code,result=invoke('prepare');self.assertEqual(code,0,result);code,result=invoke('activate');self.assertEqual(code,0,result);self.assertTrue(result['reused']);
    if oom:
     rehearsal_calls=[c for c in calls if c[:2]==['docker','run'] and any('projection-serialize-ok' in str(v) for v in c)]
     self.assertEqual(len(rehearsal_calls),1)
     read_calls=[c for c in calls if c[:2]==['docker','run'] and any('process.getuid()' in str(a) for a in c)]
     self.assertEqual(len(read_calls),2*readback_attempts)
     prefix=rehearsal_calls[0][:rehearsal_calls[0].index('--max-old-space-size=2560')]
     out_index=next(i for i,v in enumerate(prefix) if 'target=/output' in v)
     self.assertEqual(prefix[out_index-1],'--mount');del prefix[out_index-1:out_index+1]
     self.assertEqual(read_calls[-1][:-2],prefix)
     readbacks=[c for c in calls if c[:2]==['docker','run'] and any('verifyProjectionFile' in str(v) for v in c)]
     self.assertEqual(len(readbacks),readback_attempts);self.assertTrue(any('target=/output,readonly' in str(v) for v in readbacks[0]))
     self.assertFalse(any('const s=new TradeState' in str(v) for v in readbacks[0]))
     self.assertEqual(read_calls[-1][read_calls[-1].index('--user')+1],'node')
     self.assertTrue(any('rehearsal-'+digest[:24]+',target=/recovery,readonly' in str(v) for v in rehearsal_calls[0]))
     self.assertEqual((Path(json.loads((secure/('partitioned-upgrade-'+digest[:24]+'.json')).read_bytes())['backup'])/('rehearsal-'+digest[:24])/'trade-feed.json').read_bytes(),(volume/'trade-feed.json').read_bytes())
     code,verified=invoke('activate',verify_only=True);self.assertEqual(code,0,verified);self.assertTrue(verified['offlineRestoreVerified'])
    self.assertEqual(len([c for c in calls if 'up' in c]),1);self.assertEqual(len([c for c in calls if c[:2]==['docker','build']]),1)
    self.assertTrue(all(c[-1]=='worker' and '--no-deps' in c and '--pull' in c for c in calls if 'up' in c))
    if supplier:
     code,result=invoke('rollback');self.assertEqual(code,0,result);self.assertFalse(running);self.assertEqual(selected,'base');self.assertTrue(result['oldWorkerKeptStopped']);self.assertEqual(journal.read_bytes(),journal_before);self.assertTrue(all(c[-1]=='worker' and '--no-deps' in c for c in calls if 'create' in c));code,result=invoke('rollback');self.assertEqual(code,0,result);self.assertTrue(result['reused']);self.assertEqual(len([c for c in calls if 'create' in c]),1)
   finally:NS.update(old)
 def test_checkpoint_parser_derives_prepared_image_reuses_stop_and_immutable_backup(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);secure=root/'secure';secure.mkdir();backups=root/'backups';backups.mkdir();backup=backups/'adl-partitioned-upgrade-test';backup.mkdir(mode=0o700)
   files={name:'old source' for name in NS['PARTITION_FILES']};old_digest=hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest()
   for name,source in files.items():
    fp=backup/'context'/'overlay'/name;fp.parent.mkdir(parents=True,exist_ok=True);fp.write_text('older original context, not prepared leaf')
   proof={'backup':str(backup),'digest':old_digest,'phase':'stopped','image':'prepared-image','checkpointParserSourceDigest':'f'*64,'rehearsalDirectory':'rehearsal-'+'d'*24,'snapshotMemoryVerified':True,'oomRestoreVerified':False,'supplierStoppedBeforeConsumer':True,'dataBackupHashes':{'trade-feed.json':'a'*64},'preservedSpoolHash':'b'*64}
   receipt=secure/('partitioned-upgrade-'+old_digest[:24]+'.json');receipt.write_text(json.dumps(proof));(secure/'deployment.json').write_text('{}')
   ancestor={k:v for k,v in proof.items() if k!='checkpointParserSourceDigest'};ancestor['digest']='f'*64
   (secure/('partitioned-upgrade-'+'f'*24+'.json')).write_text(json.dumps(ancestor))
   old_files=dict(files)
   files['apps/worker/src/full-snapshot.ts']='fixed parser';digest=hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest();image='adl-worker-partitioned:'+digest[:24]
   calls=[]
   def run(args,**kw):
    calls.append(args)
    if args[:3]==['docker','image','inspect']:return json.dumps([{'Id':'sha256:'+'c'*64,'Config':{'User':'node','Labels':{'eu.adl.partitioned.patch':old_digest if args[3]=='prepared-image' else digest}}}]).encode()
    if args[:2]==['docker','tag']:return b''
    if args[:2]==['docker','build']:return b''
    if args[:2]==['docker','run'] and any('readFileSync' in str(a) for a in args):return json.dumps(old_files).encode()
    if args[:2]==['docker','run']:return b'snapshot-memory-offline-ok'
    raise AssertionError(args)
   keys=('SECURE','BACKUPS','run','partition_base','control_status','model','states','require');old={k:NS.get(k) for k in keys}
   NS.update(require=lambda ok,reason:None if reason=='ROOT_REQUIRED' else old['require'](ok,reason),SECURE=secure,BACKUPS=backups,run=run,partition_base=lambda _:[],control_status=lambda:200,model=lambda _:{'services':{'worker':{'mem_limit':4294967296}}},states=lambda _:[{'running':False}])
   try:
    out=io.StringIO()
    with contextlib.redirect_stdout(out):code=NS['upgrade_partitioned']({'phase':'prepare','files':files,'snapshotMemoryRepair':True,'checkpointRepairBackup':str(backup)})
    self.assertEqual(code,0,out.getvalue());result=json.loads(out.getvalue().splitlines()[-1]);self.assertEqual(result['backup'],str(backup));self.assertEqual(result['image'],image)
    new=json.loads((secure/('partitioned-upgrade-'+digest[:24]+'.json')).read_text());self.assertEqual(new['phase'],'stopped');self.assertEqual(new.get('rehearsalDirectory'),proof.get('rehearsalDirectory'));self.assertTrue(new['supplierStoppedBeforeConsumer']);self.assertEqual(new['dataBackupHashes'],proof['dataBackupHashes']);self.assertFalse(new['oomRestoreVerified']);self.assertEqual(json.loads(receipt.read_text()),proof)
    self.assertEqual(len([c for c in calls if c[:2]==['docker','build']]),1);self.assertFalse(any('up' in c or 'kill' in c or 'stop' in c for c in calls))
    build=next(c for c in calls if c[:2]==['docker','build']);self.assertEqual(build[2:4],['--builder','default'])
    dockerfile=Path(build[-1])/'Dockerfile';self.assertTrue(dockerfile.read_text().startswith('FROM adl-partition-base:'));self.assertNotIn('FROM sha256:',dockerfile.read_text())
   finally:NS.update(old)
 def test_failed_read_gate_never_runs_full_restore_or_starts_worker(self):self.test_prepare_activate_reuse_preserves_every_non_worker_field(full=True,distribution=True,supplier=True,nullable=True,throughput=True,spool=True,parser=True,durable=True,oom=True,read_access_fails=True)
 def test_confirmed_oom_resume_backs_up_and_validates_without_signalling_dead_worker(self):self.test_prepare_activate_reuse_preserves_every_non_worker_field(full=True,distribution=True,supplier=True,nullable=True,throughput=True,spool=True,parser=True,durable=True,oom=True)
 def test_durable_ingress_image_gate_preserves_single_activation_and_rollback(self):self.test_prepare_activate_reuse_preserves_every_non_worker_field(full=True,distribution=True,supplier=True,nullable=True,throughput=True,spool=True,parser=True,durable=True)
 def test_parser_offline_gate_preserves_worker_only_upgrade_and_reuse(self):self.test_prepare_activate_reuse_preserves_every_non_worker_field(full=True,distribution=True,supplier=True,nullable=True,throughput=True,spool=True,parser=True)
 def test_spool_memory_is_verified_before_single_worker_update_and_reused(self):self.test_prepare_activate_reuse_preserves_every_non_worker_field(full=True,distribution=True,supplier=True,nullable=True,throughput=True,spool=True)
 def test_throughput_fix_requires_nullable_evidence_and_reuses_single_restart(self):self.test_prepare_activate_reuse_preserves_every_non_worker_field(full=True,distribution=True,supplier=True,nullable=True,throughput=True)
 def test_captured_nullable_fixture_is_verified_before_stop_and_preserves_all_overrides(self):self.test_prepare_activate_reuse_preserves_every_non_worker_field(full=True,distribution=True,supplier=True,nullable=True)
 def test_supplier_order_is_verified_and_worker_only_rollback_is_private(self):self.test_prepare_activate_reuse_preserves_every_non_worker_field(full=True,distribution=True,supplier=True)
 def test_full_recovery_preflights_stop_before_consumer_and_preserves_migration(self):self.test_prepare_activate_reuse_preserves_every_non_worker_field(full=True)
 def test_distribution_fix_is_tested_offline_before_single_worker_restart_and_reuses_result(self):self.test_prepare_activate_reuse_preserves_every_non_worker_field(distribution=True)
 def test_resume_after_already_requested_stop_does_not_signal_again(self):self.test_prepare_activate_reuse_preserves_every_non_worker_field(resume_stopped=True)
if __name__=='__main__':unittest.main()
