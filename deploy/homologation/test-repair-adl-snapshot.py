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
 def test_graceful_worker_only_apply_preserves_journal_image_overrides_and_memory(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);secure=root/'secure';secure.mkdir();releases=root/'releases';releases.mkdir();release=releases/('a'*40);release.mkdir();backups=root/'backups';backups.mkdir();directory=root/'volume';directory.mkdir()
   override=secure/'old.json';override.write_text('{}');meta={'release':str(release),'composeOverrides':[str(override)]};(secure/'deployment.json').write_text(json.dumps(meta))
   journal=directory/'trade-feed.json.snapshot-aaaaaaaaaaaaaaaa.json';journal.write_text(json.dumps({'nextAt':0,'due':{'4510:snapshot.events':0},'failures':{}}));original=journal.read_bytes()
   error={'reason':'response_size_limit','category':'response_limit','operation':'snapshot.events','httpStatus':200,'responseLimitBytes':134217728}
   (directory/'trade-feed.json').write_text(json.dumps({'connections':{'inplay':{'lastSnapshotDiagnostic':error}}}))
   handoff={'audit':{'status':'ok','workerLockAbsent':True,'matchingWorkerProcesses':0}}
   digest=hashlib.sha256(json.dumps(handoff,sort_keys=True,separators=(',',':')).encode()).hexdigest();receipt=secure/('cutover-'+digest+'.json');receipt.write_text(json.dumps({'startRequestedAtUTC':'2026-01-01T00:00:00Z','notBeforeUTC':'2026-01-01T00:00:00Z'}))
   running=True;calls=[];hashes={k:'verified' for k in ('provider.ts','diagnostics.ts','snapshot-capacity.ts')}
   observed={'sourceHashes':hashes,'capacities':{'prematch':{'limitBytes':268435456},'inplay':{'limitBytes':134217728}},'proposed':{'allowed':True},'cgroup':{'max':str(4*1024**3),'current':str(500*1024**2)}}
   def states(_):return [{'id':'b'*64,'running':running}]
   def run(args,**kwargs):
    nonlocal running
    calls.append(args)
    if args[:3]==['docker','image','inspect']:return json.dumps([{'Id':'image-id'}]).encode()
    if args[:3]==['docker','volume','inspect']:return json.dumps([{'Labels':{'com.docker.compose.project':'adl-homologation'},'Mountpoint':str(directory)}]).encode()
    if args[:2]==['docker','inspect']:return json.dumps([{'Image':'image-id','HostConfig':{'Memory':4294967296},'Mounts':[{'Destination':'/app/.runtime/feed','Type':'volume','RW':True,'Name':'test-volume'}]}]).encode()
    if args[:2]==['docker','exec']:return json.dumps(observed).encode()
    if args[:2]==['docker','kill']:running=False
    if 'up' in args:running=True
    return b''
   def model(args):
    value={'services':{'api':{'image':'api-unchanged'},'worker':{'mem_limit':4294967296,'image':'unchanged','environment':{'LSPORTS_PREMATCH_SNAPSHOT_MAX_RESPONSE_MB':'256','LSPORTS_INPLAY_SNAPSHOT_MAX_RESPONSE_MB':'128','NODE_OPTIONS':'--max-old-space-size=3072'}}}}
    for arg in args:
     if str(arg).startswith(str(secure/'compose.snapshot-')):value['services']['worker']['environment'].update(json.loads(Path(arg).read_bytes())['services']['worker']['environment'])
    return value
   old={k:NS.get(k) for k in ['SECURE','RELEASES','BACKUPS','states','run','model','control_status','feed_evidence','os']};NS.update(os=types.SimpleNamespace(**{**os.__dict__,'geteuid':lambda:0}),SECURE=secure,RELEASES=releases,BACKUPS=backups,states=states,run=run,model=model,control_status=lambda:200,feed_evidence=lambda *a:{'recentErrors':[]})
   request={'handoff':handoff,'freshAuditAt':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),'sourceHashes':hashes}
   try:
    # Memory refusal occurs before any stop or configuration write.
    observed['proposed']['allowed']=False;out=io.StringIO()
    with contextlib.redirect_stdout(out):code=NS['repair_snapshot'](request)
    self.assertEqual(code,2);self.assertIn('MEMORY_ADMISSION_REFUSED',out.getvalue());self.assertTrue(running);self.assertFalse(any(c[:2]==['docker','kill'] for c in calls))
    observed['proposed']['allowed']=True;out=io.StringIO()
    with contextlib.redirect_stdout(out):code=NS['repair_snapshot'](request)
    self.assertEqual(code,0,out.getvalue());self.assertTrue(running);self.assertEqual(journal.read_bytes(),original)
    self.assertEqual(len([c for c in calls if c[:2]==['docker','kill']]),1);self.assertTrue(all('SIGTERM' in c for c in calls if c[:2]==['docker','kill']))
    starts=[c for c in calls if 'up' in c];self.assertEqual(len(starts),1);self.assertEqual(starts[0][-1],'worker');self.assertIn('--no-deps',starts[0]);self.assertIn('--no-build',starts[0])
    current=json.loads((secure/'deployment.json').read_bytes());self.assertEqual(current['composeOverrides'][0],str(override));effective=model(starts[0]);self.assertEqual(effective['services']['worker']['environment']['LSPORTS_INPLAY_SNAPSHOT_MAX_RESPONSE_MB'],'256');self.assertEqual(effective['services']['worker']['image'],'unchanged');self.assertEqual(effective['services']['worker']['mem_limit'],4294967296)
    self.assertEqual(len(json.loads(receipt.read_bytes())['capacityRestarts']),1)
   finally:NS.update(old)
if __name__=='__main__':unittest.main()
