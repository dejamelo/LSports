"""Read-only stopped-container diagnostics; no broker/API calls or database opens."""
import contextlib,io,json,subprocess,sys,types,unittest
from pathlib import Path
HERE=Path(__file__).parent
NS={'__name__':'tested'}
for name in ('resume-adl-api.py','execute-adl-cutover-aws.py'):
 exec((HERE/name).read_text().split("if __name__=='__main__':")[0],NS)
class Report(unittest.TestCase):
 def test_stopped_worker_distinguishes_preventive_rejection_from_oom(self):
  self.check(False)
 def test_docker_oom_is_explicit_not_inferred_from_137(self):
  self.check(True)
 def check(self,oom):
  container={'id':'a'*64,'state':'exited','running':False,'exitCode':137 if oom else 2,'oomKilled':oom}
  inspected={'Config':{'Labels':{'com.docker.compose.project':'adl-homologation','com.docker.compose.service':'worker'}},'State':{'Status':'exited','ExitCode':container['exitCode'],'OOMKilled':oom,'StartedAt':'2026-10-20T21:00:00Z','FinishedAt':'2026-10-20T21:30:00Z'},'HostConfig':{'Memory':4294967296},'Mounts':[],'Image':'sha256:'+'b'*64}
  calls=[];log='SECRET_PASSWORD memory_budget_exceeded\n at file:///app/apps/worker/src/persistence.ts:35:12'
  def run(args,**kw):
   calls.append(args);self.assertEqual(args,['docker','inspect',container['id']]);return json.dumps([inspected]).encode()
  def popen(args,**kw):
   calls.append(args);self.assertEqual(args[:2],['docker','logs'])
   return subprocess.Popen([sys.executable,'-c','print('+repr(log)+')'],**kw)
  old={k:NS.get(k) for k in ('run','states','subprocess','existing_recovery_timeline')}
  NS.update(run=run,states=lambda _: [container],subprocess=types.SimpleNamespace(Popen=popen,TimeoutExpired=subprocess.TimeoutExpired),existing_recovery_timeline=lambda consumers,window:{'window':window,'records':[]})
  try:
   out=io.StringIO()
   with contextlib.redirect_stdout(out):self.assertEqual(NS['worker_exit_report'](),0)
   text=out.getvalue();self.assertNotIn('SECRET_PASSWORD',text)
   report=json.loads(text);self.assertEqual(report['providerRequests'],0);self.assertFalse(report['workerRestarted'])
   row=report['workers'][0];self.assertEqual(row['finishedAtUTC'],'2026-10-20T21:30:00Z');self.assertEqual(row['exitCode'],container['exitCode'])
   self.assertIn('preventive_memory_budget_rejection',row['finalLogSignals'])
   self.assertEqual(row['oomConclusion'],'docker_oom_confirmed' if oom else 'not_proven')
   self.assertEqual(row['finalStackFrames'],[{'source':'apps/worker/src/persistence.ts','line':35,'column':12}])
   self.assertTrue(all(c[:2] in (['docker','inspect'],['docker','logs']) for c in calls))
  finally:NS.update(old)
if __name__=='__main__':unittest.main()
