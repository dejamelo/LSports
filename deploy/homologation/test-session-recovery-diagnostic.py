import unittest,json,runpy,io,contextlib,subprocess,types
from pathlib import Path
from unittest.mock import patch
class ReadOnly(unittest.TestCase):
 def test_stderr_errors_preserved_and_only_read_commands_used(self):
  calls=[]
  def run(args,**kw):
   calls.append(args)
   if args[1]=='inspect':out=json.dumps([{'Id':'a'*64,'Image':'sha256:'+'b'*64,'Config':{'Image':'candidate'},'State':{'Running':True,'OOMKilled':False,'ExitCode':0,'StartedAt':'start','FinishedAt':'zero'},'HostConfig':{'Memory':6442450944}}]).encode();err=b''
   elif args[1]=='logs':out=b'2026-10-23T01:08:00.000Z {"operation":"file.persist","writes":6,"message":"SECRET"}\n';err=b'2026-10-23T01:07:00.000Z {"operation":"inbox.actor_failure","lane":"prematch","ingressStage":"amqp.connect","errorType":"Error","errorCode":"ECONNREFUSED","message":"SECRET"}\n2026-10-23T01:06:30.782Z {"lane":"prematch","operation":"amqp.connection","category":"network","reason":"connection_closed","message":"SECRET"}\n'
   else:out=b'PID PPID STAT COMMAND\n1 0 S node\n';err=b''
   return types.SimpleNamespace(returncode=0,stdout=out,stderr=err)
  output=io.StringIO()
  with patch('subprocess.run',side_effect=run),contextlib.redirect_stdout(output):runpy.run_path(str(Path(__file__).with_name('session-recovery-diagnostic.py')))
  rows=[json.loads(l) for l in output.getvalue().splitlines()];records=[r['record'] for r in rows if r['stage']=='recent_lifecycle']
  self.assertEqual(records[0]['reason'],'connection_closed');self.assertEqual(records[-1]['writes'],6);self.assertEqual(records[1]['ingressStage'],'amqp.connect');self.assertEqual(records[1]['errorCode'],'ECONNREFUSED');self.assertNotIn('SECRET',output.getvalue());self.assertEqual([c[1] for c in calls],['inspect','logs','top']);self.assertEqual(rows[-1]['signalsSent'],0)
if __name__=='__main__':unittest.main()
