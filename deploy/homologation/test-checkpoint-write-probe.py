import importlib.util,tempfile,unittest,hashlib,subprocess
from pathlib import Path
spec=importlib.util.spec_from_file_location('checkpoint_probe',Path(__file__).with_name('checkpoint-write-probe.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Progress(unittest.TestCase):
 def test_same_write_stage_with_growing_inode_is_progress_not_one_stalled_syscall(self):
  with tempfile.TemporaryDirectory() as d:
   target=Path(d)/'feed.json.regular-checkpoint.json';temp=Path(str(target)+'.7.tmp');temp.write_bytes(b'a'*65536)
   before={'files':[m.file_meta(temp)]}
   with temp.open('ab') as f:f.write(b'b'*65536)
   result=m.progress(before,{'files':[m.file_meta(temp)]},target.name)
   self.assertEqual(result['assessment'],'file_size_advancing');self.assertEqual(result['sameInodeChanges'][0]['bytesAdvanced'],65536)
   self.assertFalse(result['durableInboxRetirementVerified'])
 def test_private_atomic_rename_does_not_claim_fsync_publication_or_retirement(self):
  with tempfile.TemporaryDirectory() as d:
   target=Path(d)/'feed.json.regular-checkpoint.json';temp=Path(str(target)+'.7.tmp');temp.write_bytes(b'new');before={'files':[m.file_meta(temp)]};temp.rename(target)
   r=m.progress(before,{'files':[m.file_meta(target)]},target.name)
   self.assertEqual(r['assessment'],'private_checkpoint_rename_observed');self.assertTrue(r['temporaryInodeAdvancedToTarget']);self.assertFalse(r['directoryFsyncVerified']);self.assertFalse(r['publicProjectionCommitVerified'])
 def test_no_size_change_is_not_stall_proof(self):
  with tempfile.TemporaryDirectory() as d:
   target=Path(d)/'feed.json.regular-checkpoint.json';target.write_bytes(b'old');s={'files':[m.file_meta(target)]}
   self.assertEqual(m.progress(s,s,target.name)['assessment'],'no_file_change_in_short_window_not_proof_of_stall')
 def test_checkpoint_syscall_matches_exact_fd_and_redacts_pointer_arguments(self):
  value=m.checkpoint_syscall('1 0x1c 0xDEADBEEF 0x10000 0x0 0x0', 'x86_64',{28})
  self.assertEqual(value,{'operation':'write','fd':28,'requestedBytes':65536})
  self.assertNotIn('DEADBEEF',str(value))
  self.assertIsNone(m.checkpoint_syscall('1 0x1d 0xDEADBEEF 0x10000','x86_64',{28}))
  self.assertIsNone(m.checkpoint_syscall('-1 0x1234','x86_64',{28}))
  self.assertEqual(m.checkpoint_syscall('82 0x1c','aarch64',{28}),{'operation':'fsync','fd':28})
 def test_pinned_hashes_are_exactly_the_reviewed_commit_not_worktree(self):
  for name,digest in m.EXPECTED_SOURCE_HASHES.items():
   value=subprocess.check_output(['git','show','2bd97d2:'+name]);self.assertEqual(hashlib.sha256(value).hexdigest(),digest)
if __name__=='__main__':unittest.main()
