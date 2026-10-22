import json,tempfile,unittest
from pathlib import Path
HERE=Path(__file__).parent
class PipelineIdentity(unittest.TestCase):
 def test_read_only_report_identifies_exact_reference_and_id_mismatch_without_environment(self):
  ns={'__name__':'tested'}
  for name in ('resume-adl-api.py','repair-adl-snapshot.py','upgrade-partitioned-worker.py','execute-adl-cutover-aws.py'):exec((HERE/name).read_text().split("if __name__=='__main__':")[0],ns)
  with tempfile.TemporaryDirectory() as tmp:
   secure=Path(tmp);(secure/'deployment.json').write_text('{}');actual='adl-worker-partitioned:'+'c'*24;expected='adl-worker-partitioned:'+'a'*24;actual_id='sha256:'+'b'*64;other_id='sha256:'+'d'*64;calls=[];output=[]
   worker={'id':'f'*64,'running':True,'oomKilled':False,'name':'/adl-homologation-worker-1'};names=ns['PARTITION_FILES'];hashes={name:'e'*64 for name in names}
   def run(args,**kw):
    calls.append(args)
    if args[:2]==['docker','inspect']:return json.dumps([{'Image':actual_id,'HostConfig':{'Memory':4294967296},'Config':{'User':'node','Env':['SECRET=DO_NOT_PRINT']}}]).encode()
    if args[:3]==['docker','image','inspect']:return json.dumps([{'Id':other_id if args[3]==expected else actual_id,'Config':{'Labels':{}}}]).encode()
    if args[:2]==['docker','exec']:return json.dumps({'memory.current':1603436544,'memory.max':4294967296} if 'memory.current' in args[-1] else hashes).encode()
    raise AssertionError('non-read-only command')
   old=ns['subprocess'].run
   try:
    ns.update(SECURE=secure,states=lambda service:[worker],partition_base=lambda meta:[],model=lambda base:{'services':{'worker':{'image':actual,'environment':{'PASSWORD':'DO_NOT_PRINT'}}}},run=run,emit=lambda **record:output.append(record))
    ns['subprocess'].run=lambda args,**kw:type('Result',(),{'returncode':0,'stdout':json.dumps([{'Id':other_id}]).encode()})()
    self.assertEqual(ns['pipeline_identity_report']({'expectedImage':expected,'sourceSets':{'a'*40:hashes}}),0)
   finally:ns['subprocess'].run=old
   report=output[0];self.assertEqual(report['failedChecks'],['imageReferenceMatches','containerImageMatchesExpected']);self.assertEqual(report['expectedImage'],expected);self.assertEqual(report['composeImage'],actual);self.assertEqual(report['expectedImageId'],other_id);self.assertEqual(report['containerImageId'],actual_id);self.assertTrue(report['sourceComparisons']['a'*40]['allMatch']);self.assertNotIn('DO_NOT_PRINT',json.dumps(report));self.assertFalse(report['compatibilityProven']);self.assertEqual(report['providerRequests'],0)
if __name__=='__main__':unittest.main()
