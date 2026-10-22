import unittest,tempfile,json,os,types
from pathlib import Path
SCRIPT=Path(__file__).with_name('grow-current-recovery-120.sh').read_text()
class Grow(unittest.TestCase):
 def exercise(self,size=120,running=False,invalid_formula=False,wrong_backup=False):
  code=SCRIPT.split("python3 - <<'PY'",1)[1].split('\nPY',1)[0]
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);backup=root/'backup';backup.mkdir(mode=0o700);receipt=root/'receipt.json';pin=root/'pin.json'
   old='a'*64;digest='27ea2d94d26bcc19d82ebf4b'+'0'*40
   r={'backup':'wrong' if wrong_backup else str(backup),'image':'adl-worker-partitioned:27ea2d94d26bcc19d82ebf4b','digest':digest,'oldContainer':old,'verifiedExitContainerId':old,'preExitProof':{'verified':True}}
   receipt.write_text(json.dumps(r));receipt.chmod(0o600)
   plan={'destination':str(backup),'requiredFreeBytes':45828354109,'inputBytes':5191673351,'copyMissingBytes':5 if not invalid_formula else 6,'failedOutputBytes':0,'outputReserveBytes':41533386808,'safetyAndActivationReserveBytes':4*1024**3}
   p=backup/'offline-rehearsal-disk-plan-attempt-test.json';p.write_text(json.dumps(plan));p.chmod(0o600)
   code=code.replace("Path('/etc/adl-homologation/recovery-root-ebs-identity.json')",repr(pin)).replace("Path('/var/backups/adl-partitioned-upgrade-_o9ovt74')",repr(backup)).replace("Path('/etc/adl-homologation/partitioned-upgrade-27ea2d94d26bcc19d82ebf4b.json')",repr(receipt)).replace('st.st_uid!=0','st.st_uid!=os.geteuid()')
   # repr(Path) requires PosixPath; retain actual script logic with fixture paths.
   env={'ADL_IDENTITY':json.dumps({'instanceId':'i-04690a17692088df9','region':'us-east-2','privateIp':'172.31.41.208'}),'ADL_SERIAL':'vol03fa30ff2fc37a28e','ADL_DEVICE_BYTES':str(size*1024**3),'ADL_MODE':'grow'}
   from unittest.mock import patch
   def inspect(args):
    return json.dumps([{'Id':old,'State':{'Running':running,'OOMKilled':False,'ExitCode':137,'FinishedAt':'recorded'},'Config':{'Labels':{'eu.adl.partitioned.patch':digest}}}]).encode()
   with patch.dict(os.environ,env),patch('subprocess.check_output',side_effect=inspect):exec(code,{'PosixPath':Path})
 def test_120_passes_saved_formula_and_completed_identity(self):self.exercise()
 def test_80_stops_before_resize(self):
  with self.assertRaisesRegex(SystemExit,'TO_120_GIB'):self.exercise(size=80)
 def test_running_old_worker_blocks(self):
  with self.assertRaisesRegex(SystemExit,'STILL_RUNNING'):self.exercise(running=True)
 def test_wrong_backup_blocks(self):
  with self.assertRaisesRegex(SystemExit,'RECEIPT_UNVERIFIED'):self.exercise(wrong_backup=True)
 def test_formula_is_not_trusted_blindly(self):
  with self.assertRaisesRegex(SystemExit,'FORMULA_MISMATCH'):self.exercise(invalid_formula=True)
if __name__=='__main__':unittest.main()
