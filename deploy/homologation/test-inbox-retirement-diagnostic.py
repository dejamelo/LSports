import importlib.util,sqlite3,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('retirement',Path(__file__).with_name('inbox-retirement-diagnostic.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class RetirementTest(unittest.TestCase):
 def test_read_only_wal_cohorts_and_durable_retirement(self):
  with tempfile.TemporaryDirectory() as directory:
   path=Path(directory)/'inbox.sqlite'
   with sqlite3.connect(path) as writer:
    writer.execute('PRAGMA journal_mode=WAL');writer.execute('PRAGMA wal_autocheckpoint=0')
    writer.execute('CREATE TABLE inbox(id INTEGER PRIMARY KEY AUTOINCREMENT,received INTEGER NOT NULL,content BLOB)')
    writer.execute('CREATE INDEX inbox_processing_receipt ON inbox(id,received)')
    writer.executemany('INSERT INTO inbox(received,content) VALUES(?,?)',[(100,b'old'),(200,b'old')]);writer.commit()
    first=module.sample(path);self.assertEqual(first['pendingOldRows'],2)
    writer.execute('DELETE FROM inbox WHERE id=1');writer.execute('INSERT INTO inbox(received,content) VALUES(300,?)',(b'new',));writer.commit()
    last=module.sample(path,first['boundaryId'])
    self.assertEqual(last['pendingOldRows'],1);self.assertEqual(last['pendingNewRows'],1)
    self.assertEqual(last['insertId']-first['insertId'],1);self.assertEqual(last['oldestReceivedMs'],200)
    self.assertEqual(writer.execute('SELECT count(*) FROM inbox').fetchone()[0],2)
if __name__=='__main__':unittest.main()
