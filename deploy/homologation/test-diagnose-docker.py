"""Local-only collector tests; no Docker/AWS/systemd calls."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import types
import unittest
from unittest.mock import patch

source = Path(__file__).with_name('diagnose-docker.sh').read_text().split("<<'PY'\n",1)[1].rsplit('\nPY\n',1)[0]
m = types.ModuleType('collector')
exec(compile(source,'diagnose-docker.sh:python','exec'),m.__dict__)

class CollectorTest(unittest.TestCase):
    def capture(self, fn):
        out = io.StringIO()
        with contextlib.redirect_stdout(out): result = fn()
        return result, [json.loads(line) for line in out.getvalue().splitlines()]

    def item(self, cid):
        return {'Id':cid, 'Name':'/test-'+cid, 'Config':{'Image':'app:test','Env':['SECRET=HIDDEN_VALUE'], 'Labels':{'secret':'HIDDEN_VALUE'}},'State':{'Running':True,'Health':{'Status':'healthy','Log':[{'Output':'HIDDEN_VALUE'}]}},'HostConfig':{'LogConfig':{'Type':'json-file','Config':None},'RestartPolicy':{'Name':'no'}},'Mounts':[], 'NetworkSettings':{}}

    def test_null_logging_map_and_private_fields(self):
        out = m.limits(self.item('a'*12))
        self.assertEqual(out['restartPolicy'],'no')
        self.assertIsNone(out['log']['maxSize'])
        self.assertNotIn('HIDDEN_VALUE',json.dumps(out))
        item = self.item('b'*12)
        item['State'].pop('Health')
        item['HostConfig']['LogConfig'] = None
        self.assertIsNone(m.limits(item)['health'])
        self.assertIsNone(m.limits(item)['log']['maxSize'])

    def test_failure_at_third_container_does_not_skip_fourth(self):
        ids = ['a'*12,'b'*12,'c'*12,'d'*12]
        def fake(args,stage,subject=None,timeout=20):
            if args[:2] == ['docker','info']: return b'{"NCPU":2}'
            if args[:2] == ['docker','ps']: return '\n'.join(ids).encode()
            if args[:2] == ['docker','inspect']:
                if args[2] == ids[2]: return None
                return json.dumps([self.item(args[2])]).encode()
            return b''
        with patch.object(m,'run',side_effect=fake), patch.object(m.shutil,'which',return_value='/mock'), patch.object(m,'boot_inventory'), patch.object(m,'pricing'):
            result, rows = self.capture(m.main)
        self.assertEqual(result,2)
        self.assertEqual(rows[-1]['containersInspected'],3)
        self.assertEqual(rows[-1]['inspectionFailures'],1)
        self.assertTrue(any(r.get('id') == ids[3] for r in rows))
        self.assertNotIn('HIDDEN_VALUE',json.dumps(rows))

    def test_template_failure_sanitized_and_identified(self):
        result = subprocess.CompletedProcess([],1,b'',b'template: index of untyped nil password=HIDDEN_VALUE')
        with patch.object(m.subprocess,'run',return_value=result):
            value,rows = self.capture(lambda:m.run(['docker','inspect','abc'],'container.inspect','abc'))
        self.assertIsNone(value)
        self.assertEqual(rows[0]['subject'],'abc')
        self.assertEqual(rows[0]['reason'],'template_error')
        self.assertNotIn('HIDDEN_VALUE',json.dumps(rows))

    def test_routes_redact_credentials_and_match_aliases(self):
        item=self.item('a'*12)
        item['NetworkSettings']={'Networks':{'shared':{'IPAddress':'172.18.0.2','Aliases':['backend']}}}
        caddy={'Name':'/edge','NetworkSettings':{'Networks':{'shared':{}}}}
        config={'apps':{'http':{'servers':{'srv0':{'routes':[{'match':[{'host':['example.test'],'header':{'Authorization':['HIDDEN_VALUE']}}], 'handle':[{'handler':'reverse_proxy','upstreams':[{'dial':'backend:3000'},{'dial':'https://user:HIDDEN_VALUE@host:443'}]}]}]}}}}}
        _,rows=self.capture(lambda:m.routes(config,[item,caddy],'/edge'))
        self.assertNotIn('HIDDEN_VALUE',json.dumps(rows))
        self.assertEqual(rows[0]['candidates'][0]['sharedNetworks'],['shared'])
        self.assertEqual(rows[0]['upstreams'][1],'[redacted_or_dynamic]')

    def test_boot_does_not_expose_exec_arguments(self):
        def fake(args,stage,subject=None,timeout=20):
            if stage=='boot.units': return b'custom.service enabled enabled\n'
            return b'Id=custom.service\nUnitFileState=enabled\nExecStart={ path=/usr/bin/docker ; argv[]=docker compose --secret HIDDEN_VALUE up ; }\n'
        with patch.object(m,'run',side_effect=fake): _,rows=self.capture(m.boot_inventory)
        self.assertTrue(rows[0]['mentionsCompose'])
        self.assertNotIn('HIDDEN_VALUE',json.dumps(rows))
        self.assertEqual(rows[0]['executables'],['docker'])

if __name__=='__main__': unittest.main()
