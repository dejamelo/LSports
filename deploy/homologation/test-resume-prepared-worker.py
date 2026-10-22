import hashlib,json,os,tempfile,unittest
from pathlib import Path
HERE=Path(__file__).parent

def namespace():
 ns={'__name__':'tested'}
 for name in ('resume-adl-api.py','repair-adl-snapshot.py','upgrade-partitioned-worker.py','execute-adl-cutover-aws.py'):exec((HERE/name).read_text().split("if __name__=='__main__':")[0],ns)
 return ns

class ResumePrepared(unittest.TestCase):
 def exercise(self,mode='valid'):
  ns=namespace()
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);secure=root/'secure';secure.mkdir(mode=0o700);backups=root/'backups';backups.mkdir(mode=0o700);backup=backups/'adl-partitioned-upgrade-oqxi48jd';backup.mkdir(mode=0o700)
   marker=backup/'preserved';marker.write_bytes(b'checkpoint inbox and WAL must stay untouched')
   prepared={name:'export const prepared=true;\n' for name in ns['PARTITION_FILES']};digest=hashlib.sha256(json.dumps(prepared,sort_keys=True,separators=(',',':')).encode()).hexdigest();image='adl-worker-partitioned:'+digest[:24];image_id='sha256:'+'c'*64
   record={'digest':digest,'image':image,'backup':str(backup),'phase':'stop_requested','supplierStoppedBeforeConsumer':True,'oldContainer':'a'*64,'baseImageId':'sha256:'+'b'*64}
   path=secure/('partitioned-upgrade-'+digest[:24]+'.json');path.write_text(json.dumps(record));path.chmod(0o600);original=path.read_bytes();calls=[];output=[]
   if mode=='missing':path.unlink()
   if mode=='duplicate':
    other=secure/('partitioned-upgrade-'+'d'*24+'.json');other.write_text(json.dumps(record));other.chmod(0o600)
   if mode=='identity_missing':
    changed={**record};changed.pop('oldContainer');path.write_text(json.dumps(changed))
   def run(args,**kw):
    calls.append(args)
    if args[:3]==['docker','image','inspect']:
     return json.dumps([{'Id':image_id,'Config':{'Labels':{'eu.adl.partitioned.patch':'0'*64 if mode=='wrong_label' else digest}}}]).encode()
    if args[:2]==['docker','run']:
     self.assertIn('none',args);self.assertIn('--read-only',args);self.assertIn(image_id,args)
     return json.dumps({**prepared,next(iter(prepared)):'tampered'} if mode=='wrong_source' else prepared).encode()
    raise AssertionError('unexpected mutation')
   ns.update(SECURE=secure,BACKUPS=backups,run=run,emit=lambda **r:output.append(r))
   request={'resumeBackup':str(backup),**({} if mode=='remote_lookup' else {'resumePreparedImage':image})};candidate={name:'new executor source, not the prepared image' for name in prepared}
   try:result=ns['resolve_prepared_upgrade'](request,candidate)
   except RuntimeError:
    self.assertNotIn(mode,('valid','remote_lookup'));raise
   self.assertIn(mode,('valid','remote_lookup'));found,saved,files=result;self.assertEqual(found,path);self.assertEqual(saved,record);self.assertEqual(files,prepared);self.assertNotEqual(files,candidate);self.assertEqual(path.read_bytes(),original);self.assertEqual(marker.read_bytes(),b'checkpoint inbox and WAL must stay untouched')
   self.assertFalse(output[-1]['candidateFilesMatchPrepared']);self.assertTrue(output[-1]['preparedSourceReused']);self.assertFalse(any('build' in call or 'kill' in call for call in calls));self.assertEqual(saved['phase'],'stop_requested')
   clock=[0];samples=[]
   ns['watch_upgrade_stop'](lambda:{'running':False,'files':[],'records':[]},samples.append,now=lambda:clock[0],sleep=lambda sec:self.fail('already exited worker must not wait'))
   self.assertEqual(samples[-1]['samples'][-1]['assessment'],'exited');self.assertFalse(samples[-1]['forceStopEvidenceVerified'])
 def test_interrupted_stop_resolves_original_receipt_despite_new_executor_sources(self):self.exercise()
 def test_missing_local_image_is_recovered_from_unique_original_protected_receipt(self):self.exercise('remote_lookup')
 def test_missing_original_never_fabricates_receipt(self):
  with self.assertRaisesRegex(RuntimeError,'RESUME_ORIGINAL_RECEIPT_NOT_FOUND'):self.exercise('missing')
 def test_duplicate_receipts_require_identity_resolution(self):
  with self.assertRaisesRegex(RuntimeError,'RESUME_ORIGINAL_RECEIPT_NOT_UNIQUE'):self.exercise('duplicate')
 def test_prepared_image_label_must_match_original(self):
  with self.assertRaisesRegex(RuntimeError,'RESUME_PREPARED_IMAGE_LABEL_MISMATCH'):self.exercise('wrong_label')
 def test_prepared_source_bytes_must_match_digest(self):
  with self.assertRaisesRegex(RuntimeError,'RESUME_PREPARED_SOURCE_DIGEST_MISMATCH'):self.exercise('wrong_source')
 def test_pending_stop_requires_original_container_identity(self):
  with self.assertRaisesRegex(RuntimeError,'RESUME_STOP_IDENTITY_UNVERIFIED'):self.exercise('identity_missing')
if __name__=='__main__':unittest.main()
