import hashlib,json,runpy,unittest
from pathlib import Path
ns=runpy.run_path(str(Path(__file__).with_name('test-upgrade-partitioned-worker.py')))['NS']
class TransportScope(unittest.TestCase):
 def test_exact_lifecycle_scope_and_verified_base_digest(self):
  old={p:'old' for p in ns['PARTITION_FILES']};digest=hashlib.sha256(json.dumps({p:old[p] for p in ns['PARTITION_DIGEST_FILES']},sort_keys=True,separators=(',',':')).encode()).hexdigest()
  changed={**old,**{p:'reviewed' for p in ('apps/worker/src/connected.ts','apps/worker/src/connection-closer.ts','apps/worker/src/durable-ingress.mjs','apps/worker/src/durable-ingress.d.mts')}}
  ns['verify_transport_lifecycle_sources'](old,changed,digest)
  for files,sha in ((old,digest),(changed,'f'*64),({**changed,'apps/worker/src/state.ts':'changed'},digest),({**changed,'apps/worker/src/persistence.ts':'changed'},digest)):
   with self.assertRaises(RuntimeError):ns['verify_transport_lifecycle_sources'](old,files,sha)
 def test_publication_scope_not_expanded_for_connection_close(self):
  old={p:'old' for p in ns['PARTITION_FILES']};digest=hashlib.sha256(json.dumps({p:old[p] for p in ns['PARTITION_DIGEST_FILES']},sort_keys=True,separators=(',',':')).encode()).hexdigest()
  with self.assertRaises(RuntimeError):ns['verify_publication_reserve_sources'](old,{**old,'apps/worker/src/connection-closer.ts':'changed'},digest)
if __name__=='__main__':unittest.main()
