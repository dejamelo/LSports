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
   feed={'updatedAt':now,'connections':{'prematch':copy.deepcopy(lane),'inplay':copy.deepcopy(lane)},'events':[]}
   prior=NS['states'];prior_evidence=NS['feed_evidence'];NS['feed_evidence']=lambda *args:{};NS['states']=lambda service:[{'running':True}]
   def check():
    (folder/'trade-feed.json').write_text(json.dumps(feed));output=io.StringIO()
    with contextlib.redirect_stdout(output):NS['cutover_status'](folder,now)
    return json.loads(output.getvalue())
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
if __name__=='__main__':unittest.main()
