import hashlib,json,os,shutil,subprocess,tempfile,unittest,uuid
from pathlib import Path
HERE=Path(__file__).parent;REPO=HERE.resolve().parents[1];IMAGE='node:24-bookworm-slim'
@unittest.skipUnless(os.environ.get('ADL_PRE_EXIT_OFFLINE')=='1','opt-in isolated Docker WAL/replay proof')
class OfflineReplay(unittest.TestCase):
 def test_full_commit_wal_replay_roundtrip_and_incomplete_copy_rejection(self):
  with tempfile.TemporaryDirectory(prefix='adl-pre-exit-test-') as tmp:
   root=Path(tmp);source=root/'original';source.mkdir(mode=0o700);os.chown(source,1000,1000)
   base=['docker','run','--rm','--init','--network','none','--read-only','--memory','4g','--memory-swap','4g','--cpus','2','--user','node','--mount','type=bind,source='+str(REPO)+',target=/app,readonly','--tmpfs','/tmp:size=33554432,mode=1777','--entrypoint','node']
   result=subprocess.run(base+['--mount','type=bind,source='+str(source)+',target=/data','-e','ADL_OFFLINE_FIXTURE=1',IMAGE,'--max-old-space-size=2560','--import','/app/node_modules/tsx/dist/loader.mjs','/app/deploy/homologation/fixtures/pre-exit-wal.mjs'],capture_output=True,timeout=60)
   self.assertEqual(result.returncode,137,result.stderr.decode());self.assertTrue(all((source/('trade-feed.json.'+lane+'.inbox.sqlite-wal')).stat().st_size>0 for lane in ('prematch','inplay')))
   original={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in source.iterdir()}
   for incomplete in (False,True):
    with self.subTest(incomplete=incomplete):
     work=root/('work-bad' if incomplete else 'work-good');output=root/('output-bad' if incomplete else 'output-good');work.mkdir(mode=0o700);output.mkdir(mode=0o700);os.chown(work,1000,1000);os.chown(output,1000,1000)
     for src in source.iterdir():
      if incomplete and src.name.endswith(('-wal','-shm')):continue
      dst=work/src.name;shutil.copyfile(src,dst);os.chown(dst,1000,1000)
     command=base+['--mount','type=bind,source='+str(work)+',target=/recovery','--mount','type=bind,source='+str(output)+',target=/output',IMAGE,'--max-old-space-size=2560','--import','/app/node_modules/tsx/dist/loader.mjs','/app/deploy/homologation/pre-exit-replay-proof.mjs']
     result=subprocess.run(command,capture_output=True,timeout=120)
     if incomplete:
      self.assertEqual(result.returncode,1);self.assertNotIn(b'pre-exit-proof-ok',result.stdout);self.assertIn(b'inbox_integrity_prematch',result.stdout);self.assertFalse((output/'receipt.json').exists())
     else:
      self.assertEqual(result.returncode,0,result.stdout.decode()+result.stderr.decode());receipt=json.loads((output/'receipt.json').read_text());self.assertEqual(receipt['stateRows'],40);self.assertEqual([r['replayedRows'] for r in receipt['inboxes']],[100,100]);self.assertEqual([r['pendingCommittedRows'] for r in receipt['inboxes']],[100,100])
      result=subprocess.run(command+['readback'],capture_output=True,timeout=120);self.assertEqual(result.returncode,0,result.stdout.decode());readback=json.loads((output/'readback.json').read_text());self.assertTrue(readback['verified']);self.assertEqual(readback['stateSha256'],receipt['stateSha256'])
      public=json.loads((output/'projection.json').read_text());self.assertTrue(all(not s['available'] for e in public['events'] for s in e['selections']));settled=next(e for e in public['events'] if e['id']=='prematch:1');self.assertIn('selection_settled',settled['selections'][0]['unavailableReasons'])
     self.assertEqual(original,{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in source.iterdir()})
 def test_verified_paused_container_kill_is_not_reported_as_docker_oom(self):
  name='adl-isolated-finalize-'+uuid.uuid4().hex[:12]
  try:
   result=subprocess.run(['docker','run','-d','--name',name,'--init','--network','none','--read-only','--memory','128m','--user','node','--entrypoint','node',IMAGE,'-e','setInterval(()=>{},1000)'],capture_output=True,timeout=30);self.assertEqual(result.returncode,0,result.stderr.decode())
   subprocess.run(['docker','pause',name],check=True,capture_output=True,timeout=15);subprocess.run(['docker','kill','--signal','SIGKILL',name],check=True,capture_output=True,timeout=30)
   r=subprocess.run(['docker','inspect',name],capture_output=True,check=True,timeout=15);state=json.loads(r.stdout)[0]['State'];self.assertFalse(state['Running']);self.assertFalse(state['OOMKilled']);self.assertEqual(state['ExitCode'],137)
  finally:subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=30)
if __name__=='__main__':unittest.main()
