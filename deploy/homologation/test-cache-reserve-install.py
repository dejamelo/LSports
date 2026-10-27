import unittest,tempfile,json,subprocess,runpy,os,types
from pathlib import Path
BASE=Path(__file__).parent
class Install(unittest.TestCase):
 def run_case(self,unsupported=False,unknown=False):
  ns=runpy.run_path(str(BASE/'test-upgrade-partitioned-worker.py'))['NS']
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);secure=root/'secure';secure.mkdir();backups=root/'backups';backups.mkdir();unit=root/'unit.service';calls=[];emitted=[]
   if unknown:unit.write_text('unrelated original unit')
   def mapped(value):return unit if str(value)=='/etc/systemd/system/adl-worker-cache-reserve.service' else Path(value)
   def run(args,**kw):
    calls.append(args)
    if args[0]=='python3':
     row={'status':'blocked','reason':'CACHE_RECLAIM_UNSUPPORTED_OR_DENIED_ERRNO_22'} if unsupported else {'status':'kernel_reclaim_measured','actualHeadroomBytes':2*1024**3}
     kw['log'].write_text(json.dumps(row))
     if unsupported:raise subprocess.CalledProcessError(2,args)
     return json.dumps(row).encode()
    if args[:2]==['systemctl','is-active']:return b'active'
    return b''
   ns.update(os=types.SimpleNamespace(**{**os.__dict__,'geteuid':lambda:0}),read_tail=lambda p:p.read_bytes(),Path=mapped,SECURE=secure,BACKUPS=backups,CACHE_RESERVE_SOURCE='isolated test policy',run=run,snapshot_host_memory=lambda:16*1024**3,emit=lambda **r:emitted.append(r))
   exec((BASE/'install-worker-cache-reserve.py').read_text().split('try:install_cache_reserve()')[0],ns)
   if unsupported or unknown:
    with self.assertRaisesRegex(RuntimeError,'EXISTING_CACHE_POLICY_DIFFERS_PRESERVED' if unknown else 'CACHE_RECLAIM_UNSUPPORTED_OR_DENIED_ERRNO_22'):ns['install_cache_reserve']()
    self.assertFalse(any(args[:2]==['systemctl','enable'] for args in calls))
    if unknown:self.assertEqual(unit.read_text(),'unrelated original unit')
   else:
    ns['install_cache_reserve']();self.assertTrue(any(r.get('stage')=='cache_policy_installed' for r in emitted));self.assertTrue(any(c[:2]==['systemctl','enable'] for c in calls));self.assertTrue(any(c[0]=='systemd-analyze' and c[2].endswith('.service') for c in calls));self.assertFalse(any(c[0]=='docker' for c in calls));self.assertIn('Restart=no',unit.read_text())
 def test_actual_reclaim_required_before_enable(self):self.run_case()
 def test_unsupported_kernel_stops_before_deployment(self):self.run_case(unsupported=True)
 def test_unknown_policy_is_never_overwritten(self):self.run_case(unknown=True)
 def test_known_six_gib_policy_upgrade_is_backed_up_and_restarted_without_worker_restart(self):
  ns=runpy.run_path(str(BASE/'test-upgrade-partitioned-worker.py'))['NS']
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);secure=root/'secure';secure.mkdir();backups=root/'backups';backups.mkdir();unit=root/'unit.service';calls=[];emitted=[]
   script=secure/'worker-cache-reserve.py';old=subprocess.check_output(['git','show','3ff730d:deploy/homologation/worker-cache-reserve.py'],cwd=BASE.parents[1]);script.write_bytes(old);script.chmod(0o600)
   unit.write_text('[Unit]\nDescription=ADL bounded clean-cache reserve, no worker restart\nAfter=docker.service\nRequires=docker.service\n[Service]\nType=simple\nExecStart=/usr/bin/python3 /etc/adl-homologation/worker-cache-reserve.py\nRestart=no\nUMask=0077\nMemoryMax=128M\nCPUQuota=5%\nNice=10\nNoNewPrivileges=yes\nProtectSystem=strict\nReadWritePaths=/sys/fs/cgroup\n[Install]\nWantedBy=multi-user.target\n');unit.chmod(0o600)
   prior=backups/'adl-cache-reserve-prior';prior.mkdir();receipt=prior/'verified.json';receipt.write_text(json.dumps({'policySha256':'79d34858740b082d20fb9ca5399aacf1efcadcfb98368980f860abe0314733c8','limitBytes':6442450944,'kernelReclaimVerified':True}));receipt.chmod(0o600)
   def mapped(value):return unit if str(value)=='/etc/systemd/system/adl-worker-cache-reserve.service' else Path(value)
   def run(args,**kw):
    calls.append(args)
    if args[0]=='python3':
     row={'status':'worker_stopped_no_action'};kw['log'].write_text(json.dumps(row));return json.dumps(row).encode()
    if args[:2]==['systemctl','is-active']:return b'active'
    return b''
   ns.update(os=types.SimpleNamespace(**{**os.__dict__,'geteuid':lambda:0}),read_tail=lambda p:p.read_bytes(),Path=mapped,SECURE=secure,BACKUPS=backups,CACHE_RESERVE_SOURCE='isolated upgraded policy',run=run,snapshot_host_memory=lambda:16*1024**3,emit=lambda **r:emitted.append(r))
   exec((BASE/'install-worker-cache-reserve.py').read_text().split('try:install_cache_reserve()')[0],ns)
   original_stat=Path.stat
   def root_owned_stat(path,*args,**kwargs):
    result=original_stat(path,*args,**kwargs)
    if str(path).startswith(str(root)):
     fields=list(result);fields[4]=0;return os.stat_result(fields)
    return result
   Path.stat=root_owned_stat
   try:ns['install_cache_reserve']()
   finally:Path.stat=original_stat
   self.assertNotEqual(script.read_bytes(),old);self.assertTrue(any(p.name=='worker-cache-reserve.py.before.private' and p.read_bytes()==old for p in backups.glob('adl-cache-reserve-*/worker-cache-reserve.py.before.private')))
   self.assertTrue(any(c[:2]==['systemctl','restart'] for c in calls));self.assertFalse(any(c[0]=='docker' for c in calls));self.assertTrue(any(r.get('stage')=='cache_policy_installed' and r.get('candidateWorkerLimitBytes')==8192*1024**2 for r in emitted))
 def test_reuses_exact_verified_active_policy_before_worker_release_without_ten_gib_precheck(self):
  ns=runpy.run_path(str(BASE/'test-upgrade-partitioned-worker.py'))['NS']
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);secure=root/'secure';secure.mkdir();backups=root/'backups';backups.mkdir();unit=root/'unit.service';calls=[];emitted=[];source='verified cache policy'
   unit.write_text('[Unit]\nDescription=ADL bounded clean-cache reserve, no worker restart\nAfter=docker.service\nRequires=docker.service\n[Service]\nType=simple\nExecStart=/usr/bin/python3 /etc/adl-homologation/worker-cache-reserve.py\nRestart=no\nUMask=0077\nMemoryMax=128M\nCPUQuota=5%\nNice=10\nNoNewPrivileges=yes\nProtectSystem=strict\nReadWritePaths=/sys/fs/cgroup\n[Install]\nWantedBy=multi-user.target\n');unit.chmod(0o600)
   (secure/'worker-cache-reserve.py').write_text(source);(secure/'worker-cache-reserve.py').chmod(0o600)
   prior=backups/'adl-cache-reserve-existing';prior.mkdir(mode=0o700);receipt=prior/'verified.json';receipt.write_text(json.dumps({'policySha256':__import__('hashlib').sha256(source.encode()).hexdigest(),'kernelReclaimVerifiedLimitBytes':6442450944,'kernelReclaimVerified':True,'candidateWorkerLimitBytes':8192*1024**2}));receipt.chmod(0o600)
   def mapped(value):return unit if str(value)=='/etc/systemd/system/adl-worker-cache-reserve.service' else Path(value)
   def run(args,**kwargs):
    calls.append(args)
    if args[:2]==['systemctl','is-active']:return b'active'
    if args[:2]==['systemctl','is-enabled']:return b'enabled'
    raise AssertionError(args)
   ns.update(os=types.SimpleNamespace(**{**os.__dict__,'geteuid':lambda:0}),Path=mapped,SECURE=secure,BACKUPS=backups,CACHE_RESERVE_SOURCE=source,run=run,snapshot_host_memory=lambda:6*1024**3,emit=lambda **r:emitted.append(r))
   exec((BASE/'install-worker-cache-reserve.py').read_text().split('try:install_cache_reserve()')[0],ns)
   original_stat=Path.stat
   def root_owned_stat(path,*args,**kwargs):
    result=original_stat(path,*args,**kwargs)
    if str(path).startswith(str(root)):
     fields=list(result);fields[4]=0;return os.stat_result(fields)
    return result
   Path.stat=root_owned_stat
   try:ns['install_cache_reserve']()
   finally:Path.stat=original_stat
   self.assertEqual([c[:2] for c in calls],[['systemctl','is-active'],['systemctl','is-enabled']])
   self.assertTrue(any(r.get('stage')=='cache_policy_installed' and r.get('reused') is True for r in emitted))
   self.assertEqual(len(list(backups.glob('adl-cache-reserve-*'))),1)
if __name__=='__main__':unittest.main()
