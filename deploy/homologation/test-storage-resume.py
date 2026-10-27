import importlib.util,io,json,runpy,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('proof',Path(__file__).with_name('test-pre-exit-recovery.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class StorageResume(unittest.TestCase):
 def test_insufficient_pre_stop_space_blocks_without_signals_or_deletion(self):
  ns=m.load();events=[];ns['emit']=lambda **r:events.append(r)
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);feed=root/'feed';feed.mkdir();backup=root/'backup';backup.mkdir()
   for name in ('trade-feed.json','trade-feed.json.regular-checkpoint.json','trade-feed.json.prematch.inbox.sqlite','trade-feed.json.prematch.inbox.sqlite-wal','trade-feed.json.inplay.inbox.sqlite','trade-feed.json.inplay.inbox.sqlite-wal'):(feed/name).write_bytes(b'original')
   info={'Mounts':[{'Destination':'/app/.runtime/feed','Source':str(feed)}]}
   with patch.object(ns['shutil'],'disk_usage',return_value=type('Usage',(),{'free':0})()):
    with self.assertRaisesRegex(RuntimeError,'STAGED_RECOVERY_DISK_HEADROOM_INSUFFICIENT_NO_COPY'):ns['storage_before_stop'](backup,info,{'digest':'c'*64},'c'*64)
   self.assertEqual((feed/'trade-feed.json').read_bytes(),b'original');self.assertFalse(events[-1]['workerStarted']);self.assertGreater(events[-1]['missingBytes'],0)
 def test_sufficient_space_permits_pre_stop_gate(self):
  ns=m.load();events=[];ns['emit']=lambda **r:events.append(r)
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);feed=root/'feed';feed.mkdir();backup=root/'backup';backup.mkdir()
   sizes={'trade-feed.json':1024**3,'trade-feed.json.regular-checkpoint.json':1024**3,'trade-feed.json.prematch.inbox.sqlite':512*1024**2,'trade-feed.json.prematch.inbox.sqlite-wal':8*1024**2,'trade-feed.json.inplay.inbox.sqlite':1024**2,'trade-feed.json.inplay.inbox.sqlite-wal':1024**2}
   for name,size in sizes.items():
    with (feed/name).open('wb') as f:f.truncate(size)
   with patch.object(ns['shutil'],'disk_usage',return_value=type('Usage',(),{'free':100*1024**3})()):ns['storage_before_stop'](backup,{'Mounts':[{'Destination':'/app/.runtime/feed','Source':str(feed)}]},{'digest':'c'*64},'c'*64)
   plan=next(r for r in events if r.get('stage')=='partitioned_upgrade.staged_recovery_preflight')
   self.assertEqual(plan['requiredFreeBeforeAnyCopyBytes'],plan['backupCopyBytes']+max(plan['rehearsalCopyBytes'],plan['outputReserveBytes'])+plan['safetyAndActivationReserveBytes']+plan['explicitExecutionMarginBytes'])
   self.assertLess(plan['requiredFreeBeforeAnyCopyBytes'],plan['backupCopyBytes']*10+4*1024**3)
 def test_stopped_worker_is_explicit_skipped_retirement_not_ssh_failure(self):
  ns=runpy.run_path(str(Path(__file__).with_name('inbox-retirement-diagnostic.py')))
  events=[];fn=ns['main'];fn.__globals__['worker']=lambda:{'Id':'a'*64,'State':{'Running':False}};fn.__globals__['emit']=lambda **r:events.append(r)
  fn();self.assertEqual(events[0]['stage'],'inbox_retirement_skipped');self.assertFalse(events[0]['integrationVerified'])
 def test_stop_disk_gate_precedes_provider_stop_and_signal(self):
  source=Path(__file__).with_name('upgrade-partitioned-worker.py').read_text();start=source.index("if progress['phase']=='prepared':",source.index('def upgrade_partitioned'))
  section=source[start:source.index("if progress['phase']=='stop_requested':",start)]
  self.assertLess(section.index('storage_before_stop(backup,old_container,progress,digest)'),section.index("stage='partitioned_upgrade.distribution_stop'"));self.assertLess(section.index('storage_before_stop(backup,old_container,progress,digest)'),section.index('request_graceful_signal_once'))
if __name__=='__main__':unittest.main()
