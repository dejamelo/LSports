"""No real Docker/SSH/window actions. Uses temporary files to verify export and refusal."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

def module(filename,name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(filename))
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
m=module('posnet-backup-transfer-remote.py','transfer')
w=module('posnet-window-services.py','window')

class TransferTest(unittest.TestCase):
    def test_sizes_do_not_follow_symlinks_and_allow_sparse_planning(self):
        with tempfile.TemporaryDirectory() as root:
            p=Path(root);(p/'private').write_bytes(b'PRIVATE');(p/'link').symlink_to('/etc/passwd')
            result=m.usage(p)
            self.assertEqual(result['logicalBytes'],7)
            self.assertGreater(result['archiveEstimateBytes'],7)
            self.assertEqual(result['entries'],2)
    def test_incomplete_volume_backup_cannot_be_exported(self):
        with tempfile.TemporaryDirectory() as root:
            p=Path(root)/'posnet-local-volumes-test';p.mkdir();(p/'manifest.private.json').write_text('{"volumes":[]}')
            with patch.object(m,'ROOT',Path(root)):
                with self.assertRaises(ValueError):m.export_metadata(str(p),'volumes')
    def test_copy_manifest_validates_real_sha_and_bytes(self):
        import hashlib
        with tempfile.TemporaryDirectory() as root:
            p=Path(root)/'posnet-local-volumes-test';p.mkdir();rows=[]
            for v in m.VOLUMES:
                data=b'PRIVATE';name=v+'.private.tar';(p/name).write_bytes(data)
                rows.append({'name':v,'archive':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'tarCompare':'ok'})
            (p/'manifest.private.json').write_text(json.dumps({'volumes':rows}))
            with patch.object(m,'ROOT',Path(root)):
                result=m.export_metadata(str(p),'volumes')
                self.assertEqual(len(result['files']),4)
                (p/rows[0]['archive']).write_bytes(b'CORRUPT')
                with self.assertRaises(ValueError):m.export_metadata(str(p),'volumes')
    def test_source_traversal_rejected(self):
        with self.assertRaises(ValueError):m.approved_directory('/etc','config')
    def test_no_window_action_without_explicit_flags(self):
        with patch.object(w.sys,'argv',['tool','stop']),patch.object(w,'call') as call:
            with self.assertRaises(ValueError):w.main()
            call.assert_not_called()
    def test_restore_does_not_overwrite_existing_different_file(self):
        import hashlib
        with tempfile.TemporaryDirectory() as root:
            p=Path(root);src=p/'backup';src.mkdir();(src/'file').write_bytes(b'ORIGINAL');dest=p/'target';dest.write_bytes(b'NEW')
            manifest={'files':[{'source':str(dest),'backupFile':'file','sha256':hashlib.sha256(b'ORIGINAL').hexdigest()}]}
            with patch.object(w,'TEMPFILES',{str(dest)}):
                with self.assertRaises(ValueError):w.restore_temp(src,manifest)
            self.assertEqual(dest.read_bytes(),b'NEW')

    def test_stop_and_recovery_target_only_the_twelve_preserved_containers(self):
        import copy
        with tempfile.TemporaryDirectory() as root:
            backup=Path(root)/'posnet-resize-config-test';backup.mkdir()
            ids=sorted(w.EXPECTED);items=[]
            for n,cid in enumerate(ids):
                name=sorted(w.CADDYS)[n] if n<3 else '/app-'+str(n)
                item={'Id':cid,'Name':name,'Image':'sha256:'+cid,'Mounts':[], 'State':{'Running':True,'ExitCode':0},'HostConfig':{'PortBindings':{}},'NetworkSettings':{'Networks':{}}}
                items.append(item);(backup/(cid+'.inspect.private.json')).write_text(json.dumps([item]))
            (backup/'manifest.private.json').write_text(json.dumps({'running':[{'id':cid} for cid in ids],'files':[]}))
            calls=[]
            def call(args,timeout=60):
                calls.append(args)
                if args[1]=='inspect':return json.dumps(items).encode()
                selected=args[4:] if args[1]=='stop' else args[2:]
                self.assertTrue(set(selected)<=w.EXPECTED)
                for item in items:
                    if item['Id'] in selected:item['State']['Running']=args[1]=='start'
                return b''
            out=io.StringIO()
            with patch.object(w,'ROOT',Path(root)),patch.object(w,'call',side_effect=call),patch.object(w.os,'geteuid',return_value=0),contextlib.redirect_stdout(out):
                with patch.object(w.sys,'argv',['tool','stop','--approved','--quiesced']):w.main()
                self.assertTrue(all(not i['State']['Running'] for i in items))
                with patch.object(w.sys,'argv',['tool','return','--approved']):w.main()
            self.assertTrue(all(i['State']['Running'] for i in items))
            self.assertEqual(sum(c[1]=='stop' for c in calls),2)
            self.assertEqual(sum(c[1]=='start' for c in calls),2)
            self.assertNotIn('EC2', ' '.join(' '.join(c) for c in calls))

    def test_validate_only_checks_health_and_never_exposes_health_logs(self):
        with tempfile.TemporaryDirectory() as root:
            backup=Path(root)/'posnet-resize-config-test';backup.mkdir();items=[]
            for n,cid in enumerate(sorted(w.EXPECTED)):
                name=sorted(w.CADDYS)[n] if n<3 else '/app-'+str(n)
                item={'Id':cid,'Name':name,'Image':'original','Mounts':[], 'State':{'Running':True,'Health':{'Status':'healthy','Log':[{'ExitCode':0,'Output':'PRIVATE_VALUE'}]}},'HostConfig':{},'NetworkSettings':{}}
                items.append(item);(backup/(cid+'.inspect.private.json')).write_text(json.dumps([item]))
            (backup/'manifest.private.json').write_text(json.dumps({'running':[{'id':cid} for cid in w.EXPECTED],'files':[]}))
            def call(args,timeout=60):
                self.assertEqual(args[1],'inspect');return json.dumps(items).encode()
            out=io.StringIO()
            with patch.object(w,'ROOT',Path(root)),patch.object(w,'call',side_effect=call),patch.object(w.os,'geteuid',return_value=0),patch.object(w.sys,'argv',['tool','validate']),contextlib.redirect_stdout(out):
                w.main()
            result=json.loads(out.getvalue());self.assertEqual(result['status'],'ok')
            self.assertTrue(result['readOnly']);self.assertNotIn('PRIVATE_VALUE',out.getvalue())

if __name__=='__main__':unittest.main()
