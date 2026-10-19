import contextlib
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

src=Path(__file__).with_name('backup-posnet-local-volumes.sh').read_text().split("<<'PY'\n",1)[1].rsplit('\nPY\n',1)[0]
m=types.ModuleType('volumes')
exec(compile(src,'volumes','exec'),m.__dict__)

class LocalVolumeTest(unittest.TestCase):
    def test_refuses_live_writer_without_stopping_or_archiving(self):
        commands=[]
        def call(args):
            commands.append(args)
            if args[1]=='ps': return b'abc123'
            return json.dumps([{'Id':'abc123','Name':'/writer','State':{'Running':True},'Mounts':[{'Type':'volume','Name':m.VOLUMES[0],'RW':True}]}]).encode()
        output=io.StringIO()
        with patch.object(m,'call',side_effect=call),patch.object(m.os,'geteuid',return_value=0),contextlib.redirect_stdout(output):
            self.assertEqual(m.main(),2)
        self.assertEqual(json.loads(output.getvalue())['reason'],'volume_writers_still_running')
        self.assertTrue(all(c[1] in ('ps','inspect') for c in commands))

    def test_real_archives_compare_and_preserve_secrets_privately(self):
        with tempfile.TemporaryDirectory() as root:
            volumes=[]
            for i,name in enumerate(m.VOLUMES):
                path=Path(root)/('source'+str(i)); path.mkdir(); (path/'private').write_text('PRIVATE_CONTENT')
                volumes.append({'Name':name,'Driver':'local','Options':None,'Mountpoint':str(path)})
            original=m.call; commands=[]
            def call(args):
                commands.append(args)
                if args[0]=='tar': return original(args)
                if args[1]=='ps': return b'abc123'
                if args[1]=='inspect': return b'[{"State":{"Running":false}}]'
                if args[1]=='volume': return json.dumps(volumes).encode()
                self.fail(str(args))
            output=io.StringIO()
            with patch.object(m,'ROOT',root),patch.object(m,'call',side_effect=call),patch.object(m.os,'geteuid',return_value=0),contextlib.redirect_stdout(output):
                self.assertEqual(m.main(),0)
            result=json.loads(output.getvalue())
            self.assertNotIn('PRIVATE_CONTENT',output.getvalue())
            self.assertFalse(result['applicationRestoreTested'])
            dest=Path(result['backup'])
            manifest=json.loads((dest/'manifest.private.json').read_text())
            self.assertEqual(len(manifest['volumes']),3)
            for v in manifest['volumes']:
                self.assertEqual(m.digest(dest/v['archive']),v['sha256'])
                self.assertEqual((dest/v['archive']).stat().st_mode & 0o777,0o600)
            self.assertFalse(any(c[0]=='docker' and c[1] in ('stop','start','pause','restart','update') for c in commands))

if __name__=='__main__': unittest.main()
