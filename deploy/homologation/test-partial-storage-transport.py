import importlib.util,json,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('inspect_target',Path(__file__).with_name('inspect-partial-storage-transport.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class TargetedRead(unittest.TestCase):
 def test_transport_capacity_and_error_redacted(self):
  rows=[]
  for r in ({'operation':'inbox.intake_capacity','stage':'paused','bytes':2147483600},{'operation':'amqp.connection','reason':'connection_closed'},{'operation':'distribution.status','reason':'timeout','timeoutMs':20000}):rows.append('2026-10-24T03:30:00Z '+json.dumps({'lane':'prematch','password':'SECRET','message':'SECRET',**r}))
  out=m.transport('\n'.join(rows));self.assertEqual(out['capacityEvents'][0]['stage'],'paused');self.assertEqual(len(out['lifecycleAndErrors']),2);self.assertNotIn('SECRET',json.dumps(out))
 def test_classifies_inputs_without_authorizing_cleanup(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp)
   for name in ('trade-feed.json','trade-feed.json.regular-checkpoint.json','trade-feed.json.prematch.inbox.sqlite','trade-feed.json.7.tmp','response.private.json'):(root/name).write_bytes(b'preserved')
   rows=m.inputs(root);self.assertEqual(len(rows),5);self.assertTrue(all(not r['safeToDelete'] for r in rows));self.assertEqual(sum(r['logicalBytes'] for r in rows),45)
 def test_bounded_metadata_never_reads_event_payload(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp)/'feed';p.write_text('{"mode":"connected","connections":{"prematch":{"phase":"recovering","ingressProgress":{"intakePaused":true,"bytes":2147483600}}},"events":'+('SECRET'*200000))
   r=m.connection_metadata(p);self.assertTrue(r['ingress']['intakePaused']);self.assertNotIn('SECRET',json.dumps(r));self.assertTrue(r['evidenceIsPersistedMetadataNotLiveActor'])
 def test_volume_bound_capacity_recommendation_does_not_mutate(self):
  fs={'filesystems':[{'source':'/dev/nvme0n1p1','target':'/','fstype':'ext4'}]};devices={'blockdevices':[{'type':'disk','name':'nvme0n1','size':240*1024**3,'serial':'vol03fa30ff2fc37a28e','children':[{'name':'nvme0n1p1','type':'part'}]}]}
  r=m.storage_action(fs,devices,45844828160,78060466686);self.assertEqual(r['minimumEbsGiB'],271);self.assertEqual(r['suggestedEbsGiB'],288);self.assertFalse(r['capacityChangeExecuted'])
  devices['blockdevices'][0]['serial']='different';self.assertEqual(m.storage_action(fs,devices,1,100)['status'],'volume_serial_unverified_no_action')
if __name__=='__main__':unittest.main()
