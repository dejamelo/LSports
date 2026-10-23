import contextlib,io,json,re,runpy,subprocess,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

class InstalledSDKTest(unittest.TestCase):
 def test_exact_installed_sdk_identity_and_mismatch(self):
  source=Path(__file__).with_name('apply-distribution-replay-repair.mjs').read_text()
  script=json.loads(re.search(r' const source=(".*");',source).group(1))
  compile(script,'source','exec')
  for mismatch in (False,True):
   def run(args,**kwargs):
    if args[1]=='inspect':
     return SimpleNamespace(stdout=json.dumps([{'Id':'a'*64,'Image':'sha256:test','Config':{'Labels':{'com.docker.compose.project':'adl-homologation','com.docker.compose.service':'worker'}},'State':{'Running':True}}]))
    self.assertEqual(args[:3],['docker','exec','a'*64])
    r=subprocess_run(['node','-e',args[-1]],capture_output=True,text=True,check=True)
    if mismatch:
     v=json.loads(r.stdout);v['files'][next(iter(v['files']))]='0'*64;r.stdout=json.dumps(v)
    return r
   output=io.StringIO()
   with patch('subprocess.run',side_effect=run),contextlib.redirect_stdout(output):
    with self.assertRaises(SystemExit) as exit:exec(script,{'__name__':'__main__'})
   self.assertEqual(exit.exception.code,2 if mismatch else 0)
   record=json.loads(output.getvalue())
   self.assertEqual(record['status'],'blocked' if mismatch else 'verified')
   self.assertFalse(record['workerMutationRequested'])
subprocess_run=subprocess.run
if __name__=='__main__':unittest.main()
