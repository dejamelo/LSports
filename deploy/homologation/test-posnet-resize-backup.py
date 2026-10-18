import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

src=Path(__file__).with_name('prepare-posnet-resize-backup.sh').read_text().split("<<'PY'\n",1)[1].rsplit('\nPY\n',1)[0]
m=types.ModuleType('backup')
exec(compile(src,'backup','exec'),m.__dict__)

class BackupTest(unittest.TestCase):
    def test_private_backup_and_sanitized_local_persistence(self):
        with tempfile.TemporaryDirectory() as root:
            config=Path(root)/'config'; config.write_text('PRIVATE_SECRET')
            item={'Id':'a'*64,'Name':'/app','Config':{'Env':['SUPABASE_SERVICE_ROLE_KEY=PRIVATE_SECRET']},'State':{'Running':True},'Mounts':[{'Type':'volume','Destination':'/data','RW':True}]}
            calls=[]
            def call(args):
                calls.append(args)
                if args[:3]==['docker','ps','-aq']: return b'aaaaaaaaaaaa'
                if args[:2]==['docker','inspect']: return json.dumps([item]).encode()
                if args[:2]==['docker','diff']: return b'A /data/test.db\nC /uploads/private-user/file\n'
                if args[:2]==['docker','exec']: return b'{"private":"PRIVATE_SECRET"}'
                self.fail(str(args))
            output=io.StringIO()
            with patch.object(m,'ROOT',root),patch.object(m,'FILES',[str(config)]),patch.object(m.os,'geteuid',return_value=0),patch.object(m,'call',side_effect=call),contextlib.redirect_stdout(output):
                self.assertEqual(m.main(),0)
            self.assertNotIn('PRIVATE_SECRET',output.getvalue())
            self.assertNotIn('private-user',output.getvalue())
            rows=[json.loads(s) for s in output.getvalue().splitlines()]
            local=next(r for r in rows if r['stage']=='local_persistence')
            self.assertEqual(local['configurationFamiliesPresent'],['supabase'])
            self.assertEqual(local['databaseFileCandidates'],1)
            self.assertEqual(rows[-1]['databaseBackup'],'not_verified')
            backup=Path(rows[-1]['backup'])
            self.assertEqual(backup.stat().st_mode & 0o777,0o700)
            self.assertTrue(all(f.stat().st_mode & 0o777==0o600 for f in backup.iterdir()))
            self.assertTrue(all(c[1] in ('ps','inspect','diff','exec') for c in calls))

    def test_missing_configuration_preserves_partial_backup_and_no_mutations(self):
        with tempfile.TemporaryDirectory() as root:
            output=io.StringIO()
            with patch.object(m,'ROOT',root),patch.object(m,'FILES',[root+'/missing']),patch.object(m.os,'geteuid',return_value=0),patch.object(m,'call',return_value=b'aaaaaaaaaaaa'),contextlib.redirect_stdout(output):
                self.assertEqual(m.main(),2)
            last=json.loads(output.getvalue().splitlines()[-1])
            self.assertEqual(last['stage'],'configuration_backup')
            self.assertTrue(Path(last['backup']).exists())
            self.assertTrue(last['noRestartRequested'])

if __name__=='__main__': unittest.main()
