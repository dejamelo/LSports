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
    ns['install_cache_reserve']();self.assertTrue(any(r.get('stage')=='cache_policy_installed' for r in emitted));self.assertTrue(any(c[:2]==['systemctl','enable'] for c in calls));self.assertFalse(any(c[0]=='docker' for c in calls));self.assertIn('Restart=no',unit.read_text())
 def test_actual_reclaim_required_before_enable(self):self.run_case()
 def test_unsupported_kernel_stops_before_deployment(self):self.run_case(unsupported=True)
 def test_unknown_policy_is_never_overwritten(self):self.run_case(unknown=True)
if __name__=='__main__':unittest.main()
