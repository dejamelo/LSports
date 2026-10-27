import importlib.util,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('cache',Path(__file__).with_name('worker-cache-reserve.py'));cache=importlib.util.module_from_spec(spec);spec.loader.exec_module(cache)
class Policy(unittest.TestCase):
 def test_real_measurement_is_bounded_and_cache_not_credited(self):
  stat={'file':3791609856,'inactive_file':3790954496,'file_dirty':360611840,'file_writeback':0}
  self.assertEqual(cache.plan(6218821632,6442450944,stat),512*1024**2)
 def test_dirty_cache_cannot_be_promised(self):self.assertEqual(cache.plan(6218821632,6442450944,{'file':100,'inactive_file':100,'file_dirty':100}),0)
 def test_free_margin_needs_no_reclaim(self):self.assertEqual(cache.plan(3*1024**3,6*1024**3,{'file':3*1024**3,'inactive_file':3*1024**3}),0)
 def test_eight_gib_profile_keeps_same_headroom_and_reclaim_cap(self):self.assertEqual(cache.plan(7*1024**3,8*1024**3,{'file':2*1024**3,'inactive_file':2*1024**3}),512*1024**2)
 def test_eight_gib_profile_rejects_unverified_limit(self):
  with self.assertRaisesRegex(RuntimeError,'LIMIT_UNVERIFIED'):cache.plan(1,7*1024**3,{})
 def test_limit_change_fails_closed(self):
  with self.assertRaisesRegex(RuntimeError,'LIMIT_UNVERIFIED'):cache.plan(1,4*1024**3,{})
if __name__=='__main__':unittest.main()
