import ast
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import unittest

SOURCE=Path(__file__).with_name('upgrade-partitioned-worker.py')
tree=ast.parse(SOURCE.read_text())
selected={'partition_memory','partition_heap_mib','candidate_memory','measured_snapshot_retry_heap_plan','verify_budgeted_worker_runtime','existing_pipeline_heap_plan','pre_stop_copy_files','verified_existing_snapshot_memory_profile'}
functions=[node for node in tree.body if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef)) and node.name in selected]

def require(ok,reason):
    if not ok:raise RuntimeError(reason)

def partition_memory(progress):
    value=progress.get('memoryLimitBytes',4294967296)
    require(value==4294967296 or value==6442450944 and (progress.get('pipelineRepair') is True or progress.get('snapshotMemoryRepair') is True and progress.get('snapshotPressureRepair') is True and progress.get('livePersistenceRepair') is True),'UPGRADE_MEMORY_SCOPE_UNVERIFIED')
    return value

def read_tail(path):return path.read_bytes()
def rehearse(_raw):return {'fatalSignals':['javascript_heap_out_of_memory'],'stageAtFailure':'snapshot.apply','effectiveHeapLimitBytes':4496293888,'maxSampledHeapBytes':4122212936,'maxObservedRSSBytes':4511752192}
def summary(_backup,_name):return {'signals':['node_heap_exhausted']}
def host_memory():return 12*1024**3

namespace={'require':require,'partition_memory':partition_memory,'read_tail':read_tail,'rehearsal_heap_evidence':rehearse,'oom_restore_log_summary':summary,'snapshot_host_memory':host_memory,'json':json,'os':os,'re':re,'hashlib':hashlib,'copy':copy,'snapshot_memory_bytes':lambda value:value}
exec(compile(ast.Module(body=functions,type_ignores=[]),str(SOURCE),'exec'),namespace)

class MeasuredSnapshotRetryHeap(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.backup=Path(self.tmp.name);self.backup.chmod(0o700)
        self.log=self.backup/'oom-restore-attempt-0123456789abcdef.private.log';self.log.write_bytes(b'sanitized synthetic evidence');self.log.chmod(0o600)
        self.pointer=self.backup/'oom-restore.latest.json';self.pointer.write_text(json.dumps({'name':self.log.name}));self.pointer.chmod(0o600)
        self.progress={'phase':'stopped','backup':str(self.backup),'memoryLimitBytes':6442450944,'pipelineRepair':True,'snapshotMemoryRepair':True,'livePersistenceRepair':True,'oldContainer':'a'*64,'heapBudgetPlan':{'evidenceVerified':True,'measuredSnapshotApply':True,'previousOldSpaceMiB':3840,'oldSpaceMiB':4096,'containerLimitUnchanged':True,'outsideOldSpaceBytes':2147483648,'guardBudgetBytes':335544320,'sourceTailSha256':'a'*64}}
        self.worker=[{'id':'a'*64,'running':False,'oomKilled':False,'exitCode':0}]
    def tearDown(self):self.tmp.cleanup()
    def test_verified_existing_eight_gib_profile_is_reused_without_relaxing_heap_reserve(self):
        proof={'status':'ok','offlineRestoreVerified':True,'projectionReadbackVerified':True,'rehearsalCopyVerified':True,'preservedSpoolRehearsed':True,'effectiveHeapLimitBytes':5033164800,'maxSampledHeapBytes':4374513640,'maxObservedRSSBytes':4951400448,'readbackHeapLimitBytes':5033164800,'projectionReadbackBudgetBytes':335544320}
        worker={'environment':{'NODE_OPTIONS':'--max-old-space-size=4608'}}
        self.assertTrue(namespace['verified_existing_snapshot_memory_profile'](proof,worker,8589934592))
        self.assertFalse(namespace['verified_existing_snapshot_memory_profile']({**proof,'maxSampledHeapBytes':4700000000},worker,8589934592))
        self.assertFalse(namespace['verified_existing_snapshot_memory_profile'](proof,{'environment':{'NODE_OPTIONS':'--max-old-space-size=6144'}},8589934592))
    def test_measured_heap_failure_selects_4608_mib_inside_same_six_gib_cgroup(self):
        plan=namespace['measured_snapshot_retry_heap_plan'](self.progress,self.backup,self.worker)
        self.assertEqual(plan['oldSpaceMiB'],4608);self.assertEqual(plan['outsideOldSpaceBytes'],1610612736)
        self.assertEqual(plan['containerLimitBytes'],6442450944);self.assertEqual(namespace['partition_heap_mib']({**self.progress,'heapBudgetPlan':plan}),4608)
        self.assertEqual(plan['sourceTailSha256'],hashlib.sha256(self.log.read_bytes()).hexdigest())
    def test_runtime_probe_keeps_512_mib_outside_heap(self):
        plan=namespace['measured_snapshot_retry_heap_plan'](self.progress,self.backup,self.worker)
        image='adl-worker-partitioned:'+'b'*24;image_id='sha256:'+'c'*64
        namespace['run']=lambda *_a,**_k:json.dumps({'cgroupLimitBytes':6442450944,'effectiveHeapLimitProbeBytes':5300000000}).encode()
        inspected={'Image':image_id,'HostConfig':{'Memory':6442450944},'Config':{'Env':['NODE_OPTIONS=--max-old-space-size=4608','LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT=true','LSPORTS_INPLAY_STREAMED_SNAPSHOT=true']}}
        result=namespace['verify_budgeted_worker_runtime']({**self.progress,'heapBudgetPlan':plan},'worker',inspected,image_id)
        self.assertEqual(result['effectiveHeapLimitProbeBytes'],5300000000)
    def test_existing_measured_4608_heap_is_reused_only_with_pinned_receipt(self):
        plan=namespace['measured_snapshot_retry_heap_plan'](self.progress,self.backup,self.worker)
        image='adl-worker-partitioned:'+'b'*24;digest='b'*24+'c'*40
        receipt={'image':image,'digest':digest,'oomRestoreVerified':True,'memoryLimitBytes':6442450944,'pipelineRepair':True,'snapshotMemoryRepair':True,'livePersistenceRepair':True,'measuredSnapshotRetryHeapRepair':True,'heapBudgetPlan':plan}
        path=self.backup/('partitioned-upgrade-'+('b'*24)+'.json');path.write_text(json.dumps(receipt));path.chmod(0o600)
        namespace['SECURE']=self.backup
        def run(args,**_kwargs):
            if args[1]=='image':return json.dumps([{'Config':{'Labels':{'eu.adl.partitioned.patch':digest}}}]).encode()
            return json.dumps({'heapLimitBytes':5300000000}).encode()
        namespace['run']=run
        worker={'environment':{'NODE_OPTIONS':'--max-old-space-size=4608'},'mem_limit':6442450944,'image':image}
        self.assertEqual(namespace['existing_pipeline_heap_plan'](worker),plan)
        worker['environment']['NODE_OPTIONS']='--max-old-space-size=5120'
        with self.assertRaisesRegex(RuntimeError,'PIPELINE_EXISTING_HEAP_OPTIONS_CHANGED_NO_DEPLOYMENT'):
            namespace['existing_pipeline_heap_plan'](worker)
    def test_rejects_unverified_or_insufficient_host_memory(self):
        previous=namespace['rehearsal_heap_evidence'];namespace['rehearsal_heap_evidence']=lambda _raw:{'fatalSignals':[],'stageAtFailure':'snapshot.apply','effectiveHeapLimitBytes':4496293888,'maxSampledHeapBytes':4122212936,'maxObservedRSSBytes':4511752192}
        with self.assertRaisesRegex(RuntimeError,'MEASURED_SNAPSHOT_RETRY_HEAP_FAILURE_UNVERIFIED'):
            namespace['measured_snapshot_retry_heap_plan'](self.progress,self.backup,self.worker)
        namespace['rehearsal_heap_evidence']=previous
        previous=namespace['snapshot_host_memory'];namespace['snapshot_host_memory']=lambda:5*1024**3
        with self.assertRaisesRegex(RuntimeError,'MEASURED_SNAPSHOT_RETRY_HOST_HEADROOM_INSUFFICIENT'):
            namespace['measured_snapshot_retry_heap_plan'](self.progress,self.backup,self.worker)
        namespace['snapshot_host_memory']=previous

class PreStopCopySet(unittest.TestCase):
    def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.directory=Path(self.tmp.name)
    def tearDown(self):self.tmp.cleanup()
    def touch(self,name):
        p=self.directory/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b'preserved');return p
    def test_capacity_estimate_matches_verified_checkpoint_and_inbox_copy_set(self):
        expected={
            'trade-feed.json','trade-feed.json.regular-checkpoint.json',
            'trade-feed.json.prematch.inbox.sqlite','trade-feed.json.prematch.inbox.sqlite-wal','trade-feed.json.prematch.inbox.sqlite-shm',
            'trade-feed.json.inplay.inbox.sqlite','trade-feed.json.inplay.inbox.sqlite-wal','trade-feed.json.inplay.inbox.sqlite-shm',
        }
        for name in expected|{'trade-feed.json.regular-checkpoint.json.7.tmp','.full-snapshot-prematch/response.private.json'}:
            self.touch(name)
        paths=namespace['pre_stop_copy_files'](self.directory)
        self.assertEqual({p.relative_to(self.directory).as_posix() for p in paths},expected)
        self.assertTrue((self.directory/'trade-feed.json.regular-checkpoint.json.7.tmp').exists())
        self.assertTrue((self.directory/'.full-snapshot-prematch/response.private.json').exists())
    def test_rejects_missing_lane_or_symlink_in_preserved_files(self):
        for name in ('trade-feed.json','trade-feed.json.regular-checkpoint.json','trade-feed.json.prematch.inbox.sqlite','trade-feed.json.inplay.inbox.sqlite'):
            self.touch(name)
        (self.directory/'trade-feed.json.inplay.inbox.sqlite').unlink()
        with self.assertRaisesRegex(RuntimeError,'PRE_STOP_INBOX_COPY_SET_UNVERIFIED'):
            namespace['pre_stop_copy_files'](self.directory)

if __name__=='__main__':unittest.main()
