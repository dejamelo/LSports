import hashlib,json,runpy,unittest
from pathlib import Path
ns=runpy.run_path(str(Path(__file__).with_name('test-upgrade-partitioned-worker.py')))['NS']
class PublicationScope(unittest.TestCase):
 def test_only_reviewed_four_files_with_verified_parent_digest(self):
  old={p:'old' for p in ns['PARTITION_FILES']}
  digest=hashlib.sha256(json.dumps(old,sort_keys=True,separators=(',',':')).encode()).hexdigest()
  candidate={**old,**{p:'reviewed' for p in ('apps/worker/src/state.ts','apps/worker/src/connected.ts','apps/worker/src/persistence.ts','packages/feed-store/src/index.ts')}}
  ns['verify_publication_reserve_sources'](old,candidate,digest)
  for value,sha in ((old,digest),(candidate,'0'*64),({**candidate,'apps/worker/src/durable-ingress.mjs':'other'},digest),({**candidate,'packages/contracts/src/index.ts':'format-change'},digest)):
   with self.assertRaises(RuntimeError):ns['verify_publication_reserve_sources'](old,value,sha)
 def test_existing_pipeline_scope_not_widened(self):
  root=Path(__file__).resolve().parents[2]
  base={p:'old' for p in ns['PIPELINE_BASE_FILES']}
  added={p:(root/p).read_text() for p in ns['PIPELINE_ADDED_DEPENDENCY_SHA256']}
  verified={**base,**added}
  digest=hashlib.sha256(json.dumps(verified,sort_keys=True,separators=(',',':')).encode()).hexdigest()
  with self.assertRaises(RuntimeError):ns['verify_pipeline_sources'](base,{**verified,'apps/worker/src/persistence.ts':'telemetry'},digest,added)
 def test_reviewed_publication_patch_is_verified_without_heap_repair(self):
  old={p:'installed' for p in ns['PARTITION_FILES']}
  digest=hashlib.sha256(json.dumps(old,sort_keys=True,separators=(',',':')).encode()).hexdigest()
  candidate={**old,'apps/worker/src/state.ts':'cached projection'}
  request={'pipelineRepair':True,'livePersistenceRepair':True,'publicationReserveRepair':True}
  ns['verify_partitioned_candidate_sources'](request,old,candidate,digest)
  for changed in ({**candidate,'apps/worker/src/provider.ts':'unrelated'}, {p:v for p,v in candidate.items() if p!='packages/feed-store/src/index.ts'}):
   with self.assertRaises(RuntimeError):ns['verify_partitioned_candidate_sources'](request,old,changed,digest)
if __name__=='__main__':unittest.main()
