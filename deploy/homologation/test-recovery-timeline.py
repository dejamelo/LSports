import contextlib,io,json,tempfile,unittest
from pathlib import Path
NS={'__name__':'tested'}
for name in ('resume-adl-api.py','execute-adl-cutover-aws.py'):
 exec((Path(__file__).parent/name).read_text().split("if __name__=='__main__':")[0],NS)
class Timeline(unittest.TestCase):
 def test_existing_logs_are_sanitized_and_no_runtime_control_is_called(self):
  calls=[]
  rows=[{'operation':'file.persist','writes':7,'lastDurationMs':2100,'password':'SECRET'}, {'operation':'snapshot.events','status':'full_spool_progress','stage':'validate','validatedRows':300,'body':'SECRET'}, {'operation':'feed.coverage','coverage':{'inplay':{'messagesByType':{'31':900,'32':10,'SECRET':3}}}}, {'operation':'amqp.connection','category':'unexpected','amqpCode':320,'message':'SECRET'}]
  class Process:
   def __init__(self,args,stdout,stderr):
    calls.append(args)
    for row in rows:stdout.write(b'2026-10-20T09:26:04.172Z '+json.dumps(row).encode()+b'\n')
    stdout.flush()
   def wait(self,timeout):return 0
  original=NS['subprocess'].Popen
  try:
   NS['subprocess'].Popen=Process
   result=NS['existing_recovery_timeline']([{'id':'a'*64}],{'fromUTC':'2026-10-20T09:23:00Z','toUTC':'2026-10-20T09:54:00Z'})
  finally:NS['subprocess'].Popen=original
  self.assertEqual(len(result['records']),4);self.assertNotIn('SECRET',json.dumps(result));self.assertEqual(calls[0][:2],['docker','logs']);self.assertFalse(result['eventLoopLagRecorded']);self.assertFalse(result['amqpWireHeartbeatRecorded'])
 def test_invalid_or_unbounded_window_is_refused(self):
  for window in ({'fromUTC':'SECRET','toUTC':'SECRET'},{'fromUTC':'2026-10-20T00:00:00Z','toUTC':'2026-10-20T09:54:00Z'}):
   with self.assertRaises(RuntimeError):NS['existing_recovery_timeline']([],window)
if __name__=='__main__':unittest.main()
