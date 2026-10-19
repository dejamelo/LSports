"""No AWS access. Confirm sanitization, evidence gate and minimal API-only repair."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import subprocess
import os
import shutil
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('resume',Path(__file__).with_name('resume-adl-api.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class ResumeTest(unittest.TestCase):
    def test_classify_redacts_original_log(self):
        signals=m.classify(b"Error: invalid mount path: 'mode=1777' mount path must be absolute. https://user:PRIVATE@broker/?token=PRIVATE")
        self.assertEqual(signals,['invalid_tmpfs_mount_path'])
        self.assertNotIn('PRIVATE',json.dumps(signals))
    def test_only_expected_tmpfs_fields_change(self):
        before={'services':{'api':{'tmpfs':m.BAD,'image':'same','volumes':['existing']},'worker':{'tmpfs':m.BAD,'profiles':['feed-consumer']}}}
        fixed=m.expected_model(before)
        self.assertEqual(fixed['services']['api']['tmpfs'],m.GOOD)
        self.assertEqual(before['services']['api']['tmpfs'],m.BAD)
        self.assertEqual(fixed['services']['api']['volumes'],['existing'])
        self.assertEqual(fixed['services']['worker']['profiles'],['feed-consumer'])
        with self.assertRaises(ValueError):m.expected_model(fixed)
    def execute(self,apply=True,proof=True,unrelated=False):
        with tempfile.TemporaryDirectory() as root:
            secure=Path(root)/'etc';secure.mkdir();releases=Path(root)/'releases';releases.mkdir();release=releases/('a'*40);release.mkdir()
            metadata={'release':str(release),'image':'adl-homologation:'+release.name,'adminCidr':'192.0.2.1/32'}
            (secure/'deployment.json').write_text(json.dumps(metadata))
            (release/'deploy.private.log').write_text("invalid mount path: 'mode=1777' mount path must be absolute PRIVATE" if proof else 'unrelated PRIVATE')
            before={'services':{'api':{'tmpfs':m.BAD,'image':'same'},'worker':{'tmpfs':m.BAD,'profiles':['feed-consumer']}}}
            fixed=m.expected_model(before)
            if unrelated:fixed['services']['api']['image']='different'
            calls=[]
            def run(args,**kwargs):calls.append(args);return b''
            out=io.StringIO()
            with patch.object(m,'SECURE',secure),patch.object(m,'RELEASES',releases),patch.object(m,'BACKUPS',Path(root)),patch.object(m.os,'geteuid',return_value=0),patch.object(m.sys,'argv',['tool']+(['--apply'] if apply else [])),patch.object(m,'states',return_value=[]),patch.object(m,'control_status',side_effect=[None,200]),patch.object(m,'model',side_effect=[before,fixed]),patch.object(m,'run',side_effect=run),contextlib.redirect_stdout(out):
                code=m.main()
            self.assertNotIn('PRIVATE',out.getvalue())
            return code,calls,[json.loads(line) for line in out.getvalue().splitlines()],json.loads((secure/'deployment.json').read_text())
    def test_readonly_reports_without_mutating(self):
        code,calls,rows,metadata=self.execute(apply=False)
        self.assertEqual(code,0);self.assertEqual(calls,[])
        self.assertEqual(rows[0]['deployLogSignals'],['invalid_tmpfs_mount_path'])
        self.assertNotIn('composeOverrides',metadata)
    def test_apply_uses_existing_image_only_api_and_saves_override(self):
        code,calls,rows,metadata=self.execute()
        self.assertEqual(code,0)
        self.assertEqual(len(calls),2)
        self.assertEqual(calls[0][:3],['docker','image','inspect'])
        self.assertEqual(calls[1][-1],'api')
        self.assertIn('--no-build',calls[1]);self.assertIn('--no-deps',calls[1]);self.assertIn('never',calls[1])
        self.assertFalse(rows[-1]['workerStarted']);self.assertFalse(rows[-1]['imageRebuilt'])
        self.assertEqual(metadata['apiResumeFix'],'quoted_tmpfs_v1')
    def test_unknown_production_error_cannot_trigger_repair(self):
        code,calls,rows,_=self.execute(proof=False)
        self.assertEqual(code,2);self.assertEqual(calls,[])
        self.assertEqual(rows[-1]['stage'],'repair_gate')
        self.assertFalse(rows[-1]['apiMutationRequested'])
    def test_unrelated_config_change_blocks_before_up(self):
        code,calls,rows,metadata=self.execute(unrelated=True)
        self.assertEqual(code,2)
        self.assertEqual(rows[-1]['stage'],'model_validation')
        self.assertFalse(rows[-1]['apiMutationRequested'])
        self.assertEqual(len(calls),1)
        self.assertNotIn('composeOverrides',metadata)

    @unittest.skipUnless(shutil.which('docker'), 'Docker CLI not installed')
    def test_real_compose_parser_bug_and_minimal_override(self):
        basepath=Path(__file__).parent.resolve()
        with tempfile.TemporaryDirectory() as root:
            root=Path(root);old=root/'compose.yaml';fix=root/'fix.yaml'
            source=(basepath/'compose.yaml').read_text()
            self.assertEqual(source.count('tmpfs: ["/tmp:size=67108864,mode=1777"]'),2)
            old.write_text(source.replace('tmpfs: ["/tmp:size=67108864,mode=1777"]','tmpfs: [/tmp:size=67108864,mode=1777]'))
            fix.write_text(m.OVERRIDE)
            env={**os.environ,'API_ENV_FILE':str(basepath/'api.env.example'),'WORKER_ENV_FILE':str(basepath/'worker.env.example'),'ADL_CADDY_NETWORK':'deploy_default'}
            args=['docker','compose','-p','adl-homologation','-f',str(old),'-f',str(basepath/'compose.existing-caddy.yaml')]
            def model(extra):return json.loads(subprocess.check_output(args+extra+['--profile','*','config','--format','json'],env=env))
            before=model([]);after=model(['-f',str(fix)])
            self.assertEqual(before['services']['api']['tmpfs'],m.BAD)
            self.assertEqual(after,m.expected_model(before))

if __name__=='__main__':unittest.main()
