import json,os,tempfile,unittest,subprocess
from pathlib import Path
NS={'__name__':'tested'}
for name in ('resume-adl-api.py','repair-adl-snapshot.py','upgrade-partitioned-worker.py','execute-adl-cutover-aws.py'):
 exec((Path(__file__).parent/name).read_text().split("if __name__=='__main__':")[0],NS)
class StopResume(unittest.TestCase):
 def test_old_protected_log_exposes_no_raw_secrets_and_retains_partial_status(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);p=root/'distribution-stop.private.log';p.write_text('SECRET password endpoint\nFATAL ERROR: heap out of memory\n'+json.dumps({'operation':'upgrade.distribution_stop','packageId':4511,'stage':'after','sdkIsDistributionOn':False,'password':'SECRET'})+'\n')
   report=NS['distribution_stop_log_summary'](root)
   self.assertIn('heap_exhausted',report['signals']);self.assertNotIn('SECRET',json.dumps(report));self.assertEqual(report['records'][0]['sdkIsDistributionOn'],False)
 def test_child_failure_preserves_exit_code_without_printing_raw_stderr(self):
  with self.assertRaises(subprocess.CalledProcessError) as caught:NS['run'](['python3','-c',"import sys;sys.stderr.write('SECRET');sys.exit(7)"])
  safe=NS['safe_helper_error'](caught.exception);self.assertEqual(safe['childExitCode'],7);self.assertNotIn('SECRET',json.dumps(safe))
 def test_partial_stop_recovery_checks_all_packages_before_mutating(self):
  import ast,re
  tree=ast.parse((Path(__file__).parent/'upgrade-partitioned-worker.py').read_text())
  code=next(n.value.value for n in ast.walk(tree) if isinstance(n,ast.Assign) and isinstance(n.value,ast.Constant) and isinstance(n.value.value,str) and 'upgrade.distribution_stop' in n.value.value and 'feeds=[]' in n.value.value)
  code=re.sub(r"import\{[^}]+\}from'[^']+';",'',code)
  for fail in (False,True):
   prefix="const calls=[],states={4511:false,4510:true},loadConfig=()=>({packages:[{packageId:4511},{packageId:4510}]}),describeFailure=()=>({category:'network'}),clients=p=>({async distributionStatus(){calls.push('status:'+p.packageId);if(FAIL&&p.packageId===4510)throw Error();return{isDistributionOn:states[p.packageId]}},distributionObservations:()=>[{bodyIsDistributionOn:states[p.packageId]}],async stopDistribution(){calls.push('stop:'+p.packageId);states[p.packageId]=false}});".replace('FAIL',str(fail).lower())
   suffix=";console.log(JSON.stringify({calls}));"
   result=subprocess.run(['node','--input-type=module','-e',prefix+code+suffix],capture_output=True,text=True)
   calls=json.loads(result.stdout.strip().splitlines()[-1])['calls']
   self.assertEqual(result.returncode,2 if fail else 0)
   self.assertEqual([c for c in calls if c.startswith('stop:')],[] if fail else ['stop:4510'])
   self.assertEqual(calls[:2],['status:4511','status:4510'])
 def test_stop_is_gated_by_live_status_and_image_source_is_unchanged(self):
  source=(Path(__file__).parent/'upgrade-partitioned-worker.py').read_text();self.assertIn('if(f.on)',source);self.assertIn('already_off',source);self.assertIn('feeds.push',source);self.assertIn("helper_memory,helper_heap=('384m','256') if 'heap_exhausted'",source)
if __name__=='__main__':unittest.main()
