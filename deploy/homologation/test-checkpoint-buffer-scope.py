import hashlib,json,runpy,unittest
from pathlib import Path
NS=runpy.run_path(str(Path(__file__).with_name('test-resume-prepared-worker.py')))['namespace']()
class BufferScope(unittest.TestCase):
 def test_only_connected_and_private_checkpoint_writer_can_change(self):
  old={p:'original' for p in NS['PARTITION_FILES']};sha=hashlib.sha256(json.dumps({p:old[p] for p in NS['PARTITION_DIGEST_FILES']},sort_keys=True,separators=(',',':')).encode()).hexdigest()
  new={**old,'apps/worker/src/connected.ts':'prefix and metrics','apps/worker/src/persistence.ts':'bounded write'}
  NS['verify_checkpoint_buffer_sources'](old,new,sha)
  NS['verify_checkpoint_buffer_sources'](old,{**old,'apps/worker/src/persistence.ts':'bounded native field encoding'},sha)
  for candidate,digest in (({**new,'apps/worker/src/state.ts':'unexpected'},sha),({**new,'packages/feed-store/src/index.ts':'unexpected'},sha),(new,'0'*64),(old,sha)):
   with self.assertRaises(RuntimeError):NS['verify_checkpoint_buffer_sources'](old,candidate,digest)
if __name__=='__main__':unittest.main()
