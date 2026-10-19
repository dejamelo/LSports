import contextlib,copy,datetime,hashlib,io,json,os,tempfile,types,unittest
from pathlib import Path
HERE=Path(__file__).parent
NS={'__name__':'tested'}
for name in ('resume-adl-api.py','repair-adl-snapshot.py','upgrade-partitioned-worker.py','execute-adl-cutover-aws.py'):exec((HERE/name).read_text().split("if __name__=='__main__':")[0],NS)
class Upgrade(unittest.TestCase):
 def test_prepare_activate_reuse_preserves_every_non_worker_field(self,resume_stopped=False):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);secure=root/'secure';secure.mkdir();backups=root/'backups';backups.mkdir();releases=root/'releases';release=releases/('a'*40);release.mkdir(parents=True);volume=root/'volume';volume.mkdir()
   original=secure/'old.json';original.write_text('{}');meta={'release':str(release),'composeOverrides':[str(original)]};(secure/'deployment.json').write_text(json.dumps(meta))
   (volume/'trade-feed.json').write_text('{"preserved":"checkpoint"}');journal=volume/'trade-feed.json.snapshot-aaaaaaaaaaaaaaaa.json';journal.write_text('{"nextAt":9999999999999,"due":{},"failures":{}}');journal_before=journal.read_bytes()
   handoff={'audit':{'status':'ok','workerLockAbsent':True,'matchingWorkerProcesses':0}};d=hashlib.sha256(json.dumps(handoff,sort_keys=True,separators=(',',':')).encode()).hexdigest();migration=secure/('cutover-'+d+'.json');migration.write_text(json.dumps({'digest':d,'startRequestedAtUTC':'2026-01-01T00:00:00Z','notBeforeUTC':'2026-01-01T00:00:00Z','journals':['preserved']}))
   files={path:'export const isolated=true;' for path in NS['PARTITION_FILES']};hashes={path:None for path in files};digest=hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest();image='adl-worker-partitioned:'+digest[:24]
   images={'base':{'Id':'sha256:'+('b'*64),'Config':{'Labels':{}}}};running=True;selected='base';calls=[]
   def model(args):
    result={'services':{'api':{'image':'api-unchanged'},'worker':{'image':'base','mem_limit':'4294967296','environment':{'NODE_OPTIONS':'--max-old-space-size=3072','LSPORTS_PASSWORD':'MUST_NEVER_PRINT','LSPORTS_INPLAY_SNAPSHOT_MAX_RESPONSE_MB':'128'}}},'networks':{'preserved':{}},'volumes':{'preserved':{}}}
    for arg in args:
     if str(arg).startswith(str(secure/'compose.partitioned-')):patch=json.loads(Path(arg).read_bytes())['services']['worker'];result['services']['worker']['image']=patch['image'];result['services']['worker']['environment'].update(patch['environment'])
    return result
   def states(service):return [{'id':'old-worker' if selected=='base' else 'new-worker','running':running}] if service=='worker' else [{'id':'api','health':'healthy'}]
   def run(args,**kw):
    nonlocal running,selected
    calls.append(args)
    if args[:3]==['docker','image','inspect']:return json.dumps([images[args[3]]]).encode()
    if args[:2]==['docker','tag']:images[args[3]]=images['base'];return b''
    if args[:2]==['docker','run']:return b'partitioned-offline-ok' if '--input-type=module' in args else json.dumps(hashes).encode()
    if args[:2]==['docker','build']:images[image]={'Id':'sha256:'+('c'*64),'Config':{'Labels':{'eu.adl.partitioned.patch':digest}}};return b''
    if args[:2]==['docker','inspect']:
     return json.dumps([{'Image':images[selected]['Id'],'HostConfig':{'Memory':4294967296},'Config':{'Env':['LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT=true']},'Mounts':[{'Destination':'/app/.runtime/feed','Type':'volume','RW':False,'Name':'feed'}]}]).encode()
    if args[:3]==['docker','volume','inspect']:return json.dumps([{'Mountpoint':str(volume),'Labels':{'com.docker.compose.project':'adl-homologation'}}]).encode()
    if args[:2]==['docker','kill']:running=False;return b''
    if 'up' in args:running=True;selected=image;return b''
    raise AssertionError('Unexpected operation')
   keys=('SECURE','BACKUPS','RELEASES','run','model','states','control_status','snapshot_host_memory','shutil','os');old={k:NS.get(k) for k in keys}
   NS.update(SECURE=secure,BACKUPS=backups,RELEASES=releases,run=run,model=model,states=states,control_status=lambda:200,snapshot_host_memory=lambda:12*1024**3,shutil=types.SimpleNamespace(**{**NS['shutil'].__dict__,'disk_usage':lambda _:types.SimpleNamespace(free=10*1024**3)}),os=types.SimpleNamespace(**{**os.__dict__,'geteuid':lambda:0}))
   def invoke(phase,base_hashes=hashes):
    out=io.StringIO();request={'phase':phase,'files':files,'baseHashes':base_hashes,'handoff':handoff,'freshAuditAt':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')}
    with contextlib.redirect_stdout(out):code=NS['upgrade_partitioned'](request)
    self.assertNotIn('MUST_NEVER_PRINT',out.getvalue());return code,json.loads(out.getvalue().splitlines()[-1])
   try:
    code,result=invoke('prepare',{**hashes,next(iter(hashes)):'bad'});self.assertEqual(code,2);self.assertEqual(result['reason'],'UPGRADE_BASE_SOURCES_CHANGED_NO_BLIND_PATCH');self.assertFalse(any('up' in c or c[:2]==['docker','kill'] for c in calls))
    code,result=invoke('prepare');self.assertEqual(code,0,result);self.assertTrue(result['offlineType38Verified']);self.assertTrue(running);self.assertFalse(any('up' in c or c[:2]==['docker','kill'] for c in calls))
    if resume_stopped:
     progress_file=next(secure.glob('partitioned-upgrade-*.json'));progress=json.loads(progress_file.read_bytes());progress['phase']='stop_requested';progress_file.write_text(json.dumps(progress));running=False
    code,result=invoke('activate');self.assertEqual(code,0,result);self.assertTrue(running);self.assertEqual(selected,image);self.assertEqual(journal.read_bytes(),journal_before)
    self.assertEqual(len([c for c in calls if c[:2]==['docker','kill']]),0 if resume_stopped else 1);self.assertEqual(len([c for c in calls if 'up' in c]),1)
    after=json.loads((secure/'deployment.json').read_bytes());self.assertEqual(after['composeOverrides'][0],str(original));self.assertEqual(len(after['composeOverrides']),2)
    self.assertEqual(model(NS['partition_base'](after))['services']['worker']['environment']['LSPORTS_INPLAY_SNAPSHOT_MAX_RESPONSE_MB'],'128');self.assertEqual(json.loads(migration.read_bytes())['journals'],['preserved'])
    code,result=invoke('prepare');self.assertEqual(code,0,result);code,result=invoke('activate');self.assertEqual(code,0,result);self.assertTrue(result['reused']);self.assertEqual(len([c for c in calls if 'up' in c]),1);self.assertEqual(len([c for c in calls if c[:2]==['docker','build']]),1)
    self.assertTrue(all(c[-1]=='worker' and '--no-deps' in c and '--pull' in c for c in calls if 'up' in c))
   finally:NS.update(old)
 def test_resume_after_already_requested_stop_does_not_signal_again(self):self.test_prepare_activate_reuse_preserves_every_non_worker_field(resume_stopped=True)
if __name__=='__main__':unittest.main()
