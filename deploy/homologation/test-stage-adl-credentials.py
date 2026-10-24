import runpy,unittest
from pathlib import Path

merge=runpy.run_path(str(Path(__file__).with_name('stage-adl-credentials.py')))['merge_worker_credentials']

class CredentialMerge(unittest.TestCase):
 def test_mq_reissue_preserves_primary_and_all_other_worker_settings(self):
  old=b'# retained\nLSPORTS_PREMATCH_USERNAME=old-pre-user\nLSPORTS_PREMATCH_PASSWORD=old-pre-pass\nLSPORTS_INPLAY_USERNAME=old-live-user\nLSPORTS_INPLAY_PASSWORD=old-live-pass\nLSPORTS_PREMATCH_QUEUE=custom_queue\nNODE_OPTIONS=--max-old-space-size=3584\n'
  new,changed=merge(old,{'LSPORTS_PREMATCH_USERNAME':'old-pre-user','LSPORTS_PREMATCH_PASSWORD':'old-pre-pass','LSPORTS_INPLAY_USERNAME':'old-live-user','LSPORTS_INPLAY_PASSWORD':'old-live-pass','LSPORTS_PREMATCH_MQ_USERNAME':'new-rmq-user','LSPORTS_PREMATCH_MQ_PASSWORD':'new-rmq-pass','LSPORTS_INPLAY_MQ_USERNAME':'new-live-rmq-user','LSPORTS_INPLAY_MQ_PASSWORD':'new-live-rmq-pass'})
  self.assertEqual(changed,['LSPORTS_INPLAY_MQ_PASSWORD','LSPORTS_INPLAY_MQ_USERNAME','LSPORTS_PREMATCH_MQ_PASSWORD','LSPORTS_PREMATCH_MQ_USERNAME'])
  for line in (b'# retained',b'LSPORTS_PREMATCH_QUEUE=custom_queue',b'NODE_OPTIONS=--max-old-space-size=3584',b'LSPORTS_PREMATCH_PASSWORD=old-pre-pass'):
   self.assertIn(line,new)
  self.assertEqual(new.count(b'LSPORTS_PREMATCH_MQ_USERNAME='),1)
  self.assertEqual(new.count(b'LSPORTS_INPLAY_MQ_PASSWORD='),1)

 def test_primary_rotation_changes_only_supplied_primary_fields(self):
  old=b'LSPORTS_PREMATCH_USERNAME=old-user\nLSPORTS_PREMATCH_PASSWORD=old-pass\nLSPORTS_INPLAY_USERNAME=live-user\nLSPORTS_INPLAY_PASSWORD=live-pass\nLSPORTS_PREMATCH_QUEUE=custom\n'
  new,changed=merge(old,{'LSPORTS_PREMATCH_USERNAME':'new-user','LSPORTS_PREMATCH_PASSWORD':'new-pass','LSPORTS_INPLAY_USERNAME':'live-user','LSPORTS_INPLAY_PASSWORD':'live-pass'})
  self.assertEqual(changed,['LSPORTS_PREMATCH_PASSWORD','LSPORTS_PREMATCH_USERNAME'])
  self.assertIn(b'LSPORTS_INPLAY_PASSWORD=live-pass\n',new)
  self.assertIn(b'LSPORTS_PREMATCH_QUEUE=custom\n',new)

 def test_unchanged_or_invalid_payload_is_rejected(self):
  old=b'LSPORTS_PREMATCH_USERNAME=old-user\nLSPORTS_PREMATCH_PASSWORD=old-pass\nLSPORTS_INPLAY_USERNAME=live-user\nLSPORTS_INPLAY_PASSWORD=live-pass\n'
  for payload in (
   {'LSPORTS_PREMATCH_USERNAME':'old-user','LSPORTS_PREMATCH_PASSWORD':'old-pass'},
   {'LSPORTS_PREMATCH_MQ_USERNAME':'new-user'},
   {'LSPORTS_PREMATCH_MQ_USERNAME':'','LSPORTS_PREMATCH_MQ_PASSWORD':''},
   {'LSPORTS_PREMATCH_PASSWORD':'line1\nline2'},
   {'UNRELATED_SECRET':'value'},
  ):
   with self.assertRaises(ValueError):merge(old,payload)

 def test_duplicate_credential_key_is_rejected(self):
  old=b'LSPORTS_PREMATCH_USERNAME=old-user\nLSPORTS_PREMATCH_USERNAME=other-user\nLSPORTS_PREMATCH_PASSWORD=old-pass\nLSPORTS_INPLAY_USERNAME=live-user\nLSPORTS_INPLAY_PASSWORD=live-pass\n'
  with self.assertRaises(ValueError):merge(old,{'LSPORTS_PREMATCH_PASSWORD':'new-pass'})

if __name__=='__main__':unittest.main()
