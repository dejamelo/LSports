import hashlib,json,tempfile,unittest
from pathlib import Path
HERE=Path(__file__).parent

def load():
 ns={'__name__':'tested','PRE_EXIT_REPLAY_PROOF':(HERE/'pre-exit-replay-proof.mjs').read_text()}
 for name in ('resume-adl-api.py','repair-adl-snapshot.py','upgrade-partitioned-worker.py','execute-adl-cutover-aws.py'):exec((HERE/name).read_text().split("if __name__=='__main__':")[0],ns)
 return ns
class PreExitRecovery(unittest.TestCase):
 def exercise(self,failed=False):
  ns=load();cid='a'*64;base='sha256:'+'b'*64;digest='c'*64;image='adl-worker-partitioned:'+digest[:24];calls=[];output=[];state={'running':True,'paused':False}
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);source=root/'source';source.mkdir();backup=root/'backup';backup.mkdir(mode=0o700)
   for name in ('trade-feed.json','trade-feed.json.regular-checkpoint.json','trade-feed.json.prematch.inbox.sqlite','trade-feed.json.prematch.inbox.sqlite-wal','trade-feed.json.inplay.inbox.sqlite','trade-feed.json.inplay.inbox.sqlite-wal'):(source/name).write_bytes(b'preserved original')
   before={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in source.iterdir()}
   progress={'oldContainer':cid,'baseImageId':base,'image':image,'digest':digest,'supplierStoppedBeforeConsumer':True}
   def info():return {'Id':cid,'Image':base,'State':{'Pid':987654,'Running':state['running'],'Paused':state['paused']},'HostConfig':{'Memory':4294967296},'Mounts':[{'Destination':'/app/.runtime/feed','Type':'volume','Name':'feed','RW':True}]}
   def run(args,**kw):
    calls.append(args)
    if args[:2]==['docker','inspect']:return json.dumps([info()]).encode()
    if args[:2]==['docker','top']:return b'PID PPID STAT COMMAND\n987654 1 S docker-init\n987655 987654 S node\n'
    if args[:3]==['docker','volume','inspect']:return json.dumps([{'Mountpoint':str(source),'Labels':{'com.docker.compose.project':'adl-homologation'}}]).encode()
    if args[:2]==['docker','ps']:return (cid if state['running'] else '').encode()
    if args[:2]==['docker','pause']:state['paused']=True;return b''
    if args[:3]==['docker','image','inspect']:return json.dumps([{'Id':'sha256:'+'d'*64,'Config':{'User':'node','Labels':{'eu.adl.partitioned.patch':digest}}}]).encode()
    if args[:2]==['docker','run']:return json.dumps({'uid':1000,'gid':1000,'opened':True,'readBytes':1}).encode()
    if args[:2]==['docker','kill']:
     self.assertEqual(args,['docker','kill','--signal','SIGKILL',cid]);self.assertTrue(progress['preExitProof']['verified']);self.assertTrue(state['paused']);state['running']=False;return b''
    raise AssertionError('unexpected command')
   def proof(command,log,phase):
    if failed:raise RuntimeError('PRE_EXIT_COPY_RECOVERY_FAILED_NO_TERMINATION')
    target=next(a for a in command if 'target=/output' in str(a));folder=Path(target.split('source=')[1].split(',target=')[0]);data=b'validated projection';(folder/'projection.json').write_bytes(data);(folder/'projection.json.regular-checkpoint.json').write_bytes(b'validated regular checkpoint')
    sha=hashlib.sha256(data).hexdigest();r={'sha256':sha,'stateRows':40,'stateSha256':'f'*64,'inboxes':[{'lane':lane,'pendingCommittedRows':100,'replayedRows':100,'rawRecordSha256':'e'*64} for lane in ('prematch','inplay')]};(folder/'receipt.json').write_text(json.dumps(r));(folder/'readback.json').write_text(json.dumps({'verified':True,'projectionSha256':sha,'stateRows':40,'stateSha256':'f'*64}))
   ns.update(run=run,states=lambda _:[{'id':cid,'running':state['running']}],emit=lambda **r:output.append(r),snapshot_host_memory=lambda:8*1024**3,pre_exit_proof_run=proof)
   evidence={'shutdownLogs':[{'status':'stopping'},{'status':'ok'}]}
   if failed:
    with self.assertRaisesRegex(RuntimeError,'PRE_EXIT_COPY_RECOVERY_FAILED_NO_TERMINATION'):ns['recover_completed_shutdown'](progress,lambda p:None,backup,evidence)
    self.assertTrue(state['running']);self.assertTrue(state['paused']);self.assertFalse(any(c[:2]==['docker','kill'] for c in calls));self.assertFalse(progress['preExitProof']['verified'])
   else:
    ns['recover_completed_shutdown'](progress,lambda p:None,backup,evidence)
    self.assertEqual(progress['phase'],'stopped');self.assertEqual(progress['verifiedExitContainerId'],cid);self.assertTrue(progress['preExitProof']['verified']);self.assertEqual(sum(c[:2]==['docker','kill'] for c in calls),1);self.assertEqual(progress['shutdownProcessTree']['nodeProcesses'][0]['executable'],'node')
    # Crash after finalization but before its acceptance receipt: observe exit, never re-kill.
    progress['phase']='stop_requested';progress['verifiedExitSignal']['status']='intent';progress.pop('verifiedExitContainerId');self.assertTrue(ns['mark_old_container_if_exited'](progress,lambda p:None));self.assertEqual(progress['verifiedExitSignal']['status'],'exit_observed_after_intent');self.assertEqual(sum(c[:2]==['docker','kill'] for c in calls),1)
   self.assertEqual(before,{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in source.iterdir()});self.assertFalse(any('SIGTERM' in c for c in calls))
 def test_tree_copy_recovery_and_verified_finalization_preserve_originals(self):self.exercise()
 def test_failed_copy_recovery_preserves_paused_original_and_never_finalizes(self):self.exercise(failed=True)
 def test_shutdown_ok_is_required_before_reversible_freeze(self):
  ns=load()
  with self.assertRaisesRegex(RuntimeError,'PRE_EXIT_APPLICATION_SHUTDOWN_NOT_COMPLETED'):ns['recover_completed_shutdown']({'oldContainer':'a'*64,'supplierStoppedBeforeConsumer':True},lambda p:None,Path('/not-used'),{'shutdownLogs':[{'status':'stopping'}]})
if __name__=='__main__':unittest.main()
