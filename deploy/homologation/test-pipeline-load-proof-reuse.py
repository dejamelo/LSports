import hashlib,importlib.util,json,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('proof',Path(__file__).with_name('test-pre-exit-recovery.py'));loader=importlib.util.module_from_spec(spec);spec.loader.exec_module(loader)

class PipelineLoadProofReuse(unittest.TestCase):
 def test_reuses_exact_completed_proof_and_uses_declared_load_target(self):
  ns=loader.load();proof=Path(__file__).with_name('pipeline-load-proof.mjs').read_text();digest=hashlib.sha256(proof.encode()).hexdigest()
  with tempfile.TemporaryDirectory() as tmp:
   backup=Path(tmp);script=backup/f'pipeline-load-proof-{digest[:16]}.mjs';script.write_text(proof);script.chmod(0o644)
   metrics={'snapshotBytes':516*1024**2,'snapshotRows':25416,'applied':25416,'preload':674380,'received':21900,'acknowledged':21900,'processed':24576,'checkpointed':24576,'finalBacklog':671704,'writes':13,'maxPersistMs':57652.6,'peakRSSBytes':2485207040,'maxEventLoopDelayMs':68719.5,'readbackRows':25416,'loadSent':21900,'loadDurationMs':300008.5}
   record={'operation':'pipeline.offline.complete','scope':'synthetic_snapshot_plus_real_durable_actor_and_session_not_AWS','load':{'sent':21900,'durationMs':300008.5},**{k:v for k,v in metrics.items() if k not in ('loadSent','loadDurationMs','processingBacklog')}}
   log=backup/'pipeline-load-0123456789ab.private.log';log.write_text(json.dumps(record)+'\npipeline-load-offline-ok\ninbox-capacity-offline-ok\n');log.chmod(0o644)
   reused=ns['reuse_pipeline_load_proof'](backup,digest,proof)
   self.assertTrue(reused['verified']);self.assertEqual(reused['metrics'],metrics);self.assertEqual(ns['pipeline_load_expected_messages'](proof),21900)
   self.assertTrue(ns['pipeline_load_metrics_valid'](metrics,proof))
   self.assertFalse(ns['pipeline_load_metrics_valid']({**metrics,'loadSent':30000},proof))
 def test_does_not_reuse_unverified_or_partial_logs(self):
  ns=loader.load();proof=Path(__file__).with_name('pipeline-load-proof.mjs').read_text();digest=hashlib.sha256(proof.encode()).hexdigest()
  with tempfile.TemporaryDirectory() as tmp:
   backup=Path(tmp);script=backup/f'pipeline-load-proof-{digest[:16]}.mjs';script.write_text(proof);script.chmod(0o644)
   log=backup/'pipeline-load-0123456789ab.private.log';log.write_text('{"operation":"pipeline.offline.complete"}\n');log.chmod(0o644)
   self.assertIsNone(ns['reuse_pipeline_load_proof'](backup,digest,proof))

if __name__=='__main__':unittest.main()
