import ast,contextlib,copy,datetime,hashlib,io,json,os,subprocess,tempfile,types,unittest
from pathlib import Path
HERE=Path(__file__).parent
NS={'__name__':'tested'}
for name in ('resume-adl-api.py','repair-adl-snapshot.py','upgrade-partitioned-worker.py','execute-adl-cutover-aws.py'):exec((HERE/name).read_text().split("if __name__=='__main__':")[0],NS)
class Upgrade(unittest.TestCase):
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
 def test_prepare_activate_reuse_preserves_every_non_worker_field(self,resume_stopped=False,distribution=False,full=False,supplier=False,nullable=False,throughput=False,spool=False,parser=False,durable=False,oom=False):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);secure=root/'secure';secure.mkdir();backups=root/'backups';backups.mkdir();releases=root/'releases';release=releases/('a'*40);release.mkdir(parents=True);volume=root/'volume';volume.mkdir()
   evidence=backups/'adl-snapshot-shape-example';evidence.mkdir(mode=0o700);raw=json.dumps({'FixtureId':20563979,'Fixture':{'Status':1},'Markets':None}).encode();(evidence/'rejected-row.private.json').write_bytes(raw);(evidence/'rejected-row.private.json').chmod(0o600);(evidence/'report.json').write_text(json.dumps({'rawRowSha256':hashlib.sha256(raw).hexdigest(),'rawRowBytes':len(raw),'rejection':{'path':'Markets','actualType':'null'},'sdk':{'conversion':'succeeded','markets':{'type':'null'}}}));(evidence/'report.json').chmod(0o600)
   original=secure/'old.json';original.write_text('{}');meta={'release':str(release),'composeOverrides':[str(original)]};(secure/'deployment.json').write_text(json.dumps(meta))
   (volume/'trade-feed.json').write_text('{"preserved":"checkpoint"}');journal=volume/'trade-feed.json.snapshot-aaaaaaaaaaaaaaaa.json';journal.write_text('{"nextAt":9999999999999,"due":{},"failures":{}}');journal_before=journal.read_bytes();regular=volume/'trade-feed.json.regular-checkpoint.json';regular.write_text('PRIVATE_REGULAR_PRESERVED');regular_before=regular.read_bytes()
   handoff={'audit':{'status':'ok','workerLockAbsent':True,'matchingWorkerProcesses':0}};d=hashlib.sha256(json.dumps(handoff,sort_keys=True,separators=(',',':')).encode()).hexdigest();migration=secure/('cutover-'+d+'.json');migration.write_text(json.dumps({'digest':d,'startRequestedAtUTC':'2026-01-01T00:00:00Z','notBeforeUTC':'2026-01-01T00:00:00Z','journals':['preserved']}))
   files={path:'export const isolated=true;' for path in NS['PARTITION_FILES']};hashes={path:None for path in files};digest=hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest();image='adl-worker-partitioned:'+digest[:24]
   images={'base':{'Id':'sha256:'+('b'*64),'Config':{'Labels':{}}}};running=not oom;selected='base';calls=[]
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
    if args[:2]==['docker','run']:return b'partitioned-offline-ok distribution-propagation-offline-ok full-recovery-offline-ok supplier-order-offline-ok nullable-markets-offline-ok throughput-offline-ok spool-memory-offline-ok snapshot-throughput-offline-ok planned-distribution-stop-ok durable-ingress-offline-ok snapshot-memory-offline-ok oom-checkpoint-restore-ok' if '--input-type=module' in args or any(str(a).endswith('-proof.mjs') for a in args) else json.dumps(hashes).encode()
    if args[:2]==['docker','build']:images[image]={'Id':'sha256:'+('c'*64),'Config':{'Labels':{'eu.adl.partitioned.patch':digest}}};return b''
    if args[:2]==['docker','inspect']:
     return json.dumps([{'Image':images[selected]['Id'],'HostConfig':{'Memory':4294967296,'RestartPolicy':{'Name':'no'}},'Config':{'Env':['LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT=true',*(['NODE_OPTIONS=--max-old-space-size=2560'] if oom and selected==image else [])]},'Mounts':[{'Destination':'/app/.runtime/feed','Type':'volume','RW':False,'Name':'feed'}]}]).encode()
    if args[:3]==['docker','volume','inspect']:return json.dumps([{'Mountpoint':str(volume),'Labels':{'com.docker.compose.project':'adl-homologation'}}]).encode()
    if args[:2]==['docker','kill']:running=False;return b''
    if 'up' in args:running=True;selected=image;return b''
    if 'create' in args:running=False;selected='base';return b''
    raise AssertionError('Unexpected operation')
   keys=('SECURE','BACKUPS','RELEASES','run','model','states','control_status','snapshot_host_memory','shutil','os','verify_oom_inboxes','archive_oom_locks');old={k:NS.get(k) for k in keys}
   NS.update(verify_oom_inboxes=lambda directory:[{'lane':'prematch','pendingRows':13526}],archive_oom_locks=lambda *args:None,SECURE=secure,BACKUPS=backups,RELEASES=releases,run=run,model=model,states=states,control_status=lambda:200,snapshot_host_memory=lambda:12*1024**3,shutil=types.SimpleNamespace(**{**NS['shutil'].__dict__,'disk_usage':lambda _:types.SimpleNamespace(free=10*1024**3)}),os=types.SimpleNamespace(**{**os.__dict__,'geteuid':lambda:0}))
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
     progress_file=next(secure.glob('partitioned-upgrade-*.json'));progress=json.loads(progress_file.read_bytes());progress['phase']='stop_requested';progress_file.write_text(json.dumps(progress));running=False
    if oom:
     code,verified=invoke('activate',verify_only=True);self.assertEqual(code,0,verified);self.assertTrue(verified['offlineRestoreVerified']);self.assertFalse(running);self.assertFalse(any('up' in c for c in calls));self.assertEqual(len([c for c in calls if any('oom-checkpoint-restore-ok' in str(a) for a in c)]),1)
    code,result=invoke('activate');self.assertEqual(code,0,result);self.assertTrue(running);self.assertEqual(selected,image);
    if oom:self.assertEqual(len([c for c in calls if any('oom-checkpoint-restore-ok' in str(a) for a in c)]),1)
    self.assertEqual(journal.read_bytes(),journal_before);self.assertEqual(regular.read_bytes(),regular_before);self.assertEqual((Path(result['backup'])/regular.name).read_bytes(),regular_before)
    if full and not oom:
     stop=next(i for i,c in enumerate(calls) if c[:2]==['docker','run'] and any('planned-distribution-stop-ok' in str(x) for x in c))
     term=next(i for i,c in enumerate(calls) if c[:2]==['docker','kill']);self.assertLess(stop,term)
    self.assertEqual(len([c for c in calls if c[:2]==['docker','kill']]),0 if resume_stopped or oom else 1);self.assertEqual(len([c for c in calls if 'up' in c]),1)
    after=json.loads((secure/'deployment.json').read_bytes());self.assertEqual(after['composeOverrides'][0],str(original));self.assertEqual(len(after['composeOverrides']),2)
    self.assertEqual(model(NS['partition_base'](after))['services']['worker']['environment']['LSPORTS_INPLAY_SNAPSHOT_MAX_RESPONSE_MB'],'128');self.assertEqual(json.loads(migration.read_bytes())['journals'],['preserved'])
    code,result=invoke('prepare');self.assertEqual(code,0,result);code,result=invoke('activate');self.assertEqual(code,0,result);self.assertTrue(result['reused']);
    if oom:
     code,verified=invoke('activate',verify_only=True);self.assertEqual(code,0,verified);self.assertTrue(verified['offlineRestoreVerified'])
    self.assertEqual(len([c for c in calls if 'up' in c]),1);self.assertEqual(len([c for c in calls if c[:2]==['docker','build']]),1)
    self.assertTrue(all(c[-1]=='worker' and '--no-deps' in c and '--pull' in c for c in calls if 'up' in c))
    if supplier:
     code,result=invoke('rollback');self.assertEqual(code,0,result);self.assertFalse(running);self.assertEqual(selected,'base');self.assertTrue(result['oldWorkerKeptStopped']);self.assertEqual(journal.read_bytes(),journal_before);self.assertTrue(all(c[-1]=='worker' and '--no-deps' in c for c in calls if 'create' in c));code,result=invoke('rollback');self.assertEqual(code,0,result);self.assertTrue(result['reused']);self.assertEqual(len([c for c in calls if 'create' in c]),1)
   finally:NS.update(old)
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
