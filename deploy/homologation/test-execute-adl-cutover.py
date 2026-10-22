import contextlib
import copy
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
import types

HERE=Path(__file__).parent
NS={'__name__':'tested'}
exec((HERE/'resume-adl-api.py').read_text().split("if __name__=='__main__':")[0],NS)
exec((HERE/'execute-adl-cutover-aws.py').read_text().split("if __name__=='__main__':")[0],NS)

class Cutover(unittest.TestCase):
 def test_checkpoint_format_is_read_without_materializing_private_regular_state(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp)/'feed.json';p.write_text(json.dumps({'mode':'connected','events':[],'workerCheckpoint':{'version':1,'regularExternal':True,'regular':[{'private':'not returned'}]}}))
   metadata,rows,_=NS['diagnostic_checkpoint'](p,lambda e:None);self.assertEqual(metadata['persistedFormat'],{'version':1,'regularExternal':True});self.assertNotIn('not returned',json.dumps(metadata));self.assertEqual(rows,0)
   p.write_text('{"mode":"connected","events":[],"workerCheckpoint":{"version":1,"regular":[invalid]}}')
   with self.assertRaises(RuntimeError):NS['diagnostic_checkpoint'](p,lambda e:None)
 def test_incremental_checkpoint_validates_skipped_data_and_keeps_one_event(self):
  with tempfile.TemporaryDirectory() as tmp:
   path=Path(tmp)/'trade-feed.json';seen=[]
   value={'mode':'connected','connections':{'prematch':{'consumerProgress':{'active':True}}},'coverage':{},'events':[{'id':'prematch:1','markets':[]},{'id':'inplay:2','markets':[]}],'workerCheckpoint':{'regular':[[1,{'text':'a\\b"c','nil':None}]]},'ticketOutcomes':[{'settlement':2}]}
   path.write_text(json.dumps(value));metadata,count,size=NS['diagnostic_checkpoint'](path,seen.append)
   self.assertEqual(count,2);self.assertEqual(seen,value['events']);self.assertNotIn('workerCheckpoint',metadata);self.assertEqual(size,path.stat().st_size)
   for suffix in (',}', 'false', ',"private":[1,]}'):
    path.write_text('{"mode":"connected","events":[]'+suffix)
    with self.assertRaises(RuntimeError):NS['diagnostic_checkpoint'](path,lambda e:None)
   path.write_text('{"mode":"connected","events":[],"private":{"secret":[true,false,null,"escaped\\\\value"],"bad":NaN}}')
   with self.assertRaisesRegex(RuntimeError,'DIAGNOSTIC_INVALID_SCALAR'):NS['diagnostic_checkpoint'](path,lambda e:None)
 def test_reader_keeps_open_inode_when_worker_atomically_publishes(self):
  with tempfile.TemporaryDirectory() as tmp:
   path=Path(tmp)/'trade-feed.json';original={'mode':'connected','events':[{'id':'prematch:1','markets':[]}]};path.write_text(json.dumps(original))
   def changed(event):
    other=path.with_suffix('.new');other.write_text('{"mode":"connected","events":[]}');os.replace(other,path)
   _,rows,_=NS['diagnostic_checkpoint'](path,changed);self.assertEqual(rows,1)
 def test_timeline_accepts_utc_fraction_and_identifies_invalid_field(self):
  start=NS['timeline_timestamp']('2026-10-22T01:02:03.456Z','window.fromUTC');self.assertEqual(start.microsecond,456000)
  end=NS['timeline_timestamp']('2026-10-22T01:02:03.123456789Z','State.FinishedAt');self.assertEqual(end.microsecond,123456)
  for value in (None,'2026-02-30T01:02:03Z','2026-10-22T25:02:03Z','2026-10-22T01:02:03+01:00','SECRET_NOT_A_TIMESTAMP'):
   out=io.StringIO()
   with contextlib.redirect_stdout(out):
    with self.assertRaisesRegex(RuntimeError,'TIMELINE_TIMESTAMP_UNVERIFIED_WINDOW_TOUTC'):NS['timeline_timestamp'](value,'window.toUTC')
   record=json.loads(out.getvalue());self.assertEqual(record['timestampField'],'window.toUTC');self.assertNotIn('SECRET',out.getvalue())
  out=io.StringIO()
  with contextlib.redirect_stdout(out):
   with self.assertRaisesRegex(RuntimeError,'WINDOW_TOUTC'):NS['existing_recovery_timeline']([],{'fromUTC':'2026-10-22T01:02:03Z'})
 def test_worker_exit_collection_fences_the_exact_new_container(self):
  old=NS['states'];NS['states']=lambda service:[{'id':'a'*64}]
  try:
   with self.assertRaisesRegex(RuntimeError,'EXPECTED_OOM_CONTAINER_NOT_CURRENT'):NS['worker_exit_report'](expected_worker_id='b'*64)
  finally:NS['states']=old
 def test_current_exit_timeline_uses_millisecond_window_without_consumers(self):
  result=NS['existing_recovery_timeline']([],{'fromUTC':'2026-10-22T01:02:03.123Z','toUTC':'2026-10-22T01:12:03.456Z'})
  self.assertEqual(result['records'],[])
 def test_kernel_oom_filters_the_current_container_and_correlated_host_pid(self):
  current='a'*64;other='b'*64;original=NS['subprocess']
  class Process:
   def wait(self,timeout):return 0
  def popen(args,stdout,stderr):
   self.assertEqual(args[0],'journalctl');self.assertIn('--utc',args)
   stdout.write((f'2026-10-22T01:00:00+0000 host kernel: oom-kill:task_memcg=/docker/{other},pid=88\n'+f'2026-10-22T01:00:00+0000 host kernel: oom-kill:task_memcg=/docker/{current},pid=77\n'+'2026-10-22T01:00:00+0000 host kernel: Killed process 88 (node) anon-rss:999kB\n'+'2026-10-22T01:00:00+0000 host kernel: Killed process 77 (node) anon-rss:2048kB file-rss:64kB\n').encode());return Process()
  NS['subprocess']=types.SimpleNamespace(**{**original.__dict__,'Popen':popen})
  try:
   now=NS['datetime'].datetime.now(NS['datetime'].timezone.utc);result=NS['kernel_oom_evidence'](current,now,now)
   self.assertEqual(len(result['records']),2);self.assertEqual(result['records'][-1]['anonymousRSSBytes'],2097152);self.assertNotIn('999',json.dumps(result));self.assertFalse(result['rawLogPrinted'])
  finally:NS['subprocess']=original
 def test_explicit_prefix_resolves_only_one_confirmed_oom_worker(self):
  c={'id':'7f43cb2939c7'+'a'*52,'name':'/adl-homologation-worker-1','state':'exited','running':False,'exitCode':137,'oomKilled':True}
  out=io.StringIO()
  with contextlib.redirect_stdout(out):NS['verify_exit_target']([c],expected_worker_prefix='7f43cb2939c7')
  self.assertEqual(json.loads(out.getvalue())['resolvedContainerId'],c['id'])
  for changes in ({'running':True},{'oomKilled':False},{'id':'b'*64},{'name':'/posnet-worker-1'},{'exitCode':0}):
   with self.assertRaises(RuntimeError):NS['verify_exit_target']([{**c,**changes}],expected_worker_prefix='7f43cb2939c7')
  with self.assertRaises(RuntimeError):NS['verify_exit_target']([c,c],expected_worker_prefix='7f43cb2939c7')
  with self.assertRaises(RuntimeError):NS['verify_exit_target']([c],expected_worker_id=c['id'][:-2])
 def test_amqp_comparison_reports_secret_drift_without_values_or_hashes(self):
  before={'LSPORTS_PREMATCH_USERNAME':'SECRET_USER','LSPORTS_PREMATCH_PASSWORD':'SECRET_PASSWORD','LSPORTS_INPLAY_USERNAME':'SECRET_USER_2','LSPORTS_INPLAY_PASSWORD':'SECRET_PASS_2'}
  current=dict(before);current['LSPORTS_PREMATCH_PASSWORD']='NEW_SECRET'
  result=NS['amqp_env_comparison'](current,before)
  self.assertFalse(result['prematch']['credentialsEqualToPrevious']);self.assertTrue(result['inplay']['credentialsEqualToPrevious'])
  self.assertEqual(result['current']['prematch']['host'],'stm-prematch.lsports.eu');self.assertEqual(result['current']['prematch']['vhost'],'StmPreMatch')
  self.assertEqual(result['current']['prematch']['credentialSource'],'primary');self.assertNotIn('SECRET',json.dumps(result))
 def test_amqp_comparison_detects_mq_override_and_destination_changes(self):
  before={};current={'LSPORTS_PREMATCH_MQ_USERNAME':'SECRET','LSPORTS_PREMATCH_MQ_PASSWORD':'SECRET','LSPORTS_PREMATCH_HOST':'other.example','LSPORTS_PREMATCH_VHOST':'other'}
  result=NS['amqp_env_comparison'](current,before)
  self.assertEqual(result['current']['prematch']['credentialSource'],'mq_override');self.assertTrue(result['current']['prematch']['credentialPairPresent'])
  self.assertFalse(result['prematch']['connectionSettingsEqualToPrevious']);self.assertNotIn('SECRET',json.dumps(result))
  current['LSPORTS_PREMATCH_HOST']='amqp://SECRET@host';self.assertEqual(NS['amqp_env_view'](current)['prematch']['host'],'invalid_or_redacted')

 def test_amqp_installed_image_comparison_uses_matching_protected_receipt_and_no_app_entrypoint(self):
  with tempfile.TemporaryDirectory() as tmp:
   directory=Path(tmp);secure=directory/'secure';secure.mkdir();backups=directory/'backups';backups.mkdir();backup=backups/'adl-partitioned-upgrade-test';backup.mkdir()
   digest='a'*64;image='sha256:'+'b'*64;env={'LSPORTS_PREMATCH_USERNAME':'SECRET','LSPORTS_PREMATCH_PASSWORD':'SECRET'}
   old={'services':{'worker':{'environment':env,'image':'adl-worker:previous'}}}
   (backup/'model.before.private.json').write_text(json.dumps(old))
   (secure/('partitioned-upgrade-'+digest[:24]+'.json')).write_text(json.dumps({'digest':digest,'backup':str(backup),'image':'adl-worker:current'}))
   (secure/'deployment.json').write_text('{}')
   names=['apps/worker/src/config.ts','apps/worker/src/mq.ts','apps/worker/src/connected.ts'];expected={n:'c'*64 for n in names}
   commands=[]
   def fake_run(args,**kw):
    commands.append(args)
    if args[:2]==['docker','inspect']:return json.dumps([{'Image':image,'Config':{'Env':[k+'='+v for k,v in env.items()]}}]).encode()
    if args[:3]==['docker','image','inspect']:return json.dumps([{'Id':image,'Config':{'Labels':{'eu.adl.partitioned.patch':digest}}}]).encode()
    if args[:2]==['docker','exec']:return json.dumps(expected).encode()
    self.fail('Unexpected command')
   previous={k:NS.get(k) for k in ['SECURE','BACKUPS','run','model','partition_base']}
   NS.update(SECURE=secure,BACKUPS=backups,run=fake_run,model=lambda _:old,partition_base=lambda _:[])
   try:result=NS['amqp_configuration_evidence']([{'id':'d'*64}],expected)
   finally:NS.update(previous)
   self.assertEqual(result['status'],'compared');self.assertTrue(result['prematch']['credentialsEqualToPrevious']);self.assertTrue(all(result['installedSourceMatchesRepository'].values()))
   self.assertNotIn('SECRET',json.dumps(result));self.assertFalse(any('run' in cmd or 'restart' in cmd or 'kill' in cmd for cmd in commands))

 def test_startup_diagnostic_keeps_prefetch_and_safe_network_codes_only(self):
  safe=NS['safe_feed_diagnostic']({'operation':'amqp.prefetch','category':'network','networkCode':'ECONNRESET','errorType':'type','clientCode':'ERR_BAD_RESPONSE','message':'SECRET','password':'SECRET'})
  self.assertEqual(safe['operation'],'amqp.prefetch');self.assertEqual(safe['networkCode'],'ECONNRESET');self.assertNotIn('SECRET',json.dumps(safe))
  self.assertNotIn('networkCode',NS['safe_feed_diagnostic']({'networkCode':'SECRET'}))
 def test_startup_logs_read_installed_container_initial_window_without_raw_text(self):
  oldrun,oldsub=NS['run'],NS['subprocess']
  calls=[]
  def fake_run(args):return json.dumps([{'State':{'StartedAt':'2026-10-19T17:00:00Z'},'Image':'sha256:abc','RestartCount':0}]).encode()
  def fake_sub(args,**kw):
   calls.append(args)
   return types.SimpleNamespace(returncode=0,stdout=b'2026-10-19T17:00:01Z {"lane":"inplay","operation":"amqp.prefetch","category":"network","networkCode":"ECONNRESET","message":"SECRET"}\n2026-10-19T17:00:02Z SECRET\n',stderr=b'')
  NS['run']=fake_run;NS['subprocess']=types.SimpleNamespace(run=fake_sub)
  try:result=NS['startup_log_evidence']([{'id':'a'*64}])
  finally:NS['run'],NS['subprocess']=oldrun,oldsub
  self.assertEqual(result[0]['records'][0]['networkCode'],'ECONNRESET');self.assertEqual(result[0]['unparsedLines'],1)
  self.assertNotIn('SECRET',json.dumps(result));self.assertIn('--until',calls[0]);self.assertEqual(result[0]['rawLogPrinted'],False)

 def test_distribution_observations_expose_raw_boolean_and_times_only(self):
  row={'stage':'after_propagation','bodyIsDistributionOn':False,'sdkIsDistributionOn':False,'observedAtUTC':'2026-10-19T14:00:03Z','elapsedSinceStartMs':2001,'propagationDelayMs':2000,'secret':'MUST_NEVER_PRINT','startMessage':'MUST_NEVER_PRINT'}
  safe=NS['safe_distribution_observation'](row);self.assertEqual(safe['bodyIsDistributionOn'],False);self.assertEqual(safe['elapsedSinceStartMs'],2001);self.assertNotIn('MUST_NEVER_PRINT',json.dumps(safe))
 def test_distribution_details_allow_only_official_enum_labels_and_delay(self):
  safe=NS['safe_feed_diagnostic']({'distributionInspection':{'before':False,'startRequested':True,'after':False,'startMessage':'activated','propagationDelayMs':2000,'password':'MUST_NEVER_PRINT'}})
  self.assertEqual(safe['distributionInspection']['startMessage'],'activated');self.assertEqual(safe['distributionInspection']['propagationDelayMs'],2000);self.assertNotIn('MUST_NEVER_PRINT',json.dumps(safe))
  bad=NS['safe_feed_diagnostic']({'distributionInspection':{'startMessage':'MUST_NEVER_PRINT','propagationDelayMs':1}});self.assertEqual(bad['distributionInspection'],{})
 def test_snapshot_validation_is_fixed_counts_only_and_legacy_classification_reuses_saved_message(self):
  raw={'operation':'snapshot.events','reason':'invalid_snapshot','message':'Inventario de suscripciones inválido o superior al límite local; no se usa la proyección como inventario.','snapshotValidation':{'phase':'inventory','code':'inventory_invalid_ids','attribution':'provider_contract','rawCount':3,'invalidCount':1,'itemTypes':{'number':2,'string':1,'MUST_NEVER_PRINT':1},'password':'MUST_NEVER_PRINT'}}
  result=NS['safe_feed_diagnostic'](raw);self.assertEqual(result['legacyValidationCause'],'inventory_validation_after_http_success');self.assertNotIn('MUST_NEVER_PRINT',json.dumps(result));self.assertEqual(result['snapshotValidation']['rawCount'],3)
  self.assertEqual(NS['safe_feed_diagnostic']({'message':'MUST_NEVER_PRINT'}),{})
 def test_merge_never_shortens_and_preserves_remote_evidence(self):
  old={'nextAt':400,'due':{'4511:snapshot.events':900},'failures':{'a':4},'lastRequest':{'pid':7}}
  incoming={'nextAt':200,'due':{'4511:snapshot.events':300,'4510:snapshot.events':500},'failures':{'a':1}}
  merged=NS['merge_schedule'](old,incoming)
  self.assertEqual(merged['nextAt'],400);self.assertEqual(merged['due'],{'4511:snapshot.events':900,'4510:snapshot.events':500});self.assertEqual(merged['failures']['a'],4);self.assertEqual(merged['lastRequest'],{'pid':7})
  self.assertEqual(old['due'],{'4511:snapshot.events':900})
 def test_barrier_rounds_up_without_changing_timezone_or_shortening_cooldown(self):
  self.assertEqual(NS['canonical_barrier']('2026-10-19T00:00:00.123456Z'),'2026-10-19T00:00:00.124Z')
  self.assertEqual(NS['canonical_barrier']('2026-10-19T23:59:59.999999Z'),'2026-10-20T00:00:00.000Z')
  self.assertEqual(NS['canonical_barrier']('2026-10-19T00:00:00Z'),'2026-10-19T00:00:00.000Z')
  with self.assertRaisesRegex(RuntimeError,'INVALID_DEADLINE'):NS['canonical_barrier']('2026-10-19T00:00:00')
 def test_feed_evidence_is_local_only_separates_broker_close_and_cooldown_without_raw_text(self):
  with tempfile.TemporaryDirectory() as temporary:
   folder=Path(temporary);journal={'nextAt':900,'due':{'4511:snapshot.events':1200},'failures':{},'requests':{'4511:snapshot.events':{'pid':8,'packageId':4511,'operation':'snapshot.events','outcome':'rate_limited','at':'2026-10-19T10:00:00Z','failure':{'category':'rate_limited','httpStatus':429},'secret':'MUST_NEVER_PRINT'}}}
   (folder/'trade-feed.json.snapshot-aaaaaaaaaaaaaaaa.json').write_text(json.dumps(journal))
   logs=[{'lane':'prematch','operation':'amqp.connection','category':'network','reason':'connection_closed','amqpCode':320,'amqpCloseSignals':['connection_forced','MUST_NEVER_PRINT'],'message':'MUST_NEVER_PRINT'},
         {'lane':'prematch','operation':'snapshot.events','category':'rate_limited','rateLimitSource':'local_operation_cooldown','retryAt':'2026-10-19T10:05:00Z','coordinator':journal['requests']['4511:snapshot.events']},
         {'lane':'prematch','operation':'distribution.start','category':'invalid_response','reason':'distribution_still_off','distributionInspection':{'before':False,'startRequested':True,'after':False,'password':'MUST_NEVER_PRINT'}}]
   content='\n'.join('2026-10-19T10:00:00.000000000Z '+json.dumps(row) for row in logs).encode()
   previous=NS['subprocess'];calls=[]
   def run(args,**kw):calls.append(args);return types.SimpleNamespace(returncode=0,stdout=b'',stderr=content)
   NS['subprocess']=types.SimpleNamespace(run=run)
   try:
    evidence=NS['feed_evidence'](folder,[{'id':'c'*64}]);encoded=json.dumps(evidence)
    self.assertNotIn('MUST_NEVER_PRINT',encoded);self.assertEqual(evidence['providerRequests'],0);self.assertEqual(len(evidence['recentErrors']),3)
    self.assertEqual(evidence['recentErrors'][0]['amqpCloseSignals'],['connection_forced'])
    self.assertEqual(evidence['recentErrors'][1]['rateLimitSource'],'local_operation_cooldown')
    self.assertEqual(evidence['recentErrors'][2]['distributionInspection']['after'],False)
    self.assertEqual(evidence['schedulers'][0]['operations'][0]['coordinator']['outcome'],'rate_limited')
    self.assertTrue(all(c[:2]==['docker','logs'] for c in calls));self.assertEqual(json.loads((folder/'trade-feed.json.snapshot-aaaaaaaaaaaaaaaa.json').read_bytes()),journal)
   finally:NS['subprocess']=previous
 def test_invalid_schedule_rejected(self):
  for value in ({}, {'nextAt':float('nan'),'due':{},'failures':{}},{'nextAt':0,'due':{'x':-1},'failures':{}}):
   with self.assertRaisesRegex(RuntimeError,'INVALID_SCHEDULE'):NS['schedule_checked'](value)

 def test_snapshot_success_requires_new_sessions_not_old_checkpoint_or_keepalive(self):
  with tempfile.TemporaryDirectory() as temporary:
   folder=Path(temporary);now=NS['datetime'].datetime.now(NS['datetime'].timezone.utc).isoformat().replace('+00:00','Z')
   old='2026-01-01T00:00:00Z'
   lane={'phase':'connected','lastSnapshotAt':now,'session':{'startedAt':old},'recoveryProgress':{'regularSnapshotReady':True}}
   feed={'mode':'connected','updatedAt':now,'connections':{'prematch':copy.deepcopy(lane),'inplay':copy.deepcopy(lane)},'events':[]}
   prior=NS['states'];prior_evidence=NS['feed_evidence'];NS['feed_evidence']=lambda *args:{};NS['states']=lambda service:[{'running':True}]
   def check():
    (folder/'trade-feed.json').write_text(json.dumps(feed));output=io.StringIO()
    with contextlib.redirect_stdout(output):NS['cutover_status'](folder,now)
    return json.loads(output.getvalue().splitlines()[-1])
   try:
    self.assertEqual(check()['status'],'recovering')
    for entry in feed['connections'].values():entry['session']['startedAt']=now
    self.assertEqual(check()['status'],'snapshots_ready')
    feed['connections']['prematch']['recoveryProgress']['regularSnapshotReady']=False
    self.assertEqual(check()['status'],'recovering')
   finally:NS['states']=prior;NS['feed_evidence']=prior_evidence
 @unittest.skipUnless(os.geteuid() in (0,1000),'fixture requires UID 1000 or root')
 def test_import_start_preserves_existing_overrides_only_starts_worker_and_obeys_cooldown(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);secure=root/'secure';secure.mkdir();releases=root/'releases';releases.mkdir();release=releases/('a'*40);release.mkdir();vol=root/'volume';vol.mkdir();os.chown(vol,1000,1000) if os.geteuid()==0 else None;backups=root/'backups';backups.mkdir()
   override=secure/'saved.json';override.write_text('{}')
   meta={'release':str(release),'composeOverrides':[str(override)],'image':'unchanged'};(secure/'deployment.json').write_text(json.dumps(meta))
   schedule={'nextAt':0,'due':{'4511:snapshot.events':0},'failures':{}};name='.snapshot-'+('a'*16)+'.json'
   handoff={'audit':{'status':'ok','workerLockAbsent':True,'matchingWorkerProcesses':0,'operation':'cutover.audit','readOnly':True,'notBeforeUTC':'2026-01-01T00:00:00Z','journals':1},'schedules':[{'name':name,'schedule':schedule}]}
   commands=[]
   def run(args,**kw):
    commands.append(args)
    if args[:2]==['docker','inspect']:return json.dumps([{'Mounts':[{'Destination':'/app/.runtime/feed','Type':'volume','RW':False,'Name':'feed'}]}]).encode()
    if args[:3]==['docker','volume','inspect']:return json.dumps([{'Labels':{'com.docker.compose.project':'adl-homologation'},'Mountpoint':str(vol)}]).encode()
    return b''
   def model(base):
    result={'services':{'api':{'image':'preserved'},'worker':{'image':'worker:verified','mem_limit':4294967296,'environment':{'ADL_CAPACITY_APPROVED':'no','ADL_MAC_WORKER_STOPPED':'no','ADL_SUPPLIER_NOT_BEFORE_UTC':''}}}}
    for arg in base:
     if str(arg).startswith(str(secure/'compose.cutover-')):result['services']['worker']['environment'].update(json.loads(Path(arg).read_text())['services']['worker']['environment'])
    return result
   ns=NS;previous={k:ns.get(k) for k in ['SECURE','RELEASES','BACKUPS','run','model','states','os','subprocess']}
   test_os=types.SimpleNamespace(**os.__dict__);test_os.geteuid=lambda:0;test_os.chown=lambda *args:None
   ns.update(os=test_os,SECURE=secure,RELEASES=releases,BACKUPS=backups,run=run,model=model,states=lambda service:[{'id':'api','health':'healthy'}] if service=='api' else [])
   def call(action):
    source={'action':action,'handoff':handoff,'freshAuditAt':ns['datetime'].datetime.now(ns['datetime'].timezone.utc).isoformat().replace('+00:00','Z')}
    old=ns['sys'].stdin;ns['sys'].stdin=io.TextIOWrapper(io.BytesIO(json.dumps(source).encode()));out=io.StringIO()
    try:
     with contextlib.redirect_stdout(out):code=ns['cutover_main']()
     self.assertNotIn('MUST_NEVER_PRINT',out.getvalue())
     return code,json.loads(out.getvalue().strip().splitlines()[-1])
    finally:ns['sys'].stdin=old
   try:
    code,result=call('import');self.assertEqual(code,0,result);self.assertEqual(result['journals'],1)
    count=len(list(backups.iterdir()));code,reused=call('import');self.assertEqual(code,0,reused);self.assertEqual(reused['reused'],True);self.assertEqual(len(list(backups.iterdir())),count)
    target=vol/('trade-feed.json'+name);self.assertEqual(target.stat().st_uid,1000);self.assertEqual(target.stat().st_mode&0o777,0o600)
    # An updated coordinator deadline must prevent start; no locks removed or gates written.
    target.write_text(json.dumps({**schedule,'nextAt':(ns['time'].time()+300)*1000}))
    code,result=call('start');self.assertEqual(code,2);self.assertEqual(result['reason'],'COOLDOWN_NOT_ELAPSED');self.assertEqual(json.loads((secure/'deployment.json').read_text()),meta)
    target.write_text(json.dumps(schedule));code,result=call('start');self.assertEqual(code,0,result)
    after=json.loads((secure/'deployment.json').read_text());self.assertEqual(after['composeOverrides'][0],str(override));self.assertEqual(len(after['composeOverrides']),2)
    starts=[c for c in commands if 'up' in c];self.assertEqual(len(starts),1);self.assertEqual(starts[0][-1],'worker');self.assertIn('--no-deps',starts[0]);self.assertIn('--no-build',starts[0]);self.assertIn('never',starts[0]);self.assertIn(str(override),starts[0])
    code,result=call('start');self.assertEqual(code,2);self.assertEqual(result['reason'],'WORKER_START_ALREADY_ATTEMPTED_INSPECT_BEFORE_RETRY')
    # Reproduce the old Python-generated six-digit barrier rejected by the actual image.
    receipt=next(secure.glob('cutover-*.json'));saved=json.loads(receipt.read_bytes());saved['notBeforeUTC']='2026-01-01T00:00:00.000123Z';receipt.write_text(json.dumps(saved))
    worker={'id':'b'*64,'state':'exited','running':False,'exitCode':2,'oomKilled':False}
    env={'ADL_CAPACITY_APPROVED':'yes','ADL_MAC_WORKER_STOPPED':'yes','ADL_SUPPLIER_NOT_BEFORE_UTC':saved['notBeforeUTC']}
    oldrun=ns['run']
    def recovery_run(args,**kw):
     if args[:3]==['docker','image','inspect']:return json.dumps([{'Id':'sha256:verified'}]).encode()
     if args[:2]==['docker','inspect'] and args[2]==worker['id']:return json.dumps([{'Image':'sha256:verified','Config':{'Env':[k+'='+v for k,v in env.items()]}}]).encode()
     return oldrun(args,**kw)
    log={'operation':'homologation.admission','status':'blocked','reason':'supplier_cooldown_not_confirmed','password':'MUST_NEVER_PRINT'}
    ns.update(run=recovery_run,states=lambda service:[{'id':'api','health':'healthy'}] if service=='api' else [worker],subprocess=types.SimpleNamespace(run=lambda *a,**kw:types.SimpleNamespace(returncode=0,stdout=b'',stderr=json.dumps(log).encode())))
    # Lock and cooldown fences still precede recovery; no automatic lock reclamation.
    (vol/'trade-feed.json.lock').write_text('99')
    code,result=call('recover_start');self.assertEqual(code,2);self.assertEqual(result['reason'],'AWS_WORKER_LOCK_PRESENT');(vol/'trade-feed.json.lock').unlink()
    # A memory rejection is diagnosed but is NOT retried by this specific repair.
    log.update(operation='homologation.preflight',reason='memory_budget_exceeded')
    code,result=call('recover_start');self.assertEqual(code,2);self.assertEqual(result['reason'],'WORKER_EXIT_CAUSE_NOT_CONFIRMED_NO_RESTART');self.assertEqual(len([c for c in commands if 'up' in c]),1)
    log.update(operation='homologation.admission',reason='supplier_cooldown_not_confirmed')
    code,result=call('recover_start');self.assertEqual(code,0,result)
    repaired=json.loads(receipt.read_bytes());self.assertEqual(repaired['notBeforeUTC'],'2026-01-01T00:00:00.001Z');self.assertEqual(len(repaired['previousStartAttempts']),1)
    evidence=Path(repaired['previousStartAttempts'][0]['backup']);self.assertEqual(json.loads((evidence/'receipt.before.json').read_bytes())['notBeforeUTC'],saved['notBeforeUTC']);self.assertTrue((evidence/'worker.private.log').is_file())
    final=json.loads((secure/'deployment.json').read_bytes());self.assertEqual(final['composeOverrides'][:2],after['composeOverrides']);self.assertEqual(len([c for c in commands if 'up' in c]),2)
    # Re-running this repair on the new canonical barrier cannot start again blindly.
    env['ADL_SUPPLIER_NOT_BEFORE_UTC']=repaired['notBeforeUTC']
    code,result=call('recover_start');self.assertEqual(code,2);self.assertEqual(result['reason'],'COOLDOWN_FORMAT_DEFECT_NOT_PROVEN');self.assertEqual(len([c for c in commands if 'up' in c]),2)
   finally:ns.update(previous)
class NullableShapeSafety(unittest.TestCase):
 def test_exact_field_type_survive_without_values_or_arbitrary_paths(self):
  d={'snapshotValidation':{'phase':'batch','code':'full_document_invalid','attribution':'not_proven','detail':'invalid_markets_shape','fieldPath':'Markets[12].Bets[0]','fixtureId':20563979,'actualType':'null','value':'MUST_NEVER_PRINT'}}
  safe=NS['safe_feed_diagnostic'](d)['snapshotValidation'];self.assertEqual(safe['fieldPath'],'Markets[12].Bets[0]');self.assertEqual(safe['actualType'],'null');self.assertEqual(safe['fixtureId'],20563979);self.assertNotIn('MUST_NEVER_PRINT',json.dumps(safe))
  d['snapshotValidation'].update(fieldPath='MUST_NEVER_PRINT',actualType={'secret':'MUST_NEVER_PRINT'},fixtureId='MUST_NEVER_PRINT');safe=NS['safe_feed_diagnostic'](d)['snapshotValidation'];self.assertNotIn('fieldPath',safe);self.assertNotIn('actualType',safe);self.assertNotIn('fixtureId',safe)

class RecoveryRuntimeEvidence(unittest.TestCase):
 def test_proof_is_read_only_confirms_nullable_source_and_does_not_read_private_snapshot(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);secure=root/'secure';secure.mkdir();feed=root/'feed';feed.mkdir();spool=feed/'.full-snapshot-test';spool.mkdir();(spool/'response.private.json').write_text('PRIVATE_BODY_NOT_TO_PRINT');(feed/'trade-feed.json.snapshot-example.lock').write_text('7')
   digest='a'*64;(secure/('partitioned-upgrade-'+digest[:24]+'.json')).write_text(json.dumps({'digest':digest,'nullableMarketsVerified':True}))
   names=['apps/worker/src/connected.ts','apps/worker/src/provider.ts','apps/worker/src/full-snapshot.ts'];before={n:'b'*64 for n in names};candidate={n:'c'*64 for n in names};calls=[]
   def run(args,**kw):
    calls.append(args)
    if args[:2]==['docker','inspect']:return json.dumps([{'Image':'sha256:'+'d'*64,'HostConfig':{'ReadonlyRootfs':True},'Mounts':[]}]).encode()
    if args[:3]==['docker','image','inspect']:return json.dumps([{'Config':{'Labels':{'eu.adl.partitioned.patch':digest}}}]).encode()
    if args[:2]==['docker','run']:return json.dumps(before).encode()
    if args[:2]==['docker','exec']:return b'7\n'
    raise AssertionError('unexpected mutation or provider call')
   old={k:NS.get(k) for k in ('SECURE','run','subprocess')};NS.update(SECURE=secure,run=run,subprocess=types.SimpleNamespace(run=lambda *a,**kw:types.SimpleNamespace(returncode=0,stdout=b'{"CPUPerc":"90.00%","MemPerc":"50.0%"}')))
   try:
    result=NS['recovery_runtime_evidence'](feed,[{'id':'worker','running':True}],{'before':before,'candidate':candidate});self.assertTrue(result['nullableCollectionsInstalled']);self.assertTrue(result['capturedRowPreviouslyVerified']);self.assertTrue(result['matchesBefore']);self.assertFalse(result['brokerCloseCauseProven']);self.assertEqual(result['coordinatorLocks'][0]['action'],'preserved');self.assertEqual(result['snapshotSpools'][0]['bytes'],len('PRIVATE_BODY_NOT_TO_PRINT'));self.assertNotIn('PRIVATE_BODY',json.dumps(result));self.assertTrue(all('--network' in c and 'none' in c and '--memory' in c and '128m' in c for c in calls if c[:2]==['docker','run']));self.assertTrue((feed/'trade-feed.json.snapshot-example.lock').exists())
   finally:NS.update(old)

if __name__=='__main__':unittest.main()
