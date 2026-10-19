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
 def test_merge_never_shortens_and_preserves_remote_evidence(self):
  old={'nextAt':400,'due':{'4511:snapshot.events':900},'failures':{'a':4},'lastRequest':{'pid':7}}
  incoming={'nextAt':200,'due':{'4511:snapshot.events':300,'4510:snapshot.events':500},'failures':{'a':1}}
  merged=NS['merge_schedule'](old,incoming)
  self.assertEqual(merged['nextAt'],400);self.assertEqual(merged['due'],{'4511:snapshot.events':900,'4510:snapshot.events':500});self.assertEqual(merged['failures']['a'],4);self.assertEqual(merged['lastRequest'],{'pid':7})
  self.assertEqual(old['due'],{'4511:snapshot.events':900})
 def test_invalid_schedule_rejected(self):
  for value in ({}, {'nextAt':float('nan'),'due':{},'failures':{}},{'nextAt':0,'due':{'x':-1},'failures':{}}):
   with self.assertRaisesRegex(RuntimeError,'INVALID_SCHEDULE'):NS['schedule_checked'](value)

 def test_snapshot_success_requires_new_sessions_not_old_checkpoint_or_keepalive(self):
  with tempfile.TemporaryDirectory() as temporary:
   folder=Path(temporary);now=NS['datetime'].datetime.now(NS['datetime'].timezone.utc).isoformat().replace('+00:00','Z')
   old='2026-01-01T00:00:00Z'
   lane={'phase':'connected','lastSnapshotAt':now,'session':{'startedAt':old},'recoveryProgress':{'regularSnapshotReady':True}}
   feed={'updatedAt':now,'connections':{'prematch':copy.deepcopy(lane),'inplay':copy.deepcopy(lane)},'events':[]}
   prior=NS['states'];NS['states']=lambda service:[{'running':True}]
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
   finally:NS['states']=prior
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
    result={'services':{'api':{'image':'preserved'},'worker':{'mem_limit':4294967296,'environment':{'ADL_CAPACITY_APPROVED':'no','ADL_MAC_WORKER_STOPPED':'no','ADL_SUPPLIER_NOT_BEFORE_UTC':''}}}}
    for arg in base:
     if str(arg).startswith(str(secure/'compose.cutover-')):result['services']['worker']['environment'].update(json.loads(Path(arg).read_text())['services']['worker']['environment'])
    return result
   ns=NS;previous={k:ns.get(k) for k in ['SECURE','RELEASES','BACKUPS','run','model','states','os']}
   test_os=types.SimpleNamespace(**os.__dict__);test_os.geteuid=lambda:0;test_os.chown=lambda *args:None
   ns.update(os=test_os,SECURE=secure,RELEASES=releases,BACKUPS=backups,run=run,model=model,states=lambda service:[{'id':'api','health':'healthy'}] if service=='api' else [])
   def call(action):
    source={'action':action,'handoff':handoff,'freshAuditAt':ns['datetime'].datetime.now(ns['datetime'].timezone.utc).isoformat().replace('+00:00','Z')}
    old=ns['sys'].stdin;ns['sys'].stdin=io.TextIOWrapper(io.BytesIO(json.dumps(source).encode()));out=io.StringIO()
    try:
     with contextlib.redirect_stdout(out):code=ns['cutover_main']()
     return code,json.loads(out.getvalue())
    finally:ns['sys'].stdin=old
   try:
    code,result=call('import');self.assertEqual(code,0,result);self.assertEqual(result['journals'],1)
    target=vol/('trade-feed.json'+name);self.assertEqual(target.stat().st_uid,1000);self.assertEqual(target.stat().st_mode&0o777,0o600)
    # An updated coordinator deadline must prevent start; no locks removed or gates written.
    target.write_text(json.dumps({**schedule,'nextAt':(ns['time'].time()+300)*1000}))
    code,result=call('start');self.assertEqual(code,2);self.assertEqual(result['reason'],'COOLDOWN_NOT_ELAPSED');self.assertEqual(json.loads((secure/'deployment.json').read_text()),meta)
    target.write_text(json.dumps(schedule));code,result=call('start');self.assertEqual(code,0,result)
    after=json.loads((secure/'deployment.json').read_text());self.assertEqual(after['composeOverrides'][0],str(override));self.assertEqual(len(after['composeOverrides']),2)
    starts=[c for c in commands if 'up' in c];self.assertEqual(len(starts),1);self.assertEqual(starts[0][-1],'worker');self.assertIn('--no-deps',starts[0]);self.assertIn('--no-build',starts[0]);self.assertIn('never',starts[0]);self.assertIn(str(override),starts[0])
   finally:ns.update(previous)
if __name__=='__main__':unittest.main()
