import json,tempfile,unittest,sqlite3,subprocess,time,hashlib
from pathlib import Path
HERE=Path(__file__).parent

def load():
 ns={'__name__':'test'}
 for name in ('resume-adl-api.py','repair-adl-snapshot.py','upgrade-partitioned-worker.py','execute-adl-cutover-aws.py'):
  exec(compile((HERE/name).read_text().split("if __name__=='__main__':")[0],name,'exec'),ns)
 exec(compile((HERE/'recovery-pressure-report.py').read_text().split('try:pressure_main()',1)[0],'recovery-pressure-report.py','exec'),ns)
 return ns
class Pressure(unittest.TestCase):
 def test_prefix_reads_no_events_or_checkpoint_graph(self):
  ns=load()
  with tempfile.TemporaryDirectory() as tmp:
   path=Path(tmp)/'feed.json';path.write_text('{"mode":"connected","updatedAt":"2026-10-22T12:00:00Z","connections":{"prematch":{"phase":"recovering"}},"events":THIS_IS_NOT_EVEN_JSON')
   result=ns['pressure_metadata'](path);self.assertEqual(result['connections']['prematch']['phase'],'recovering');self.assertNotIn('events',result)
 def test_snapshot_memory_diagnostic_preserves_cause_and_excludes_secrets(self):
  ns=load();result=ns['safe_feed_diagnostic']({'reason':'memory_budget_exceeded','memoryBudgetBytes':320*1024**2,'memoryHeadroomBytes':100,'password':'SECRET','snapshotMemory':{'heapLimitBytes':1024,'heapUsedBytes':1000,'heapHeadroomBytes':24,'availableMemoryBytes':100,'limitingFactor':'heap','credential':'SECRET'}})
  self.assertEqual(result['snapshotMemory']['limitingFactor'],'heap');self.assertEqual(result['memoryHeadroomBytes'],100);self.assertNotIn('SECRET',json.dumps(result))
 def test_metadata_prefix_rejects_events_before_connections(self):
  ns=load()
  with tempfile.TemporaryDirectory() as tmp:
   path=Path(tmp)/'feed.json';path.write_text('{"events":[]}')
   with self.assertRaisesRegex(RuntimeError,'CONNECTIONS_NOT_IN_BOUNDED_PREFIX'):ns['pressure_metadata'](path)
 def test_sql_cohorts_distinguish_old_retirement_from_new_arrivals(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);start=int(time.time()*1000)
   for lane in ('prematch','inplay'):
    with sqlite3.connect(root/('trade-feed.json.'+lane+'.inbox.sqlite')) as db:
     db.execute('CREATE TABLE inbox(id INTEGER PRIMARY KEY AUTOINCREMENT,received INTEGER)')
     db.executemany('INSERT INTO inbox(received) VALUES(?)',[(start-10000,)]*100+[(start+1,)]*10)
   script=(HERE/'recovery-pressure-inbox.mjs').read_text().replace('/app/.runtime/feed/',str(root)+'/').replace('/app/apps/worker/src/',str(HERE.resolve().parents[1]/'apps/worker/src')+'/')
   def probe(boundary):return json.loads(subprocess.check_output(['node','--input-type=module','-e',script,str(start),json.dumps(boundary)],stderr=subprocess.DEVNULL))
   first=probe({});self.assertEqual(first['lanes']['prematch']['receivedBeforeWorkerStart'],100);self.assertEqual(first['lanes']['prematch']['receivedSinceWorkerStart'],10)
   with sqlite3.connect(root/'trade-feed.json.prematch.inbox.sqlite') as db:
    db.execute('DELETE FROM inbox WHERE id<=20');db.executemany('INSERT INTO inbox(received) VALUES(?)',[(start+2,)]*5)
   path=root/'trade-feed.json.prematch.inbox.sqlite';before=hashlib.sha256(path.read_bytes()).hexdigest()
   second=probe({l:first['lanes'][l]['baselineHighId'] for l in ('prematch','inplay')})
   self.assertEqual(second['lanes']['prematch']['receivedBeforeWorkerStart'],80);self.assertEqual(second['lanes']['prematch']['receivedSinceWorkerStart'],15);self.assertEqual(second['lanes']['prematch']['arrivedSinceFirstSample'],5);self.assertEqual(second['lanes']['prematch']['pendingCheckpointRows'],95);self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(),before)
if __name__=='__main__':unittest.main()
