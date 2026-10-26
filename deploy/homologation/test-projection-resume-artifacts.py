import contextlib,hashlib,io,json,os,tempfile,unittest
from pathlib import Path
HERE=Path(__file__).parent
NS={'__name__':'tested'}
for name in ('resume-adl-api.py','repair-adl-snapshot.py','upgrade-partitioned-worker.py','execute-adl-cutover-aws.py'):
 exec((HERE/name).read_text().split("if __name__=='__main__':")[0],NS)

class ProjectionResume(unittest.TestCase):
 def test_artifacts_are_bound_to_preserved_snapshot_and_round_trip(self):
  with tempfile.TemporaryDirectory() as temp:
   backup=Path(temp);digest='a'*64;rehearsal_name='rehearsal-'+digest[:24];resume_name='projection-resume-20261026T1345Z'
   rehearsal=backup/rehearsal_name;rehearsal.mkdir(mode=0o700);spool_dir=rehearsal/'.full-snapshot-abc';spool_dir.mkdir(mode=0o700)
   def private(path,data):path.parent.mkdir(mode=0o700,parents=True,exist_ok=True);path.write_bytes(data);path.chmod(0o600);return path
   public=private(backup/'trade-feed.json',b'preserved-public-checkpoint');private(rehearsal/'trade-feed.json',public.read_bytes())
   spool=private(spool_dir/'response.private.json',b'preserved-snapshot-spool')
   prior=[{'operation':'offline.memory','stage':'snapshot.validate','rows':16000},{'operation':'offline.memory','stage':'snapshot.finalize','rows':16329},{'operation':'offline.memory','stage':'projection.build','rows':16329,'indexCounts':{'stateRows':18547}},{'operation':'offline.memory','stage':'projection.serialize','rows':16329,'indexCounts':{'stateRows':18547}}]
   private(backup/'oom-restore-attempt-0123456789abcdef.private.log',b''.join(json.dumps(r).encode()+b'\n' for r in prior));private(backup/'oom-restore.latest.json',json.dumps({'name':'oom-restore-attempt-0123456789abcdef.private.log'}).encode())
   sidecar_source=private(backup/('projection-rehearsal-'+digest[:24])/'projection.json.regular-checkpoint.json',b'private-regular-checkpoint')
   resume=backup/resume_name;resume.mkdir(mode=0o700);(resume/'input').mkdir(mode=0o700);(resume/'output').mkdir(mode=0o700)
   private(resume/'driver.mjs',b'test driver');NS['PROJECTION_RESUME_DRIVER_SHA256']=hashlib.sha256((resume/'driver.mjs').read_bytes()).hexdigest()
   os.link(public,resume/'input'/'trade-feed.json');os.link(sidecar_source,resume/'input'/'trade-feed.json.regular-checkpoint.json');os.link(sidecar_source,resume/'output'/'projection.json.regular-checkpoint.json')
   projection=private(resume/'output'/'projection.json',b'valid measured projection');side_hash=hashlib.sha256(sidecar_source.read_bytes()).hexdigest()
   receipt={'sha256':hashlib.sha256(projection.read_bytes()).hexdigest(),'bytes':projection.stat().st_size,'privateCheckpointSha256':side_hash,'stateRows':18547,'rows':18449,'measurements':{'bytesWritten':projection.stat().st_size,'serializeAndWriteMs':100,'writeAwaitMs':10,'writeCalls':1,'fsyncMs':2,'buildMs':1}}
   private(resume/'output'/'receipt.json',json.dumps(receipt).encode())
   private(resume/'serialize.log',json.dumps({'operation':'projection.resume.complete','receipt':receipt}).encode()+b'\n')
   private(resume/'readback.log',json.dumps({'operation':'projection.resume.readback','verified':True,'projection':{'integrityVerified':True,'sha256':receipt['sha256']},'stateRows':18547,'verifyMs':10,'privateRestoreMs':20}).encode()+b'\n')
   progress={'digest':digest,'dataBackupHashes':{'trade-feed.json':hashlib.sha256(public.read_bytes()).hexdigest()},'rehearsalDirectory':rehearsal_name,'preservedSpoolHash':hashlib.sha256(spool.read_bytes()).hexdigest()}
   image={'Config':{'Labels':{'eu.adl.partitioned.patch':digest}}}
   result=NS['verify_projection_resume_artifacts'](backup,progress,image,resume_name)
   self.assertTrue(result['verified']);self.assertEqual(result['stateRows'],18547);self.assertEqual(result['projectionBytes'],projection.stat().st_size)
   projection.write_bytes(b'tampered')
   with self.assertRaises(Exception):NS['verify_projection_resume_artifacts'](backup,progress,image,resume_name)

if __name__=='__main__':unittest.main()
