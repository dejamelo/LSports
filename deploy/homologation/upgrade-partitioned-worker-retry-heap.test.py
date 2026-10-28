import ast
import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import unittest

SOURCE=Path(__file__).with_name('upgrade-partitioned-worker.py')
tree=ast.parse(SOURCE.read_text())
selected={'partition_memory','partition_heap_mib','candidate_memory','measured_snapshot_retry_heap_plan','verify_budgeted_worker_runtime','existing_pipeline_heap_plan','pre_stop_copy_files','verified_existing_snapshot_memory_profile','pipeline_memory_identity_verified','verify_pinned_added_dependencies','verify_transport_lifecycle_sources','incomplete_shutdown_recovery_eligible','work_counter_progress','stop_observation_fingerprint','sample_elapsed_seconds','verify_full_recovery_sources'}
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

namespace={'require':require,'partition_memory':partition_memory,'read_tail':read_tail,'rehearsal_heap_evidence':rehearse,'oom_restore_log_summary':summary,'snapshot_host_memory':host_memory,'json':json,'os':os,'re':re,'hashlib':hashlib,'copy':copy,'datetime':datetime,'snapshot_memory_bytes':lambda value:value}
namespace['PARTITION_FILES']={'apps/worker/src/durable-ingress.mjs','apps/worker/src/durable-ingress.d.mts','apps/worker/src/connected.ts','apps/worker/src/connection-closer.ts','apps/worker/src/diagnostics.ts','apps/worker/src/snapshot-capacity.ts','apps/worker/src/provider.ts','apps/worker/src/snapshot-scheduler.ts','apps/worker/src/state.ts','apps/worker/src/messages.ts','apps/worker/src/league-fixtures.ts','apps/worker/src/partitioned-snapshot.ts','apps/worker/src/full-snapshot.ts','apps/worker/src/persistence.ts','apps/worker/src/timestamp-recovery.ts','packages/contracts/src/index.ts','packages/feed-store/src/index.ts','packages/feed-store/src/operation-risk.ts','packages/feed-store/src/tenant-tickets.ts'}
namespace['PARTITION_DIGEST_FILES']=namespace['PARTITION_FILES']-{'packages/feed-store/src/operation-risk.ts','packages/feed-store/src/tenant-tickets.ts'}
namespace['PIPELINE_PINNED_ADDED_DEPENDENCY_SHA256']={'packages/feed-store/src/tenant-tickets.ts':'56bc1ee5debef412fd571439d9980ef065275ea141692aa58858278401103ad2'}
namespace['PIPELINE_ADDED_DEPENDENCY_SHA256']={'apps/worker/src/snapshot-capacity.ts':'6b5f7b632e4cc9f725edcc461392095ff865b4f47218d0d4b3b868d3bb130aa0'}
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
        self.assertEqual(namespace['partition_memory']({'memoryLimitBytes':8589934592,'verifiedExistingSnapshotMemoryProfile':True,'existingSnapshotMemoryNodeOptions':'--max-old-space-size=4608'}),8589934592)
        with self.assertRaises(RuntimeError):namespace['partition_memory']({'memoryLimitBytes':8589934592,'verifiedExistingSnapshotMemoryProfile':True,'existingSnapshotMemoryNodeOptions':'--max-old-space-size=6144'})
        self.assertTrue(namespace['pipeline_memory_identity_verified'](8589934592,False,True))
        self.assertFalse(namespace['pipeline_memory_identity_verified'](8589934592,False,False))
        self.assertTrue(namespace['pipeline_memory_identity_verified'](6442450944,False,False))
    def test_full_recovery_accepts_only_the_exact_projection_gate_delta_from_installed_image(self):
        names={'apps/worker/src/durable-ingress.mjs','apps/worker/src/durable-ingress.d.mts','apps/worker/src/connected.ts','apps/worker/src/connection-closer.ts','apps/worker/src/diagnostics.ts','apps/worker/src/snapshot-capacity.ts','apps/worker/src/provider.ts','apps/worker/src/snapshot-scheduler.ts','apps/worker/src/state.ts','apps/worker/src/messages.ts','apps/worker/src/league-fixtures.ts','apps/worker/src/partitioned-snapshot.ts','apps/worker/src/full-snapshot.ts','apps/worker/src/persistence.ts','apps/worker/src/timestamp-recovery.ts','packages/contracts/src/index.ts','packages/feed-store/src/index.ts','packages/feed-store/src/operation-risk.ts','packages/feed-store/src/tenant-tickets.ts'}
        old={name:'unchanged' for name in names};old['apps/worker/src/full-snapshot.ts']='transportComplete=res.complete===true; if(!transportComplete) reject(); transportBytes!==contentLengthBytes; Snapshot HTTP Content-Length mismatch'
        old['apps/worker/src/connected.ts']='previous verified connected implementation'
        new=dict(old);new['apps/worker/src/connected.ts']="lanes.every(c=>c.phase==='recovering'&&c.recoveryProgress?.stage==='snapshot'&&c.recoveryProgress.regularSnapshotReady===false)"
        digest=hashlib.sha256(json.dumps(old,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        namespace['verify_full_recovery_sources'](old,new,digest)
        with self.assertRaises(RuntimeError):namespace['verify_full_recovery_sources'](old,{**new,'apps/worker/src/state.ts':'unrelated'},digest)
        with self.assertRaises(RuntimeError):namespace['verify_full_recovery_sources'](old,new,'0'*64)
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

    def test_rolling_log_window_dropping_oldest_row_is_not_progress(self):
        first={'files':[{'kind':'checkpoint','bytes':10}],'records':[{'loggedAtUTC':'a'},{'loggedAtUTC':'b'}]}
        rolled={'files':[{'kind':'checkpoint','bytes':10}],'records':[{'loggedAtUTC':'b'}]}
        advanced={'files':[{'kind':'checkpoint','bytes':10}],'records':[{'loggedAtUTC':'b'},{'loggedAtUTC':'c'}]}
        self.assertEqual(namespace['stop_observation_fingerprint'](first),namespace['stop_observation_fingerprint'](rolled))
        self.assertNotEqual(namespace['stop_observation_fingerprint'](rolled),namespace['stop_observation_fingerprint'](advanced))
    def test_cpu_io_progress_threshold_scales_to_sample_interval(self):
        before={'cpuUsageUsec':1_000_000,'readBytes':0,'writeBytes':0}
        self.assertFalse(namespace['work_counter_progress'](before,{**before,'cpuUsageUsec':1_250_000},15))
        self.assertFalse(namespace['work_counter_progress'](before,{**before,'cpuUsageUsec':2_250_000},60))
        self.assertTrue(namespace['work_counter_progress'](before,{**before,'cpuUsageUsec':3_100_000},60))
        self.assertFalse(namespace['work_counter_progress'](before,{**before,'writeBytes':2*1024*1024},45))
        self.assertTrue(namespace['work_counter_progress'](before,{**before,'writeBytes':4*1024*1024},45))
    def test_verified_existing_snapshot_profile_reuses_8gib_heap_without_changing_reserve(self):
        image='adl-worker-partitioned:'+('d'*24);worker={'environment':{'NODE_OPTIONS':'--max-old-space-size=4608'},'mem_limit':8589934592,'image':image}
        previous_run=namespace.get('run');previous_states=namespace.get('states')
        namespace['states']=lambda _name:[{'id':'e'*64,'running':True}]
        def run(args,**_kwargs):
            if args[1]=='inspect':return json.dumps([{'Config':{'Image':image,'Env':['NODE_OPTIONS=--max-old-space-size=4608']},'HostConfig':{'Memory':8589934592}}]).encode()
            return json.dumps({'heapLimitBytes':5300000000}).encode()
        namespace['run']=run
        try:
            plan=namespace['existing_pipeline_heap_plan'](worker,True)
            self.assertEqual(plan,{'evidenceVerified':True,'oldSpaceMiB':4608,'previousOldSpaceMiB':4608,'containerLimitUnchanged':True,'preserveExisting':True,'effectiveHeapLimitBytes':5300000000})
            namespace['run']=lambda args,**_kwargs:json.dumps([{'Config':{'Image':image,'Env':['NODE_OPTIONS=--max-old-space-size=6144']},'HostConfig':{'Memory':8589934592}}]).encode()
            with self.assertRaisesRegex(RuntimeError,'PIPELINE_LIVE_WORKER_HEAP_PROBE_CONFIGURATION_UNVERIFIED'):
                namespace['existing_pipeline_heap_plan'](worker,True)
        finally:
            if previous_run is not None:namespace['run']=previous_run
            if previous_states is not None:namespace['states']=previous_states
            else:namespace.pop('states',None)
    def test_stopped_worker_profile_requires_verified_replay_receipt_and_probes_exact_image_offline(self):
        image='adl-worker-partitioned:'+('d'*24);container='e'*64;worker={'environment':{'NODE_OPTIONS':'--max-old-space-size=4608'},'mem_limit':8589934592,'image':image}
        previous_run=namespace.get('run');previous_states=namespace.get('states')
        namespace['states']=lambda _name:[{'id':container,'running':False}]
        def run(args,**_kwargs):
            if args[1]=='inspect':return json.dumps([{'Image':'sha256:'+'f'*64,'Config':{'Image':image,'Env':['NODE_OPTIONS=--max-old-space-size=4608']},'HostConfig':{'Memory':8589934592},'State':{'Running':False,'ExitCode':137,'OOMKilled':False}}]).encode()
            self.assertEqual(args[:10],['docker','run','--rm','--network','none','--read-only','--memory','8589934592','--memory-swap','8589934592'])
            return json.dumps({'heapLimitBytes':5300000000}).encode()
        namespace['run']=run
        try:
            with self.assertRaisesRegex(RuntimeError,'PIPELINE_STOPPED_HEAP_PROBE_EXIT_UNVERIFIED'):
                namespace['existing_pipeline_heap_plan'](worker,True,False,container)
            plan=namespace['existing_pipeline_heap_plan'](worker,True,True,container)
            self.assertTrue(plan['evidenceVerified']);self.assertEqual(plan['oldSpaceMiB'],4608);self.assertTrue(plan['containerLimitUnchanged'])
        finally:
            if previous_run is not None:namespace['run']=previous_run
            else:namespace.pop('run',None)
            if previous_states is not None:namespace['states']=previous_states
            else:namespace.pop('states',None)
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
    def test_transport_lifecycle_gate_hashes_the_full_installed_image_manifest(self):
        root=SOURCE.resolve().parents[2]
        old={name:'unchanged:'+name for name in namespace['PARTITION_FILES']}
        old['packages/feed-store/src/tenant-tickets.ts']=(root/'packages/feed-store/src/tenant-tickets.ts').read_text()
        self.assertTrue(namespace['verify_pinned_added_dependencies'](old,namespace['PIPELINE_PINNED_ADDED_DEPENDENCY_SHA256']))
        digest=hashlib.sha256(json.dumps(old,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        candidate=dict(old);candidate['apps/worker/src/connected.ts']='lifecycle fix'
        namespace['verify_transport_lifecycle_sources'](old,candidate,digest)
        with self.assertRaisesRegex(RuntimeError,'TRANSPORT_LIFECYCLE_BASE_DIGEST_MISMATCH'):
            namespace['verify_transport_lifecycle_sources'](old,candidate,'0'*64)
        changed=dict(candidate);changed['apps/worker/src/state.ts']='unreviewed change'
        with self.assertRaisesRegex(RuntimeError,'TRANSPORT_LIFECYCLE_PATCH_SCOPE_UNVERIFIED'):
            namespace['verify_transport_lifecycle_sources'](old,changed,digest)
    def test_stalled_shutdown_needs_stable_files_and_no_measured_work_before_restore_proof(self):
        progress={'pipelineRepair':True,'supplierStoppedBeforeConsumer':True}
        evidence={'running':True,'applicationStoppingObserved':True,'eventsReadFailed':False,'distributionRestartAfterRecordedStop':False,'shutdownErrors':[],'shutdownLogs':[{'status':'stopping'}]}
        previous={'observationElapsedSeconds':95,'progressSincePreviousSample':False,'files':[{'kind':'inbox','bytes':10}],'lastCompletedPersistence':None,'containerWork':{'cpuUsageUsec':100,'readBytes':200,'writeBytes':300}}
        current={'running':True,'files':previous['files'],'lastCompletedPersistence':None,'containerWork':{'cpuUsageUsec':100200,'readBytes':200,'writeBytes':300}}
        self.assertTrue(namespace['incomplete_shutdown_recovery_eligible'](progress,evidence,previous,current))
        for changed_previous,changed_current,changed_evidence in [
            ({**previous,'observationElapsedSeconds':30},current,evidence),
            ({**previous,'progressSincePreviousSample':True},current,evidence),
            (previous,{**current,'files':[{'kind':'inbox','bytes':11}]},evidence),
            (previous,{**current,'containerWork':{'cpuUsageUsec':700100,'readBytes':200,'writeBytes':300}},evidence),
            (previous,current,{**evidence,'applicationStoppingObserved':False}),
            (previous,current,{**evidence,'distributionRestartAfterRecordedStop':True}),
            (previous,current,{**evidence,'shutdownErrors':[{'present':True}]}),
        ]:self.assertFalse(namespace['incomplete_shutdown_recovery_eligible'](progress,changed_evidence,changed_previous,changed_current))
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
