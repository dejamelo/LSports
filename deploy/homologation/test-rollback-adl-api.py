import unittest,tempfile,json,copy,io,contextlib,sys,importlib.util
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('rollbacktested',Path(__file__).with_name('update-adl-api.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Rollback(unittest.TestCase):
 def exercise(self,fail=False):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);secure=root/'secure';secure.mkdir(mode=0o700);backup=root/'adl-api-update-example';backup.mkdir(mode=0o700)
   current={'release':'preserved','apiUiCommit':'new','workerExtra':'new-worker-settings','composeOverrides':[]};(secure/'deployment.json').write_text(json.dumps(current))
   for name,data in [('model.before.private.json',{'services':{'api':{'image':'old'}}}),('deployment.before.private.json',{'apiUiCommit':'old','composeOverrides':['must-not-restore-old-worker']})]:
    f=backup/name;f.write_text(json.dumps(data));f.chmod(0o600)
   calls=[];installed='new';fail_once=fail;ids={'old':'sha256:'+'a'*64,'new':'sha256:'+'b'*64}
   def fakepath(value):return backup if str(value)=='/var/backups/adl-api-update-example' else Path(value)
   def run(args,**kwargs):
    nonlocal installed,fail_once
    calls.append(args)
    if args[:3]==['docker','image','inspect']:return json.dumps([{'Id':ids.get(args[3],args[3])}]).encode()
    if args[:3]==['docker','ps','-aq']:return b'api-id'
    if args[:2]==['docker','inspect']:return json.dumps([{'Image':ids.get(installed,installed)}]).encode()
    if 'config' in args:
     model={'services':{'api':{'image':'new','volumes':['private-data']},'worker':{'image':'new-worker-preserved'}},'networks':{'same':{}}}
     for arg in args:
      if 'compose.api-rollback-' in str(arg):model['services']['api']['image']=json.loads(Path(arg).read_text())['services']['api']['image']
     return json.dumps(model).encode()
    if 'up' in args:
     self.assertEqual(args[-1],'api');self.assertIn('--no-deps',args);self.assertIn('--pull',args)
     if fail_once:fail_once=False;raise RuntimeError('ISOLATED_FAILURE')
     installed=ids['old'] if any('compose.api-rollback-' in str(v) for v in args) else 'new';return b''
    raise AssertionError(args)
   out=io.StringIO()
   with patch.object(m.os,'geteuid',lambda:0),patch.object(m,'SECURE',secure),patch.object(m,'Path',fakepath),patch.object(m,'run',run),patch.object(m,'compose',lambda meta:['docker','compose','-p','adl-homologation']),patch.object(m,'identities',lambda:{'worker':'unchanged','posnet':'unchanged'}),patch.object(m,'health',lambda:{'initialized':True}),patch.object(sys,'argv',['helper','--rollback','/var/backups/adl-api-update-example']),contextlib.redirect_stdout(out):
    code=m.rollback_main()
   final=json.loads((secure/'deployment.json').read_text());self.assertEqual(final['workerExtra'],'new-worker-settings');self.assertNotIn('must-not-restore-old-worker',final['composeOverrides']);self.assertEqual(code,2 if fail else 0,out.getvalue())
   if fail:self.assertEqual(final,current);self.assertEqual(installed,'new')
   else:self.assertEqual(final['apiUiCommit'],'old');self.assertEqual(len(final['composeOverrides']),1)
   self.assertNotIn('private-data',out.getvalue());self.assertTrue(all(c[-1]=='api' for c in calls if 'up' in c))
 def test_rolls_back_only_api_image_preserving_current_worker_and_data(self):self.exercise()
 def test_failed_rollback_restores_current_api_and_leaves_metadata(self):self.exercise(True)
 def test_rejects_arbitrary_backup_path_before_commands(self):
  with patch.object(m.os,'geteuid',lambda:0),patch.object(sys,'argv',['helper','--rollback','/tmp/not-allowed']),patch.object(m,'run',side_effect=AssertionError('must not execute')),contextlib.redirect_stdout(io.StringIO()):self.assertEqual(m.rollback_main(),2)
if __name__=='__main__':unittest.main()
