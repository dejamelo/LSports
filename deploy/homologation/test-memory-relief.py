import unittest
from pathlib import Path
ns={}
def require(ok,message):
 if not ok:raise RuntimeError(message)
ns['require']=require
exec(Path(__file__).with_name('relieve-current-memory.py').read_text().split('def relief_main():')[0],ns)
class Relief(unittest.TestCase):
 def group(self):return {'memory.max':4294967296,'memory.high':None,'stat':{'inactive_file':2131210240,'file_dirty':132313088,'file_writeback':0,'shmem':544768}}
 def test_real_measurement(self):
  p=ns['relief_plan'](self.group(),12885045696);self.assertEqual(p['cleanInactiveEstimateBytes'],1998352384);self.assertEqual(p['reclaimBytes'],1610612736);self.assertGreater(p['hostReserveAfterIncreaseBytes'],8*1024**3)
 def test_dirty_is_not_free(self):
  g=self.group();g['stat']['file_dirty']=3*1024**3;self.assertEqual(ns['relief_plan'](g,12*1024**3)['reclaimBytes'],0)
 def test_host_reserve(self):
  with self.assertRaisesRegex(RuntimeError,'HOST_RESERVE'):ns['relief_plan'](self.group(),9*1024**3)
 def test_high_guard(self):
  g=self.group();g['memory.high']=3*1024**3
  with self.assertRaisesRegex(RuntimeError,'MEMORY_HIGH'):ns['relief_plan'](g,12*1024**3)
 def test_resume_no_unbounded_increase(self):
  g=self.group();g['memory.max']=6*1024**3;p=ns['relief_plan'](g,9*1024**3);self.assertEqual(p['oldLimitBytes'],p['newLimitBytes']);self.assertEqual(p['hostReserveAfterIncreaseBytes'],9*1024**3)
if __name__=='__main__':unittest.main()
