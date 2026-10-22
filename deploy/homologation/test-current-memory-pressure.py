import unittest,tempfile
from pathlib import Path
import re
class Cgroup(unittest.TestCase):
 def exercise(self,high='max'):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);cg=root/'cg';leaf=cg/'slice'/'worker';leaf.mkdir(parents=True);proc=root/'proc'/'123';proc.mkdir(parents=True);(proc/'cgroup').write_text('0::/slice/worker\n')
   for k,v in {'memory.current':str(4294967296-262144),'memory.max':'4294967296','memory.high':high,'memory.stat':'anon 1600000000\nfile 2600000000\ninactive_file 2200000000\nfile_dirty 300000000\nfile_writeback 100000000\n','memory.events':'oom 0\noom_kill 0\n','memory.pressure':'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'}.items():(leaf/k).write_text(v)
   def mapped(value):
    if value=='/sys/fs/cgroup':return cg
    if value.startswith('/proc/'):return root/'proc'/value[len('/proc/'):]
    return Path(value)
   def require(condition,reason):
    if not condition:raise RuntimeError(reason)
   ns={'Path':mapped,'re':re,'require':require};source=Path(__file__).with_name('current-memory-pressure.py').read_text().split('def memory_processes():')[0];exec(source,ns)
   result=ns['memory_cgroup'](123);self.assertEqual(result['memory.events']['oom_kill'],0);self.assertTrue(result['cacheEstimateIsNotGuaranteedAllocatable']);self.assertEqual(result['inactiveFileMinusDirtyWritebackBytes'],1800000000);return result
 def test_cache_is_reported_not_credited_as_free_memory(self):self.assertEqual(self.exercise()['limitMinusCurrentBytes'],262144)
 def test_high_is_included_and_negative_remaining_is_clamped(self):self.assertEqual(self.exercise('3221225472')['limitMinusCurrentBytes'],0)
if __name__=='__main__':unittest.main()
