import hashlib,json,runpy,unittest
from pathlib import Path
ns=runpy.run_path(str(Path(__file__).with_name('test-upgrade-partitioned-worker.py')))['NS']
class PublicationScope(unittest.TestCase):
 def test_only_reviewed_six_files_with_verified_parent_digest(self):
  pinned={'packages/feed-store/src/tenant-tickets.ts':hashlib.sha256(b'old').hexdigest()}
  ns['PIPELINE_PINNED_ADDED_DEPENDENCY_SHA256']=pinned
  self.assertEqual(ns['PUBLICATION_BASE_DIGEST_FILES'],ns['PARTITION_FILES']-{'packages/feed-store/src/tenant-tickets.ts'})
  old={p:'old' for p in ns['PARTITION_FILES']}
  digest=hashlib.sha256(json.dumps({p:old[p] for p in ns['PUBLICATION_BASE_DIGEST_FILES']},sort_keys=True,separators=(',',':')).encode()).hexdigest()
  candidate={**old,**{p:'reviewed' for p in ('apps/worker/src/state.ts','apps/worker/src/connected.ts','apps/worker/src/persistence.ts','packages/feed-store/src/index.ts','packages/feed-store/src/operation-risk.ts','packages/feed-store/src/tenant-tickets.ts')}}
  ns['verify_publication_reserve_sources'](old,candidate,digest)
  for value,sha in ((old,digest),(candidate,'0'*64),({**candidate,'apps/worker/src/durable-ingress.mjs':'other'},digest),({**candidate,'packages/contracts/src/index.ts':'format-change'},digest)):
   with self.assertRaises(RuntimeError):ns['verify_publication_reserve_sources'](old,value,sha)
 def test_existing_pipeline_scope_not_widened(self):
  ns['PIPELINE_PINNED_ADDED_DEPENDENCY_SHA256']={'packages/feed-store/src/tenant-tickets.ts':hashlib.sha256(b'old').hexdigest()}
  old={p:'old' for p in ns['PIPELINE_BASE_FILES']|ns['PIPELINE_AUXILIARY_FILES']}
  added={'apps/worker/src/snapshot-capacity.ts':Path('apps/worker/src/snapshot-capacity.ts').read_text(),'packages/feed-store/src/tenant-tickets.ts':'old'}
  self.assertEqual(hashlib.sha256(added['apps/worker/src/snapshot-capacity.ts'].encode()).hexdigest(),ns['PIPELINE_ADDED_DEPENDENCY_SHA256']['apps/worker/src/snapshot-capacity.ts'])
  base={**old,**added};digest=hashlib.sha256(json.dumps({p:base[p] for p in ns['PIPELINE_BASE_FILES']|set(ns['PIPELINE_ADDED_DEPENDENCY_SHA256'])},sort_keys=True,separators=(',',':')).encode()).hexdigest()
  files={p:base[p] if p in base else 'old' for p in ns['PARTITION_FILES']}
  files['packages/feed-store/src/tenant-tickets.ts']='reviewed tenant dependency'
  ns['verify_pipeline_sources'](old,files,digest,added)
  with self.assertRaises(RuntimeError):ns['verify_pipeline_sources'](old,{**files,'apps/worker/src/persistence.ts':'telemetry'},digest,added)
if __name__=='__main__':unittest.main()
