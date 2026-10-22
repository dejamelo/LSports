import unittest,copy,re,hashlib,json,subprocess,tempfile
from pathlib import Path
ns={'copy':copy,'re':re}
def require(ok,message):
 if not ok:raise RuntimeError(message)
ns['require']=require
exec(Path(__file__).with_name('relieve-current-memory.py').read_text().split('def relief_main():')[0],ns)
class Relief(unittest.TestCase):
 def group(self):return {'memory.max':4294967296,'memory.high':None,'stat':{'inactive_file':2131210240,'file_dirty':132313088,'file_writeback':0,'shmem':544768}}
 def test_real_measurement(self):
  p=ns['relief_plan'](self.group(),12885045696);self.assertEqual(p['cleanInactiveEstimateBytes'],1998352384);self.assertEqual(p['reclaimBytes'],1610612736);self.assertGreater(p['hostReserveAfterIncreaseBytes'],8*1024**3)
 def test_dirty_is_not_free(self):
  g=self.group();g['stat']['file_dirty']=3*1024**3;self.assertEqual(ns['relief_plan'](g,12*1024**3)['reclaimBytes'],0)
 def test_host_reserve(self):
  with self.assertRaisesRegex(RuntimeError,'HOST_RESERVE'):ns['relief_plan'](self.group(),9*1024**3)
 def test_high_guard(self):
  g=self.group();g['memory.high']=3*1024**3
  with self.assertRaisesRegex(RuntimeError,'MEMORY_HIGH'):ns['relief_plan'](g,12*1024**3)
 def test_resume_no_unbounded_increase(self):
  g=self.group();g['memory.max']=6*1024**3;p=ns['relief_plan'](g,9*1024**3);self.assertEqual(p['oldLimitBytes'],p['plannedLimitBytes']);self.assertEqual(p['hostReserveAfterIncreaseBytes'],9*1024**3)

# End-to-end host orchestration regression: cache headroom must not skip live/persistent update.
class PersistentRelief(unittest.TestCase):
 def test_already_reclaimed_cache_still_updates_and_preserves_other_services(self):
  import tempfile,json,os,datetime,copy,re
  from types import SimpleNamespace
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);secure=root/'secure';secure.mkdir();cid='176d57fbd609'+'a'*52
   cg=root/'cgroup';(cg/cid).mkdir(parents=True)
   (root/'meminfo').write_text('MemAvailable: 12582912 kB\n')
   (root/'cgroup-entry').write_text('0::/'+cid+'\n')
   original={'release':'preserved','composeOverrides':[]};(secure/'deployment.json').write_text(json.dumps(original))
   state={'limit':4*1024**3,'updates':0};events=[]
   info={'Image':'sha256:preserved','State':{'Pid':123,'StartedAt':'2026-10-22T00:00:00Z','Running':True,'OOMKilled':False},'HostConfig':{'Memory':state['limit'],'MemorySwap':state['limit']}}
   def run(args):
    if args[:2]==['docker','inspect']:
     value=copy.deepcopy(info);value['HostConfig']['Memory']=state['limit'];return json.dumps([value]).encode()
    if args[:2]==['docker','update']:state['limit']=int(args[args.index('--memory')+1]);state['updates']+=1;return b'ok'
    raise AssertionError(args)
   def mapped(p):
    return {'/proc/meminfo':root/'meminfo','/proc/123/cgroup':root/'cgroup-entry','/sys/fs/cgroup':cg}.get(str(p),Path(p))
   base_model={'services':{'worker':{'mem_limit':4*1024**3,'memswap_limit':4*1024**3,'environment':{'NODE_OPTIONS':'preserved'}},'api':{'image':'preserved-api'}}}
   def model(args):
    value=copy.deepcopy(base_model)
    for p in args:
     if str(p).endswith('.json'):value['services']['worker'].update(json.loads(Path(p).read_text())['services']['worker'])
    return value
   realopen=os.open
   def opened(path,*args):return realopen(root/'action.lock' if str(path).startswith('/run/lock/') else path,*args)
   local=dict(ns,Path=mapped,json=json,os=SimpleNamespace(**{k:getattr(os,k) for k in dir(os) if not k.startswith('__')}),datetime=datetime,copy=copy,re=re,hashlib=hashlib,SECURE=secure,run=run,states=lambda _: [{'id':cid,'running':True}],memory_cgroup=lambda _:{'memory.max':state['limit'],'memory.high':None,'memory.current':2407251968,'limitMinusCurrentBytes':state['limit']-2407251968,'stat':{},'memory.events':{'oom_kill':0}},emit=lambda **row:events.append(row),partition_base=lambda meta:meta['composeOverrides'],model=model,private=lambda path,data:path.write_bytes(data),durable_replace=lambda a,b:os.replace(a,b))
   local['os'].open=opened
   exec(Path(__file__).with_name('relieve-current-memory.py').read_text().split('try:relief_main()')[0],local)
   local['relief_main']()
   self.assertEqual(state['updates'],1);self.assertEqual(state['limit'],6*1024**3)
   saved=json.loads((secure/'deployment.json').read_text());self.assertEqual(saved['release'],'preserved');self.assertEqual(len(saved['composeOverrides']),1)
   self.assertTrue(any(e.get('stage')=='persistent_limit_verified' for e in events));self.assertFalse((cg/cid/'memory.reclaim').exists())

class ModelComparison(unittest.TestCase):
 def test_only_memory_representation_normalized(self):
  a={'services':{'worker':{'mem_limit':6442450944,'environment':{'X':'1'}}}}
  b=copy.deepcopy(a);b['services']['worker']['mem_limit']='6442450944'
  self.assertEqual(ns['memory_model_canonical'](a),ns['memory_model_canonical'](b))
  self.assertEqual(ns['safe_model_diff'](a,b)[0]['classification'],'representation_only')
  b['services']['worker']['environment']['X']=1
  self.assertNotEqual(ns['memory_model_canonical'](a),ns['memory_model_canonical'](b))
 def test_diagnostic_does_not_print_secrets(self):
  diff=ns['safe_model_diff']({'services':{'api':{'environment':{'PASSWORD':'before-secret'}}}}, {'services':{'api':{'environment':{'PASSWORD':'after-secret'}}}})
  self.assertNotIn('before-secret',json.dumps(diff));self.assertNotIn('after-secret',json.dumps(diff))
 def test_real_compose_merge(self):
  with tempfile.TemporaryDirectory() as tmp:
   folder=Path(tmp);a=folder/'base.json';b=folder/'override.json'
   a.write_text(json.dumps({'services':{'worker':{'image':'node:24-bookworm-slim','mem_limit':4294967296,'memswap_limit':4294967296},'api':{'image':'unchanged'}}}))
   b.write_text(json.dumps({'services':{'worker':{'mem_limit':6442450944,'memswap_limit':6442450944}}}))
   command=['docker','compose','-p','adl-memory-test','-f',str(a)]
   original=json.loads(subprocess.check_output(command+['config','--format','json']))
   candidate=json.loads(subprocess.check_output(command+['-f',str(b),'config','--format','json']))
   expected=copy.deepcopy(original);expected['services']['worker'].update({'mem_limit':6442450944,'memswap_limit':6442450944})
   self.assertNotEqual(expected,candidate)
   self.assertEqual(ns['memory_model_canonical'](candidate),ns['memory_model_canonical'](expected))
   paths={r['path'] for r in ns['safe_model_diff'](original,candidate)}
   self.assertEqual(paths,{'services/worker/mem_limit','services/worker/memswap_limit'})

if __name__=='__main__':unittest.main()
