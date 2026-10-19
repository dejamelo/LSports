import contextlib,copy,datetime,hashlib,io,json,os,tempfile,unittest,types
from pathlib import Path
HERE=Path(__file__).parent
NS={'__name__':'tested'}
for name in ['resume-adl-api.py','execute-adl-cutover-aws.py','repair-adl-snapshot.py']:
 exec((HERE/name).read_text().split("if __name__=='__main__':")[0],NS)
class Repair(unittest.TestCase):
 def test_plan_changes_only_proven_128_lane_never_256_or_distribution(self):
  caps={l:{'limitBytes':m*1048576} for l,m in [('prematch',256),('inplay',128)]}
  error={'reason':'response_size_limit','responseLimitBytes':134217728,'httpStatus':200}
  self.assertEqual(NS['snapshot_plan'](caps,{'inplay':[error]})[0],{'inplay':256})
  self.assertEqual(NS['snapshot_plan'](caps,{'prematch':[error]})[0],{})
  self.assertEqual(NS['snapshot_plan'](caps,{'inplay':[{'reason':'distribution_still_off'}]})[0],{})
  self.assertEqual(NS['snapshot_plan'](caps,{'inplay':[{**error,'httpStatus':429}]})[0],{})
  # Local cooldown retains the previous real HTTP failure in its coordinator.
  deferred={'operation':'snapshot.events','category':'rate_limited','coordinator':{'failure':error}}
  self.assertEqual(NS['snapshot_plan'](caps,{'inplay':[deferred]})[0],{'inplay':256})
  self.assertTrue(NS['snapshot_volume_failures']({'inplay':[deferred]})['inplay'])
 def test_graceful_worker_only_apply_preserves_journal_image_overrides_and_memory(self,current_memory=4294967296,model_as_text=False):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);secure=root/'secure';secure.mkdir();(secure/'deploy.env').write_text('ADL_WORKER_MEMORY_LIMIT=2g\n');releases=root/'releases';releases.mkdir();release=releases/('a'*40);release.mkdir();backups=root/'backups';backups.mkdir();directory=root/'volume';directory.mkdir()
   override=secure/'old.json';override.write_text('{}');meta={'release':str(release),'composeOverrides':[str(override)]};(secure/'deployment.json').write_text(json.dumps(meta))
   journal=directory/'trade-feed.json.snapshot-aaaaaaaaaaaaaaaa.json';journal.write_text(json.dumps({'nextAt':0,'due':{'4510:snapshot.events':0},'failures':{}}));original=journal.read_bytes()
   error={'reason':'response_size_limit','category':'response_limit','operation':'snapshot.events','httpStatus':200,'responseLimitBytes':134217728}
   (directory/'trade-feed.json').write_text(json.dumps({'connections':{'inplay':{'lastSnapshotDiagnostic':error}}}))
   handoff={'audit':{'status':'ok','workerLockAbsent':True,'matchingWorkerProcesses':0}}
   digest=hashlib.sha256(json.dumps(handoff,sort_keys=True,separators=(',',':')).encode()).hexdigest();receipt=secure/('cutover-'+digest+'.json');receipt.write_text(json.dumps({'startRequestedAtUTC':'2026-01-01T00:00:00Z','notBeforeUTC':'2026-01-01T00:00:00Z'}))
   running=True;container_memory=current_memory;calls=[];hashes={k:'verified' for k in ('provider.ts','diagnostics.ts','snapshot-capacity.ts')}
   observed={'sourceHashes':hashes,'capacities':{'prematch':{'limitBytes':268435456},'inplay':{'limitBytes':134217728}},'proposed':{'allowed':True},'cgroup':{'max':str(current_memory),'current':str(500*1024**2)}}
   def states(_):return [{'id':'b'*64,'running':running}]
   def run(args,**kwargs):
    nonlocal running,container_memory
    calls.append(args)
    if args[:3]==['docker','image','inspect']:return json.dumps([{'Id':'image-id'}]).encode()
    if args[:3]==['docker','volume','inspect']:return json.dumps([{'Labels':{'com.docker.compose.project':'adl-homologation'},'Mountpoint':str(directory)}]).encode()
    if args[:2]==['docker','inspect']:return json.dumps([{'Image':'image-id','HostConfig':{'Memory':container_memory},'Mounts':[{'Destination':'/app/.runtime/feed','Type':'volume','RW':True,'Name':'test-volume'}]}]).encode()
    if args[:2]==['docker','exec']:return json.dumps(observed).encode()
    if args[:2]==['docker','kill']:running=False
    if 'up' in args:running=True;container_memory=4294967296
    return b''
   def model(args):
    value={'services':{'api':{'image':'api-unchanged'},'worker':{'mem_limit':str(current_memory) if model_as_text else current_memory,'image':'unchanged','environment':{'LSPORTS_PREMATCH_SNAPSHOT_MAX_RESPONSE_MB':'256','LSPORTS_INPLAY_SNAPSHOT_MAX_RESPONSE_MB':'128','NODE_OPTIONS':'--max-old-space-size=3072'}}}}
    for arg in args:
     if str(arg).startswith(str(secure/'compose.snapshot-')):
      change=json.loads(Path(arg).read_bytes())['services']['worker'];value['services']['worker']['environment'].update(change['environment']);value['services']['worker']['mem_limit']=str(change['mem_limit']) if model_as_text else change['mem_limit']
    return value
   old={k:NS.get(k) for k in ['SECURE','RELEASES','BACKUPS','states','run','model','control_status','feed_evidence','os','snapshot_host_memory']};NS.update(os=types.SimpleNamespace(**{**os.__dict__,'geteuid':lambda:0}),SECURE=secure,RELEASES=releases,BACKUPS=backups,states=states,run=run,model=model,control_status=lambda:200,feed_evidence=lambda *a:{'recentErrors':[]},snapshot_host_memory=lambda:1024**3)
   request={'handoff':handoff,'freshAuditAt':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),'sourceHashes':hashes}
   try:
    # Correlation reads protected evidence even when RAM admission would reject a mutation.
    out=io.StringIO()
    with contextlib.redirect_stdout(out):code=NS['repair_snapshot']({**request,'inspectOnly':True})
    self.assertEqual(code,0,out.getvalue());self.assertIn('snapshot_repair.correlation',out.getvalue());self.assertEqual(list(backups.iterdir()),[]);self.assertTrue(running);self.assertEqual(journal.read_bytes(),original);self.assertFalse(any(c[:2]==['docker','kill'] for c in calls))
    # Memory refusal occurs before any stop or configuration write.
    out=io.StringIO()
    with contextlib.redirect_stdout(out):code=NS['repair_snapshot'](request)
    self.assertEqual(code,2);self.assertIn('HOST_HEADROOM_INSUFFICIENT',out.getvalue());self.assertTrue(running);self.assertFalse(any(c[:2]==['docker','kill'] for c in calls))
    NS['snapshot_host_memory']=lambda:12*1024**3;out=io.StringIO()
    with contextlib.redirect_stdout(out):code=NS['repair_snapshot'](request)
    self.assertEqual(code,0,out.getvalue());comp=next(json.loads(line) for line in out.getvalue().splitlines() if json.loads(line).get('stage')=='snapshot_repair.memory_comparison');self.assertEqual(comp['compose'],{'type':'str' if model_as_text else 'int','value':str(current_memory) if model_as_text else current_memory});self.assertEqual(comp['docker'],{'type':'int','value':current_memory});self.assertTrue(running);self.assertEqual(journal.read_bytes(),original)
    self.assertEqual(len([c for c in calls if c[:2]==['docker','kill']]),1);self.assertTrue(all('SIGTERM' in c for c in calls if c[:2]==['docker','kill']))
    starts=[c for c in calls if 'up' in c];self.assertEqual(len(starts),1);self.assertEqual(starts[0][-1],'worker');self.assertIn('--no-deps',starts[0]);self.assertIn('--no-build',starts[0])
    current=json.loads((secure/'deployment.json').read_bytes());self.assertEqual(current['composeOverrides'][0],str(override));effective=model(starts[0]);self.assertEqual(effective['services']['worker']['environment']['LSPORTS_INPLAY_SNAPSHOT_MAX_RESPONSE_MB'],'256');self.assertEqual(effective['services']['worker']['image'],'unchanged');self.assertEqual(NS['snapshot_memory_bytes'](effective['services']['worker']['mem_limit']),4294967296)
    self.assertEqual(len(json.loads(receipt.read_bytes())['capacityRestarts']),1)
   finally:NS.update(old)
 def test_two_gib_container_is_reconciled_to_four_gib_without_touching_posnet(self):
  self.test_graceful_worker_only_apply_preserves_journal_image_overrides_and_memory(2147483648)
 def test_sizing_reserves_host_memory_and_does_not_require_old_two_gib_admission(self):
  GiB=1024**3;cg={'max':str(2*GiB),'current':str(512*1024**2)};caps={'prematch':{'limitBytes':268435456},'inplay':{'limitBytes':134217728}}
  with self.assertRaisesRegex(RuntimeError,'HOST_HEADROOM_INSUFFICIENT'):NS['snapshot_sizing'](2*GiB,2*GiB,cg,6*GiB-1,{},caps)
  result=NS['snapshot_sizing'](2*GiB,2*GiB,cg,6*GiB,{},caps)
  self.assertTrue(result['resize']);self.assertEqual(result['targetMemoryBytes'],4*GiB);self.assertEqual(result['conversionBudgetBytes'],2112*1024**2)
  with self.assertRaisesRegex(RuntimeError,'OUTSIDE_APPROVED_PLAN'):NS['snapshot_sizing'](8*GiB,8*GiB,cg,12*GiB,{},caps)
 def test_compose_decimal_string_and_docker_integer_are_equivalent_through_full_repair(self):
  self.test_graceful_worker_only_apply_preserves_journal_image_overrides_and_memory(4294967296,model_as_text=True)
 def test_memory_parser_only_accepts_exact_positive_integer_bytes(self):
  for value in (4294967296,'4294967296',2147483648,'2147483648'):
   with self.subTest(value=value):self.assertEqual(NS['snapshot_memory_bytes'](value),int(value))
  for value in (None,True,False,0,'0',-1,'-1','4g','4 GiB','unlimited',' 4294967296','4294967296.0',4294967296.0,float('nan'),'04294967296','+4294967296','４２９４９６７２９６',str(2**63)):
   with self.subTest(type=type(value).__name__):
    with self.assertRaisesRegex(RuntimeError,'WORKER_MEMORY_LIMIT_UNVERIFIED'):NS['snapshot_memory_bytes'](value)
 def test_memory_operand_redacts_unexpected_text_and_model_normalization_preserves_other_fields(self):
  report=NS['snapshot_memory_operand']('MUST_NEVER_PRINT');self.assertNotIn('MUST_NEVER_PRINT',json.dumps(report));self.assertTrue(report['valueRedacted'])
  before={'services':{'api':{'mem_limit':'805306368'},'worker':{'mem_limit':'4294967296','environment':{'preserved':'yes'},'volumes':['preserved']}}}
  original=copy.deepcopy(before);after=NS['snapshot_memory_model'](before)
  self.assertEqual(before,original);self.assertEqual(after['services']['worker']['mem_limit'],4294967296);self.assertEqual(after['services']['api'],before['services']['api']);self.assertEqual(after['services']['worker']['volumes'],['preserved'])
 def test_correlation_256_current_vs_128_historical_and_cooldown_does_not_refresh_failure_age(self):
  caps={'prematch':{'limitBytes':268435456},'inplay':{'limitBytes':134217728}};started='2026-10-19T05:00:00Z'
  def failure(limit):return {'reason':'response_size_limit','operation':'snapshot.events','httpStatus':200,'responseLimitBytes':limit}
  old={'packageId':4511,'operation':'snapshot.events','at':'2026-10-19T04:00:00Z','completedAt':'2026-10-19T04:00:10Z','failure':failure(134217728)}
  fresh={'packageId':4511,'operation':'snapshot.events','at':'2026-10-19T05:31:22Z','completedAt':'2026-10-19T05:31:27Z','failure':failure(268435456)}
  evidence={'recentErrors':[{'lane':'prematch','category':'rate_limited','rateLimitSource':'local_operation_cooldown','loggedAt':'2026-10-19T05:40:00Z','coordinator':old}], 'schedulers':[{'operations':[{'packageId':4511,'operation':'snapshot.events','coordinator':fresh}]}]}
  report=NS['correlate_snapshot_failures'](caps,started,{},evidence)
  current=next(r for r in report['rows'] if r['attemptLimitBytes']==268435456)
  self.assertEqual(current['classification'],'current_limit_exceeded');self.assertEqual(current['requestAt'],'2026-10-19T05:31:22Z');self.assertEqual(current['failedAt'],'2026-10-19T05:31:27Z')
  historical=next(r for r in report['rows'] if r['attemptLimitBytes']==134217728);self.assertEqual(historical['classification'],'historical_before_current_configuration')
  self.assertEqual(report['decisions']['prematch'],'bounded_partitioned_recovery_required_no_cap_increase')
 def test_correlation_unknown_time_and_runtime_mismatch_never_claim_current_256_overflow(self):
  caps={'prematch':{'limitBytes':268435456},'inplay':{'limitBytes':134217728}};failure={'reason':'response_size_limit','httpStatus':200,'responseLimitBytes':268435456}
  feed={'connections':{'prematch':{'lastSnapshotDiagnostic':failure,'diagnostic':{'reason':'unsupported_message_type','operation':'feed.decode','category':'unsupported_message','messageMetadata':{'messageType':99,'payload':'MUST_NEVER_PRINT'}}}}}
  report=NS['correlate_snapshot_failures'](caps,'2026-10-19T05:00:00Z',feed,{})
  self.assertEqual(report['rows'][0]['classification'],'insufficient_timestamp_evidence');self.assertEqual(report['decisions']['prematch'],'no_current_size_failure_proven_do_not_change_limits');self.assertNotIn('MUST_NEVER_PRINT',json.dumps(report));self.assertEqual(report['independentMessageBlockers'][0]['diagnostic']['messageMetadata']['messageType'],99)
  evidence={'recentErrors':[{'lane':'inplay','loggedAt':'2026-10-19T05:02:00Z',**failure}]}
  report=NS['correlate_snapshot_failures'](caps,'2026-10-19T05:00:00Z',{},evidence)
  self.assertEqual(report['rows'][0]['classification'],'current_runtime_limit_mismatch')
 def test_later_success_and_saved_evidence_are_correlated_without_reopening_markets(self):
  caps={'prematch':{'limitBytes':268435456},'inplay':{'limitBytes':134217728}}
  evidence={'recentErrors':[{'lane':'prematch','loggedAt':'2026-10-19T05:01:00Z','reason':'response_size_limit','responseLimitBytes':268435456,'httpStatus':200}]}
  feed={'connections':{'prematch':{'lastSnapshotAt':'2026-10-19T05:02:00Z'}}}
  original=copy.deepcopy(feed);report=NS['correlate_snapshot_failures'](caps,'2026-10-19T05:00:00Z',feed,{},historical={'evidence':evidence})
  self.assertEqual(report['rows'][0]['classification'],'superseded_by_later_successful_snapshot');self.assertEqual(report['decisions']['prematch'],'no_current_size_failure_proven_do_not_change_limits');self.assertEqual(feed,original)
if __name__=='__main__':unittest.main()
