import hashlib,json,runpy,unittest
from pathlib import Path
ns=runpy.run_path(str(Path(__file__).with_name('test-upgrade-partitioned-worker.py')))['NS']
class PublicationScope(unittest.TestCase):
 def test_only_reviewed_five_files_with_verified_parent_digest(self):
  old={p:'old' for p in ns['PARTITION_FILES']}
  digest=hashlib.sha256(json.dumps({p:old[p] for p in ns['PARTITION_DIGEST_FILES']},sort_keys=True,separators=(',',':')).encode()).hexdigest()
  candidate={**old,**{p:'reviewed' for p in ('apps/worker/src/state.ts','apps/worker/src/connected.ts','apps/worker/src/persistence.ts','packages/feed-store/src/index.ts','packages/feed-store/src/operation-risk.ts')}}
  ns['verify_publication_reserve_sources'](old,candidate,digest)
  for value,sha in ((old,digest),(candidate,'0'*64),({**candidate,'apps/worker/src/durable-ingress.mjs':'other'},digest),({**candidate,'packages/contracts/src/index.ts':'format-change'},digest)):
   with self.assertRaises(RuntimeError):ns['verify_publication_reserve_sources'](old,value,sha)
 def test_existing_pipeline_scope_not_widened(self):
  old={p:'old' for p in ns['PIPELINE_BASE_FILES']|ns['PIPELINE_AUXILIARY_FILES']}
  added={'apps/worker/src/snapshot-capacity.ts':Path('apps/worker/src/snapshot-capacity.ts').read_text()}
  self.assertEqual(hashlib.sha256(added['apps/worker/src/snapshot-capacity.ts'].encode()).hexdigest(),ns['PIPELINE_ADDED_DEPENDENCY_SHA256']['apps/worker/src/snapshot-capacity.ts'])
  base={**old,**added};digest=hashlib.sha256(json.dumps({p:base[p] for p in ns['PIPELINE_BASE_FILES']|set(added)},sort_keys=True,separators=(',',':')).encode()).hexdigest()
  files={p:base.get(p, 'old') for p in ns['PARTITION_FILES']}
  with self.assertRaises(RuntimeError):ns['verify_pipeline_sources'](old,{**files,'apps/worker/src/persistence.ts':'telemetry'},digest,added)
if __name__=='__main__':unittest.main()
