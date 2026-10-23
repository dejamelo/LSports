import copy, importlib.util, sqlite3, tempfile, unittest, io, tarfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('update',Path(__file__).with_name('update-adl-api.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class UpdateTests(unittest.TestCase):
    def test_native_allocation_hints_do_not_echo_raw_frames_or_secrets(self):
        raw=b'2026-10-23T01:12:31Z v8::internal::JsonParser<char>::ParseJson() private-token=secret'
        self.assertEqual(m.api_allocation_hints(raw),['json_parse'])
        self.assertEqual(m.api_allocation_hints(b'FATAL ERROR: heap limit Allocation failed'),[])
        self.assertEqual(m.api_allocation_hints(b'v8::internal::JsonStringifier::SerializeJSObject()'),['json_stringify'])
    def test_only_api_image_may_change(self):
        old={'services':{'api':{'image':'old','volumes':['same'],'environment':{'DATA_MODE':'connected'}},'worker':{'image':'worker','mem_limit':4294967296}},'networks':{'same':{}}}
        new=copy.deepcopy(old);new['services']['api']['image']='new';m.compare_models(old,new,'new')
        for change in ('worker','volume','mode'):
            bad=copy.deepcopy(new)
            if change=='worker':bad['services']['worker']['image']='other'
            elif change=='volume':bad['services']['api']['volumes']=[]
            else:bad['services']['api']['environment']['DATA_MODE']='demo'
            with self.assertRaisesRegex(RuntimeError,'UNRELATED_COMPOSE_CHANGE'):m.compare_models(old,bad,'new')
    def test_live_wal_backup_integrity_credentials_and_ticket_preserved(self):
        with tempfile.TemporaryDirectory() as d:
            src=Path(d)/'control.sqlite';dst=Path(d)/'backup.sqlite'
            db=sqlite3.connect(src);db.execute('PRAGMA journal_mode=WAL');db.execute('CREATE TABLE admins(id,email,password)');db.execute("INSERT INTO admins VALUES('existing','private','hash-unchanged')");db.commit()
            m.backup_db(src,dst)
            with sqlite3.connect(dst) as b:
                self.assertEqual(b.execute('SELECT * FROM admins').fetchall(),[('existing','private','hash-unchanged')]);self.assertEqual(m.schema(b),m.schema(db))
            self.assertEqual(dst.stat().st_mode&0o777,0o600);db.close()
    def test_schema_gate_detects_change(self):
        db=sqlite3.connect(':memory:');db.execute('CREATE TABLE tickets(id)');before=m.schema(db);db.execute('ALTER TABLE tickets ADD COLUMN unexpected');self.assertNotEqual(before,m.schema(db));db.close()
    def test_only_reviewed_terminal_table_addition_allowed(self):
        db=sqlite3.connect(':memory:');db.execute('CREATE TABLE operations(id TEXT PRIMARY KEY)');old=m.schema(db)
        db.execute('CREATE TABLE operation_terminals(operation_id TEXT NOT NULL REFERENCES operations(id),terminal_id TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(operation_id,terminal_id))')
        self.assertEqual(m.compatible_schema(old,m.schema(db)),['operation_terminals'])
        db.execute('CREATE TABLE other(secret)')
        with self.assertRaisesRegex(RuntimeError,'UNREVIEWED_SCHEMA_ADDITION'):m.compatible_schema(old,m.schema(db))
        db.close()
    def test_git_archive_directory_entries_are_valid_but_links_and_escape_are_not(self):
        def archive(kind,name='apps/api/src/index.ts'):
            raw=io.BytesIO()
            with tarfile.open(fileobj=raw,mode='w') as t:
                d=tarfile.TarInfo('apps/');d.type=tarfile.DIRTYPE;t.addfile(d)
                f=tarfile.TarInfo(name)
                if kind=='link':f.type=tarfile.SYMTYPE;f.linkname='/etc/passwd';t.addfile(f)
                else:f.size=4;t.addfile(f,io.BytesIO(b'test'))
            raw.seek(0);return raw
        with tempfile.TemporaryDirectory() as d:
            m.receive_source(archive('file'),Path(d));self.assertEqual((Path(d)/'apps/api/src/index.ts').read_bytes(),b'test')
            for raw in [archive('link'),archive('file','../outside')]:
                with self.assertRaisesRegex(RuntimeError,'ARCHIVE_PATH_REJECTED'):m.receive_source(raw,Path(d))
    def test_version_attestation_and_progress_are_required(self):
        code=Path(__file__).with_name('update-adl-api.py').read_text()
        self.assertIn('org.opencontainers.image.revision',code)
        self.assertIn('INSTALLED_IMAGE_VERSION_MISMATCH',code)
        self.assertIn('INSTALLED_SOURCE_MISMATCH',code)
        self.assertIn('installedSourceVerified=True',code)
        self.assertIn("emit(stage=stage,status='running')",code)
    def test_no_worker_or_caddy_commands(self):
        code=Path(__file__).with_name('update-adl-api.py').read_text()
        self.assertNotIn("'down'",code);self.assertNotIn("'stop'",code);self.assertNotIn("'restart'",code);self.assertNotIn("'reload'",code)
        self.assertIn("'--no-deps','--no-build','--pull','never','api'",code)
        self.assertIn("EXISTING_SCHEMA_CHANGED",code)
if __name__=='__main__':unittest.main()
