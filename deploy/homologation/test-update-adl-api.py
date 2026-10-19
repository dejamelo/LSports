import copy, importlib.util, sqlite3, tempfile, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('update',Path(__file__).with_name('update-adl-api.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class UpdateTests(unittest.TestCase):
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
    def test_no_worker_or_caddy_commands(self):
        code=Path(__file__).with_name('update-adl-api.py').read_text()
        self.assertNotIn("'down'",code);self.assertNotIn("'stop'",code);self.assertNotIn("'restart'",code);self.assertNotIn("'reload'",code)
        self.assertIn("'--no-deps','--no-build','--pull','never','api'",code)
        self.assertIn("SCHEMA_CHANGE_REQUIRES_MAINTENANCE",code)
if __name__=='__main__':unittest.main()
