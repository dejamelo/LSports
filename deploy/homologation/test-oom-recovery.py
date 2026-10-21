import json,os,sqlite3,tempfile,unittest
from pathlib import Path
HERE=Path(__file__).parent
NS={'__name__':'tested'}
for name in ('resume-adl-api.py','repair-adl-snapshot.py','upgrade-partitioned-worker.py','execute-adl-cutover-aws.py'):exec((HERE/name).read_text().split("if __name__=='__main__':")[0],NS)
class OomRecovery(unittest.TestCase):
 def test_offline_failure_reports_cause_without_log_values(self):
  with tempfile.TemporaryDirectory() as tmp:
   backup=Path(tmp);backup.chmod(0o700);(backup/'oom-restore.private.log').write_bytes(b'SECRET_TOKEN memory_budget_exceeded heap out of memory')
   result=NS['oom_restore_log_summary'](backup);self.assertEqual(result['signals'],['node_heap_exhausted','preventive_memory_budget_rejection']);self.assertNotIn('SECRET_TOKEN',json.dumps(result))
 def test_targeted_rehearsal_report_is_readonly_and_sanitized(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);backup=root/'adl-partitioned-upgrade-example';backup.mkdir(mode=0o700);secure=root/'secure';secure.mkdir()
   log=backup/'oom-restore.private.log';log.write_text("SECRET_TOKEN Snapshot completo rechazado: invalid_markets_shape.\n snapshotValidation: { detail: 'invalid_markets_shape', fieldPath: 'Markets', actualType: 'object', fixtureId: 20563979 }\n at file:///app/apps/worker/src/persistence.ts:201:12")
   receipt=secure/'partitioned-upgrade-example.json';receipt.write_text(json.dumps({'backup':str(backup),'phase':'stopped','snapshotMemoryVerified':True,'preservedSpoolHash':'a'*64}))
   old={k:NS.get(k) for k in ('BACKUPS','SECURE')};NS.update(BACKUPS=root,SECURE=secure)
   before={p:p.read_bytes() for p in (log,receipt)}
   try:
    result=NS['preserved_rehearsal_report'](str(backup))
    self.assertEqual(result['validationDetails'],['invalid_markets_shape']);self.assertEqual(result['fieldPaths'],['Markets']);self.assertEqual(result['actualTypes'],['object']);self.assertEqual(result['fixtureIds'],[20563979]);self.assertEqual(result['failureOrigin'],'checkpoint_restore');self.assertFalse(result['offlineRestoreVerified']);self.assertNotIn('SECRET_TOKEN',json.dumps(result))
    self.assertEqual(before,{p:p.read_bytes() for p in before})
    receipt.unlink()
    with self.assertRaisesRegex(Exception,'REHEARSAL_RECEIPT_NOT_UNIQUE'):NS['preserved_rehearsal_report'](str(backup))
   finally:NS.update(old)
 def test_build_log_reports_source_resolution_without_secrets_or_mutation(self):
  with tempfile.TemporaryDirectory() as tmp:
   backup=Path(tmp);backup.chmod(0o700);context=backup/('checkpoint-fix-'+'a'*24);context.mkdir();dockerfile=context/'Dockerfile';dockerfile.write_text('FROM sha256:'+'b'*64+'\nUSER node\n')
   log=backup/'checkpoint-fix-build.private.log';log.write_text('SECRET_PASSWORD https://private.invalid/?token=SECRET\nERROR: failed to resolve source metadata for docker.io/library/sha256:abc: pull access denied, repository does not exist\n')
   before={p:p.read_bytes() for p in (dockerfile,log)};report=NS['checkpoint_build_log_summary'](backup)
   self.assertTrue(report['recognizedError']);self.assertIn('IMAGE_ID_SOURCE_RESOLUTION_FAILED',[r['reason'] for r in report['records']]);self.assertNotIn('SECRET',json.dumps(report));self.assertNotIn('private.invalid',json.dumps(report));self.assertEqual(report['contexts'][0]['command'][:5],['docker','build','--network','none','--pull=false']);self.assertEqual(before,{p:p.read_bytes() for p in before})
 def test_unrecognized_build_error_does_not_leak_raw_line(self):
  with tempfile.TemporaryDirectory() as tmp:
   backup=Path(tmp);backup.chmod(0o700);(backup/'checkpoint-fix-build.private.log').write_text('ERROR secret arbitrary failure')
   report=NS['checkpoint_build_log_summary'](backup);self.assertFalse(report['recognizedError']);self.assertNotIn('secret',json.dumps(report))
 def test_durable_inboxes_checked_without_deleting_confirmed_rows(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp)
   for lane in ('prematch','inplay'):
    db=sqlite3.connect(root/('trade-feed.json.'+lane+'.inbox.sqlite'));db.execute('CREATE TABLE inbox(id INTEGER PRIMARY KEY,content BLOB)');db.execute("INSERT INTO inbox VALUES(1,x'010203')");db.commit();db.close()
   before={p.name:p.read_bytes() for p in root.glob('*.sqlite')}
   result=NS['verify_oom_inboxes'](root);self.assertEqual([r['pendingRows'] for r in result],[1,1])
   self.assertEqual(before,{p.name:p.read_bytes() for p in root.glob('*.sqlite')})
 def test_archive_requires_dead_verified_owner_and_no_other_volume_writer(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);directory=root/'feed';directory.mkdir();backup=root/'backup';backup.mkdir(mode=0o700);lock=directory/'trade-feed.json.lock';lock.write_bytes(b'7')
   worker={'id':'a'*64,'running':False,'oomKilled':True,'exitCode':137}
   old={k:NS.get(k) for k in ('run','states')}
   NS.update(run=lambda *a,**k:b'',states=lambda _:[worker])
   try:
    with self.assertRaises(Exception):NS['archive_oom_locks'](directory,backup,{'oomContainerId':'wrong'},[worker])
    self.assertTrue(lock.exists())
    with self.assertRaises(Exception):NS['archive_oom_locks'](directory,backup,{'oomContainerId':worker['id']},[{**worker,'running':True}])
    self.assertTrue(lock.exists())
    NS['archive_oom_locks'](directory,backup,{'oomContainerId':worker['id']},[worker]);self.assertFalse(lock.exists());self.assertEqual((backup/'oom-archived-trade-feed.json.lock').read_bytes(),b'7')
    NS['archive_oom_locks'](directory,backup,{'oomContainerId':worker['id']},[worker])
   finally:NS.update(old)
if __name__=='__main__':unittest.main()
