"""Isolated preparation tests; Docker, sockets and HTTP are mocked."""
import io
import json
import tarfile
import types
import contextlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('prepare',Path(__file__).with_name('prepare-adl-release.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class PreparationTest(unittest.TestCase):
    def test_build_and_api_only_never_start_worker_or_touch_caddy(self):
        payload=io.BytesIO()
        with tarfile.open(fileobj=payload,mode='w') as tar:
            for name,data in {'Dockerfile.homologation':b'FROM node:24-bookworm-slim','deploy/homologation/worker.env.example':b'LSPORTS_PREMATCH_USERNAME=\nLSPORTS_PREMATCH_PASSWORD=\n'}.items():
                info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o644;tar.addfile(info,io.BytesIO(data))
        payload.seek(0)
        calls=[]
        def run(args,**kwargs):
            calls.append(args);return types.SimpleNamespace(returncode=0,stdout=b'')
        original=Path.read_text
        def text(path,*a,**kw):
            if str(path)=='/proc/meminfo':return 'MemAvailable: 10000000 kB\n'
            return original(path,*a,**kw)
        with tempfile.TemporaryDirectory() as root:
            secure=Path(root)/'etc';out=io.StringIO()
            with patch.object(m,'ROOT',Path(root)/'releases'),patch.object(m,'SECURE',secure),patch.object(m.os,'geteuid',return_value=0),patch.object(m.sys,'version_info',(3,12)),patch.object(m.sys,'argv',['tool','a'*40,'192.0.2.2 1234 77.113.150.100 22']),patch.object(m.sys,'stdin',types.SimpleNamespace(buffer=payload)),patch.object(m.subprocess,'run',side_effect=run),patch.object(m.socket,'socket'),patch.object(m.shutil,'disk_usage',return_value=types.SimpleNamespace(free=100*1024**3)),patch.object(Path,'read_text',text),patch.object(m.urllib.request,'urlopen') as url,contextlib.redirect_stdout(out):
                url.return_value.__enter__.return_value.status=200
                self.assertEqual(m.main(),0)
            result=json.loads(out.getvalue().splitlines()[-1]);self.assertTrue(result['apiStarted']);self.assertFalse(result['workerStarted'])
            ups=[c for c in calls if 'up' in c];self.assertEqual(len(ups),1);self.assertEqual(ups[0][-1],'api')
            self.assertFalse(any('reload' in c or 'restart' in c or 'stop' in c for c in calls))
            self.assertEqual((secure/'worker.env').stat().st_mode&0o777,0o600)
            self.assertIn('ADL_MAC_WORKER_STOPPED=no',(secure/'deploy.env').read_text())
            self.assertNotIn('192.0.2.2',out.getvalue())
    def test_invalid_commit_refuses_before_any_docker_action(self):
        with patch.object(m.os,'geteuid',return_value=0),patch.object(m.sys,'argv',['tool','bad;command']),patch.object(m.subprocess,'run') as run,contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(m.main(),2)
            run.assert_not_called()

if __name__=='__main__':unittest.main()
