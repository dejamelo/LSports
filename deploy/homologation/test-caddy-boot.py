"""No remote calls: verifies boot config comparison and conservative refusal."""
import contextlib
import io
import json
from pathlib import Path
import types
import unittest
from unittest.mock import patch, mock_open

src=Path(__file__).with_name('check-posnet-caddy-boot.sh').read_text().split("<<'PY'\n",1)[1].rsplit('\nPY\n',1)[0]
m=types.ModuleType('bootcheck')
exec(compile(src,'bootcheck','exec'),m.__dict__)

class BootTest(unittest.TestCase):
    def check(self, *, resume=False, changed=False, host_changed=False):
        item={'Name':'/deploy-caddy-production-1','Config':{'Entrypoint':['caddy'],'Cmd':['run','--config','/etc/caddy/Caddyfile','--adapter','caddyfile']+(['--resume'] if resume else [])},'Mounts':[{'Type':'bind','Destination':'/etc/caddy/Caddyfile','Source':m.EXPECTED}]}
        active={'apps':{'http':{'secret':'PRIVATE_VALUE','routes':[1,2]}}}
        adapted={'apps':{'http':{'secret':'PRIVATE_VALUE','routes':[2,1] if changed else [1,2]}}}
        def read(args,stage):
            return {'inspect':json.dumps([item]).encode(),'mounted_file':b'PRIVATE_FILE','active_config':json.dumps(active).encode(),'startup_adapt':json.dumps(adapted).encode()}[stage]
        output=io.StringIO()
        with patch.object(m,'read',side_effect=read),patch('builtins.open',mock_open(read_data=b'OTHER' if host_changed else b'PRIVATE_FILE')),contextlib.redirect_stdout(output):
            result=m.main()
        self.assertNotIn('PRIVATE',output.getvalue())
        return result,[json.loads(s) for s in output.getvalue().splitlines()]

    def test_equal(self):
        result,rows=self.check()
        self.assertEqual(result,0)
        self.assertEqual(rows[-1]['status'],'config_matches_now')
    def test_array_order_matters(self):
        result,rows=self.check(changed=True)
        self.assertEqual(result,2)
        self.assertEqual(rows[-1]['status'],'blocked')
    def test_stale_bind_inode(self):
        result,rows=self.check(host_changed=True)
        self.assertEqual(result,2)
        self.assertFalse(rows[0]['hostMatchesMounted'])
    def test_resume_not_assumed_file(self):
        result,rows=self.check(resume=True)
        self.assertEqual(result,2)
        self.assertEqual(rows[-1]['reason'],'resume_requires_autosave_review')

if __name__=='__main__': unittest.main()
