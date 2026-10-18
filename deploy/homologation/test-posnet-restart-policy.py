"""Tests simulate all Docker operations; write backups only to a temporary directory."""
import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

src=Path(__file__).with_name('apply-posnet-restart-policy.sh').read_text().split("<<'PY'\n",1)[1].rsplit('\nPY\n',1)[0]
m=types.ModuleType('policy')
exec(compile(src,'policy','exec'),m.__dict__)

class PolicyTest(unittest.TestCase):
    def execute(self,backup_failure=False,second_failure=False,already=False):
        items={}
        for cid,name,alias in m.TARGETS:
            items[cid]={'Id':cid,'Name':name,'Image':'sha256:original','Config':{'Env':['KEY=DO_NOT_PRINT']},'State':{'Running':True,'Health':{'Status':'healthy'},'Pid':42,'StartedAt':'original'},'HostConfig':{'RestartPolicy':{'Name':'unless-stopped' if already else 'no'},'PortBindings':{}},'Mounts':[],'NetworkSettings':{'Networks':{'posnet-sso-canary_default':{'Aliases':[alias]},'posnet-sso-originfix_default':{}}}}
        updates=[]
        def inspect(cid): return copy.deepcopy(items[cid])
        def call(args):
            self.assertEqual(args[:2],['docker','update'])
            updates.append(args[-1])
            if second_failure and args[-1]==m.TARGETS[1][0]: raise RuntimeError('DO_NOT_PRINT')
            items[args[-1]]['HostConfig']['RestartPolicy']['Name']='unless-stopped'
            return b''
        with tempfile.TemporaryDirectory() as root:
            output=io.StringIO()
            original_save=m.save
            def save(*args):
                if backup_failure: raise OSError('DO_NOT_PRINT')
                return original_save(*args)
            with patch.object(m,'BACKUP_ROOT',root),patch.object(m.os,'geteuid',return_value=0),patch.object(m,'inspect',side_effect=inspect),patch.object(m,'call',side_effect=call),patch.object(m,'save',side_effect=save),contextlib.redirect_stdout(output):
                code=m.main()
            self.assertNotIn('DO_NOT_PRINT',output.getvalue())
            rows=[json.loads(s) for s in output.getvalue().splitlines()]
            if not backup_failure:
                before=json.loads(next(Path(root).glob('*/before.json')).read_text())
                self.assertNotIn('DO_NOT_PRINT',json.dumps(before))
                self.assertTrue(next(Path(root).glob('*/rollback.json')).exists())
            return code,updates,rows

    def test_success(self):
        code,updates,rows=self.execute()
        self.assertEqual(code,0)
        self.assertEqual(len(updates),2)
        self.assertEqual(rows[-1]['status'],'ok')
    def test_no_mutation_without_backup(self):
        code,updates,rows=self.execute(backup_failure=True)
        self.assertEqual(code,2)
        self.assertEqual(updates,[])
        self.assertEqual(rows[-1]['stage'],'backup')
    def test_partial_failure_is_explicit(self):
        code,updates,rows=self.execute(second_failure=True)
        self.assertEqual(code,2)
        self.assertEqual(rows[-1]['stage'],'update_2')
        self.assertTrue(rows[-1]['changesPossible'])
    def test_repeat_does_not_update_again(self):
        code,updates,rows=self.execute(already=True)
        self.assertEqual(code,0)
        self.assertEqual(updates,[])

if __name__=='__main__': unittest.main()
