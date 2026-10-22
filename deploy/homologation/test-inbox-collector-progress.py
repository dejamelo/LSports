import json,os,shutil,subprocess,sys,tempfile,unittest
from pathlib import Path
HERE=Path(__file__).parent
class CollectorProgress(unittest.TestCase):
 def test_progress_visible_and_persisted_before_ssh_completion(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);stage=root/'stage';stage.mkdir();home=root/'home';(home/'Downloads').mkdir(parents=True);(home/'Downloads'/'LotteryUnitKey.pem').write_text('ISOLATED TEST FIXTURE')
   for name in ['collect-recovery-inbox-identity.mjs','remote-helper-transport.mjs','remote-helper-bootstrap.py','pre-exit-replay-proof.mjs','resume-adl-api.py','inspect-cutover-aws.py','patch-adl-worker-image.py','repair-adl-snapshot.py','upgrade-partitioned-worker.py','execute-adl-cutover-aws.py','recovery-inbox-identity.py']:shutil.copyfile(HERE/name,stage/name)
   tools=root/'bin';tools.mkdir();ssh=tools/'ssh';ssh.write_text('#!'+sys.executable+'\nimport sys,json,time\njson.load(sys.stdin)\nprint(json.dumps({"operation":"recovery_inbox_identity_progress","stage":"node_descriptor_identities"}),flush=True)\ntime.sleep(0.5)\nprint(json.dumps({"operation":"recovery_inbox_identity","workerId":"isolated","processes":[],"sqliteQueriesExecuted":0}),flush=True)\n');ssh.chmod(0o700)
   proc=subprocess.Popen(['node',str(stage/'collect-recovery-inbox-identity.mjs')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={**os.environ,'HOME':str(home),'PATH':str(tools)+os.pathsep+os.environ['PATH']})
   try:
    first=json.loads(proc.stdout.readline());self.assertEqual(first['stage'],'ssh_connect')
    second=json.loads(proc.stdout.readline());self.assertEqual(second['stage'],'node_descriptor_identities');self.assertIsNone(proc.poll())
    progress=(stage/'recovery-inbox-identity-progress.jsonl').read_text();self.assertIn('node_descriptor_identities',progress)
    _,err=proc.communicate(timeout=10);self.assertEqual(proc.returncode,0,err);self.assertEqual(json.loads((stage/'recovery-inbox-identity.json').read_text())['workerId'],'isolated')
   finally:
    if proc.poll() is None:proc.kill();proc.communicate()
 def test_guard_rejects_duplicate_and_releases_after_close(self):
  ns={'__name__':'test'}
  for name in ('resume-adl-api.py','repair-adl-snapshot.py','upgrade-partitioned-worker.py','execute-adl-cutover-aws.py'):exec(compile((HERE/name).read_text().split("if __name__=='__main__':")[0],name,'exec'),ns)
  exec(compile((HERE/'recovery-inbox-identity.py').read_text().split('import signal')[0],'recovery-inbox-identity.py','exec'),ns)
  with tempfile.TemporaryDirectory() as tmp:
   path=Path(tmp)/'probe.lock';first=ns['identity_guard'](path)
   try:
    with self.assertRaisesRegex(RuntimeError,'COLLECTOR_ALREADY_RUNNING'):ns['identity_guard'](path)
   finally:os.close(first)
   second=ns['identity_guard'](path);os.close(second)
if __name__=='__main__':unittest.main()
