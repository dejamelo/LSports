import unittest,tempfile,json,hashlib
from pathlib import Path
import importlib.util
spec=importlib.util.spec_from_file_location('proof_test',Path(__file__).with_name('test-pre-exit-recovery.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);load=module.load
class Reuse(unittest.TestCase):
 def exercise(self,tamper=False,spool=False):
  ns=load();ns['emit']=lambda **kw:None
  with tempfile.TemporaryDirectory() as tmp:
   b=Path(tmp)/'backup';b.mkdir();d=Path(tmp)/'volume';d.mkdir();o=b/'pre-exit-output-proof';o.mkdir();raw=b/'pre-exit-original-proof';raw.mkdir()
   hashes={}
   for name in ['trade-feed.json','trade-feed.json.regular-checkpoint.json','trade-feed.json.prematch.inbox.sqlite','trade-feed.json.inplay.inbox.sqlite','trade-feed.json.prematch.inbox.sqlite-wal']:
    for folder in (b,d,raw):(folder/name).write_bytes(b'committed unchanged data')
    hashes[name]=hashlib.sha256((b/name).read_bytes()).hexdigest()
   (o/'projection.json').write_bytes(b'full projection');(o/'projection.json.regular-checkpoint.json').write_bytes(b'private checkpoint')
   ph=hashlib.sha256((o/'projection.json').read_bytes()).hexdigest();inboxes=[dict(lane=l,pendingCommittedRows=2,replayedRows=2,rawRecordSha256='a'*64) for l in ('prematch','inplay')]
   (o/'receipt.json').write_text(json.dumps(dict(sha256=ph,stateRows=10,stateSha256='b'*64,inboxes=inboxes)))
   (o/'readback.json').write_text(json.dumps(dict(verified=True,stateRows=10,stateSha256='b'*64,projectionSha256=ph)))
   proof=dict(verified=True,sourceHashes=hashes,proofCodeHash=hashlib.sha256(ns['PRE_EXIT_REPLAY_PROOF'].encode()).hexdigest(),output=str(o),originalCopy=str(raw),stateRows=10)
   for name,key in [('receipt.json','receiptHash'),('readback.json','readbackHash'),('projection.json','projectionHash'),('projection.json.regular-checkpoint.json','regularHash')]:proof[key]=hashlib.sha256((o/name).read_bytes()).hexdigest()
   p=dict(preExitProof=proof,oldContainer='cid',verifiedExitContainerId='cid',verifiedExitSignal={'status':'docker_accepted'},digest='digest',dataBackupHashes=hashes)
   image={'Config':{'Labels':{'eu.adl.partitioned.patch':'digest'}}}
   if tamper:(d/'trade-feed.json').write_bytes(b'changed')
   if spool:
    folder=d/'.full-snapshot-active';folder.mkdir();(folder/'response.private.json').write_bytes(b'preserved untested snapshot')
   saved=[]
   if tamper:
    with self.assertRaisesRegex(RuntimeError,'ARTIFACT_HASH_MISMATCH'):ns['reuse_pre_exit_restore'](p,b,d,image,lambda x:saved.append(True))
    self.assertFalse(saved)
   else:
    result=ns['reuse_pre_exit_restore'](p,b,d,image,lambda x:saved.append(True));self.assertEqual(result,not spool);self.assertEqual(bool(p.get('oomRestoreVerified')),not spool)
   self.assertTrue((raw/'trade-feed.json').exists());self.assertTrue((o/'projection.json').exists())
 def test_identical_verified_proof_reused(self):self.exercise()
 def test_changed_original_blocks(self):self.exercise(tamper=True)
 def test_distinct_http_spool_still_needs_its_own_proof(self):self.exercise(spool=True)
if __name__=='__main__':unittest.main()
