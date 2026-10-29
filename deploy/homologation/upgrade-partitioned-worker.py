"""Prepare a verified derived worker image, then activate once; preserve migration and POSNET."""
PARTITION_FILES={'apps/worker/src/durable-ingress.mjs','apps/worker/src/durable-ingress.d.mts','apps/worker/src/connected.ts','apps/worker/src/connection-closer.ts','apps/worker/src/diagnostics.ts','apps/worker/src/snapshot-capacity.ts','apps/worker/src/provider.ts','apps/worker/src/snapshot-scheduler.ts','apps/worker/src/state.ts','apps/worker/src/messages.ts','apps/worker/src/league-fixtures.ts','apps/worker/src/partitioned-snapshot.ts','apps/worker/src/full-snapshot.ts','apps/worker/src/persistence.ts','apps/worker/src/timestamp-recovery.ts','packages/contracts/src/index.ts','packages/feed-store/src/index.ts','packages/feed-store/src/operation-risk.ts','packages/feed-store/src/tenant-tickets.ts'}
PARTITION_DIGEST_FILES=PARTITION_FILES-{'packages/feed-store/src/operation-risk.ts','packages/feed-store/src/tenant-tickets.ts'}
PUBLICATION_BASE_DIGEST_FILES=PARTITION_FILES-{'packages/feed-store/src/tenant-tickets.ts'}
PIPELINE_AUXILIARY_FILES={'packages/feed-store/src/operation-risk.ts'}
OOM_REHEARSAL_TIMEOUT_SECONDS=1200
PIPELINE_ADDED_DEPENDENCY_SHA256={'apps/worker/src/snapshot-capacity.ts':'6b5f7b632e4cc9f725edcc461392095ff865b4f47218d0d4b3b868d3bb130aa0'}
PIPELINE_PINNED_ADDED_DEPENDENCY_SHA256={'packages/feed-store/src/tenant-tickets.ts':'56bc1ee5debef412fd571439d9980ef065275ea141692aa58858278401103ad2'}
INDEXED_PUBLICATION_FILES={'packages/feed-store/src/indexed-feed.ts'}
INDEXED_PUBLICATION_SOURCE_SHA256={'packages/feed-store/src/indexed-feed.ts':'58f3940794485218f77e620d7f94d9d8fd21f1a719e9d2a0357f2935fb203c23'}
def source_export_script(names):
    require(isinstance(names,set) and names and all(isinstance(name,str) and re.fullmatch(r'(?:apps|packages)/[A-Za-z0-9_./-]{1,220}',name) and '..' not in Path(name).parts for name in names),'UPGRADE_SOURCE_EXPORT_SET_INVALID')
    return "const f=require('node:fs');console.log(JSON.stringify(Object.fromEntries("+json.dumps(sorted(names))+".map(n=>[n,f.readFileSync('/app/'+n,'utf8')]))));"
def current_image_source_names(pipeline_repair):
    return PARTITION_FILES|(INDEXED_PUBLICATION_FILES if pipeline_repair else set())
PIPELINE_BASE_FILES=PARTITION_DIGEST_FILES-set(PIPELINE_ADDED_DEPENDENCY_SHA256)
PROJECTION_RESUME_DRIVER_SHA256='b2f7cd58ee386c3855b9225088d112fef51a8b442bd0369848fab626fa0c8034'

def verify_pinned_added_dependencies(files,pins):
    return all(name in files and hashlib.sha256(files[name].encode()).hexdigest()==digest for name,digest in pins.items())

def verified_existing_snapshot_memory_profile(proof,worker,memory_limit):
    heap_limit=proof.get('effectiveHeapLimitBytes')
    heap_peak=proof.get('maxSampledHeapBytes')
    rss_peak=proof.get('maxObservedRSSBytes')
    budget=proof.get('projectionReadbackBudgetBytes')
    return proof.get('status')=='ok' and all(proof.get(key) is True for key in ('offlineRestoreVerified','projectionReadbackVerified','rehearsalCopyVerified','preservedSpoolRehearsed')) and type(heap_limit) is int and type(heap_peak) is int and heap_limit-heap_peak>=512*1024**2 and type(rss_peak) is int and rss_peak<memory_limit and proof.get('readbackHeapLimitBytes')==heap_limit and type(budget) is int and budget>0 and memory_limit==8589934592 and worker.get('environment',{}).get('NODE_OPTIONS')=='--max-old-space-size=4608'

def pipeline_memory_identity_verified(memory_limit,eight_gib_pipeline,verified_existing_snapshot_profile):
    return memory_limit==6442450944 or memory_limit==8589934592 and (eight_gib_pipeline or verified_existing_snapshot_profile)

def verify_api_compatibility(required_commit,required_source_manifest,required_manifest_digest):
    require(isinstance(required_commit,str) and re.fullmatch('[0-9a-f]{40}',required_commit),'INDEXED_API_COMMIT_REQUIRED')
    require(isinstance(required_source_manifest,dict) and 1<=len(required_source_manifest)<=2048 and all(isinstance(name,str) and re.fullmatch(r'(?:(?:apps|packages|scripts)/[A-Za-z0-9_./-]{1,220}|(?:package(?:-lock)?\.json|tsconfig\.json))',name) and '..' not in Path(name).parts and re.fullmatch('[0-9a-f]{64}',str(digest)) for name,digest in required_source_manifest.items()),'INDEXED_API_SOURCE_MANIFEST_INVALID')
    required_digest=hashlib.sha256(json.dumps(dict(sorted(required_source_manifest.items())),sort_keys=True,separators=(',',':')).encode()).hexdigest()
    require(required_manifest_digest==required_digest,'INDEXED_API_SOURCE_MANIFEST_DIGEST_MISMATCH')
    apis=states('api');require(len(apis)==1 and apis[0].get('running') is True and apis[0].get('health')=='healthy','INDEXED_API_NOT_HEALTHY')
    info=json.loads(run(['docker','inspect',apis[0]['id']]))[0]
    ref=info.get('Config',{}).get('Image');require(isinstance(ref,str),'INDEXED_API_IMAGE_UNVERIFIED')
    image=json.loads(run(['docker','image','inspect',ref]))[0]
    revision=(image.get('Config',{}).get('Labels') or {}).get('org.opencontainers.image.revision')
    require(revision==required_commit,'INDEXED_API_WORKER_VERSION_MISMATCH')
    script="const fs=require('node:fs'),crypto=require('node:crypto'),expected=JSON.parse(process.env.ADL_SOURCE_MANIFEST);for(const [name,digest] of Object.entries(expected)){const actual=crypto.createHash('sha256').update(fs.readFileSync('/app/'+name)).digest('hex');if(actual!==digest)throw Error('API_SOURCE_HASH_MISMATCH')}console.log(JSON.stringify({verified:Object.keys(expected).length}));"
    env_value=json.dumps(required_source_manifest,sort_keys=True,separators=(',',':'))
    checked=json.loads(run(['docker','exec','--user','0:0','-e','ADL_SOURCE_MANIFEST='+env_value,apis[0]['id'],'node','-e',script]))
    require(checked.get('verified')==len(required_source_manifest),'INDEXED_API_SOURCE_MANIFEST_MISMATCH')
    return {'apiCommit':revision,'apiImage':ref,'apiContainerId':apis[0]['id'],'healthy':True,'sourceManifestSha256':required_digest,'sourceFilesVerified':checked['verified']}

def verify_full_recovery_sources(old_files,files,old_digest):
    require(set(old_files)==PARTITION_FILES and set(files)==PARTITION_FILES,'FULL_RECOVERY_SOURCE_MANIFEST_MISMATCH')
    installed_digest=hashlib.sha256(json.dumps(old_files,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    require(installed_digest==old_digest,'FULL_RECOVERY_INSTALLED_SOURCE_DIGEST_MISMATCH')
    changed={name for name in files if files[name]!=old_files[name]}
    require(changed=={'apps/worker/src/connected.ts'},'FULL_RECOVERY_PATCH_SCOPE_UNVERIFIED')
    connected=files['apps/worker/src/connected.ts']
    snapshot_gate="lanes.length>0&&lanes.every(c=>c.phase==='recovering'&&c.recoveryProgress?.regularSnapshotReady===false)" in connected
    stale_backlog_gate=("ingress.processingBacklog??ingress.backlog" in connected and
                        "ingress.oldestProcessingAgeMs??ingress.oldestAgeMs)>5000" in connected)
    require(snapshot_gate and (changed==set() or stale_backlog_gate),'FULL_RECOVERY_PROJECTION_DEFER_GUARD_UNVERIFIED')
    snapshot=old_files['apps/worker/src/full-snapshot.ts']
    require('transportComplete=res.complete===true' in snapshot and 'if(!transportComplete)' in snapshot and 'transportBytes!==contentLengthBytes' in snapshot and 'Snapshot HTTP Content-Length mismatch' in snapshot,'FULL_RECOVERY_TRANSPORT_GUARD_MISSING')

def verify_current_source_receipt(receipt,image,digest,full_recovery,backups_root):
    require(receipt.get('digest')==digest and receipt.get('image')==image,'CURRENT_SOURCE_RECEIPT_IDENTITY_MISMATCH')
    if receipt.get('oomRestoreVerified') is True:return True
    # New full-recovery receipts use a distinct proof field. Accept that schema
    # only when its immutable recovery backup is still present and every
    # recorded data file independently matches its SHA-256. This keeps the old
    # OOM-specific receipt requirement while allowing a verified full-recovery
    # source; it never treats the offline full-recovery flag alone as proof.
    require(full_recovery is True and receipt.get('fullRecoveryVerified') is True and
            receipt.get('phase') in ('stopped','start_requested','running'),'CURRENT_SOURCE_RECOVERY_RECEIPT_UNVERIFIED')
    backup_value=receipt.get('backup');require(isinstance(backup_value,str) and re.fullmatch(r'.*/adl-partitioned-upgrade-[A-Za-z0-9_-]{1,80}',backup_value),'CURRENT_SOURCE_BACKUP_PATH_UNVERIFIED')
    backup=Path(backup_value);require(backup.parent==Path(backups_root) and backup.is_dir() and not backup.is_symlink() and backup.stat().st_uid==os.geteuid() and backup.stat().st_mode&0o077==0,'CURRENT_SOURCE_BACKUP_UNSAFE')
    hashes=receipt.get('dataBackupHashes');required={'trade-feed.json','trade-feed.json.regular-checkpoint.json','trade-feed.json.prematch.inbox.sqlite','trade-feed.json.inplay.inbox.sqlite'}
    require(isinstance(hashes,dict) and len(hashes)>=6 and required.issubset(hashes),'CURRENT_SOURCE_BACKUP_MANIFEST_INCOMPLETE')
    for name,digest_value in hashes.items():
        require(isinstance(name,str) and (name in ('trade-feed.json','trade-feed.public.sqlite') or re.fullmatch(r'trade-feed\.json(?:\.regular-checkpoint\.json|\.checkpoint-journal\.jsonl|\.pre-indexed-compaction\.bak|\.checkpoint-compaction\.tmp|\.checkpoint-journal\.jsonl\.empty\.tmp|\.snapshot-[0-9a-f]{16}\.json|\.(?:prematch|inplay)\.inbox\.sqlite)',name)),'CURRENT_SOURCE_BACKUP_ENTRY_UNSAFE')
        require(re.fullmatch('[0-9a-f]{64}',str(digest_value)) is not None,'CURRENT_SOURCE_BACKUP_HASH_INVALID')
        path=backup/name;require(path.is_file() and not path.is_symlink() and path.stat().st_uid==os.geteuid() and path.stat().st_mode&0o077==0 and snapshot_file_hash(path)==digest_value,'CURRENT_SOURCE_BACKUP_HASH_MISMATCH')
    return True

def verify_active_container_source_hashes(active_hashes,candidate_files,installed_image_files):
    require(set(active_hashes)==set(candidate_files),'UPGRADE_ACTIVE_SOURCE_MANIFEST_MISMATCH')
    expected={name:(hashlib.sha256(installed_image_files[name].encode()).hexdigest() if name in installed_image_files else None) for name in candidate_files}
    require(active_hashes==expected,'UPGRADE_ACTIVE_SOURCE_IMAGE_MISMATCH')
    return True

def verify_projection_resume_artifacts(backup,progress,image_info,name):
    require(isinstance(name,str) and re.fullmatch(r'projection-resume-[0-9]{8}T[0-9]{4}Z',name),'PROJECTION_RESUME_DIRECTORY_UNVERIFIED')
    resume=backup/name;require(resume.parent==backup and resume.is_dir() and not resume.is_symlink() and resume.stat().st_mode&0o077==0,'PROJECTION_RESUME_DIRECTORY_UNSAFE')
    image_digest=(image_info.get('Config',{}).get('Labels') or {}).get('eu.adl.partitioned.patch')
    require(image_digest==progress.get('digest') and re.fullmatch('[0-9a-f]{64}',str(image_digest or '')),'PROJECTION_RESUME_IMAGE_MISMATCH')
    expected_public=progress.get('dataBackupHashes',{}).get('trade-feed.json')
    require(re.fullmatch('[0-9a-f]{64}',str(expected_public or '')),'PROJECTION_RESUME_PUBLIC_HASH_MISSING')
    rehearsal_name=progress.get('rehearsalDirectory');require(isinstance(rehearsal_name,str) and re.fullmatch(r'rehearsal-[0-9a-f]{24}',rehearsal_name),'PROJECTION_RESUME_SOURCE_DIRECTORY_UNVERIFIED')
    original=backup/'trade-feed.json';copied=backup/rehearsal_name/'trade-feed.json'
    for source in (original,copied):require(source.is_file() and not source.is_symlink() and snapshot_file_hash(source)==expected_public,'PROJECTION_RESUME_PUBLIC_SOURCE_CHANGED')
    spool_rows=list((backup/rehearsal_name).glob('.full-snapshot-*/response.private.json'))
    require(len(spool_rows)==1 and spool_rows[0].is_file() and not spool_rows[0].is_symlink() and not spool_rows[0].parent.is_symlink(),'PROJECTION_RESUME_SPOOL_IDENTITY_UNVERIFIED')
    spool=spool_rows[0];spool_hash=snapshot_file_hash(spool)
    require(re.fullmatch('[0-9a-f]{64}',str(progress.get('preservedSpoolHash',''))) and spool_hash==progress['preservedSpoolHash'],'PROJECTION_RESUME_SPOOL_HASH_MISMATCH')
    pointer_path=backup/'oom-restore.latest.json';require(pointer_path.is_file() and not pointer_path.is_symlink() and pointer_path.stat().st_mode&0o077==0,'PROJECTION_RESUME_PRIOR_LOG_POINTER_UNVERIFIED')
    prior_name=json.loads(pointer_path.read_bytes()).get('name')
    require(isinstance(prior_name,str) and re.fullmatch(r'oom-restore-attempt-[0-9a-f]{16,32}\.private\.log',prior_name),'PROJECTION_RESUME_PRIOR_LOG_NAME_UNVERIFIED')
    prior_log=backup/prior_name;require(prior_log.is_file() and not prior_log.is_symlink() and prior_log.stat().st_size<=8*1024**2 and prior_log.stat().st_mode&0o077==0,'PROJECTION_RESUME_PRIOR_LOG_UNVERIFIED')
    prior=[]
    for line in prior_log.read_bytes().splitlines():
        try:record=json.loads(line)
        except ValueError:continue
        if isinstance(record,dict) and record.get('operation')=='offline.memory':prior.append(record)
    stages={}
    for record in prior:
        if isinstance(record.get('stage'),str):stages.setdefault(record['stage'],[]).append(record)
    last=lambda stage:stages.get(stage,[])[-1] if stages.get(stage) else {}
    require(16000<=last('snapshot.validate').get('rows',0)<=16329 and last('snapshot.finalize').get('rows')==16329,'PROJECTION_RESUME_SNAPSHOT_APPLY_UNPROVEN')
    prior_projection=last('projection.build');prior_serialize=last('projection.serialize')
    require(prior_projection.get('rows')==prior_serialize.get('rows')==16329 and prior_projection.get('indexCounts',{}).get('stateRows')==18547,'PROJECTION_RESUME_PRIOR_STATE_UNVERIFIED')
    driver=resume/'driver.mjs';require(driver.is_file() and not driver.is_symlink() and driver.stat().st_mode&0o077==0 and snapshot_file_hash(driver)==PROJECTION_RESUME_DRIVER_SHA256,'PROJECTION_RESUME_DRIVER_UNVERIFIED')
    public_input=resume/'input'/'trade-feed.json';sidecar_source=backup/('projection-rehearsal-'+progress['digest'][:24])/'projection.json.regular-checkpoint.json'
    sidecar_input=resume/'input'/'trade-feed.json.regular-checkpoint.json';sidecar_output=resume/'output'/'projection.json.regular-checkpoint.json'
    for path in (public_input,sidecar_source,sidecar_input,sidecar_output):require(path.is_file() and not path.is_symlink() and path.stat().st_mode&0o077==0,'PROJECTION_RESUME_CHECKPOINT_FILE_UNVERIFIED')
    require(snapshot_file_hash(public_input)==expected_public,'PROJECTION_RESUME_INPUT_CHECKPOINT_CHANGED')
    inode=lambda path:(path.stat().st_dev,path.stat().st_ino)
    require(inode(sidecar_source)==inode(sidecar_input)==inode(sidecar_output),'PROJECTION_RESUME_SIDECAR_COPY_MISMATCH')
    projection=resume/'output'/'projection.json';receipt_path=resume/'output'/'receipt.json'
    require(projection.is_file() and not projection.is_symlink() and projection.stat().st_mode&0o077==0 and receipt_path.is_file() and not receipt_path.is_symlink() and receipt_path.stat().st_mode&0o077==0 and receipt_path.stat().st_size<=65536,'PROJECTION_RESUME_OUTPUT_UNVERIFIED')
    receipt=json.loads(receipt_path.read_bytes());projection_hash=snapshot_file_hash(projection);sidecar_hash=snapshot_file_hash(sidecar_source)
    require(receipt.get('sha256')==projection_hash and receipt.get('bytes')==projection.stat().st_size and receipt.get('privateCheckpointSha256')==sidecar_hash and receipt.get('stateRows')==18547,'PROJECTION_RESUME_RECEIPT_MISMATCH')
    require(prior_serialize.get('indexCounts',{}).get('stateRows')==receipt['stateRows'],'PROJECTION_RESUME_PRIOR_SERIALIZATION_STATE_MISMATCH')
    logs={}
    for log_name in ('serialize.log','readback.log'):
        path=resume/log_name;require(path.is_file() and not path.is_symlink() and path.stat().st_mode&0o077==0 and path.stat().st_size<=8*1024**2,'PROJECTION_RESUME_LOG_UNVERIFIED')
        records=[]
        for line in path.read_bytes().splitlines():
            if not line.startswith(b'{'):continue
            try:record=json.loads(line)
            except ValueError:continue
            if isinstance(record,dict):records.append(record)
        logs[log_name]=records
    serialized=[r for r in logs['serialize.log'] if r.get('operation')=='projection.resume.complete']
    returned=[r for r in logs['readback.log'] if r.get('operation')=='projection.resume.readback']
    require(len(serialized)==len(returned)==1,'PROJECTION_RESUME_COMPLETION_MARKER_MISSING')
    measured=serialized[0].get('receipt',{});read=returned[0]
    require(measured==receipt and read.get('verified') is True and read.get('projection',{}).get('integrityVerified') is True and read.get('projection',{}).get('sha256')==projection_hash and read.get('stateRows')==receipt['stateRows'],'PROJECTION_RESUME_READBACK_MISMATCH')
    metrics=receipt.get('measurements',{})
    require(metrics.get('bytesWritten')==receipt['bytes'] and type(metrics.get('serializeAndWriteMs')) is int and metrics['serializeAndWriteMs']>0 and type(metrics.get('writeAwaitMs')) is int and 0<=metrics['writeAwaitMs']<=metrics['serializeAndWriteMs'] and type(metrics.get('fsyncMs')) is int and metrics['fsyncMs']>=0,'PROJECTION_RESUME_MEASUREMENTS_INVALID')
    stat=projection.stat();side_stat=sidecar_source.stat()
    return {'verified':True,'directory':name,'projectionSha256':projection_hash,'privateCheckpointSha256':sidecar_hash,'projectionBytes':receipt['bytes'],'projectionRows':receipt['rows'],'stateRows':receipt['stateRows'],'spoolSha256':spool_hash,'serializeAndWriteMs':metrics['serializeAndWriteMs'],'writeAwaitMs':metrics['writeAwaitMs'],'writeCalls':metrics.get('writeCalls'),'fsyncMs':metrics['fsyncMs'],'buildMs':metrics.get('buildMs'),'verifyMs':read.get('verifyMs'),'privateRestoreMs':read.get('privateRestoreMs'),'projectionFileIdentity':{'device':stat.st_dev,'inode':stat.st_ino,'size':stat.st_size,'mtimeNs':stat.st_mtime_ns},'privateCheckpointIdentity':{'device':side_stat.st_dev,'inode':side_stat.st_ino,'size':side_stat.st_size,'mtimeNs':side_stat.st_mtime_ns},'workerStarted':False}
def verify_live_oom_identity(worker,request):
    require(request.get('snapshotMemoryRepair') and worker.get('oomKilled') is True and worker.get('exitCode')==137 and not worker.get('running') and worker.get('name')=='/adl-homologation-worker-1' and re.fullmatch('[0-9a-f]{12,63}',str(request.get('expectedOomPrefix',''))) and str(worker.get('id','')).startswith(request['expectedOomPrefix']),'CURRENT_OOM_IDENTITY_UNVERIFIED')

def verify_live_v8_heap_oom_identity(worker,request):
    prefix=request.get('expectedOomPrefix','')
    require(request.get('snapshotMemoryRepair') and request.get('v8HeapOomRepair') is True and worker.get('oomKilled') is False and worker.get('exitCode')==134 and not worker.get('running') and worker.get('name')=='/adl-homologation-worker-1' and re.fullmatch('[0-9a-f]{12,63}',str(prefix)) and str(worker.get('id','')).startswith(prefix),'CURRENT_V8_HEAP_OOM_IDENTITY_UNVERIFIED')
    logs=subprocess.run(['docker','logs','--tail','100',worker['id']],capture_output=True,timeout=15,check=False)
    require(logs.returncode==0,'CURRENT_V8_HEAP_OOM_LOG_READ_FAILED')
    require(b'Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory' in logs.stdout+logs.stderr,'CURRENT_V8_HEAP_OOM_SIGNATURE_UNVERIFIED')

def verify_live_persistence_failure_identity(worker,request,image):
    """Accept only the exact, logged checkpoint-write failure as a stopped source."""
    require(request.get('snapshotMemoryRepair') is True and request.get('livePersistenceRepair') is True and request.get('pipelineRepair') is True,'CURRENT_PERSISTENCE_FAILURE_REPAIR_SCOPE_UNVERIFIED')
    require(worker.get('running') is False and worker.get('oomKilled') is False and worker.get('exitCode')==1 and worker.get('name')=='/adl-homologation-worker-1','CURRENT_PERSISTENCE_FAILURE_CONTAINER_UNVERIFIED')
    expected=request.get('expectedLiveImage')
    require(re.fullmatch('adl-worker-partitioned:[0-9a-f]{24}',str(expected or '')) and image==expected,'CURRENT_PERSISTENCE_FAILURE_IMAGE_UNVERIFIED')
    inspected=json.loads(run(['docker','inspect',worker['id']]))[0]
    require(inspected.get('Config',{}).get('Image')==expected and inspected.get('State',{}).get('ExitCode')==1 and inspected.get('State',{}).get('OOMKilled') is False and inspected.get('State',{}).get('Error','')=='','CURRENT_PERSISTENCE_FAILURE_STATE_UNVERIFIED')
    image_id=json.loads(run(['docker','image','inspect',expected]))[0].get('Id')
    require(inspected.get('Image')==image_id,'CURRENT_PERSISTENCE_FAILURE_IMAGE_ID_MISMATCH')
    logs=subprocess.run(['docker','logs','--tail','400',worker['id']],capture_output=True,timeout=20,check=False)
    require(logs.returncode==0,'CURRENT_PERSISTENCE_FAILURE_LOG_READ_FAILED')
    records=[]
    for line in (logs.stdout+logs.stderr).splitlines():
        try:record=json.loads(line)
        except ValueError:continue
        if isinstance(record,dict):records.append(record)
    restored=any(r.get('operation')=='file.restore' and r.get('status')=='ok' and r.get('source')=='checkpoint' and r.get('rows')==44094 for r in records)
    waits=[r for r in records if r.get('operation')=='file.persist' and r.get('status')=='waiting' and r.get('publicationStage')=='regular_checkpoint.write' and type(r.get('elapsedMs')) is int and r['elapsedMs']>=20000]
    failed=any(r.get('operation')=='file.persist' and r.get('status')=='error' and r.get('protocol')=='local' and r.get('category')=='unexpected' and r.get('reason')=='unknown_exception' and type(r.get('elapsedMs')) is int and r['elapsedMs']>=90000 for r in records)
    shutdown=any(r.get('operation')=='worker.shutdown' and r.get('status')=='error' and r.get('lock')=='released' for r in records)
    require(restored and waits and failed and shutdown,'CURRENT_PERSISTENCE_FAILURE_SIGNATURE_UNVERIFIED')

def verify_stopped_upgrade_worker(worker,request,reason,verify_identity=True,expected_container_id=None):
    if worker.get('running') is True or worker.get('running') is False and worker.get('exitCode')==0 and worker.get('oomKilled') is False:return
    if request.get('snapshotMemoryRepair') and worker.get('oomKilled') is True and worker.get('exitCode')==137:
        if verify_identity and expected_container_id is not None:require(worker.get('id')==expected_container_id,'CURRENT_OOM_CONTAINER_CHANGED')
        return
    if request.get('v8HeapOomRepair') and worker.get('oomKilled') is False and worker.get('exitCode')==134 and worker.get('running') is False:
        if verify_identity:verify_live_v8_heap_oom_identity(worker,request)
        return
    if request.get('livePersistenceRepair') and worker.get('oomKilled') is False and worker.get('exitCode')==1 and worker.get('running') is False:
        if expected_container_id is not None:require(worker.get('id')==expected_container_id,'CURRENT_PERSISTENCE_FAILURE_CONTAINER_CHANGED')
        if verify_identity:
            image=request.get('expectedLiveImage')
            require(isinstance(image,str),'CURRENT_PERSISTENCE_FAILURE_IMAGE_UNVERIFIED')
            verify_live_persistence_failure_identity(worker,request,image)
        return
    require(False,reason)

def verify_live_persistence_identity(worker,request,image):
    expected=request.get('expectedLiveImage')
    checks={'snapshotMemoryRepair':request.get('snapshotMemoryRepair') is True,'workerRunning':worker.get('running') is True,'workerNotOomKilled':worker.get('oomKilled') is False,'workerNameMatches':worker.get('name')=='/adl-homologation-worker-1','expectedImageFormat':bool(re.fullmatch('adl-worker-partitioned:[0-9a-f]{24}',str(expected))),'imageReferenceMatches':image==expected}
    def safe_image(value):return value if re.fullmatch('adl-worker-partitioned:[0-9a-f]{24}',str(value)) else 'unverified_reference'
    emit(operation='cutover.aws',stage='partitioned_upgrade.identity_comparison',status='verified' if all(checks.values()) else 'blocked',checks=checks,failedChecks=[key for key,value in checks.items() if not value],expectedImage=safe_image(expected),composeImage=safe_image(image),workerStarted=False,workerRestarted=False,providerRequests=0,posnetChanged=False)
    require(all(checks.values()),'CURRENT_PERSISTENCE_IMAGE_UNVERIFIED')

def verify_current_worker_identity(worker,request,image):
    # A verified V8 heap exit is the identity proof for the stopped container;
    # the live-persistence path is reserved for a running worker.
    if request.get('v8HeapOomRepair') is True:
        verify_live_v8_heap_oom_identity(worker,request)
        return 'verified_v8_heap_exit'
    if request.get('livePersistenceRepair'):
        if worker.get('running') is False and worker.get('exitCode')==1:
            verify_live_persistence_failure_identity(worker,request,image)
            return 'verified_persistence_failure_exit'
        verify_live_persistence_identity(worker,request,image)
        return 'verified_live_persistence'
    verify_live_oom_identity(worker,request)
    return 'verified_kernel_oom'

def verify_live_oom_sources(old_files,files,old_digest):
    legacy_files={name:value for name,value in old_files.items() if name in PARTITION_DIGEST_FILES and name!='apps/worker/src/timestamp-recovery.ts'}
    require(set(old_files)==set(files) and 'apps/worker/src/timestamp-recovery.ts' in old_files and hashlib.sha256(json.dumps(legacy_files,sort_keys=True,separators=(',',':')).encode()).hexdigest()==old_digest,'CURRENT_OOM_SOURCE_DIGEST_MISMATCH')
    require(verify_pinned_added_dependencies(old_files,PIPELINE_PINNED_ADDED_DEPENDENCY_SHA256),'CURRENT_OOM_ADDED_DEPENDENCY_BASE_UNVERIFIED')
    changed={name for name in files if files[name]!=old_files[name]}
    require(changed and changed<= {'apps/worker/src/state.ts','apps/worker/src/connected.ts','apps/worker/src/persistence.ts','apps/worker/src/timestamp-recovery.ts','packages/feed-store/src/index.ts'},'CURRENT_OOM_PATCH_SCOPE_UNVERIFIED')

def verify_snapshot_checkpoint_memory_sources(old_files,files,old_digest):
    require(set(old_files)==PARTITION_FILES and set(files)==PARTITION_FILES,'SNAPSHOT_CHECKPOINT_SOURCE_MANIFEST_MISMATCH')
    canonical=hashlib.sha256(json.dumps(old_files,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    require(canonical==old_digest,'SNAPSHOT_CHECKPOINT_INSTALLED_SOURCE_DIGEST_MISMATCH')
    changed={name for name in files if files[name]!=old_files[name]}
    snapshot_memory_patch={'apps/worker/src/connected.ts','apps/worker/src/full-snapshot.ts','packages/contracts/src/index.ts'}
    if changed==snapshot_memory_patch:return 'snapshot_memory_patch'
    # The currently prepared repair combines the already bounded durable
    # inbox checkpoint policy with transport completion proof. Keep the file
    # set exact and require every guard that prevents partial baselines.
    snapshot_transport_patch={'apps/worker/src/connected.ts','apps/worker/src/full-snapshot.ts'}
    if changed==snapshot_transport_patch:
        source=files['apps/worker/src/connected.ts']
        require(re.search(r'PREMATCH_CHECKPOINT_BATCH_THRESHOLD\s*=\s*131072\s*;',source) and re.search(r'PREMATCH_CHECKPOINT_BATCH_FLUSH_MS\s*=\s*600000\s*;',source),'CHECKPOINT_COMPACTION_POLICY_UNVERIFIED')
        require('pendingAcks.length+checkpointPending>=checkpointBatchThreshold' in source and 'Math.min(4096,Math.max(1,checkpointBatchThreshold-pendingAcks.length-checkpointPending))' in source and 'retained_in_durable_inbox' in source,'CHECKPOINT_COMPACTION_DURABILITY_BARRIER_UNVERIFIED')
        snapshot=files['apps/worker/src/full-snapshot.ts']
        require('transportBytes+=chunk.length' in snapshot and 'transportComplete=res.complete===true' in snapshot and 'if(!transportComplete)' in snapshot and 'transportBytes!==contentLengthBytes' in snapshot and 'Snapshot HTTP Content-Length mismatch' in snapshot,'SNAPSHOT_TRANSPORT_COMPLETION_PROOF_UNVERIFIED')
        return 'durable_checkpoint_and_complete_snapshot_transport'
    # The inbox-backed compaction change is intentionally limited to the
    # checkpoint scheduler. Admit only its exact bounded policy and the
    # existing durable-inbox barriers; all other source deltas stay rejected.
    if changed=={'apps/worker/src/connected.ts'}:
        source=files['apps/worker/src/connected.ts']
        require(re.search(r'PREMATCH_CHECKPOINT_BATCH_THRESHOLD\s*=\s*131072\s*;',source) and re.search(r'PREMATCH_CHECKPOINT_BATCH_FLUSH_MS\s*=\s*600000\s*;',source),'CHECKPOINT_COMPACTION_POLICY_UNVERIFIED')
        require('pendingAcks.length+checkpointPending>=checkpointBatchThreshold' in source and 'Math.min(4096,Math.max(1,checkpointBatchThreshold-pendingAcks.length-checkpointPending))' in source and 'retained_in_durable_inbox' in source,'CHECKPOINT_COMPACTION_DURABILITY_BARRIER_UNVERIFIED')
        return 'durable_inbox_checkpoint_compaction'
    require(False,'SNAPSHOT_CHECKPOINT_PATCH_SCOPE_UNVERIFIED')

def verify_live_snapshot_pressure_sources(old_files,files,old_digest):
    base={name:old_files[name] for name in PARTITION_DIGEST_FILES if name in old_files}
    require(set(old_files)==set(files) and set(base)==PARTITION_DIGEST_FILES and hashlib.sha256(json.dumps(base,sort_keys=True,separators=(',',':')).encode()).hexdigest()==old_digest,'CURRENT_PRESSURE_SOURCE_DIGEST_MISMATCH')
    require(verify_pinned_added_dependencies(old_files,PIPELINE_PINNED_ADDED_DEPENDENCY_SHA256),'CURRENT_PRESSURE_ADDED_DEPENDENCY_BASE_UNVERIFIED')
    changed={name for name in files if files[name]!=old_files[name]}
    require(changed=={'apps/worker/src/full-snapshot.ts'},'CURRENT_PRESSURE_PATCH_SCOPE_UNVERIFIED')
    # Existing identity, memory, source and preparation receipt gates still apply.
    # This explicit path does not relax the separate historical OOM patch scope.

def partition_memory(progress):
    value=progress.get('memoryLimitBytes',4294967296)
    verified_six_gib=value==6442450944 and (progress.get('pipelineRepair') is True or progress.get('snapshotMemoryRepair') is True and progress.get('snapshotPressureRepair') is True and progress.get('livePersistenceRepair') is True or progress.get('snapshotMemoryRepair') is True and progress.get('v8HeapOomRepair') is True)
    verified_existing_eight_gib=value==8589934592 and progress.get('pipelineRepair') is True and progress.get('pipelineMemoryEightGiB') is True and progress.get('snapshotMemoryRepair') is True and progress.get('livePersistenceRepair') is True
    verified_snapshot_eight_gib=value==8589934592 and progress.get('snapshotMemoryEightGiBRepair') is True and progress.get('snapshotMemoryRepair') is True and progress.get('snapshotMemoryEightGiBHeadroomBytes',0)>=12*1024**3 and progress.get('heapBudgetPlan',{}).get('preserveExisting') is True
    verified_existing_snapshot=value==8589934592 and progress.get('verifiedExistingSnapshotMemoryProfile') is True and progress.get('existingSnapshotMemoryNodeOptions')=='--max-old-space-size=4608'
    require(value==4294967296 or verified_six_gib or verified_existing_eight_gib or verified_snapshot_eight_gib or verified_existing_snapshot,'UPGRADE_MEMORY_SCOPE_UNVERIFIED')
    return value

def candidate_memory(progress):
    if progress.get('snapshotMemoryEightGiBRepair') is True:
        require(progress.get('snapshotMemoryRepair') is True and partition_memory(progress)==8589934592,'SNAPSHOT_EIGHT_GIB_PROFILE_SCOPE_UNVERIFIED')
        return 8589934592
    if progress.get('pipelineMemoryEightGiB') is True:
        require(progress.get('pipelineRepair') is True and progress.get('snapshotMemoryRepair') is True and progress.get('livePersistenceRepair') is True,'EIGHT_GIB_PROFILE_SCOPE_UNVERIFIED')
        return 8192*1024**2
    return partition_memory(progress)

def pre_stop_memory_floor_gib(worker_running,eight_gib_pipeline,snapshot_eight_gib=False):
    # The old worker's cgroup is expected to be released by the controlled
    # stop. The stronger 10 GiB floor is enforced after exit, before rehearsal
    # and activation; only the reversible copy/stop phase uses the 6 GiB floor.
    return 6 if worker_running else (12 if snapshot_eight_gib else 10 if eight_gib_pipeline else 6)

def expected_partitioned_model(saved_model,progress,snapshot_memory_repair):
    expected=copy.deepcopy(saved_model)
    worker=expected['services']['worker']
    worker['image']=progress['image']
    worker['mem_limit']=str(candidate_memory(progress))
    worker['environment']['LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT']='true'
    worker['environment']['LSPORTS_INPLAY_STREAMED_SNAPSHOT']='true'
    if snapshot_memory_repair:
        worker['environment']['NODE_OPTIONS']='--max-old-space-size='+str(partition_heap_mib(progress))
    return expected

def activation_base_model(saved_model,current_model,active_api_matches_current,expected_models=()):
    """Preserve a healthy API-only publication made after worker preparation."""
    if current_model==saved_model:return copy.deepcopy(saved_model)
    if isinstance(expected_models,dict):expected_models=(expected_models,)
    if any(current_model==candidate for candidate in expected_models):return copy.deepcopy(current_model)
    differences=[]
    def compare(old,new,path=''):
        if isinstance(old,dict) and isinstance(new,dict):
            for key in sorted(set(old)|set(new)):
                compare(old.get(key,'<missing>'),new.get(key,'<missing>'),path+'.'+str(key))
        elif old!=new:differences.append(path)
    compare(saved_model,current_model)
    current_worker=current_model.get('services',{}).get('worker')
    saved_worker=saved_model.get('services',{}).get('worker')
    expected_workers=[candidate.get('services',{}).get('worker') for candidate in expected_models if isinstance(candidate,dict)]
    api_only=current_worker==saved_worker and differences==['.services.api.image']
    prepared_worker=(current_worker is not None and current_worker in expected_workers and
        differences and '.services.api.image' in differences and all(path=='.services.api.image' or path.startswith('.services.worker.') for path in differences))
    require(active_api_matches_current and (api_only or prepared_worker),
            'DEPLOYMENT_CHANGED_SINCE_UPGRADE_PREPARE')
    return copy.deepcopy(current_model)

def partition_heap_mib(progress):
    plan=progress.get('heapBudgetPlan')
    if progress.get('snapshotMemoryEightGiBRepair') is True:
        memory=partition_memory(progress);old_space=plan.get('oldSpaceMiB') if plan else None
        require(memory==8589934592 and plan.get('preserveExisting') is True and plan.get('snapshotMemoryEightGiBRepair') is True and plan.get('evidenceVerified') is True and old_space==4608 and plan.get('previousOldSpaceMiB')==4608 and plan.get('containerLimitUnchanged') is True and 4608*1024**2<=plan.get('effectiveHeapLimitBytes',0)<=memory-512*1024**2,'SNAPSHOT_EIGHT_GIB_HEAP_PRESERVATION_UNVERIFIED')
        return old_space
    if plan is None:return 2560
    if plan.get('v8HeapCompactionPreserve') is True:
        verified_origin=progress.get('v8HeapOomRepair') is True or progress.get('inheritedV8HeapCompactionPlan') is True
        require(partition_memory(progress)==6442450944 and progress.get('snapshotMemoryRepair') is True and verified_origin and plan.get('evidenceVerified') is True and plan.get('previousOldSpaceMiB')==4608 and plan.get('oldSpaceMiB')==4608 and plan.get('containerLimitUnchanged') is True and plan.get('measuredRedundantTimestampBytes')>=300*1024*1024,'V8_HEAP_COMPACTION_PLAN_UNVERIFIED')
        return 4608
    if plan.get('measuredSnapshotRetry') is True:
        require(partition_memory(progress)==6442450944 and plan.get('evidenceVerified') is True and plan.get('previousOldSpaceMiB')==4096 and plan.get('oldSpaceMiB')==4608 and plan.get('containerLimitUnchanged') is True and plan.get('outsideOldSpaceBytes')==1610612736 and plan.get('guardBudgetBytes')==335544320 and re.fullmatch('[0-9a-f]{64}',str(plan.get('sourceTailSha256',''))),'MEASURED_SNAPSHOT_RETRY_PLAN_UNVERIFIED')
        return 4608
    if plan.get('measuredSnapshotApply') is True:
        require(partition_memory(progress)==6442450944 and plan.get('evidenceVerified') is True and plan.get('previousOldSpaceMiB')==3840 and plan.get('oldSpaceMiB')==4096 and plan.get('containerLimitUnchanged') is True and plan.get('outsideOldSpaceBytes')==2147483648 and plan.get('guardBudgetBytes')==335544320 and re.fullmatch('[0-9a-f]{64}',str(plan.get('sourceTailSha256',''))),'MEASURED_HEAP_PLAN_UNVERIFIED')
        return 4096
    if plan.get('preserveExisting') is True:
        memory=partition_memory(progress);old_space=plan.get('oldSpaceMiB')
        require(plan.get('evidenceVerified') is True and type(old_space) is int and plan.get('previousOldSpaceMiB')==old_space and plan.get('containerLimitUnchanged') is True and old_space*1024**2<=plan.get('effectiveHeapLimitBytes',0)<=memory-512*1024**2,'HEAP_PRESERVATION_PLAN_UNVERIFIED')
        return old_space
    require(partition_memory(progress)==6442450944 and plan.get('evidenceVerified') is True and plan.get('oldSpaceMiB')==3584 and plan.get('previousOldSpaceMiB')==2560 and plan.get('containerLimitUnchanged') is True,'HEAP_BUDGET_PLAN_UNVERIFIED')
    return 3584

def verify_budgeted_worker_runtime(progress,worker_id,inspected,image_id):
    expected_heap=partition_heap_mib(progress);expected_memory=candidate_memory(progress)
    env=dict(item.split('=',1) for item in inspected['Config'].get('Env',[]) if '=' in item)
    require(inspected['Image']==image_id and inspected['HostConfig']['Memory']==expected_memory and env.get('NODE_OPTIONS')=='--max-old-space-size='+str(expected_heap) and env.get('LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT')=='true' and env.get('LSPORTS_INPLAY_STREAMED_SNAPSHOT')=='true','BUDGETED_RUNTIME_IDENTITY_MISMATCH')
    probe="const fs=require('node:fs'),v8=require('node:v8');console.log(JSON.stringify({cgroupLimitBytes:Number(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8')),effectiveHeapLimitProbeBytes:v8.getHeapStatistics().heap_size_limit}))"
    configured=json.loads(run(['docker','exec',worker_id,'node','-e',probe],timeout=30))
    require(configured.get('cgroupLimitBytes')==expected_memory and expected_heap*1024**2<=configured.get('effectiveHeapLimitProbeBytes',0)<=expected_memory-512*1024**2,'BUDGETED_HEAP_CONFIGURATION_MISMATCH')
    return {'nodeOptions':'--max-old-space-size='+str(expected_heap),'dockerMemoryLimitBytes':expected_memory,**configured,'probeIsSeparateProcess':True}

def verified_stopped_pipeline_probe_exit(state,verified_stopped_recovery):
    # The verified recovery handoff normally shuts the old worker down cleanly
    # (exit 0). A bounded external stop can leave 137 without Docker OOM. In
    # either case the recorded container identity/stop proof is still required
    # by the caller before running this networkless, read-only image probe.
    return (verified_stopped_recovery is True and state.get('Running') is False
        and state.get('OOMKilled') is False and state.get('ExitCode') in (0,137))

def stopped_profile_proof_diagnostics(progress,expected_container_id):
    observation=progress.get('shutdownObservation',{})
    samples=observation.get('samples',[]) if isinstance(observation,dict) else []
    if not isinstance(samples,list):samples=[]
    final=samples[-1] if samples else {}
    prior=any(isinstance(sample,dict) and sample.get('containerId')==expected_container_id
        and sample.get('running') is True and sample.get('oomKilled') is False
        and sample.get('signalsSent')==0 for sample in samples[:-1])
    supplier_order=(isinstance(progress.get('supplierStoppedAtUTC'),str) and isinstance(progress.get('stopRequestedAtUTC'),str)
        and progress['supplierStoppedAtUTC']<=progress['stopRequestedAtUTC'])
    final_after_stop=(isinstance(final.get('atUTC'),str) and isinstance(progress.get('stopRequestedAtUTC'),str)
        and final['atUTC']>=progress['stopRequestedAtUTC'])
    legacy=(progress.get('preExitProof',{}).get('verified') is True
        and progress.get('verifiedExitSignal',{}).get('containerId')==expected_container_id
        and progress.get('verifiedExitSignal',{}).get('status') in ('docker_accepted','exit_observed_after_intent'))
    return {'phaseAccepted':progress.get('phase') in ('stopped','start_requested'),
        'containerIdentityMatches':progress.get('oldContainer')==expected_container_id,
        'supplierStoppedBeforeConsumer':progress.get('supplierStoppedBeforeConsumer') is True,
        'legacyStopProofVerified':legacy,'sampleCount':len(samples),
        'priorRunningSameContainer':prior,
        'finalStoppedCleanly':isinstance(final,dict) and final.get('containerId')==expected_container_id and final.get('running') is False and final.get('exitCode')==0 and final.get('oomKilled') is False and final.get('signalsSent')==0,
        'supplierStopPrecedesWorkerStop':supplier_order,'workerExitObservedAfterStopRequest':final_after_stop}

def verified_stopped_profile_proof(progress,expected_container_id):
    proof=stopped_profile_proof_diagnostics(progress,expected_container_id)
    return (proof['phaseAccepted'] and proof['containerIdentityMatches'] and proof['supplierStoppedBeforeConsumer']
        and (proof['legacyStopProofVerified'] or proof['sampleCount']>=2 and proof['priorRunningSameContainer']
            and proof['finalStoppedCleanly'] and proof['supplierStopPrecedesWorkerStop']
            and proof['workerExitObservedAfterStopRequest']))

def should_defer_existing_profile_probe(request,verified_profile,receipt_exists):
    # A prepared receipt makes this a resume even when the coordinator omitted
    # resumeBackup. Load and validate that receipt before deriving the stop
    # proof; otherwise the safe offline probe sees an empty in-memory progress.
    return verified_profile is True and (bool(request.get('resumeBackup')) or receipt_exists is True)

def existing_pipeline_heap_plan(worker,verified_existing_snapshot_profile=False,verified_stopped_recovery=False,expected_container_id=None):
    options=worker.get('environment',{}).get('NODE_OPTIONS')
    if options=='--max-old-space-size=2560':return None
    if options=='--max-old-space-size=3840' and snapshot_memory_bytes(worker.get('mem_limit'))==6442450944:
        image=worker.get('image','');require(re.fullmatch('adl-worker-partitioned:[0-9a-f]{24}',image),'PIPELINE_HEAP_IMAGE_UNVERIFIED')
        path=SECURE/('partitioned-upgrade-'+image.split(':')[1]+'.json')
        require(path.is_file() and not path.is_symlink() and path.stat().st_uid==os.geteuid() and path.stat().st_mode&0o077==0 and path.stat().st_size<2*1024**2,'PIPELINE_HEAP_RECEIPT_UNVERIFIED')
        old=json.loads(path.read_bytes());require(old.get('image')==image and isinstance(old.get('digest'),str) and old['digest'][:24]==image.split(':')[1] and old.get('oomRestoreVerified') is True,'PIPELINE_HEAP_RESTORE_RECEIPT_UNVERIFIED')
        found=json.loads(run(['docker','image','inspect',image]))[0]
        require((found['Config'].get('Labels') or {}).get('eu.adl.partitioned.patch')==old['digest'],'PIPELINE_HEAP_SOURCE_IMAGE_MISMATCH')
        probe="const s=require('node:v8').getHeapStatistics();console.log(JSON.stringify({heapLimitBytes:s.heap_size_limit}))"
        measured=json.loads(run(['docker','run','--rm','--network','none','--memory','6g','--read-only','-e','NODE_OPTIONS='+options,'--entrypoint','node',image,'-e',probe]))
        limit=measured.get('heapLimitBytes')
        require(type(limit) is int and 3840*1024**2<=limit<=6442450944-512*1024**2,'PIPELINE_EFFECTIVE_HEAP_HEADROOM_UNVERIFIED')
        return {'evidenceVerified':True,'oldSpaceMiB':3840,'previousOldSpaceMiB':3840,'containerLimitUnchanged':True,'preserveExisting':True,'effectiveHeapLimitBytes':limit}
    if options=='--max-old-space-size=4608' and snapshot_memory_bytes(worker.get('mem_limit'))==8589934592:
        if verified_existing_snapshot_profile:
            require(worker.get('environment',{}).get('NODE_OPTIONS')==options,'PIPELINE_EXISTING_HEAP_OPTIONS_CHANGED_NO_DEPLOYMENT')
            workers=states('worker');require(len(workers)==1 and (expected_container_id is None or workers[0].get('id')==expected_container_id),'PIPELINE_WORKER_HEAP_PROBE_COUNT_UNVERIFIED')
            live=json.loads(run(['docker','inspect',workers[0]['id']]))[0]
            live_env=dict(item.split('=',1) for item in live.get('Config',{}).get('Env',[]) if '=' in item)
            require(live.get('Config',{}).get('Image')==worker.get('image') and live.get('HostConfig',{}).get('Memory')==8589934592 and live_env.get('NODE_OPTIONS')==options,'PIPELINE_LIVE_WORKER_HEAP_PROBE_CONFIGURATION_UNVERIFIED')
            probe="const s=require('node:v8').getHeapStatistics();console.log(JSON.stringify({heapLimitBytes:s.heap_size_limit}))"
            if workers[0].get('running') is True:
                measured=json.loads(run(['docker','exec',workers[0]['id'],'node','-e',probe],timeout=30))
            else:
                state=live.get('State',{})
                require(verified_stopped_pipeline_probe_exit(state,verified_stopped_recovery),'PIPELINE_STOPPED_HEAP_PROFILE_HANDOFF_UNVERIFIED')
                measured=json.loads(run(['docker','run','--rm','--network','none','--read-only','--memory','8589934592','--memory-swap','8589934592','--cpus','2','-e','NODE_OPTIONS='+options,'--entrypoint','node',live.get('Image'),'-e',probe],timeout=30))
            limit=measured.get('heapLimitBytes')
            require(type(limit) is int and 4608*1024**2<=limit<=8589934592-512*1024**2,'PIPELINE_EFFECTIVE_HEAP_HEADROOM_UNVERIFIED')
            return {'evidenceVerified':True,'oldSpaceMiB':4608,'previousOldSpaceMiB':4608,'containerLimitUnchanged':True,'preserveExisting':True,'effectiveHeapLimitBytes':limit}
        image=worker.get('image','');require(re.fullmatch('adl-worker-partitioned:[0-9a-f]{24}',image),'PIPELINE_HEAP_IMAGE_UNVERIFIED')
        path=SECURE/('partitioned-upgrade-'+image.split(':')[1]+'.json')
        require(path.is_file() and not path.is_symlink() and path.stat().st_uid==os.geteuid() and path.stat().st_mode&0o077==0 and path.stat().st_size<2*1024**2,'PIPELINE_HEAP_RECEIPT_UNVERIFIED')
        old=json.loads(path.read_bytes());require(old.get('image')==image and isinstance(old.get('digest'),str) and old['digest'][:24]==image.split(':')[1] and old.get('oomRestoreVerified') is True,'PIPELINE_HEAP_RESTORE_RECEIPT_UNVERIFIED')
        found=json.loads(run(['docker','image','inspect',image]))[0]
        require((found['Config'].get('Labels') or {}).get('eu.adl.partitioned.patch')==old['digest'],'PIPELINE_HEAP_SOURCE_IMAGE_MISMATCH')
        probe="const s=require('node:v8').getHeapStatistics();console.log(JSON.stringify({heapLimitBytes:s.heap_size_limit}))"
        workers=states('worker');require(len(workers)==1,'PIPELINE_WORKER_HEAP_PROBE_COUNT_UNVERIFIED')
        live=json.loads(run(['docker','inspect',workers[0]['id']]))[0]
        live_env=dict(item.split('=',1) for item in live.get('Config',{}).get('Env',[]) if '=' in item)
        require(live.get('Image')==found.get('Id') and live.get('HostConfig',{}).get('Memory')==8589934592 and live_env.get('NODE_OPTIONS')==options,'PIPELINE_LIVE_WORKER_HEAP_PROBE_CONFIGURATION_UNVERIFIED')
        if workers[0].get('running') is True:
            measured=json.loads(run(['docker','exec',workers[0]['id'],'node','-e',probe],timeout=30))
        else:
            # Resume after a confirmed protected stop: accept a clean exit or
            # the narrowly verified checkpoint-write failure, then measure the
            # exact saved image/profile in a data-free diagnostic process.
            state=live.get('State',{})
            if state.get('ExitCode')==1 and state.get('OOMKilled') is False:
                verify_live_persistence_failure_identity(workers[0],{'snapshotMemoryRepair':True,'livePersistenceRepair':True,'pipelineRepair':True,'expectedLiveImage':image},image)
            else:
                require(state.get('Running') is False and state.get('ExitCode')==0 and state.get('OOMKilled') is False,'PIPELINE_STOPPED_HEAP_CONTAINER_STATE_UNVERIFIED')
            measured=json.loads(run(['docker','run','--rm','--network','none','--read-only','--memory','8589934592','--memory-swap','8589934592','--cpus','2','--entrypoint','node',found['Id'],options,'-e',probe],timeout=30))
        limit=measured.get('heapLimitBytes')
        require(type(limit) is int and 4608*1024**2<=limit<=8589934592-512*1024**2,'PIPELINE_EFFECTIVE_HEAP_HEADROOM_UNVERIFIED')
        return {'evidenceVerified':True,'oldSpaceMiB':4608,'previousOldSpaceMiB':4608,'containerLimitUnchanged':True,'preserveExisting':True,'effectiveHeapLimitBytes':limit}
    if options=='--max-old-space-size=4096' and snapshot_memory_bytes(worker.get('mem_limit'))==6442450944:
        image=worker.get('image','');require(re.fullmatch('adl-worker-partitioned:[0-9a-f]{24}',image),'PIPELINE_HEAP_IMAGE_UNVERIFIED')
        path=SECURE/('partitioned-upgrade-'+image.split(':')[1]+'.json')
        require(path.is_file() and not path.is_symlink() and path.stat().st_uid==os.geteuid() and path.stat().st_mode&0o077==0 and path.stat().st_size<2*1024**2,'PIPELINE_HEAP_RECEIPT_UNVERIFIED')
        old=json.loads(path.read_bytes());require(old.get('image')==image and old.get('oomRestoreVerified') is True,'PIPELINE_HEAP_RESTORE_RECEIPT_UNVERIFIED')
        require(partition_heap_mib(old)==4096,'PIPELINE_MEASURED_HEAP_RECEIPT_UNVERIFIED')
        found=json.loads(run(['docker','image','inspect',image]))[0]
        require((found['Config'].get('Labels') or {}).get('eu.adl.partitioned.patch')==old.get('digest'),'PIPELINE_HEAP_SOURCE_IMAGE_MISMATCH')
        probe="const s=require('node:v8').getHeapStatistics();console.log(JSON.stringify({heapLimitBytes:s.heap_size_limit}))"
        measured=json.loads(run(['docker','run','--rm','--network','none','--memory','6g','--read-only','-e','NODE_OPTIONS='+options,'--entrypoint','node',image,'-e',probe]))
        require(4096*1024**2<=measured.get('heapLimitBytes',0)<5*1024**3,'PIPELINE_MEASURED_HEAP_HEADROOM_UNVERIFIED')
        return copy.deepcopy(old['heapBudgetPlan'])
    if options=='--max-old-space-size=4608' and snapshot_memory_bytes(worker.get('mem_limit'))==6442450944:
        image=worker.get('image','');require(re.fullmatch('adl-worker-partitioned:[0-9a-f]{24}',image),'PIPELINE_HEAP_IMAGE_UNVERIFIED')
        path=SECURE/('partitioned-upgrade-'+image.split(':')[1]+'.json')
        require(path.is_file() and not path.is_symlink() and path.stat().st_uid==os.geteuid() and path.stat().st_mode&0o077==0 and path.stat().st_size<2*1024**2,'PIPELINE_HEAP_RECEIPT_UNVERIFIED')
        old=json.loads(path.read_bytes());require(old.get('image')==image and isinstance(old.get('digest'),str) and old['digest'][:24]==image.split(':')[1] and old.get('oomRestoreVerified') is True,'PIPELINE_HEAP_RESTORE_RECEIPT_UNVERIFIED')
        plan=old.get('heapBudgetPlan') or {}
        if old.get('v8HeapOomRepair') is True and plan.get('v8HeapCompactionPreserve') is True:
            # Carry forward the already verified 4.5 GiB old-space plan. The
            # prior pipeline gate understood only a measured retry plan and
            # rejected this separately measured compaction-preserve receipt.
            require(old.get('snapshotMemoryRepair') is True and partition_heap_mib(old)==4608,'PIPELINE_V8_HEAP_PLAN_UNVERIFIED')
        else:
            require(old.get('measuredSnapshotRetryHeapRepair') is True and partition_heap_mib(old)==4608,'PIPELINE_MEASURED_RETRY_RECEIPT_UNVERIFIED')
        found=json.loads(run(['docker','image','inspect',image]))[0]
        require((found['Config'].get('Labels') or {}).get('eu.adl.partitioned.patch')==old['digest'],'PIPELINE_HEAP_SOURCE_IMAGE_MISMATCH')
        probe="const s=require('node:v8').getHeapStatistics();console.log(JSON.stringify({heapLimitBytes:s.heap_size_limit}))"
        measured=json.loads(run(['docker','run','--rm','--network','none','--memory','6g','--read-only','-e','NODE_OPTIONS='+options,'--entrypoint','node',image,'-e',probe]))
        require(type(measured.get('heapLimitBytes')) is int and 4608*1024**2<=measured['heapLimitBytes']<=6442450944-512*1024**2,'PIPELINE_MEASURED_RETRY_HEADROOM_UNVERIFIED')
        return copy.deepcopy(old['heapBudgetPlan'])
    require(options=='--max-old-space-size=3584' and snapshot_memory_bytes(worker.get('mem_limit'))==6442450944,'PIPELINE_EXISTING_HEAP_OPTIONS_CHANGED_NO_DEPLOYMENT')
    image=worker.get('image','');require(re.fullmatch('adl-worker-partitioned:[0-9a-f]{24}',image),'PIPELINE_HEAP_IMAGE_UNVERIFIED')
    path=SECURE/('partitioned-upgrade-'+image.split(':')[1]+'.json')
    require(path.is_file() and not path.is_symlink() and path.stat().st_uid==os.geteuid() and path.stat().st_mode&0o077==0 and path.stat().st_size<2*1024**2,'PIPELINE_HEAP_RECEIPT_UNVERIFIED')
    old=json.loads(path.read_bytes());require(old.get('image')==image and isinstance(old.get('digest'),str) and old['digest'][:24]==image.split(':')[1] and old.get('oomRestoreVerified') is True,'PIPELINE_HEAP_RESTORE_RECEIPT_UNVERIFIED')
    require(partition_heap_mib(old)==3584,'PIPELINE_HEAP_PLAN_UNVERIFIED')
    found=json.loads(run(['docker','image','inspect',image]))[0]
    require((found['Config'].get('Labels') or {}).get('eu.adl.partitioned.patch')==old['digest'],'PIPELINE_HEAP_SOURCE_IMAGE_MISMATCH')
    return copy.deepcopy(old['heapBudgetPlan'])

def preserved_snapshot_eight_gib_heap_plan(worker,container,worker_model,expected_backup,request=None):
    options=worker_model.get('environment',{}).get('NODE_OPTIONS')
    require(options=='--max-old-space-size=4608' and snapshot_memory_bytes(worker_model.get('mem_limit'))==8589934592,'SNAPSHOT_EIGHT_GIB_BASE_PROFILE_MISMATCH')
    v8=(request or {}).get('v8HeapOomRepair') is True
    if v8:verify_live_v8_heap_oom_identity(worker,{**(request or {}),'snapshotMemoryRepair':True})
    else:require(worker.get('name')=='/adl-homologation-worker-1' and worker.get('running') is False and worker.get('oomKilled') is True and worker.get('exitCode')==137 and re.fullmatch('[0-9a-f]{64}',str(worker.get('id',''))),'SNAPSHOT_EIGHT_GIB_OOM_IDENTITY_UNVERIFIED')
    expected_oom=(container.get('State',{}).get('OOMKilled') is False and container.get('State',{}).get('ExitCode')==134) if v8 else (container.get('State',{}).get('OOMKilled') is True and container.get('State',{}).get('ExitCode')==137)
    require(container.get('Id')==worker.get('id') and container.get('Config',{}).get('Image')==worker_model.get('image') and expected_oom and container.get('HostConfig',{}).get('Memory')==8589934592 and container.get('HostConfig',{}).get('RestartPolicy',{}).get('Name') in ('no',''),'SNAPSHOT_EIGHT_GIB_CONTAINER_IDENTITY_UNVERIFIED')
    image=worker_model.get('image','');require(re.fullmatch('adl-worker-partitioned:[0-9a-f]{24}',image),'SNAPSHOT_EIGHT_GIB_IMAGE_UNVERIFIED')
    path=SECURE/('partitioned-upgrade-'+image.split(':')[1]+'.json')
    require(path.is_file() and not path.is_symlink() and path.stat().st_uid==os.geteuid() and path.stat().st_mode&0o077==0 and path.stat().st_size<2*1024**2,'SNAPSHOT_EIGHT_GIB_RECEIPT_UNVERIFIED')
    source_backup=Path(str(expected_backup or ''))
    require(source_backup.parent==BACKUPS and not source_backup.is_symlink() and source_backup.is_dir() and source_backup.stat().st_uid==os.geteuid() and source_backup.stat().st_mode&0o077==0,'SNAPSHOT_EIGHT_GIB_BACKUP_REFERENCE_UNVERIFIED')
    old=json.loads(path.read_bytes());require(old.get('image')==image and old.get('backup')==str(source_backup) and old.get('oomRestoreVerified') is True and old.get('snapshotMemoryVerified') is True,'SNAPSHOT_EIGHT_GIB_RECOVERY_RECEIPT_UNVERIFIED')
    found=json.loads(run(['docker','image','inspect',image]))[0]
    require(found.get('Id')==container.get('Image') and (found.get('Config',{}).get('Labels') or {}).get('eu.adl.partitioned.patch')==old.get('digest'),'SNAPSHOT_EIGHT_GIB_SOURCE_IMAGE_MISMATCH')
    require(snapshot_host_memory()>=12*1024**3,'SNAPSHOT_EIGHT_GIB_HOST_RESERVE_INSUFFICIENT')
    probe="const s=require('node:v8').getHeapStatistics();console.log(JSON.stringify({heapLimitBytes:s.heap_size_limit}))"
    measured=json.loads(run(['docker','run','--rm','--network','none','--read-only','--memory','8g','--memory-swap','8g','--cpus','2','--entrypoint','node',found['Id'],options,'-e',probe],timeout=30))
    limit=measured.get('heapLimitBytes')
    require(type(limit) is int and 4608*1024**2<=limit<=8589934592-512*1024**2,'SNAPSHOT_EIGHT_GIB_EFFECTIVE_HEAP_UNVERIFIED')
    return {'evidenceVerified':True,'preserveExisting':True,'snapshotMemoryEightGiBRepair':True,'oldSpaceMiB':4608,'previousOldSpaceMiB':4608,'containerLimitUnchanged':True,'effectiveHeapLimitBytes':limit}

def measured_snapshot_apply_heap_plan(progress,backup,workers):
    require(progress.get('phase')=='stopped' and progress.get('memoryLimitBytes')==6442450944 and progress.get('pipelineRepair') is True and progress.get('snapshotMemoryRepair') is True and progress.get('livePersistenceRepair') is True,'MEASURED_HEAP_SCOPE_UNVERIFIED')
    require(str(backup)==progress.get('backup') and not backup.is_symlink() and backup.is_dir() and backup.stat().st_mode&0o077==0,'MEASURED_HEAP_BACKUP_UNVERIFIED')
    require(len(workers)==1 and workers[0].get('id')==progress.get('oldContainer') and not workers[0].get('running') and not workers[0].get('oomKilled') and workers[0].get('exitCode')==0,'MEASURED_HEAP_CLEAN_STOP_UNVERIFIED')
    old_plan=progress.get('heapBudgetPlan') or {}
    if old_plan.get('measuredSnapshotApply') is True:
        # The latest-log pointer is intentionally advanced to the independent
        # readback log after a successful rehearsal. Resume from the failure
        # artifact named by the already-saved, hash-pinned plan instead.
        name=old_plan.get('sourceAttempt')
    else:
        pointer=backup/'oom-restore.latest.json';require(pointer.is_file() and not pointer.is_symlink() and pointer.stat().st_mode&0o077==0,'MEASURED_HEAP_ATTEMPT_POINTER_UNVERIFIED')
        name=json.loads(pointer.read_bytes()).get('name')
    require(isinstance(name,str) and re.fullmatch(r'oom-restore-attempt-[0-9a-f]{16,32}\.private\.log',name),'MEASURED_HEAP_ATTEMPT_NAME_UNVERIFIED')
    path=backup/name;require(path.is_file() and not path.is_symlink() and path.stat().st_uid==os.geteuid() and path.stat().st_mode&0o077==0 and path.stat().st_size<=8*1024**2,'MEASURED_HEAP_ATTEMPT_LOG_UNVERIFIED')
    raw=read_tail(path);records=[]
    for line in raw.decode(errors='replace').splitlines():
        try:r=json.loads(line)
        except ValueError:continue
        if isinstance(r,dict) and r.get('operation') in ('offline.memory','offline.memory_budget'):records.append(r)
    if old_plan.get('measuredSnapshotApply') is True:
        require(hashlib.sha256(raw).hexdigest()==old_plan.get('sourceTailSha256'),'MEASURED_HEAP_SOURCE_LOG_CHANGED')
    # The runtime emits the admission decision as snapshot_guard, separately
    # from row-level snapshot.apply progress. Match that exact guard stage so
    # the measured recovery plan is anchored to the preserved failed attempt.
    failures=[r for r in records if r.get('operation')=='offline.memory_budget' and r.get('stage')=='snapshot_guard' and r.get('allowed') is False]
    samples=[r for r in records if r.get('operation')=='offline.memory' and r.get('stage')=='snapshot.apply' and r.get('rows',0)>=12000]
    require(failures and samples,'MEASURED_HEAP_FAILURE_EVIDENCE_MISSING');failure=failures[-1];sample=samples[-1];memory=failure.get('memory') or {};counts=sample.get('indexCounts') or {}
    require(failure.get('budgetBytes')==335544320 and failure.get('headroomBytes')==333903952 and memory.get('limitingFactor')=='heap' and memory.get('heapLimitBytes')==4227858432 and memory.get('heapUsedBytes')==3893954480 and memory.get('availableMemoryBytes')==2005966848,'MEASURED_HEAP_FAILURE_METRICS_CHANGED')
    require(counts.get('stateRows',0)>=42000 and counts.get('bets',0)>=5700000 and counts.get('markets',0)>=840000 and sample.get('heapUsedBytes',0)>3700000000,'MEASURED_HEAP_STATE_SHAPE_CHANGED')
    tail_hash=hashlib.sha256(raw).hexdigest()
    plan={'evidenceVerified':True,'measuredSnapshotApply':True,'previousOldSpaceMiB':3840,'oldSpaceMiB':4096,'containerLimitUnchanged':True,'containerLimitBytes':6442450944,'outsideOldSpaceBytes':2147483648,'guardBudgetBytes':335544320,'failureHeadroomBytes':failure['headroomBytes'],'failureHeapUsedBytes':memory['heapUsedBytes'],'failureAvailableMemoryBytes':memory['availableMemoryBytes'],'applyRowsAtFailure':sample['rows'],'retainedStateRows':counts['stateRows'],'retainedMarkets':counts['markets'],'retainedSelections':counts['bets'],'sourceAttempt':name,'sourceTailSha256':tail_hash,'realDataAcceptanceRequired':True}
    if old_plan.get('measuredSnapshotApply') is True:
        # A previous protected run may have durably recorded the exact plan
        # before failing at a later gate. Revalidate it from the same immutable
        # failure log rather than rejecting our own resumable state.
        require(old_plan==plan,'MEASURED_HEAP_PLAN_CHANGED')
    else:
        require(old_plan.get('preserveExisting') is True and old_plan.get('oldSpaceMiB')==3840 and old_plan.get('effectiveHeapLimitBytes')==4227858432,'MEASURED_HEAP_BASELINE_UNVERIFIED')
    return plan

def measured_snapshot_retry_heap_plan(progress,backup,workers):
    require(progress.get('phase')=='stopped' and progress.get('memoryLimitBytes')==6442450944 and progress.get('pipelineRepair') is True and progress.get('snapshotMemoryRepair') is True and progress.get('livePersistenceRepair') is True,'MEASURED_SNAPSHOT_RETRY_SCOPE_UNVERIFIED')
    require(str(backup)==progress.get('backup') and not backup.is_symlink() and backup.is_dir() and backup.stat().st_mode&0o077==0,'MEASURED_SNAPSHOT_RETRY_BACKUP_UNVERIFIED')
    require(len(workers)==1 and workers[0].get('id')==progress.get('oldContainer') and not workers[0].get('running') and not workers[0].get('oomKilled') and workers[0].get('exitCode')==0,'MEASURED_SNAPSHOT_RETRY_CLEAN_STOP_UNVERIFIED')
    old_plan=progress.get('heapBudgetPlan') or {}
    require(partition_heap_mib({**progress,'heapBudgetPlan':old_plan})==4096,'MEASURED_SNAPSHOT_RETRY_BASE_HEAP_UNVERIFIED')
    pointer=backup/'oom-restore.latest.json';require(pointer.is_file() and not pointer.is_symlink() and pointer.stat().st_uid==os.geteuid() and pointer.stat().st_mode&0o077==0 and pointer.stat().st_size<4096,'MEASURED_SNAPSHOT_RETRY_POINTER_UNVERIFIED')
    name=json.loads(pointer.read_bytes()).get('name');require(isinstance(name,str) and re.fullmatch(r'oom-restore-attempt-[0-9a-f]{16,32}\.private\.log',name),'MEASURED_SNAPSHOT_RETRY_ATTEMPT_UNVERIFIED')
    path=backup/name;require(path.is_file() and not path.is_symlink() and path.stat().st_uid==os.geteuid() and path.stat().st_mode&0o077==0 and path.stat().st_size<=8*1024**2,'MEASURED_SNAPSHOT_RETRY_LOG_UNVERIFIED')
    raw=read_tail(path);evidence=rehearsal_heap_evidence(raw);summary=oom_restore_log_summary(backup,name)
    require('node_heap_exhausted' in summary.get('signals',[]) and 'javascript_heap_out_of_memory' in evidence.get('fatalSignals',[]) and evidence.get('stageAtFailure')=='snapshot.apply','MEASURED_SNAPSHOT_RETRY_HEAP_FAILURE_UNVERIFIED')
    heap_limit=evidence.get('effectiveHeapLimitBytes') or 0;peak_heap=evidence.get('maxSampledHeapBytes') or 0;peak_rss=evidence.get('maxObservedRSSBytes') or 0
    require(4200*1024**2<=heap_limit<=4400*1024**2 and peak_heap>=3900*1024**2 and peak_rss<6442450944-512*1024**2,'MEASURED_SNAPSHOT_RETRY_HEADROOM_UNVERIFIED')
    require(snapshot_host_memory()>=6*1024**3,'MEASURED_SNAPSHOT_RETRY_HOST_HEADROOM_INSUFFICIENT')
    return {'evidenceVerified':True,'measuredSnapshotRetry':True,'previousOldSpaceMiB':4096,'oldSpaceMiB':4608,'containerLimitUnchanged':True,'containerLimitBytes':6442450944,'outsideOldSpaceBytes':1610612736,'guardBudgetBytes':335544320,'previousHeapLimitBytes':heap_limit,'previousPeakHeapBytes':peak_heap,'previousPeakRSSBytes':peak_rss,'sourceAttempt':name,'sourceTailSha256':hashlib.sha256(raw).hexdigest(),'realDataAcceptanceRequired':True}

def inherit_pressure_heap_plan(progress,request,worker):
    # Reuse only the exact heap budget already proven by the currently deployed
    # image. This repairs a smaller rehearsal heap; it does not raise cgroup RAM.
    require(request.get('preservedHeapBudgetRepair') is True and request.get('snapshotMemoryRepair') is True and request.get('snapshotPressureRepair') is True and request.get('livePersistenceRepair') is True and request.get('pipelineRepair') is not True and request.get('resumeBackup')==progress.get('backup'),'PRESERVED_PRESSURE_HEAP_SCOPE_UNVERIFIED')
    require(partition_memory(progress)==6442450944 and progress.get('phase') in ('stop_requested','stopped') and progress.get('oomRestoreVerified') is True,'PRESERVED_PRESSURE_HEAP_REQUIRES_VERIFIED_REHEARSAL')
    plan=existing_pipeline_heap_plan(worker)
    require(plan is not None and plan.get('oldSpaceMiB')==3584 and plan.get('containerLimitUnchanged') is True,'PRESERVED_PRESSURE_HEAP_SOURCE_UNVERIFIED')
    if progress.get('heapBudgetPlan') is not None:require(progress['heapBudgetPlan']==plan,'PRESERVED_PRESSURE_HEAP_PLAN_CHANGED')
    else:progress['heapBudgetPlan']=plan
    return progress

def preserved_heap_budget_plan(progress,backup,workers):
    # This bounded adjustment is tied to the exact failed preparation, not a
    # general heap override. The six-GiB cgroup remains unchanged.
    require(progress.get('backup')=='/var/backups/adl-partitioned-upgrade-o4uv0zl9' and str(backup)==progress['backup'] and progress.get('image')=='adl-worker-partitioned:78f1104c6e9246c233a7f26b','HEAP_REPAIR_PREPARATION_MISMATCH')
    require(partition_memory(progress)==6442450944 and progress.get('phase')=='stopped' and not progress.get('oomRestoreVerified'),'HEAP_REPAIR_REQUIRES_STOPPED_UNVERIFIED_REHEARSAL')
    require(len(workers)==1 and workers[0].get('id')==progress.get('oldContainer') and not workers[0].get('running') and not workers[0].get('oomKilled') and workers[0].get('exitCode')==0,'HEAP_REPAIR_CLEAN_EXIT_NOT_VERIFIED')
    path=backup/'oom-restore-attempt-c84e458361c7bf49.private.log'
    require(path.is_file() and not path.is_symlink() and path.stat().st_uid==os.geteuid() and path.stat().st_mode&0o077==0,'HEAP_REPAIR_EVIDENCE_UNVERIFIED')
    raw=read_tail(path);records=[]
    for line in raw.decode(errors='replace').splitlines():
        try:r=json.loads(line)
        except ValueError:continue
        if isinstance(r,dict) and r.get('operation')=='offline.memory_budget':records.append(r)
    require(records,'HEAP_REPAIR_BUDGET_RECORD_MISSING');r=records[-1];memory=r.get('memory',{})
    require(r.get('allowed') is False and r.get('budgetBytes')==335544320 and r.get('headroomBytes')==332097824 and memory.get('limitingFactor')=='heap' and memory.get('heapLimitBytes')==2885681152 and memory.get('heapUsedBytes')==2553583328 and memory.get('availableMemoryBytes')==2208849920,'HEAP_REPAIR_MEASUREMENTS_DIFFER')
    # Add 1 GiB of old space inside the existing cgroup. This leaves 2.5 GiB
    # outside old space for young generation, native buffers and file cache.
    # It is a candidate budget: full real-data replay/write/readback MUST pass.
    return {'evidenceVerified':True,'previousOldSpaceMiB':2560,'oldSpaceMiB':3584,'containerLimitUnchanged':True,'containerLimitBytes':6442450944,'outsideOldSpaceBytes':2684354560,'observedHeapUsedBytes':memory['heapUsedBytes'],'observedAvailableMemoryBytes':memory['availableMemoryBytes'],'guardBudgetBytes':r['budgetBytes'],'priorHeadroomBytes':r['headroomBytes'],'sourceAttempt':path.name,'sourceTailSha256':hashlib.sha256(raw).hexdigest(),'realDataAcceptanceRequired':True}

def partition_rehearsal_args(args,progress):
    if candidate_memory(progress)==6442450944:
        for key in ('--memory','--memory-swap'):
            if key in args:args[args.index(key)+1]='6g'
        if '--memory-swap' not in args:args[args.index('--memory')+2:args.index('--memory')+2]=['--memory-swap','6g']
        args[2:2]=['--label','eu.adl.recovery.cache-policy=bounded-reclaim-verified']
    elif candidate_memory(progress)==8192*1024**2:
        for key in ('--memory','--memory-swap'):
            if key in args:args[args.index(key)+1]='8g'
        if '--memory-swap' not in args:args[args.index('--memory')+2:args.index('--memory')+2]=['--memory-swap','8g']
        args[2:2]=['--label','eu.adl.recovery.cache-policy=bounded-reclaim-verified']
    return args

def verify_pipeline_sources(old_files,files,old_digest,added_old_files,indexed_old_files=None):
    indexed_old_files=indexed_old_files or {}
    require(set(files)==PARTITION_FILES|INDEXED_PUBLICATION_FILES and set(old_files)==PIPELINE_BASE_FILES|PIPELINE_AUXILIARY_FILES and set(added_old_files)==set(PIPELINE_ADDED_DEPENDENCY_SHA256)|set(PIPELINE_PINNED_ADDED_DEPENDENCY_SHA256),'PIPELINE_SOURCE_MANIFEST_MISMATCH')
    require(set(indexed_old_files)<=INDEXED_PUBLICATION_FILES,'PIPELINE_INDEXED_BASE_SOURCE_MANIFEST_MISMATCH')
    require({name:hashlib.sha256(added_old_files[name].encode()).hexdigest() for name in PIPELINE_ADDED_DEPENDENCY_SHA256}==PIPELINE_ADDED_DEPENDENCY_SHA256,'PIPELINE_ADDED_DEPENDENCY_BASE_UNVERIFIED')
    require(verify_pinned_added_dependencies(added_old_files,PIPELINE_PINNED_ADDED_DEPENDENCY_SHA256),'PIPELINE_PINNED_ADDED_DEPENDENCY_BASE_UNVERIFIED')
    verified_base={**old_files,**added_old_files,**indexed_old_files}
    # Earlier indexed-publication images already carried indexed-feed.ts in
    # their immutable source digest even though it was tracked separately from
    # PARTITION_FILES. Bind that exact installed source when present; legacy
    # full-set images retain the partition-only digest.
    digest_base={name:verified_base[name] for name in PARTITION_FILES|set(indexed_old_files)}
    require(hashlib.sha256(json.dumps(digest_base,sort_keys=True,separators=(',',':')).encode()).hexdigest()==old_digest,'PIPELINE_BASE_SOURCE_DIGEST_MISMATCH')
    require({name:hashlib.sha256(files[name].encode()).hexdigest() for name in INDEXED_PUBLICATION_FILES}==INDEXED_PUBLICATION_SOURCE_SHA256,'INDEXED_PUBLICATION_SOURCE_HASH_UNVERIFIED')
    require('export { IndexedFeedStore, indexedFeedPath } from "./indexed-feed.js";' in files['packages/feed-store/src/index.ts'],'INDEXED_PUBLICATION_EXPORT_MISSING')
    changed={n for n in files if n not in verified_base or files[n]!=verified_base[n]}
    require(changed and changed<={'apps/worker/src/connected.ts','apps/worker/src/full-snapshot.ts','apps/worker/src/provider.ts','apps/worker/src/diagnostics.ts','apps/worker/src/snapshot-capacity.ts','apps/worker/src/state.ts','apps/worker/src/persistence.ts','apps/worker/src/durable-ingress.mjs','apps/worker/src/durable-ingress.d.mts','packages/contracts/src/index.ts','packages/feed-store/src/index.ts','packages/feed-store/src/operation-risk.ts','packages/feed-store/src/tenant-tickets.ts'}|INDEXED_PUBLICATION_FILES,'PIPELINE_PATCH_SCOPE_UNVERIFIED')
    require('indexed_projection.rebuild' in files['apps/worker/src/connected.ts'] and 'indexed_projection.delta' in files['apps/worker/src/connected.ts'] and 'new IndexedFeedStore' in files['apps/worker/src/connected.ts'],'INDEXED_PUBLICATION_WORKER_WIRING_MISSING')
    require('persistCheckpointDelta' in files['apps/worker/src/persistence.ts'] and 'compactCheckpointJournal' in files['apps/worker/src/persistence.ts'] and 'await file.sync()' in files['apps/worker/src/persistence.ts'],'INDEXED_PUBLICATION_DURABILITY_GUARD_MISSING')

def verify_publication_reserve_sources(old_files,files,old_digest):
    # The installed image label covers the historical full source set. The
    # later-added tenant ticket dependency is pinned independently below.
    base={name:old_files[name] for name in PUBLICATION_BASE_DIGEST_FILES if name in old_files}
    require(set(old_files)==set(files) and set(base)==PUBLICATION_BASE_DIGEST_FILES and hashlib.sha256(json.dumps(base,sort_keys=True,separators=(',',':')).encode()).hexdigest()==old_digest,'PUBLICATION_RESERVE_BASE_DIGEST_MISMATCH')
    require(verify_pinned_added_dependencies(old_files,PIPELINE_PINNED_ADDED_DEPENDENCY_SHA256),'PUBLICATION_RESERVE_ADDED_DEPENDENCY_BASE_UNVERIFIED')
    changed={n for n in files if files[n]!=old_files[n]}
    # State: wait outside FIFO; connected: decode inside guarded apply, bounded
    # metadata retention; persistence/feed-store: awaited write/fsync telemetry.
    # feed-store carries read containment plus lazy-iterable-safe settlement and
    # risk reconciliation; the API is not replaced. No format/provider changes.
    require(changed and changed<={'apps/worker/src/state.ts','apps/worker/src/connected.ts','apps/worker/src/persistence.ts','packages/feed-store/src/index.ts','packages/feed-store/src/operation-risk.ts','packages/feed-store/src/tenant-tickets.ts'},'PUBLICATION_RESERVE_PATCH_SCOPE_UNVERIFIED')

def verify_checkpoint_repair_sources(old_files,files):
    changed={name for name in files if files[name]!=old_files[name]}
    require(changed and changed<={'apps/worker/src/full-snapshot.ts','apps/worker/src/persistence.ts','apps/worker/src/state.ts','apps/worker/src/connected.ts','packages/feed-store/src/index.ts','packages/feed-store/src/operation-risk.ts','packages/feed-store/src/tenant-tickets.ts'},'CHECKPOINT_REPAIR_DIFF_NOT_ALLOWED')
    return changed

def verify_checkpoint_buffer_sources(old_files,files,old_digest):
    base={name:old_files[name] for name in PARTITION_DIGEST_FILES if name in old_files}
    require(set(old_files)==set(files) and set(base)==PARTITION_DIGEST_FILES and hashlib.sha256(json.dumps(base,sort_keys=True,separators=(',',':')).encode()).hexdigest()==old_digest,'CHECKPOINT_BUFFER_BASE_DIGEST_MISMATCH')
    require(verify_pinned_added_dependencies(old_files,PIPELINE_PINNED_ADDED_DEPENDENCY_SHA256),'CHECKPOINT_BUFFER_ADDED_DEPENDENCY_BASE_UNVERIFIED')
    changed={name for name in files if files[name]!=old_files[name]}
    # connected: already tested partial-prefix retirement plus IO counters;
    # persistence: bounded writes, identical JSON/atomicity. No parser, schema,
    # state, provider, feed-store, queue or API changes are permitted here.
    require('apps/worker/src/persistence.ts' in changed and changed<={'apps/worker/src/connected.ts','apps/worker/src/persistence.ts'},'CHECKPOINT_BUFFER_PATCH_SCOPE_UNVERIFIED')

def verify_transport_lifecycle_sources(old_files,files,old_digest):
    # Image labels are created from the complete PARTITION_FILES manifest.
    # Hash that exact set here; hashing only the historical subset can never
    # match a full-set image label and blocks valid, pinned lifecycle repairs.
    require(set(old_files)==set(files)==PARTITION_FILES and hashlib.sha256(json.dumps(old_files,sort_keys=True,separators=(',',':')).encode()).hexdigest()==old_digest,'TRANSPORT_LIFECYCLE_BASE_DIGEST_MISMATCH')
    require(verify_pinned_added_dependencies(old_files,PIPELINE_PINNED_ADDED_DEPENDENCY_SHA256),'TRANSPORT_LIFECYCLE_ADDED_DEPENDENCY_BASE_UNVERIFIED')
    changed={n for n in files if files[n]!=old_files[n]}
    # Actor lifetime/join, durable post-disconnect retirement and actor identity.
    # Persistence/parser/state formats and vendor requests are unchanged.
    require(changed and changed<={'apps/worker/src/connected.ts','apps/worker/src/connection-closer.ts','apps/worker/src/durable-ingress.mjs','apps/worker/src/durable-ingress.d.mts'},'TRANSPORT_LIFECYCLE_PATCH_SCOPE_UNVERIFIED')

def partition_base(meta):
    release=Path(meta['release']);require(release.parent==RELEASES and re.fullmatch('[0-9a-f]{40}',release.name) and not release.is_symlink(),'RELEASE_UNVERIFIED')
    base=['docker','compose','-p','adl-homologation','--env-file',str(SECURE/'deploy.env'),'-f',str(release/'deploy/homologation/compose.yaml'),'-f',str(release/'deploy/homologation/compose.existing-caddy.yaml')]
    for entry in meta.get('composeOverrides',[]):
        path=Path(entry);require(path.parent==SECURE and path.is_file() and not path.is_symlink(),'OVERRIDE_UNVERIFIED');base+=['-f',entry]
    return base

def distribution_stop_log_summary(backup):
    path=backup/'distribution-stop.private.log'
    if not path.exists():return {'present':False}
    require(path.is_file() and not path.is_symlink() and path.stat().st_uid==os.geteuid() and not backup.is_symlink() and backup.stat().st_mode&0o077==0,'STOP_LOG_NOT_PROTECTED')
    raw=read_tail(path);text=raw.decode(errors='replace').lower();signals=classify(raw)
    for token,label in [('heap out of memory','heap_exhausted'),('cannot find package','module_not_found'),('enoent','missing_file'),('etimedout','network_timeout'),('econnreset','connection_reset'),('fetch failed','http_transport_failure')]:
        if token in text:signals.append(label)
    records=[]
    for line in raw.decode(errors='replace').splitlines():
        try:entry=json.loads(line)
        except Exception:continue
        if not isinstance(entry,dict):continue
        if entry.get('operation')=='distribution.stop' and entry.get('status')=='ok' and entry.get('bodyIsDistributionOn') is False and entry.get('lane') in ('prematch','inplay'):
            records.append({'packageId':4511 if entry['lane']=='prematch' else 4510,'stage':'after','bodyIsDistributionOn':False,'historicalLogRecord':True});continue
        if entry.get('operation')!='upgrade.distribution_stop':continue
        if entry.get('packageId') not in (4510,4511):continue
        row={'packageId':entry['packageId']}
        if isinstance(entry.get('observedAtUTC'),str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T[0-9:.]+Z',entry['observedAtUTC']):row['observedAtUTC']=entry['observedAtUTC']
        for k,allowed in {'stage':('before','after','failed'),'step':('configuration','status_before','stop','status_after'),'localReason':('STATUS_SHAPE_UNVERIFIED','DISTRIBUTION_STILL_ON'),'action':('stop_requested','already_off','status_only'),'category':('network','authentication_rejected','invalid_response','supplier_error','rate_limited','unexpected'),'reason':('timeout','invalid_snapshot','distribution_still_off','unknown_exception'),'rateLimitSource':('supplier_http','local_operation_cooldown','local_in_flight')}.items():
            if entry.get(k) in allowed:row[k]=entry[k]
        for k in ('bodyIsDistributionOn','sdkIsDistributionOn'):
            if type(entry.get(k)) is bool:row[k]=entry[k]
        if type(entry.get('httpStatus')) is int and 100<=entry['httpStatus']<=599:row['httpStatus']=entry['httpStatus']
        records.append(row)
    return {'present':True,'signals':sorted(set(signals)),'records':records[-12:],'httpStatusCodes':sorted(set(int(v) for v in re.findall(r'httpStatus[\"\']?\s*[:=]\s*([1-5][0-9]{2})',raw.decode(errors='replace')))),'privateLogSha256':hashlib.sha256(raw).hexdigest(),'rawLogPrinted':False}

def durable_ingress_proof_command(backup,image,check,name='durable-ingress-proof.mjs'):
    # A file entrypoint keeps --input-type out of the transport Worker's execArgv.
    proof=backup/name
    require(not backup.is_symlink() and backup.stat().st_mode&0o077==0,'OFFLINE_PROOF_BACKUP_NOT_PRIVATE')
    if proof.exists():
        require(proof.is_file() and not proof.is_symlink() and proof.stat().st_uid==os.geteuid() and proof.read_bytes()==check.encode(),'OFFLINE_PROOF_CHANGED')
    else:private(proof,check.encode())
    # Direct file bind: readable by container node, protected on host by parent 0700.
    os.chmod(proof,0o644)
    return ['docker','run','--rm','--network','none','--memory','512m','--cpus','0.5','--read-only','--tmpfs','/tmp:size=268435456,mode=1777','--mount','type=bind,source='+str(proof)+',target=/offline-proof.mjs,readonly','--entrypoint','node',image,'/offline-proof.mjs']

def pipeline_proof_revision(check):return hashlib.sha256(check.encode()).hexdigest()

def pipeline_load_expected_messages(proof):
    duration=re.search(r'duration=Number\(process\.env\.ADL_PIPELINE_DURATION_MS\|\|(\d+)\)',proof)
    load=re.search(r'offlineLoad\(\{durationMs:duration,rate:(\d+),burst:(\d+),',proof)
    require(duration is not None and load is not None,'PIPELINE_LOAD_TARGET_UNVERIFIED')
    return int(duration.group(1))*int(load.group(1))//1000+int(load.group(2))

def pipeline_load_expected_duration(proof):
    match=re.search(r'duration=Number\(process\.env\.ADL_PIPELINE_DURATION_MS\|\|(\d+)\)',proof)
    require(match is not None,'PIPELINE_LOAD_TARGET_UNVERIFIED')
    return int(match.group(1))

def pipeline_load_metrics_valid(metrics,proof):
    expected=pipeline_load_expected_messages(proof)
    return (metrics.get('snapshotRows',0)>0 and metrics.get('applied')==metrics.get('snapshotRows') and
        metrics.get('preload',0)>=500000 and metrics.get('loadSent')==expected and metrics.get('received')==expected and
        pipeline_load_expected_duration(proof)<=metrics.get('loadDurationMs',0)<=pipeline_load_expected_duration(proof)+max(10000,pipeline_load_expected_duration(proof)//100) and
        metrics.get('processed',0)>metrics.get('received',0) and metrics.get('checkpointed')==metrics.get('processed') and
        metrics.get('finalBacklog')==metrics.get('preload')+metrics.get('received')-metrics.get('checkpointed') and
        metrics.get('finalBacklog')<metrics.get('preload') and metrics.get('readbackRows',0)>=metrics.get('snapshotRows') and
        metrics.get('peakRSSBytes',0)<6*1024**3 and metrics.get('maxPersistMs',10**12)<180000)

def reuse_pipeline_load_proof(backup,proof_sha,proof):
    script=backup/('pipeline-load-proof-'+proof_sha[:16]+'.mjs')
    if not script.exists():return None
    backup_info=backup.lstat();require(backup.is_dir() and not backup.is_symlink() and backup_info.st_uid==os.geteuid() and backup_info.st_mode&0o077==0,'PIPELINE_LOAD_SAVED_PROOF_BACKUP_NOT_PRIVATE')
    script_info=script.lstat();require(script.is_file() and not script.is_symlink() and script_info.st_nlink==1 and script_info.st_uid==os.geteuid() and script_info.st_mode&0o777 in (0o600,0o644) and snapshot_file_hash(script)==proof_sha and script.read_text()==proof,'PIPELINE_LOAD_SAVED_PROOF_IDENTITY_MISMATCH')
    candidates=[]
    for log in backup.glob('pipeline-load-*.private.log'):
        if log.is_symlink() or not log.is_file():continue
        info=log.stat()
        if info.st_nlink!=1 or info.st_uid!=os.geteuid() or info.st_mode&0o777 not in (0o600,0o644) or info.st_size>64*1024**2:continue
        raw=log.read_bytes();records=[]
        for line in raw.splitlines():
            try:record=json.loads(line)
            except ValueError:continue
            if isinstance(record,dict) and record.get('operation')=='pipeline.offline.complete':records.append(record)
        if b'pipeline-load-offline-ok' not in raw or b'inbox-capacity-offline-ok' not in raw or len(records)!=1:continue
        record=records[0]
        if record.get('scope')!='synthetic_snapshot_plus_real_durable_actor_and_session_not_AWS':continue
        fields=('snapshotBytes','snapshotRows','applied','preload','received','acknowledged','processed','checkpointed','finalBacklog','writes','maxPersistMs','peakRSSBytes','maxEventLoopDelayMs','readbackRows')
        metrics={key:record[key] for key in fields if type(record.get(key)) in (int,float)}
        load=record.get('load') or {}
        if isinstance(load,dict):
            for key,value in (('loadSent',load.get('sent')),('loadDurationMs',load.get('durationMs'))):
                if type(value) in (int,float):metrics[key]=value
        if pipeline_load_metrics_valid(metrics,proof):candidates.append((info.st_mtime_ns,log.name,metrics))
    if not candidates:return None
    _,name,metrics=max(candidates)
    return {'verified':True,'log':name,'proofSha256':proof_sha,'metrics':metrics}

def durable_ingress_log_summary(backup):
    path=backup/'durable-ingress-test.private.log'
    if not path.exists():return {'present':False}
    require(path.is_file() and not path.is_symlink() and path.stat().st_uid==os.geteuid() and not backup.is_symlink() and backup.stat().st_mode&0o077==0,'OFFLINE_LOG_NOT_PROTECTED')
    raw=read_tail(path)
    signals=[label for token,label in [(b'ERR_INPUT_TYPE_NOT_ALLOWED','worker_inherited_input_type'),(b'INBOX_CAPACITY_EXCEEDED','inbox_disk_reserve_unavailable'),(b'not durable ahead of processing','durable_ack_proof_failed'),(b'missing replay','durable_replay_proof_failed')] if token in raw]
    return {'present':True,'signals':signals,'privateLogSha256':hashlib.sha256(raw).hexdigest(),'rawLogPrinted':False}

def oom_restore_log_summary(backup,expected_log=None):
    path=backup/'oom-restore.private.log';current=False
    pointer=backup/'oom-restore.latest.json'
    if expected_log is not None:
        require(isinstance(expected_log,str) and re.fullmatch(r'oom-restore-attempt-[0-9a-f]{16,32}\.private\.log',expected_log),'OFFLINE_LOG_NAME_UNVERIFIED')
        path=backup/expected_log;current=True
    if (expected_log is None or not path.exists()) and pointer.exists():
        require(pointer.is_file() and not pointer.is_symlink() and pointer.stat().st_uid==os.geteuid() and pointer.stat().st_size<4096,'OFFLINE_LOG_POINTER_UNVERIFIED')
        name=json.loads(pointer.read_bytes()).get('name')
        require(isinstance(name,str) and re.fullmatch(r'oom-restore-attempt-[0-9a-f]{16}\.private\.log',name),'OFFLINE_LOG_NAME_UNVERIFIED')
        path=backup/name;current=True
    if not path.exists():return {'present':False}
    require(path.is_file() and not path.is_symlink() and path.stat().st_uid==os.geteuid() and not backup.is_symlink() and backup.stat().st_mode&0o077==0,'OFFLINE_LOG_NOT_PROTECTED')
    raw=read_tail(path);text=raw.decode(errors='replace').lower()
    signals=classify(raw)
    for token,label in [('memory_budget_exceeded','preventive_memory_budget_rejection'),('heap out of memory','node_heap_exhausted'),('invalid private','checkpoint_validation_failed'),('invalid saved trade','checkpoint_validation_failed'),('snapshot completo rechazado','preserved_snapshot_validation_failed'),('duplicate fixture','preserved_snapshot_inventory_invalid'),('fixture count limit','preserved_snapshot_inventory_invalid')]:
        if token in text:signals.append(label)
    permission_failures=[]
    decoded=raw.decode(errors='replace')
    for m in re.finditer(r"(?:EACCES|EPERM): permission denied, (open|scandir|mkdir|stat|access|readlink|copyfile) ['\"]([^'\"\n]{1,240})['\"]",decoded):
        path_value=m[2]
        if path_value=='/dev/null' or re.fullmatch(r'/recovery(?:/(?:trade-feed\.json[A-Za-z0-9_.-]*|\.full-snapshot-[A-Za-z0-9_-]{1,80}|response\.private\.json))*',path_value):
            permission_failures.append({'operation':m[1],'path':path_value,'code':'EACCES' if m[0].startswith('EACCES') else 'EPERM'})
    return {'present':True,'signals':sorted(set(signals)),'permissionFailures':permission_failures[-8:],'logMayContainEarlierAttempts':not current,'attemptLog':path.name,'requestedLog':expected_log,'requestedLogFound':(backup/expected_log).is_file() if expected_log else None,'logBytes':path.stat().st_size,'tailTruncated':path.stat().st_size>128*1024,'privateLogSha256':hashlib.sha256(raw).hexdigest(),'rawLogPrinted':False}

REHEARSAL_ACCESS_PROBE="const fs=require('node:fs');const result={uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),chain:[]};const safeCode=e=>['EACCES','EPERM','ENOENT','ELOOP','ENOTDIR'].includes(e.code)?e.code:'other';for(const key of ['uid','gid']){try{result[key+'Map']=fs.readFileSync('/proc/self/'+key+'_map','utf8').trim().split('\\n').map(line=>line.trim().split(/\\s+/).map(Number));}catch{}}for(const path of ['/','/recovery','/recovery/trade-feed.json']){try{const st=fs.lstatSync(path);const entry={path,uid:st.uid,gid:st.gid,mode:(st.mode&511).toString(8).padStart(4,'0'),symlink:st.isSymbolicLink(),kind:st.isDirectory()?'directory':st.isFile()?'file':'other'};if(st.isSymbolicLink()){const link=fs.readlinkSync(path);entry.target=link.startsWith('/recovery/')&&!link.includes('..')?link:'outside_rehearsal_not_followed';result.linkDetected=true;}result.chain.push(entry);}catch(e){result.chain.push({path,code:safeCode(e)});}}let fd;try{if(result.linkDetected)throw Object.assign(Error(),{code:'ELOOP'});fd=fs.openSync('/recovery/trade-feed.json',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);result.readBytes=fs.readSync(fd,Buffer.alloc(1),0,1,0);result.opened=result.readBytes===1;}catch(e){result.opened=false;result.code=safeCode(e);result.operation='open';result.path='/recovery/trade-feed.json';}finally{if(fd!==undefined)fs.closeSync(fd);}console.log(JSON.stringify(result));"

def rehearsal_host_id(value,ranges):
    if ranges is None:return value
    require(isinstance(ranges,list) and 0<len(ranges)<=16,'REHEARSAL_NAMESPACE_MAP_UNVERIFIED')
    matches=[]
    for row in ranges:
        require(isinstance(row,list) and len(row)==3 and all(type(n) is int and 0<=n<=4294967295 for n in row) and row[2]>0,'REHEARSAL_NAMESPACE_MAP_UNVERIFIED')
        if row[0]<=value<row[0]+row[2]:matches.append(row[1]+value-row[0])
    require(len(matches)==1,'REHEARSAL_NAMESPACE_ID_UNMAPPED');return matches[0]

def rehearsal_copy_permissions(backup,rehearsal,sources,identity):
    require(type(identity.get('uid')) is int and identity['uid']>0 and type(identity.get('gid')) is int and identity['gid']>0,'REHEARSAL_NONROOT_IDENTITY_UNVERIFIED')
    uid=rehearsal_host_id(identity['uid'],identity.get('uidMap'));gid=rehearsal_host_id(identity['gid'],identity.get('gidMap'))
    require(type(uid) is int and type(gid) is int and 0<uid<2**31 and 0<gid<2**31,'REHEARSAL_NONROOT_IDENTITY_UNVERIFIED')
    require(rehearsal.parent==backup and re.fullmatch('rehearsal-[0-9a-f]{24}',rehearsal.name),'REHEARSAL_SCOPE_UNVERIFIED')
    dirs={rehearsal};files=[]
    for src,dst,sha in sources:
        require(dst.is_relative_to(rehearsal) and dst!=src,'REHEARSAL_SCOPE_UNVERIFIED')
        require(dst.is_file() and not dst.is_symlink() and dst.stat().st_nlink==1 and (dst.stat().st_dev,dst.stat().st_ino)!=(src.stat().st_dev,src.stat().st_ino) and snapshot_file_hash(dst)==sha,'REHEARSAL_COPY_IDENTITY_UNVERIFIED')
        files.append(dst);parent=dst.parent
        while parent!=backup:dirs.add(parent);parent=parent.parent
    for directory in dirs:require(directory.is_dir() and not directory.is_symlink(),'REHEARSAL_DIRECTORY_UNVERIFIED')
    before=[{'path':'/recovery'+('/'+str(p.relative_to(rehearsal)) if p!=rehearsal else ''),'uid':p.stat().st_uid,'gid':p.stat().st_gid,'mode':format(p.stat().st_mode&0o777,'04o')} for p in sorted(dirs|set(files))]
    # Owner-only access inside the bind root. Host backup parent stays root/0700.
    # Avoid an unnecessary chown when the private copy already has the exact
    # container identity. On some host filesystems, even a same-owner chown is
    # rejected for an unprivileged test process. A differing owner still needs
    # an actual chown; failure remains fatal, and the checks below stay strict.
    for directory in dirs:
        st=directory.stat()
        if (st.st_uid,st.st_gid)!=(uid,gid):os.chown(directory,uid,gid)
        os.chmod(directory,0o700)
    for path in files:
        st=path.stat()
        if (st.st_uid,st.st_gid)!=(uid,gid):os.chown(path,uid,gid)
        os.chmod(path,0o600)
    for directory in dirs:require(directory.stat().st_uid==uid and directory.stat().st_gid==gid and directory.stat().st_mode&0o777==0o700,'REHEARSAL_DIRECTORY_ACCESS_UNVERIFIED')
    for path in files:require(path.stat().st_uid==uid and path.stat().st_gid==gid and path.stat().st_mode&0o777==0o600,'REHEARSAL_FILE_ACCESS_UNVERIFIED')
    for src,dst,sha in sources:require(snapshot_file_hash(dst)==sha and snapshot_file_hash(src)==sha,'REHEARSAL_CONTENT_CHANGED_DURING_PERMISSION_FIX')
    return {'containerIdentity':identity,'hostOwner':{'uid':uid,'gid':gid},'before':before[:80],'pathsTotal':len(before),'directoriesMode':'0700','filesMode':'0600','scope':'rehearsal_copy_only','backupParentChanged':False}

def checkpoint_build_log_summary(backup):
    path=backup/'checkpoint-fix-build.private.log'
    if not path.exists():return {'present':False}
    require(path.is_file() and not path.is_symlink() and path.stat().st_uid==os.geteuid() and not backup.is_symlink() and backup.stat().st_mode&0o077==0,'BUILD_LOG_NOT_PROTECTED')
    raw=read_tail(path);records=[]
    # Fixed phrases only: registry URLs, environment values and arbitrary paths
    # in Docker stderr must never be copied into the report.
    rules=[
      (r'pull access denied for sha256','IMAGE_ID_INTERPRETED_AS_REPOSITORY','pull access denied for sha256 [image ID redacted]'),
      (r'failed to resolve source metadata for (?:docker\.io/library/)?sha256:','IMAGE_ID_SOURCE_RESOLUTION_FAILED','failed to resolve source metadata for sha256:[image ID]'),
      (r'(?:sha256[^\n]*pull access denied|repository does not exist)','BASE_REPOSITORY_UNAVAILABLE','base repository does not exist or requires authorization'),
      (r'no space left on device','DISK_FULL','no space left on device'),
      (r'read-only file system','READ_ONLY_FILESYSTEM','read-only file system'),
      (r'permission denied','PERMISSION_DENIED','permission denied'),
      (r'cannot connect to the docker daemon','DOCKER_DAEMON_UNAVAILABLE','cannot connect to the Docker daemon'),
      (r'(?:failed to (?:compute cache key|calculate checksum)|not found)[^\n]*overlay|overlay[^\n]*(?:not found|no such file)','OVERLAY_NOT_FOUND','build overlay not found or checksum unavailable'),
      (r'failed to read dockerfile|cannot locate specified dockerfile','DOCKERFILE_UNAVAILABLE','failed to read Dockerfile'),
      (r'dockerfile parse error','DOCKERFILE_PARSE_ERROR','Dockerfile parse error'),
      (r'network is unreachable|i/o timeout|tls handshake timeout','BUILD_NETWORK_FAILURE','network unavailable or timed out'),
    ]
    for number,line in enumerate(raw.decode(errors='replace').splitlines(),1):
        for pattern,reason,message in rules:
            if re.search(pattern,line,re.I):records.append({'tailLine':number,'reason':reason,'messageSanitized':message})
    contexts=[]
    for directory in sorted(backup.glob('checkpoint-fix-*')):
        if not re.fullmatch('checkpoint-fix-(?:tagged-)?[0-9a-f]{24}',directory.name):continue
        require(directory.is_dir() and not directory.is_symlink(),'BUILD_CONTEXT_UNVERIFIED')
        dockerfile=directory/'Dockerfile';require(dockerfile.is_file() and not dockerfile.is_symlink() and dockerfile.stat().st_size<4096,'BUILD_DOCKERFILE_UNVERIFIED')
        source=dockerfile.read_text();first=source.splitlines()[0] if source else ''
        match=re.fullmatch(r'FROM (sha256:[0-9a-f]{64}|adl-partition-base:[0-9a-f]{64})',first)
        contexts.append({'context':str(directory),'dockerfileSha256':hashlib.sha256(source.encode()).hexdigest(),'baseReference':match[1] if match else 'unrecognized_not_printed','command':['docker','build',*(['--builder','default'] if 'tagged-' in directory.name else []),'--network','none','--pull=false','-t','adl-worker-partitioned:'+directory.name[-24:],str(directory)]})
    return {'present':True,'stage':'partitioned_upgrade.checkpoint_parser_image','logBytes':path.stat().st_size,'tailTruncated':path.stat().st_size>128*1024,'records':records[-12:],'recognizedError':bool(records),'contexts':contexts[-4:],'privateLogSha256':hashlib.sha256(raw).hexdigest(),'rawLogPrinted':False,'readOnly':True}

def rehearsal_heap_evidence(raw):
    text=raw.decode(errors='replace');gc=[]
    pattern=r'([0-9]+) ms: (Scavenge|Mark-Compact|Mark-sweep|Mark-Sweep)[^\n]*?([0-9]+(?:\.[0-9]+)?) \(([0-9]+(?:\.[0-9]+)?)\) -> ([0-9]+(?:\.[0-9]+)?) \(([0-9]+(?:\.[0-9]+)?)\) MB'
    for m in re.finditer(pattern,text):gc.append({'elapsedMs':int(m[1]),'kind':m[2],'usedBeforeMiB':float(m[3]),'allocatedBeforeMiB':float(m[4]),'usedAfterMiB':float(m[5]),'allocatedAfterMiB':float(m[6])})
    fatal=[label for phrase,label in [('Reached heap limit','reached_heap_limit'),('Ineffective mark-compacts near heap limit','ineffective_gc_near_heap_limit'),('JavaScript heap out of memory','javascript_heap_out_of_memory'),('ERR_WORKER_OUT_OF_MEMORY','worker_thread_heap_out_of_memory')] if phrase in text]
    subsystems=[name for token,name in [('JsonParser','json_parse'),('JsonStringifier','json_serialization'),('SlowFlatten','string_flatten'),('StringBuilder','string_builder'),('NewFixedArray','array_allocation'),('HeapAllocator','heap_allocation')] if token in text]
    phases=[]
    allowed=('checkpoint.scan','checkpoint.rebuild','checkpoint.sidecar','checkpoint.commit','checkpoint.complete','checkpoint.serialize','projection.build','snapshot.validate','snapshot.apply','snapshot.finalize','projection.serialize','projection.readback','complete')
    for line in text.splitlines():
        try:record=json.loads(line)
        except Exception:continue
        if not isinstance(record,dict) or record.get('operation')!='offline.memory' or record.get('stage') not in allowed:continue
        phases.append({'stage':record['stage'],**{k:v for k,v in record.items() if k in ('rows','elapsedMs','heapUsedBytes','heapLimitBytes','rssBytes','maxRSSBytes','sampledHeapPeakBytes','externalBytes','arrayBufferBytes','heapTotalBytes') and type(v) is int and 0<=v<2**53}})
        counts=record.get('indexCounts')
        if isinstance(counts,dict):phases[-1]['indexCounts']={k:v for k,v in counts.items() if k in ('stateRows','markets','bets','betAt','betOrder','snapshotBets','freshBets','settlementAudit','timestampRecovery') and type(v) is int and 0<=v<2**53}
    return {'fatalSignals':fatal,'gcSamples':gc[-8:],'maxLoggedHeapUsedMiB':max((g['usedBeforeMiB'] for g in gc),default=None),'nativeSubsystemHints':subsystems,'stageAtFailure':phases[-1]['stage'] if phases else 'not_recorded_unless_JS_stack_identifies_source','checkpointBaseline':next((p for p in phases if p['stage']=='checkpoint.complete'),None),'applicationStart':next((p for p in phases if p['stage']=='snapshot.apply'),None),'phaseSamples':phases[-12:],'maxObservedRSSBytes':max((p.get('maxRSSBytes',0) for p in phases),default=None),'maxSampledHeapBytes':max((p.get('sampledHeapPeakBytes',0) for p in phases),default=None),'peakRSSBytes':None,'effectiveHeapLimitBytes':phases[0].get('heapLimitBytes') if phases else None,'metricsLimit':'GC samples are not RSS or a measured heap limit. Exit code alone is not Docker OOM proof.'}

def rehearsal_memory_configuration(entry,backup,log_name):
    memory_limit=candidate_memory(entry)
    result={'rehearsalInvocation':{'containerMemoryLimitBytes':memory_limit,'nodeMaxOldSpaceSizeMiB':partition_heap_mib(entry),'source':'executor_arguments_not_preserved_container_inspect','containerRemovedAfterExit':True},'intendedWorker':{'containerMemoryLimitBytes':memory_limit,'nodeMaxOldSpaceSizeMiB':partition_heap_mib(entry)},'effectiveRehearsalHeapLimitBytes':None,'rehearsalOOMKilled':None,'effectiveMetricsRecorded':False}
    recorded=rehearsal_heap_evidence(read_tail(backup/log_name))
    result['effectiveRehearsalHeapLimitBytes']=recorded.get('effectiveHeapLimitBytes');result['effectiveMetricsRecorded']=bool(recorded.get('phaseSamples'))
    image=entry.get('image')
    if not isinstance(image,str) or not re.fullmatch('adl-worker-partitioned:[0-9a-f]{24}',image):result['imageIdentityVerified']=False;return result
    image_info=json.loads(run(['docker','image','inspect',image]))[0]
    require((image_info.get('Config',{}).get('Labels') or {}).get('eu.adl.partitioned.patch')==entry.get('digest'),'REHEARSAL_IMAGE_IDENTITY_UNVERIFIED')
    result['imageId']=image_info['Id'];result['imageIdentityVerified']=True
    options=next((x.split('=',1)[1] for x in image_info.get('Config',{}).get('Env',[]) if x.startswith('NODE_OPTIONS=')),None)
    result['imageDefaultHeapMiB']=[int(n) for n in re.findall(r'--max[-_]old[-_]space[-_]size(?:=|\s+)([0-9]{1,6})',options or '')]
    try:
        meta=json.loads((SECURE/'deployment.json').read_bytes());worker=model(partition_base(meta))['services']['worker']
        result['currentComposeWorker']={'memoryLimitBytes':snapshot_memory_bytes(worker.get('mem_limit')),'nodeMaxOldSpaceSizeMiB':[int(n) for n in re.findall(r'--max[-_]old[-_]space[-_]size(?:=|\s+)([0-9]{1,6})',(worker.get('environment') or {}).get('NODE_OPTIONS',''))]}
    except Exception:result['currentComposeWorker']={'verified':False}
    user=image_info.get('Config',{}).get('User')
    if user=='node' or isinstance(user,str) and re.fullmatch(r'[1-9][0-9]{0,9}(?::[1-9][0-9]{0,9})?',user):
        probe="const fs=require('node:fs'),v8=require('node:v8');let limit=null;for(const p of ['/sys/fs/cgroup/memory.max','/sys/fs/cgroup/memory/memory.limit_in_bytes']){try{const n=Number(fs.readFileSync(p,'utf8').trim());if(Number.isSafeInteger(n)&&n>0)limit=n;break}catch{}}const m=process.memoryUsage();console.log(JSON.stringify({heapLimitBytes:v8.getHeapStatistics().heap_size_limit,heapUsedBytes:m.heapUsed,rssBytes:m.rss,cgroupLimitBytes:limit,uid:process.getuid(),gid:process.getgid()}))"
        try:
            metrics=json.loads(run(['docker','run','--rm','--network','none','--read-only','--memory',str(memory_limit),'--cpus','2','--user',user,'--entrypoint','node',image_info['Id'],'--max-old-space-size='+str(partition_heap_mib(entry)),'-e',probe],timeout=30))
            result['sameConfigurationProbe']={k:v for k,v in metrics.items() if k in ('heapLimitBytes','heapUsedBytes','rssBytes','cgroupLimitBytes','uid','gid') and type(v) is int and 0<=v<2**53}
            result['configurationProbeStarted']=True;result['configurationProbeLimit']='Fresh diagnostic process; startup RSS is not failed rehearsal peak. No data mounted or restored.'
        except Exception:result['configurationProbeVerified']=False
    # Read bounded retained Docker events for this immutable image near the log's
    # final write. No rehearsal container was retained; these are candidates only.
    end=int((backup/log_name).stat().st_mtime)+5
    try:
        data=run(['docker','events','--since',str(end-905),'--until',str(end),'--filter','type=container','--filter','image='+image_info['Id'],'--format','{{json .}}'],timeout=20)
        events=[]
        for line in data.decode(errors='replace').splitlines()[-256:]:
            try:row=json.loads(line)
            except Exception:continue
            action=row.get('Action') or row.get('status');actor=row.get('Actor') or {};cid=actor.get('ID') or row.get('id');attrs=actor.get('Attributes') or {}
            if action not in ('oom','die') or not isinstance(cid,str) or not re.fullmatch('[0-9a-f]{12,64}',cid):continue
            event={'action':action,'containerId':cid,'unixTime':row.get('time') if type(row.get('time')) is int else None}
            code=attrs.get('exitCode')
            if isinstance(code,str) and re.fullmatch('[0-9]{1,3}',code):event['exitCode']=int(code)
            events.append(event)
        result['nearbyImageEvents']=events[-16:];result['eventCorrelation']='candidate_only_no_rehearsal_container_id_recorded'
    except Exception:result['nearbyImageEventsUnavailable']=True
    return result

def preserved_rehearsal_report(expected_backup,expected_log=None):
    backup=Path(expected_backup)
    require(backup.parent==BACKUPS and re.fullmatch(r'adl-partitioned-upgrade-[A-Za-z0-9_-]{1,80}',backup.name) and not backup.is_symlink() and backup.is_dir() and backup.stat().st_uid==os.geteuid() and backup.stat().st_mode&0o077==0,'REHEARSAL_BACKUP_UNVERIFIED')
    receipts=[]
    for path in SECURE.glob('partitioned-upgrade-*.json'):
        require(path.is_file() and not path.is_symlink() and path.stat().st_uid==os.geteuid() and path.stat().st_size<=1024*1024,'REHEARSAL_RECEIPT_UNVERIFIED')
        entry=json.loads(path.read_bytes())
        if entry.get('backup')==str(backup):receipts.append(entry)
    superseded={r['checkpointParserSourceDigest'] for r in receipts if r.get('checkpointParserSourceDigest')}
    receipts=[r for r in receipts if r.get('digest') not in superseded]
    require(len(receipts)==1,'REHEARSAL_RECEIPT_NOT_UNIQUE')
    entry=receipts[0];summary=oom_restore_log_summary(backup,expected_log)
    raw_bytes=read_tail(backup/summary['attemptLog']) if summary['present'] else b''
    require(not summary['present'] or hashlib.sha256(raw_bytes).hexdigest()==summary['privateLogSha256'],'REHEARSAL_LOG_CHANGED_DURING_REPORT')
    raw=raw_bytes.decode(errors='replace')
    # Only source-defined validator codes/paths/types escape the private log.
    allowed={'invalid_checkpoint_object','token_size_limit','invalid_json','truncated_json','truncated_string','invalid_root_key','duplicate_or_invalid_root_key','invalid_root_colon','body_not_array','invalid_body_separator','invalid_root_separator','trailing_comma','trailing_json','invalid_header_or_application_error','header_status_rejected','root_not_object','row_not_object','invalid_fixture','invalid_markets_shape','invalid_timestamp','item_size_limit','nesting_limit','unsupported_content_encoding'}
    details=sorted(set(re.findall(r"(?:detail[\"']?\s*:\s*|Snapshot completo rechazado: )['\"]?([a-z_]+)",raw))&allowed)
    fields=sorted(set(re.findall(r"fieldPath[\"']?\s*:\s*['\"]((?:Markets|Bets)(?:\[\d{1,6}\])?(?:\.(?:Bets|Markets))?)['\"]",raw)))
    types=sorted(set(re.findall(r"actualType[\"']?\s*:\s*['\"](null|array|object|string|number|boolean|undefined)['\"]",raw)))
    fixtures=sorted(set(int(x) for x in re.findall(r"fixtureId[\"']?\s*:\s*([1-9][0-9]{0,15})",raw)))[:8]
    frames=[{'source':m[0],'line':int(m[1]),'column':int(m[2])} for m in re.findall(r'/app/(apps/worker/src/[a-zA-Z0-9_.-]+\.(?:mjs|ts|js)|packages/feed-store/src/index\.ts):(\d{1,7}):(\d{1,7})',raw)][-16:]
    checkpoint=any(f['source'].endswith('/persistence.ts') for f in frames)
    origin='checkpoint_restore' if checkpoint else 'snapshot_application' if any(f['source'].endswith('/state.ts') for f in frames) else 'projection_serialization' if any(f['source'].startswith('packages/feed-store/') for f in frames) else 'snapshot_parser_or_conversion' if any(f['source'].endswith('/full-snapshot.ts') for f in frames) else 'not_proven'
    exceptions=sorted(set(re.findall(r'\b(OperationError|SyntaxError|TypeError|RangeError|Error):',raw)))
    known_messages=[message for message in ['Invalid checkpoint envelope','Invalid saved TRADE state; original file preserved','Unsupported TRADE checkpoint; original file preserved','Invalid outright checkpoint; original file preserved','Duplicate outright checkpoint identity','Private checkpoint incremental memory guard; original preserved','duplicate fixture','fixture count limit'] if message in raw]
    return {'backup':str(backup),'receiptPhase':entry.get('phase') if entry.get('phase') in ('prepared','stopped','configured','activated','rolled_back_stopped') else 'unknown','offlineRestoreVerified':entry.get('oomRestoreVerified') is True,'snapshotMemoryVerified':entry.get('snapshotMemoryVerified') is True,'preservedSpoolHash':entry.get('preservedSpoolHash') if re.fullmatch('[0-9a-f]{64}',str(entry.get('preservedSpoolHash',''))) else None,'failureOrigin':origin,'heapEvidence':rehearsal_heap_evidence(raw_bytes),'memoryConfiguration':rehearsal_memory_configuration(entry,backup,summary['attemptLog']) if summary['present'] else None,'exceptionTypes':exceptions,'knownExceptionMessages':known_messages,'validationDetails':details,'fieldPaths':fields,'actualTypes':types,'fixtureIds':fixtures,'stackFrames':frames,'privateLog':summary,'checkpointImageBuild':checkpoint_build_log_summary(backup),'distributionState':'not_queried_saved_stop_evidence_only','readOnly':True,'providerRequests':0,'workerRestarted':False}

def archive_oom_locks(directory,backup,progress,workers):
    verified_oom=progress.get('oomContainerId') and len(workers)==1 and workers[0]['id']==progress['oomContainerId'] and not workers[0]['running'] and workers[0].get('oomKilled') is True and workers[0].get('exitCode')==137
    verified_v8_oom=progress.get('v8HeapOomRepair') is True and progress.get('oomContainerId') and len(workers)==1 and workers[0]['id']==progress['oomContainerId'] and not workers[0]['running'] and workers[0].get('oomKilled') is False and workers[0].get('exitCode')==134
    if verified_v8_oom:verify_live_v8_heap_oom_identity(workers[0],{'snapshotMemoryRepair':True,'v8HeapOomRepair':True,'expectedOomPrefix':progress.get('expectedOomPrefix')})
    verified_exit=progress.get('verifiedExitContainerId') and len(workers)==1 and workers[0]['id']==progress['verifiedExitContainerId'] and not workers[0]['running'] and progress.get('preExitProof',{}).get('verified') is True and progress.get('verifiedExitSignal',{}).get('status') in ('docker_accepted','exit_observed_after_intent')
    require(verified_oom or verified_v8_oom or verified_exit,'OOM_OR_VERIFIED_EXIT_LOCK_OWNER_NOT_CONFIRMED')
    # Verify no other running container can write this feed volume, not merely its Compose service label.
    ids=run(['docker','ps','-q']).decode().split()
    for item in json.loads(run(['docker','inspect',*ids])) if ids else []:
        require(not any(m.get('RW') and m.get('Type')=='volume' and Path(m.get('Source',''))==directory for m in item.get('Mounts',[])),'OTHER_FEED_VOLUME_WRITER_PRESENT')
    paths=[directory/'trade-feed.json.lock',*directory.glob('trade-feed.json*.reclaim'),*directory.glob('trade-feed.json.snapshot-*.lock')]
    for lock in paths:
        if not lock.exists():continue
        require(lock.is_file() and not lock.is_symlink() and lock.stat().st_size<=4096,'OOM_LOCK_FORMAT_UNVERIFIED')
        owner=lock.read_bytes();require(re.fullmatch(rb'[1-9][0-9]{0,9}',owner) is not None or owner==b'' and (lock.name.endswith('.reclaim') or lock.name.startswith('trade-feed.json.snapshot-')),'OOM_LOCK_OWNER_FORMAT_UNVERIFIED')
        target=backup/('oom-preserved-'+lock.name)
        if not target.exists():private(target,owner)
        require(target.read_bytes()==owner,'OOM_LOCK_BACKUP_MISMATCH')
        # Container namespace is dead; preserve original inode by moving, never reclaim a live owner.
        archived=backup/('oom-archived-'+lock.name);require(not archived.exists(),'OOM_LOCK_ARCHIVE_ALREADY_PRESENT')
        require(not any(w['running'] for w in states('worker')),'WORKER_STARTED_DURING_OOM_RECOVERY')
        identity=lock.stat()
        try:os.rename(lock,archived)
        except OSError as error:
            import errno
            if error.errno!=errno.EXDEV:raise
            private(archived,owner);require(archived.read_bytes()==owner,'OOM_CROSS_DEVICE_ARCHIVE_MISMATCH')
            current=lock.lstat();require(current.st_ino==identity.st_ino and current.st_dev==identity.st_dev and lock.read_bytes()==owner,'OOM_LOCK_CHANGED_DURING_ARCHIVE');lock.unlink()
    parent=os.open(backup,os.O_RDONLY)
    try:os.fsync(parent)
    finally:os.close(parent)
    fd=os.open(directory,os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)

def verify_oom_inboxes(directory):
    import sqlite3
    result=[]
    for path in sorted(directory.glob('trade-feed.json.*.inbox.sqlite')):
        require(path.is_file() and not path.is_symlink(),'INBOX_IDENTITY_UNVERIFIED')
        db=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)
        try:
            db.execute('PRAGMA query_only=ON')
            require(db.execute('PRAGMA quick_check').fetchall()==[('ok',)],'DURABLE_INBOX_INTEGRITY_FAILED')
            count=db.execute('SELECT count(*) FROM inbox').fetchone()[0]
            result.append({'lane':'prematch' if '.prematch.' in path.name else 'inplay','pendingRows':count,'integrity':'ok'})
        finally:db.close()
    require(len(result)==2,'EXPECTED_BOTH_DURABLE_INBOXES');return result

def container_process_tree(container):
    info=json.loads(run(['docker','inspect',container]))[0];root=info.get('State',{}).get('Pid')
    raw=run(['docker','top',container,'-eo','pid,ppid,stat,comm'],timeout=15).decode()
    require(len(raw)<1024*1024,'PROCESS_TREE_SIZE_LIMIT');rows=[]
    for line in raw.splitlines()[1:]:
        fields=line.split(None,3);require(len(fields)==4 and fields[0].isdigit() and fields[1].isdigit(),'PROCESS_TREE_PARSE_FAILED')
        pid,ppid=int(fields[0]),int(fields[1]);name=Path(fields[3]).name
        row={'hostPid':pid,'parentHostPid':ppid,'state':fields[2],'executable':name if re.fullmatch('[A-Za-z0-9_.-]{1,80}',name) else 'other','isContainerInit':pid==root}
        try:
            for stat_line in Path('/proc/'+str(pid)+'/status').read_text().splitlines():
                key,_,value=stat_line.partition(':')
                if key in ('NSpid','VmRSS','Threads'):row[key]=value.strip()
        except OSError:row['exitedDuringObservation']=True
        rows.append(row)
    require(len(rows)<=512 and any(r['hostPid']==root for r in rows),'PROCESS_TREE_ROOT_UNVERIFIED')
    return {'containerId':container,'initHostPid':root,'processes':rows,'nodeProcesses':[r for r in rows if r['executable'] in ('node','nodejs')],'completeContainerProcessList':True}

def write_recovery_attempt_report(path,data):
    # Preserve legacy reports and all previous attempts. Never overwrite evidence.
    require(path.name in ('offline-rehearsal-disk-plan.json','pre-exit-disk-plan.json'),'RECOVERY_REPORT_SCOPE_UNVERIFIED')
    if path.exists() or path.is_symlink():
        info=path.lstat()
        require(path.is_file() and not path.is_symlink() and info.st_uid==os.geteuid() and info.st_nlink==1 and info.st_mode&0o077==0,'RECOVERY_REPORT_IDENTITY_UNVERIFIED')
    attempt=path.with_name(path.stem+'-attempt-'+time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())+'-'+os.urandom(8).hex()+'.json')
    private(attempt,data)
    fd=os.open(path.parent,os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)
    return attempt

def recovery_exception_details(error):
    import traceback,errno
    kind=type(error).__name__
    details={'exceptionType':kind if re.fullmatch('[A-Za-z][A-Za-z0-9_]{0,79}',kind) else 'other','stack':[{'file':Path(frame.filename).name if re.fullmatch('[A-Za-z0-9_.<>-]{1,100}',Path(frame.filename).name) else 'helper','line':frame.lineno,'function':frame.name if re.fullmatch('[A-Za-z0-9_<>]{1,100}',frame.name) else 'other'} for frame in traceback.extract_tb(error.__traceback__)[-12:]],'exceptionMessagePrinted':False}
    if isinstance(error,OSError):details['osCode']=errno.errorcode.get(error.errno,'UNKNOWN');details['errno']=error.errno
    if isinstance(error,subprocess.CalledProcessError):details['childExitCode']=error.returncode
    if isinstance(error,FileExistsError) and Path(str(error.filename)).name in ('offline-rehearsal-disk-plan.json','pre-exit-disk-plan.json'):details['operation']='exclusive_create_existing_disk_report';details['file']=Path(error.filename).name
    return details

def save_upgrade_exception(backup,error,operation):
    import traceback
    details=recovery_exception_details(error)
    details['operation']=operation if re.fullmatch('[a-z_.]{1,120}',str(operation)) else 'partitioned_upgrade.unknown'
    if backup is None:return details
    try:
        info=backup.lstat()
        require(backup.is_dir() and not backup.is_symlink() and info.st_uid==os.geteuid() and info.st_mode&0o077==0,'EXCEPTION_LOG_BACKUP_UNVERIFIED')
        log=backup/('upgrade-exception-'+time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())+'-'+os.urandom(8).hex()+'.private.log')
        private(log,json.dumps({'operation':details['operation'],'exceptionType':type(error).__name__,'errno':getattr(error,'errno',None),'traceback':''.join(traceback.format_exception(type(error),error,error.__traceback__))}).encode())
        details['privateLog']=log.name
    except Exception as logging_error:
        details['exceptionLogSaved']=False
        details['loggingFailure']=recovery_exception_details(logging_error)
    return details

def streamed_rehearsal_run(command,timeout,log):
    require(command[:2]==['docker','run'],'REHEARSAL_COMMAND_UNVERIFIED')
    name='adl-offline-check-'+os.urandom(8).hex();args=command[:2]+['--name',name]+command[2:]
    began=time.monotonic();last=-10
    with log.open('ab') as target:
        child=subprocess.Popen(args,stdout=target,stderr=subprocess.STDOUT)
        while child.poll() is None:
            elapsed=time.monotonic()-began
            if elapsed>=timeout:
                subprocess.run(['docker','kill',name],capture_output=True,timeout=20,check=False)
                child.wait(timeout=30);raise subprocess.TimeoutExpired(args,timeout)
            if elapsed-last>=10:
                last=elapsed;latest={}
                for line in read_tail(log).decode(errors='replace').splitlines():
                    try:r=json.loads(line)
                    except ValueError:continue
                    if isinstance(r,dict) and r.get('operation')=='offline.memory' and re.fullmatch('[a-z_.]{1,50}',str(r.get('stage',''))):latest=r
                    elif isinstance(r,dict) and r.get('operation')=='pipeline.offline':
                        latest={'stage':'pipeline.load','rows':r.get('applied'),'validatedRows':r.get('validated'),'rssBytes':r.get('rssBytes'),'heapUsedBytes':r.get('heapUsedBytes'),**{k:v for k,v in (r.get('metrics') or {}).items() if k in ('received','acknowledged','processed','checkpointed','processingBacklog','oldestProcessingAgeMs')}}
                    elif isinstance(r,dict) and r.get('operation')=='pipeline.offline.readback':latest={**r,'stage':'pipeline.readback'}
                emit(operation='cutover.aws',stage='partitioned_upgrade.rehearsal_progress',status='running',elapsedSeconds=round(elapsed),rehearsalStage=latest.get('stage','starting'),metrics={k:v for k,v in latest.items() if k in ('rows','validatedRows','heapUsedBytes','heapLimitBytes','rssBytes','maxRSSBytes','received','acknowledged','processed','checkpointed','processingBacklog','oldestProcessingAgeMs') and type(v) is int},workerStarted=False,posnetChanged=False)
            time.sleep(1)
    require(log.stat().st_size<=8*1024**2,'REHEARSAL_LOG_SIZE_LIMIT')
    output=log.read_bytes()
    if child.returncode:raise subprocess.CalledProcessError(child.returncode,args,output=output)
    return output

def reuse_pre_exit_restore(progress,backup,directory,image_info,save):
    proof=progress.get('preExitProof') or {}
    if proof.get('verified') is not True:return False
    if progress.get('checkpointParserSourceDigest') and proof.get('imageDigest')!=progress.get('digest'):
        emit(operation='cutover.aws',stage='partitioned_upgrade.recovery_proof_reuse',status='not_reused',reason='DERIVED_IMAGE_REQUIRES_OWN_REHEARSAL',workerStarted=False,posnetChanged=False);return False
    if any(directory.glob('.full-snapshot-*/response.private.json')):
        emit(operation='cutover.aws',stage='partitioned_upgrade.recovery_proof_reuse',status='not_reused',reason='PRESERVED_HTTP_SPOOL_REQUIRES_DISTINCT_REHEARSAL',workerStarted=False,posnetChanged=False)
        return False
    require(progress.get('verifiedExitContainerId')==progress.get('oldContainer') and progress.get('verifiedExitSignal',{}).get('status') in ('docker_accepted','exit_observed_after_intent'),'RESTORE_REUSE_CONTAINER_EXIT_UNVERIFIED')
    require(proof.get('proofCodeHash')==hashlib.sha256(PRE_EXIT_REPLAY_PROOF.encode()).hexdigest(),'RESTORE_REUSE_PROOF_CODE_CHANGED')
    require((image_info.get('Config',{}).get('Labels') or {}).get('eu.adl.partitioned.patch')==progress.get('digest'),'RESTORE_REUSE_PREPARED_IMAGE_CHANGED')
    output=Path(proof.get('output',''));original=Path(proof.get('originalCopy',''))
    require(output.parent==backup and original.parent==backup and output.is_dir() and original.is_dir() and not output.is_symlink() and not original.is_symlink(),'RESTORE_REUSE_PATH_UNVERIFIED')
    def checked(path,sha):
        require(re.fullmatch('[0-9a-f]{64}',str(sha)) and path.is_file() and not path.is_symlink() and snapshot_file_hash(path)==sha,'RESTORE_REUSE_ARTIFACT_HASH_MISMATCH')
    hashes=proof.get('sourceHashes') or {};required={'trade-feed.json','trade-feed.json.regular-checkpoint.json','trade-feed.json.prematch.inbox.sqlite','trade-feed.json.inplay.inbox.sqlite'}
    require(required<=set(hashes),'RESTORE_REUSE_SOURCE_SET_INCOMPLETE')
    for name,sha in hashes.items():
        require(Path(name).name==name,'RESTORE_REUSE_SOURCE_NAME_UNVERIFIED');checked(original/name,sha)
        if name.endswith('.inbox.sqlite-shm'):continue # SQLite shared-memory cache is not a committed record.
        require(progress.get('dataBackupHashes',{}).get(name)==sha,'RESTORE_REUSE_CURRENT_BACKUP_CHANGED');checked(backup/name,sha);checked(directory/name,sha)
    for name,key in [('receipt.json','receiptHash'),('readback.json','readbackHash'),('projection.json','projectionHash'),('projection.json.regular-checkpoint.json','regularHash')]:checked(output/name,proof.get(key))
    require((output/'receipt.json').stat().st_size<1024*1024 and (output/'readback.json').stat().st_size<1024*1024,'RESTORE_REUSE_RECEIPT_SIZE_LIMIT')
    receipt=json.loads((output/'receipt.json').read_bytes());readback=json.loads((output/'readback.json').read_bytes())
    require(readback.get('verified') is True and readback.get('stateRows')==receipt.get('stateRows')==proof.get('stateRows') and readback.get('stateSha256')==receipt.get('stateSha256') and readback.get('projectionSha256')==receipt.get('sha256')==proof.get('projectionHash'),'RESTORE_REUSE_ROUNDTRIP_RECEIPT_MISMATCH')
    inboxes=receipt.get('inboxes',[])
    require(len(inboxes)==2 and {r.get('lane') for r in inboxes}=={'prematch','inplay'} and all(type(r.get('pendingCommittedRows')) is int and r['pendingCommittedRows']>=0 and r['pendingCommittedRows']==r.get('replayedRows') and re.fullmatch('[0-9a-f]{64}',str(r.get('rawRecordSha256'))) for r in inboxes),'RESTORE_REUSE_INBOX_REPLAY_UNVERIFIED')
    free=shutil.disk_usage(backup).free;require(free>=4*1024**3,'RESTORE_REUSE_ACTIVATION_DISK_HEADROOM_INSUFFICIENT')
    progress.update(oomRestoreVerified=True,projectionReadbackVerified=True,rehearsalCopyVerified=True,preservedSpoolRehearsed=False)
    progress['restoreProofReused']={'output':str(output),'receiptHash':proof['receiptHash'],'readbackHash':proof['readbackHash'],'reason':'same_prepared_image_same_committed_input_full_replay_roundtrip_verified'};save(progress)
    emit(operation='cutover.aws',stage='partitioned_upgrade.recovery_proof_reuse',status='verified',rows=proof['stateRows'],inboxCount=2,freeDiskBytes=free,requiredFreeBytes=4*1024**3,newDataCopies=0,newProjectionWrites=0,backupsRemoved=0,workerStarted=False,posnetChanged=False)
    return True

def offline_rehearsal_disk_reserve(input_bytes,partial_bytes,public_bytes,regular_bytes,progress):
    measured_pipeline=(progress.get('pipelineRepair') is True and progress.get('pipelineLoadVerified') is True and progress.get('snapshotMemoryRepair') is True and progress.get('livePersistenceRepair') is True)
    if progress.get('v8HeapOomRepair') is True or measured_pipeline:
        require(public_bytes>0 and regular_bytes>0,'MEASURED_REHEARSAL_OUTPUT_BASELINE_MISSING')
        measured_peak=public_bytes+regular_bytes
        output=max(measured_peak*2,partial_bytes*2)
        return output,2*1024**3,'phased peak: exact restore inputs are unlinked from the isolated rehearsal copy after restore/snapshot consumption and before serialization; output reserve is two times measured public plus private checkpoint bytes with an equal growth reserve; 4 GiB safety/activation reserve plus 2 GiB explicit execution margin'
    return max(input_bytes*8,partial_bytes*2),0,'conservative planning reserve, not measured complete serialization peak'

def offline_rehearsal_disk_plan(backup,sources,progress,digest):
    output=backup/('projection-rehearsal-'+digest[:24])
    require(not output.is_symlink(),'REHEARSAL_OUTPUT_PATH_UNSAFE')
    partial=output/'projection.json';receipt=output/'receipt.json'
    input_bytes=sum(src.stat().st_size for src,dst,sha in sources)
    missing=sum(src.stat().st_size for src,dst,sha in sources if not dst.exists())
    partial_bytes=partial.stat().st_size if partial.is_file() and not partial.is_symlink() else 0
    failed_output_bytes=partial_bytes
    # Incomplete output is a lower bound, not the required final output size.
    measured_pipeline=(progress.get('pipelineRepair') is True and progress.get('pipelineLoadVerified') is True and progress.get('snapshotMemoryRepair') is True and progress.get('livePersistenceRepair') is True)
    if progress.get('v8HeapOomRepair') is True or measured_pipeline:
        public=backup/'trade-feed.json';regular=backup/'trade-feed.json.regular-checkpoint.json'
        require(public.is_file() and not public.is_symlink() and regular.is_file() and not regular.is_symlink(),'MEASURED_REHEARSAL_OUTPUT_BASELINE_MISSING')
        output_reserve,execution_margin,budget_basis=offline_rehearsal_disk_reserve(input_bytes,partial_bytes,public.stat().st_size,regular.stat().st_size,progress)
    else:output_reserve,execution_margin,budget_basis=offline_rehearsal_disk_reserve(input_bytes,partial_bytes,0,0,progress)
    safety_reserve=4*1024**3
    required=max(missing,output_reserve)+safety_reserve+execution_margin
    removed=[];preserved_partial=None;prior=oom_restore_log_summary(backup)
    if partial_bytes and not progress.get('projectionSerializationVerified') and not receipt.exists() and not receipt.is_symlink() and 'disk_full' in prior.get('signals',[]):
        require(partial.is_file() and not partial.is_symlink() and partial.stat().st_nlink==1,'REHEARSAL_PARTIAL_OUTPUT_UNVERIFIED')
        ids=run(['docker','ps','-aq']).decode().split()
        containers=json.loads(run(['docker','inspect',*ids])) if ids else []
        mounts=[Path(m['Source']).resolve() for c in containers for m in c.get('Mounts',[]) if m.get('Source')]
        require(not any(output.resolve()==m or output.resolve() in m.parents or m in output.resolve().parents for m in mounts),'REHEARSAL_PARTIAL_OUTPUT_MOUNTED_NO_CLEANUP')
        removed.append({'path':str(partial),'logicalBytes':partial_bytes,'allocatedBytes':partial.stat().st_blocks*512,'reason':'incomplete_output_without_receipt_after_disk_full'})
        partial.unlink()
        partial_bytes=0
    elif partial_bytes and not progress.get('projectionSerializationVerified') and not receipt.exists() and not receipt.is_symlink():
        require(partial.is_file() and not partial.is_symlink() and partial.stat().st_nlink==1,'REHEARSAL_PARTIAL_OUTPUT_UNVERIFIED')
        ids=run(['docker','ps','-aq']).decode().split();containers=json.loads(run(['docker','inspect',*ids])) if ids else []
        mounts=[Path(m['Source']).resolve() for c in containers for m in c.get('Mounts',[]) if m.get('Source')]
        require(not any(output.resolve()==m or output.resolve() in m.parents or m in output.resolve().parents for m in mounts),'REHEARSAL_PARTIAL_OUTPUT_MOUNTED_NO_ARCHIVE')
        digest_partial=snapshot_file_hash(partial);archive=output/('projection.incomplete-'+digest_partial[:16]+'.private')
        if archive.exists():require(archive.is_file() and not archive.is_symlink() and snapshot_file_hash(archive)==digest_partial,'REHEARSAL_PARTIAL_ARCHIVE_CHANGED')
        else:os.rename(partial,archive)
        fd=os.open(output,os.O_RDONLY)
        try:os.fsync(fd)
        finally:os.close(fd)
        preserved_partial={'path':str(archive),'bytes':partial_bytes,'sha256':digest_partial,'reason':'incomplete_output_preserved_after_measured_timeout'}
        partial_bytes=0
    usage=shutil.disk_usage(backup);short=max(0,required-usage.free)
    filesystem=json.loads(run(['findmnt','--json','--target',str(backup),'--output','SOURCE,TARGET,FSTYPE,SIZE,AVAIL','--bytes']))
    block_devices=json.loads(run(['lsblk','--json','--bytes','--output','NAME,SIZE,TYPE,PKNAME,SERIAL,MOUNTPOINTS']))
    copies=[]
    for folder in sorted(backup.iterdir()):
        if folder.is_symlink() or not folder.is_dir():continue
        allocated=0
        for root,dirs,files in os.walk(folder,followlinks=False):
            dirs[:]=[d for d in dirs if not (Path(root)/d).is_symlink()]
            for name in files:allocated+=(Path(root)/name).lstat().st_blocks*512
        copies.append({'path':str(folder),'allocatedBytes':allocated,'preserved':True})
    gib=(short+1024**3-1)//1024**3
    source=str((filesystem.get('filesystems') or [{}])[0].get('source','')).split('[')[0]
    def backing_disk(nodes,parent=None):
        for node in nodes:
            disk=node if node.get('type')=='disk' else parent
            if '/dev/'+str(node.get('name'))==source:return disk
            found=backing_disk(node.get('children',[]),disk)
            if found:return found
    disk=backing_disk(block_devices.get('blockdevices',[]))
    physical=int(disk['size']) if disk and str(disk.get('size','')).isdigit() else None
    physical_gib=(physical+1024**3-1)//1024**3 if physical else None
    # EBS is provisioned in whole GiB; ext4 capacity is smaller than its device.
    minimum=(physical_gib+gib) if physical_gib is not None else None
    target=max(64,((minimum+3)//4)*4) if minimum is not None else None
    report={'destination':str(backup),'filesystem':filesystem,'blockDevices':block_devices,'filesystemDevice':backup.stat().st_dev,'filesystemTotalBytes':usage.total,'freeDiskBytes':usage.free,'inputBytes':input_bytes,'copyMissingBytes':missing,'failedOutputBytes':failed_output_bytes,'failedOutputIsLowerBound':True,'outputReserveBytes':output_reserve,'phasedPeakBytes':max(missing,output_reserve),'safetyAndActivationReserveBytes':safety_reserve,'executionMarginBytes':execution_margin,'requiredFreeBytes':required,'missingBytes':short,'additionalGiB':gib,'minimumFilesystemGiB':(usage.total+short+1024**3-1)//1024**3,'currentEbsGiB':physical_gib,'minimumEbsGiB':minimum,'suggestedEbsGiB':target,'ebsGrowthGiB':target-physical_gib if target is not None else None,'estimatedEbsGrowthUSDPerMonth':round((target-physical_gib)*0.08,2) if target is not None else None,'gp3AdditionalStorageUSDPerMonthEstimate':round(gib*0.08,2),'priceAssumption':'us-east-2 gp3 0.08 USD/GiB-month; verify EBS type, size, pricing and device before console expansion; excludes IOPS/throughput/tax','budgetBasis':budget_basis,'removed':removed,'preservedPartial':preserved_partial,'copies':copies}
    report_path=write_recovery_attempt_report(backup/'offline-rehearsal-disk-plan.json',json.dumps(report).encode())
    report['reportFile']=str(report_path)
    emit(operation='cutover.aws',stage='partitioned_upgrade.offline_disk',status='verified' if short==0 else 'blocked',**report,workerStarted=False,posnetChanged=False)
    require(short==0,'OFFLINE_REHEARSAL_DISK_EXPANSION_REQUIRED_NO_START')

def staged_recovery_disk_preflight(directory,backup,progress,digest,spool):
    """Budget all future copies before the first new recovery copy is written."""
    recovery=pre_stop_copy_files(directory)
    journals=[p for p in directory.glob('trade-feed.json.snapshot-*.json') if re.fullmatch(r'trade-feed\.json\.snapshot-[0-9a-f]{16}\.json',p.name)]
    backup_sources=[*recovery,*journals]
    backup_missing=sum(recovery_source_bytes(p) for p in backup_sources if not (backup/p.name).exists())
    rehearsal_name=progress.get('rehearsalDirectory') or 'rehearsal-'+digest[:24]
    require(re.fullmatch(r'rehearsal-[0-9a-f]{24}',rehearsal_name),'REHEARSAL_DIRECTORY_NAME_UNVERIFIED')
    rehearsal=backup/rehearsal_name
    checkpoint_sources=[directory/'trade-feed.json',directory/'trade-feed.json.regular-checkpoint.json']
    rehearsal_sources=[(p,rehearsal/p.name) for p in checkpoint_sources]
    if spool:rehearsal_sources.append((spool,rehearsal/'selected.response.private.json'))
    rehearsal_missing=sum(src.stat().st_size for src,dst in rehearsal_sources if not dst.exists())
    public=directory/'trade-feed.json';regular=directory/'trade-feed.json.regular-checkpoint.json'
    output_reserve=2*(public.stat().st_size+regular.stat().st_size)
    safety=4*1024**3;margin=2*1024**3
    required=backup_missing+max(rehearsal_missing,output_reserve)+safety+margin
    free=shutil.disk_usage(backup).free;short=max(0,required-free)
    report={'destination':str(backup),'freeBytes':free,'backupCopyBytes':backup_missing,'rehearsalCopyBytes':rehearsal_missing,'measuredOutputBaselineBytes':public.stat().st_size+regular.stat().st_size,'outputReserveBytes':output_reserve,'phasedPeakAfterBackupBytes':max(rehearsal_missing,output_reserve),'safetyAndActivationReserveBytes':safety,'explicitExecutionMarginBytes':margin,'requiredFreeBeforeAnyCopyBytes':required,'missingBytes':short,'additionalGiB':(short+1024**3-1)//1024**3,'copySet':[p.name for p in backup_sources],'rehearsalSet':[dst.name for src,dst in rehearsal_sources],'spoolBytes':spool.stat().st_size if spool else 0,'basis':'backup copy first; rehearsal input copy next; rehearsal inputs are hash-verified before restore and removed only after checkpoint+snapshot consumption; output phase follows; 4 GiB safety/activation reserve plus explicit 2 GiB margin'}
    emit(operation='cutover.aws',stage='partitioned_upgrade.staged_recovery_preflight',status='verified' if short==0 else 'blocked',**report,workerStarted=False,posnetChanged=False)
    require(short==0,'STAGED_RECOVERY_DISK_HEADROOM_INSUFFICIENT_NO_COPY')

def pre_stop_copy_files(directory):
    checkpoint=directory/'trade-feed.json';regular=directory/'trade-feed.json.regular-checkpoint.json'
    inboxes=sorted(directory.glob('trade-feed.json.*.inbox.sqlite'))
    sidecars=sorted(directory.glob('trade-feed.json.*.inbox.sqlite-*'))
    databases=[p for p in inboxes if re.fullmatch(r'trade-feed\.json\.(prematch|inplay)\.inbox\.sqlite',p.name)]
    require(checkpoint.is_file() and not checkpoint.is_symlink() and regular.is_file() and not regular.is_symlink(),'PRE_STOP_CHECKPOINT_COPY_SET_UNVERIFIED')
    require(len(databases)==2 and {p.name for p in databases}=={'trade-feed.json.prematch.inbox.sqlite','trade-feed.json.inplay.inbox.sqlite'},'PRE_STOP_INBOX_COPY_SET_UNVERIFIED')
    paths=[checkpoint,regular,*inboxes]
    # These are part of the authoritative recovery state for incremental
    # checkpoints and the public index. SQLite files are captured with the
    # SQLite backup API after the writer stops; WAL/SHM are never copied as
    # independent files.
    for name in ('trade-feed.json.checkpoint-journal.jsonl','trade-feed.json.pre-indexed-compaction.bak','trade-feed.json.checkpoint-compaction.tmp','trade-feed.json.checkpoint-journal.jsonl.empty.tmp','trade-feed.public.sqlite'):
        candidate=directory/name
        if candidate.exists():paths.append(candidate)
    require(all(p.is_file() and not p.is_symlink() for p in paths+sidecars),'PRE_STOP_PERSISTED_COPY_FILE_UNVERIFIED')
    return paths

def sqlite_consistent_backup(source,target):
    """Create a standalone, verified SQLite snapshot, including committed WAL pages."""
    import sqlite3
    require(source.is_file() and not source.is_symlink() and not target.is_symlink(),'SQLITE_BACKUP_SOURCE_UNVERIFIED')
    temporary=target.with_name(target.name+'.consistent.tmp')
    require(not temporary.exists() and not temporary.is_symlink(),'SQLITE_BACKUP_TEMP_EXISTS')
    src=sqlite3.connect(source.as_uri()+'?mode=ro',uri=True,timeout=30)
    dst=sqlite3.connect(temporary,timeout=30)
    try:
        try:
            src.backup(dst,pages=4096,sleep=0.05)
            check=dst.execute('PRAGMA integrity_check').fetchone()
            require(check and check[0]=='ok','SQLITE_BACKUP_INTEGRITY_FAILED')
            # The source may itself be in WAL mode. Normalize only the private
            # backup destination so the artifact is a single standalone DB.
            if dst.execute('PRAGMA journal_mode').fetchone()[0].lower()=='wal':
                dst.execute('PRAGMA wal_checkpoint(TRUNCATE)')
                require(dst.execute('PRAGMA journal_mode=DELETE').fetchone()[0].lower()=='delete','SQLITE_BACKUP_WAL_CLOSE_FAILED')
            dst.commit()
        finally:dst.close();src.close()
    except Exception:
        try:temporary.unlink()
        except FileNotFoundError:pass
        raise
    for suffix in ('-wal','-shm'):
        sidecar=Path(str(temporary)+suffix)
        if sidecar.exists():require(sidecar.is_file() and not sidecar.is_symlink(),'SQLITE_BACKUP_TEMP_SIDECAR_UNSAFE');sidecar.unlink()
    with temporary.open('rb') as copied:os.fsync(copied.fileno())
    os.chmod(temporary,0o600);os.replace(temporary,target)
    directory_fd=os.open(target.parent,os.O_RDONLY)
    try:os.fsync(directory_fd)
    finally:os.close(directory_fd)
    verify=sqlite3.connect(target.as_uri()+'?mode=ro',uri=True,timeout=30)
    try:
        result=verify.execute('PRAGMA integrity_check').fetchone()
        require(result and result[0]=='ok','SQLITE_BACKUP_READBACK_FAILED')
        pages=verify.execute('PRAGMA page_count').fetchone()[0];page_size=verify.execute('PRAGMA page_size').fetchone()[0]
    finally:verify.close()
    return {'sha256':snapshot_file_hash(target),'bytes':target.stat().st_size,'logicalBytes':pages*page_size,'integrity':'ok','walIncludedBySQLiteBackupApi':True}

def sqlite3_integrity(path):
    import sqlite3
    if not path.is_file() or path.is_symlink():return False
    db=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=30)
    try:return db.execute('PRAGMA integrity_check').fetchone()==('ok',)
    except sqlite3.DatabaseError:return False
    finally:db.close()

def recovery_source_bytes(path):
    size=path.stat().st_size
    if path.name.endswith('.sqlite'):
        wal=path.with_name(path.name+'-wal')
        if wal.is_file() and not wal.is_symlink():size+=wal.stat().st_size
    return size

def rollback_recovery_disk_preflight(directory,backup):
    sources=pre_stop_copy_files(directory)
    sources.extend(p for p in directory.glob('trade-feed.json.snapshot-*.json') if re.fullmatch(r'trade-feed\.json\.snapshot-[0-9a-f]{16}\.json',p.name))
    require(all(p.is_file() and not p.is_symlink() for p in sources),'ROLLBACK_RECOVERY_SOURCE_UNVERIFIED')
    total=sum(recovery_source_bytes(p) for p in sources)
    free=shutil.disk_usage(backup).free;reserve=4*1024**3
    require(free>=total+reserve,'ROLLBACK_RECOVERY_DISK_HEADROOM_INSUFFICIENT')
    return {'sourceBytes':total,'freeBytes':free,'reserveBytes':reserve,'requiredFreeBytes':total+reserve,'sourceFiles':len(sources)}

def capture_recovery_generation(directory,backup):
    """Capture a post-stop rollback point without raw copies of active SQLite sidecars."""
    budget=rollback_recovery_disk_preflight(directory,backup)
    sources=pre_stop_copy_files(directory)
    sources.extend(p for p in directory.glob('trade-feed.json.snapshot-*.json') if re.fullmatch(r'trade-feed\.json\.snapshot-[0-9a-f]{16}\.json',p.name))
    total=budget['sourceBytes'];free=budget['freeBytes'];reserve=budget['reserveBytes']
    name='rollback-state-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+os.urandom(4).hex()
    destination=backup/name;destination.mkdir(mode=0o700)
    entries={};sqlite_receipts={}
    for source in sorted(sources,key=lambda p:p.name):
        require(source.parent==directory and not source.is_symlink(),'ROLLBACK_RECOVERY_SOURCE_SCOPE_UNVERIFIED')
        target=destination/source.name
        if source.name.endswith('.sqlite'):
            receipt=sqlite_consistent_backup(source,target);sqlite_receipts[source.name]=receipt
        else:
            shutil.copyfile(source,target);os.chmod(target,0o600)
            with target.open('rb') as copied:os.fsync(copied.fileno())
            require(snapshot_file_hash(source)==snapshot_file_hash(target),'ROLLBACK_RECOVERY_COPY_HASH_MISMATCH')
        entries[source.name]={'sha256':snapshot_file_hash(target),'bytes':target.stat().st_size,'kind':'sqlite_online_backup' if source.name.endswith('.sqlite') else 'file_copy'}
    manifest={'version':1,'capturedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),'files':entries,'sqliteBackupReceipts':sqlite_receipts,'sourceBytes':total,'freeBytesBefore':free,'reserveBytesAfter':reserve,'walShmCopiedIndependently':False}
    private(destination/'recovery-manifest.private.json',json.dumps(manifest,sort_keys=True).encode())
    return {'directory':name,'files':len(entries),'sourceBytes':total,'freeBytesAfter':shutil.disk_usage(backup).free,'manifestSha256':snapshot_file_hash(destination/'recovery-manifest.private.json'),'sqliteDatabases':sorted(sqlite_receipts),'walShmCopiedIndependently':False}

def verify_recovery_generation(backup,receipt):
    root_name=receipt.get('directory') if isinstance(receipt,dict) else None
    require(isinstance(root_name,str) and re.fullmatch(r'rollback-state-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}',root_name),'ROLLBACK_RECOVERY_GENERATION_UNVERIFIED')
    root=backup/root_name;manifest_path=root/'recovery-manifest.private.json'
    require(root.parent==backup and root.is_dir() and not root.is_symlink() and root.stat().st_mode&0o077==0 and manifest_path.is_file() and not manifest_path.is_symlink() and manifest_path.stat().st_mode&0o077==0 and manifest_path.stat().st_uid==os.geteuid() and snapshot_file_hash(manifest_path)==receipt.get('manifestSha256'),'ROLLBACK_RECOVERY_MANIFEST_MISMATCH')
    manifest=json.loads(manifest_path.read_bytes());files=manifest.get('files',{});sqlites=manifest.get('sqliteBackupReceipts',{})
    require(manifest.get('walShmCopiedIndependently') is False and len(files)==receipt.get('files') and sorted(sqlites)==receipt.get('sqliteDatabases'),'ROLLBACK_RECOVERY_MANIFEST_INCOMPLETE')
    for filename,row in files.items():
        artifact=root/filename
        require(isinstance(filename,str) and Path(filename).name==filename and artifact.is_file() and not artifact.is_symlink() and artifact.stat().st_mode&0o077==0 and artifact.stat().st_uid==os.geteuid() and row.get('sha256')==snapshot_file_hash(artifact),'ROLLBACK_RECOVERY_FILE_HASH_MISMATCH')
        if filename.endswith('.sqlite'):
            receipt=sqlites.get(filename,{})
            require(row.get('kind')=='sqlite_online_backup' and sqlite3_integrity(artifact) and receipt.get('sha256')==row.get('sha256') and receipt.get('walIncludedBySQLiteBackupApi') is True and receipt.get('integrity')=='ok','ROLLBACK_RECOVERY_SQLITE_INVALID')
    return {'directory':root_name,'files':len(files),'sqliteDatabases':sorted(sqlites),'verified':True}

def storage_before_stop(backup,container,progress,digest):
    mounts=[m for m in container.get('Mounts',[]) if m.get('Destination')=='/app/.runtime/feed']
    require(len(mounts)==1,'PRE_STOP_FEED_MOUNT_UNVERIFIED')
    directory=Path(mounts[0]['Source'])
    files=pre_stop_copy_files(directory)
    total=sum(recovery_source_bytes(p) for p in files)
    # Run the same phased peak plan before stopping the only writer. The old
    # total*10 estimate counted many copies that never coexist and could block
    # every cutover despite a smaller, explicitly budgeted recovery sequence.
    retained_spools=[p for p in directory.rglob('response.private.json') if p.is_file() and not p.is_symlink()]
    unfinished=[p for p in directory.rglob('*.tmp') if p.is_file() and not p.is_symlink()]
    retained_bytes=sum(p.stat().st_size for p in retained_spools+unfinished)
    candidates=[p for p in retained_spools if 0<p.stat().st_size<=2*1024**3]
    spool=max(candidates,key=lambda p:p.stat().st_mtime) if candidates else None
    staged_recovery_disk_preflight(directory,backup,progress,digest,spool)
    free=shutil.disk_usage(backup).free
    emit(operation='cutover.aws',stage='partitioned_upgrade.pre_stop_disk',status='verified',freeDiskBytes=free,inputBytes=total,retainedInPlaceBytes=retained_bytes,retainedInPlaceFiles=True,copySet=['trade-feed.json','trade-feed.json.regular-checkpoint.json','prematch+inplay inbox SQLite/WAL/SHM'],budgetBasis='phased recovery preflight includes the one consistent copy, the largest mutually exclusive rehearsal/output phase, 4 GiB safety reserve, and 2 GiB explicit execution margin; active spools and unfinished checkpoints remain in place',signalsSent=0,workerStarted=False,posnetChanged=False)

def pre_exit_disk_plan(backup,total,hashes,proof,previous_original):
    # Working SQLite may have changed after replay. Only byte-identical, unreferenced
    # copies are disposable; retained outputs, logs and pristine copies are evidence.
    required=total*(4 if previous_original is not None else 5)+512*1024**2
    free=shutil.disk_usage(backup).free;candidates=[];removed=[]
    if free<required:
        ids=run(['docker','ps','-aq']).decode().split()
        mounts=[]
        if ids:
            for container in json.loads(run(['docker','inspect',*ids])):
                mounts.extend(Path(m['Source']).resolve() for m in container.get('Mounts',[]) if m.get('Source'))
        for folder in sorted(backup.iterdir()):
            if folder.is_symlink() or not folder.is_dir() or not re.fullmatch('(rehearsal-[0-9a-f]{24}|pre-exit-(original|output)-[0-9a-f]{16})',folder.name):continue
            allocated=0
            for root,dirs,files in os.walk(folder,followlinks=False):
                dirs[:]=[d for d in dirs if not (Path(root)/d).is_symlink()]
                for name in files:allocated+=(Path(root)/name).lstat().st_blocks*512
            reason='preserved_evidence_or_modified_copy';safe=False
            if re.fullmatch('rehearsal-[0-9a-f]{24}',folder.name) and str(folder)!=proof.get('workingCopy') and not any(folder.resolve()==m or folder.resolve() in m.parents or m in folder.resolve().parents for m in mounts):
                entries=list(folder.iterdir())
                safe=set(p.name for p in entries)==set(hashes) and all(p.is_file() and not p.is_symlink() and p.stat().st_nlink==1 and snapshot_file_hash(p)==hashes[p.name] for p in entries)
                if safe:
                    for p in entries:p.unlink()
                    folder.rmdir();removed.append(str(folder));reason='removed_byte_identical_unmounted_work_copy'
            candidates.append({'path':str(folder),'allocatedBytes':allocated,'decision':reason})
        free=shutil.disk_usage(backup).free
    missing=max(0,required-free)
    report={'destination':str(backup),'filesystemDevice':backup.stat().st_dev,'sourceBytes':total,'requiredFreeBytes':required,'availableFreeBytes':free,'missingBytes':missing,'minimumExpansionGiB':(missing+1024**3-1)//1024**3,'pristineCopyReused':previous_original is not None,'reserveBytes':512*1024**2,'copies':candidates,'removed':removed}
    report_path=write_recovery_attempt_report(backup/'pre-exit-disk-plan.json',json.dumps(report).encode())
    report['reportFile']=str(report_path)
    emit(operation='cutover.aws',stage='partitioned_upgrade.pre_exit_disk',status='verified' if missing==0 else 'blocked',**report,workerStarted=False,posnetChanged=False)
    require(missing==0,'PRE_EXIT_COPY_DISK_HEADROOM_INSUFFICIENT')

def pre_exit_proof_run(command,log,phase):
    private(log,b'');began=time.monotonic();last=0
    with log.open('ab') as output:
        child=subprocess.Popen(command,stdout=output,stderr=output)
        while child.poll() is None:
            elapsed=time.monotonic()-began
            if elapsed>=1200:
                name=command[command.index('--name')+1];require(re.fullmatch('adl-pre-exit-proof-[0-9a-f]{16}-(replay|readback)',name),'PROOF_CONTAINER_NAME_UNVERIFIED')
                subprocess.run(['docker','kill','--signal','SIGKILL',name],capture_output=True,timeout=20,check=False)
                child.wait(timeout=30);raise RuntimeError('PRE_EXIT_PROOF_DEADLINE_EXCEEDED_ORIGINAL_PRESERVED_PAUSED')
            if elapsed-last>=10:
                last=elapsed;latest=None
                for line in read_tail(log).decode(errors='replace').splitlines():
                    try:r=json.loads(line)
                    except ValueError:continue
                    if isinstance(r,dict) and r.get('operation')=='pre_exit.proof':latest=r
                emit(operation='cutover.aws',stage='partitioned_upgrade.pre_exit_proof.progress',status='running',proofPhase=phase,elapsedSeconds=round(elapsed),metrics={k:v for k,v in (latest or {}).items() if k in ('processed','rssBytes','heapUsedBytes','heapLimitBytes','maxRSSBytes') and type(v) is int},workerStarted=False,posnetChanged=False)
            time.sleep(1)
    if child.returncode:
        details={};divergence=None
        for line in read_tail(log).decode(errors='replace').splitlines():
            try:r=json.loads(line)
            except ValueError:continue
            if isinstance(r,dict) and r.get('operation')=='pre_exit.divergence':divergence={k:v for k,v in r.items() if k in ('entity','lane','path','expectedType','actualType','expectedCount','actualCount','fieldMembershipMismatch','valueMismatch')}
            if isinstance(r,dict) and r.get('operation')=='pre_exit.proof' and r.get('status')=='blocked':details={k:v for k,v in r.items() if k in ('phase','processed','reason','validationCode','validationDetail','rssBytes','heapUsedBytes','heapLimitBytes','maxRSSBytes')}
        emit(operation='cutover.aws',stage='partitioned_upgrade.pre_exit_proof',status='blocked',reason='PRE_EXIT_COPY_RECOVERY_FAILED_NO_TERMINATION',proofPhase=phase,childExitCode=child.returncode,diagnostic=details,divergence=divergence,privateLog=log.name,workerStarted=False,posnetChanged=False)
        raise RuntimeError('PRE_EXIT_COPY_RECOVERY_FAILED_NO_TERMINATION')
    require(b'pre-exit-proof-ok' in read_tail(log),'PRE_EXIT_PROOF_COMPLETION_NOT_VERIFIED')

def confirm_pre_exit_finalization(progress,save):
    cid=progress['oldContainer'];workers=states('worker');require(len(workers)==1 and workers[0]['id']==cid and not workers[0]['running'],'PRE_EXIT_FINALIZE_EXIT_NOT_CONFIRMED')
    proof=progress.get('preExitProof') or {};signal=progress.get('verifiedExitSignal') or {};require(proof.get('verified') is True and signal.get('containerId')==cid and signal.get('imageId')==progress['baseImageId'] and signal.get('status') in ('intent','docker_accepted','exit_observed_after_intent'),'PRE_EXIT_FINALIZE_RECEIPT_UNVERIFIED')
    info=json.loads(run(['docker','inspect',cid]))[0];require(info['Image']==progress['baseImageId'],'PRE_EXIT_FINALIZE_IMAGE_CHANGED')
    mounts=[m for m in info.get('Mounts',[]) if m.get('Destination')=='/app/.runtime/feed' and m.get('Type')=='volume'];require(len(mounts)==1,'PRE_EXIT_FINALIZE_VOLUME_UNVERIFIED')
    volume=json.loads(run(['docker','volume','inspect',mounts[0]['Name']]))[0];require((volume.get('Labels') or {}).get('com.docker.compose.project')=='adl-homologation','PRE_EXIT_FINALIZE_VOLUME_PROJECT_UNVERIFIED');directory=Path(volume['Mountpoint']);require(not directory.is_symlink(),'PRE_EXIT_FINALIZE_VOLUME_SYMLINK')
    require(all((directory/name).is_file() and not (directory/name).is_symlink() and snapshot_file_hash(directory/name)==sha for name,sha in proof['sourceHashes'].items()),'PRE_EXIT_DATA_CHANGED_DURING_FINALIZATION')
    if signal['status']=='intent':signal['status']='exit_observed_after_intent'
    progress['verifiedExitContainerId']=cid;progress['phase']='stopped';save(progress)

def mark_old_container_if_exited(progress,save):
    workers=states('worker');require(len(workers)==1 and workers[0]['id']==progress['oldContainer'],'STOP_CONTAINER_IDENTITY_CHANGED')
    if workers[0]['running']:return False
    info=json.loads(run(['docker','inspect',workers[0]['id']]))[0];require(info['Image']==progress['baseImageId'],'PRE_EXIT_CONTAINER_IDENTITY_CHANGED')
    if progress.get('preExitProof',{}).get('verified') and progress.get('verifiedExitSignal'):confirm_pre_exit_finalization(progress,save)
    else:progress['phase']='stopped';save(progress)
    return True

def incomplete_shutdown_recovery_eligible(progress,evidence,previous,current):
    logs=evidence.get('shutdownLogs',[])
    return (progress.get('pipelineRepair') is True and progress.get('supplierStoppedBeforeConsumer') is True and
        evidence.get('running') is True and evidence.get('applicationStoppingObserved') is True and
        not evidence.get('eventsReadFailed') and not evidence.get('distributionRestartAfterRecordedStop') and
        not evidence.get('shutdownErrors') and any(r.get('status')=='stopping' for r in logs) and
        not any(r.get('status')=='error' for r in logs) and
        isinstance(previous,dict) and previous.get('observationElapsedSeconds',0)>=90 and
        previous.get('progressSincePreviousSample') is False and current.get('running') is True and
        current.get('files')==previous.get('files') and
        current.get('lastCompletedPersistence')==previous.get('lastCompletedPersistence') and
        not work_counter_progress(previous.get('containerWork'),current.get('containerWork'),sample_elapsed_seconds(previous,current)))

def recover_completed_shutdown(progress,save,backup,evidence,allow_incomplete=False,previous=None,current=None):
    cid=progress['oldContainer'];require(progress.get('supplierStoppedBeforeConsumer') is True and not evidence.get('distributionRestartAfterRecordedStop'),'PRE_EXIT_DISTRIBUTION_STOP_UNVERIFIED')
    completed=any(r.get('status')=='ok' for r in evidence.get('shutdownLogs',[]))
    require(completed or allow_incomplete and incomplete_shutdown_recovery_eligible(progress,evidence,previous,current),'PRE_EXIT_APPLICATION_SHUTDOWN_NOT_COMPLETED')
    if mark_old_container_if_exited(progress,save):return
    try:tree=container_process_tree(cid)
    except subprocess.CalledProcessError:
        if mark_old_container_if_exited(progress,save):return
        raise
    progress['shutdownProcessTree']=tree;save(progress)
    emit(operation='cutover.aws',stage='partitioned_upgrade.shutdown_process_tree',status='collected',tree=tree,workerStarted=False,posnetChanged=False)
    info=json.loads(run(['docker','inspect',cid]))[0]
    require(info['Image']==progress['baseImageId'] and info['State']['Running'] and info['HostConfig']['Memory']==partition_memory(progress),'PRE_EXIT_CONTAINER_IDENTITY_CHANGED')
    mounts=[m for m in info.get('Mounts',[]) if m.get('Destination')=='/app/.runtime/feed' and m.get('Type')=='volume'];require(len(mounts)==1,'PRE_EXIT_VOLUME_UNVERIFIED');mount=mounts[0]
    volume=json.loads(run(['docker','volume','inspect',mount['Name']]))[0];require((volume.get('Labels') or {}).get('com.docker.compose.project')=='adl-homologation','PRE_EXIT_VOLUME_PROJECT_UNVERIFIED');directory=Path(volume['Mountpoint']);require(not directory.is_symlink(),'PRE_EXIT_VOLUME_SYMLINK')
    active=run(['docker','ps','-q']).decode().split()
    for other in json.loads(run(['docker','inspect',*active])) if active else []:
        require(other['Id']==cid or not any(m.get('Name')==mount['Name'] and m.get('RW') for m in other.get('Mounts',[])),'PRE_EXIT_OTHER_FEED_WRITER')
    freeze=progress.get('recoveryFreeze')
    require(not info['State'].get('Paused') or freeze and freeze.get('containerId')==cid and freeze.get('imageId')==info['Image'],'PRE_EXIT_UNOWNED_PAUSE_PRESERVED')
    if not info['State'].get('Paused'):
        progress['recoveryFreeze']={'containerId':cid,'imageId':info['Image'],'status':'intent'};save(progress)
        try:run(['docker','pause',cid])
        except subprocess.CalledProcessError:
            if mark_old_container_if_exited(progress,save):return
            raise
        info=json.loads(run(['docker','inspect',cid]))[0]
    require(info['State'].get('Paused') is True,'PRE_EXIT_FREEZE_NOT_CONFIRMED')
    progress['recoveryFreeze']['status']='paused';save(progress)
    emit(operation='cutover.aws',stage='partitioned_upgrade.pre_exit_freeze',status='verified',containerId=cid,paused=True,originalsPreserved=True,posnetChanged=False)
    paths=[directory/'trade-feed.json',directory/'trade-feed.json.regular-checkpoint.json',*sorted(directory.glob('trade-feed.json.*.inbox.sqlite*'))]
    require(all(p.is_file() and not p.is_symlink() for p in paths) and len(list(directory.glob('trade-feed.json.*.inbox.sqlite')))==2,'PRE_EXIT_PERSISTED_FILES_UNVERIFIED')
    hashes={p.name:snapshot_file_hash(p) for p in paths};total=sum(p.stat().st_size for p in paths)
    proof_code_hash=hashlib.sha256(PRE_EXIT_REPLAY_PROOF.encode()).hexdigest();proof=progress.get('preExitProof') or {};valid=proof.get('verified') is True and proof.get('sourceHashes')==hashes and proof.get('proofCodeHash')==proof_code_hash
    if valid:
        output=Path(proof['output']);require(output.parent==backup and not output.is_symlink(),'PRE_EXIT_PROOF_OUTPUT_UNVERIFIED')
        require(snapshot_file_hash(output/'receipt.json')==proof['receiptHash'] and snapshot_file_hash(output/'readback.json')==proof['readbackHash'] and snapshot_file_hash(output/'projection.json')==proof['projectionHash'] and snapshot_file_hash(output/'projection.json.regular-checkpoint.json')==proof['regularHash'],'PRE_EXIT_PROOF_RECEIPT_CHANGED')
    else:
        previous_original=Path(proof['originalCopy']) if proof.get('sourceHashes')==hashes and proof.get('originalCopy') else None
        if previous_original is not None:
            require(previous_original.parent==backup and not previous_original.is_symlink() and previous_original.is_dir() and all((previous_original/name).is_file() and not (previous_original/name).is_symlink() and snapshot_file_hash(previous_original/name)==sha for name,sha in hashes.items()),'PRE_EXIT_PRESERVED_COPY_IDENTITY_CHANGED')
        pre_exit_disk_plan(backup,total,hashes,proof,previous_original)
        require(snapshot_host_memory()>=6*1024**3,'PRE_EXIT_COPY_MEMORY_HEADROOM_INSUFFICIENT')
        nonce=os.urandom(8).hex();original=previous_original if previous_original is not None else backup/('pre-exit-original-'+nonce)
        if previous_original is None:original.mkdir(mode=0o700)
        work=backup/('rehearsal-'+os.urandom(12).hex());work.mkdir(mode=0o700);output=backup/('pre-exit-output-'+nonce);output.mkdir(mode=0o700)
        progress['preExitProof']={'verified':False,'originalCopy':str(original),'workingCopy':str(work),'output':str(output),'sourceHashes':hashes,'proofCodeHash':proof_code_hash};save(progress)
        copies=[]
        for src in paths:
            raw=original/src.name
            if previous_original is None:
                shutil.copyfile(src,raw);os.chmod(raw,0o600)
                with raw.open('rb') as file:os.fsync(file.fileno())
            require(snapshot_file_hash(raw)==hashes[src.name] and snapshot_file_hash(src)==hashes[src.name],'PRE_EXIT_RAW_COPY_HASH_MISMATCH')
            dst=work/src.name;shutil.copyfile(raw,dst);os.chmod(dst,0o600);copies.append((raw,dst,hashes[src.name]))
        image=json.loads(run(['docker','image','inspect',progress['image']]))[0];require((image.get('Config',{}).get('Labels') or {}).get('eu.adl.partitioned.patch')==progress['digest'],'PRE_EXIT_PREPARED_IMAGE_IDENTITY_CHANGED')
        user=image['Config'].get('User');require(user in ('node','1000','1000:1000'),'PRE_EXIT_REHEARSAL_USER_UNVERIFIED')
        common=['docker','run','--rm','--network','none','--memory','4g','--memory-swap','4g','--cpus','2','--read-only','--user',user,'--mount','type=bind,source='+str(work)+',target=/recovery','--tmpfs','/tmp:size=33554432,mode=1777','--entrypoint','node',image['Id']]
        access=json.loads(run(common+['-e',REHEARSAL_ACCESS_PROBE],timeout=30));rehearsal_copy_permissions(backup,work,copies,access)
        access=json.loads(run(common+['-e',REHEARSAL_ACCESS_PROBE],timeout=30));require(access.get('opened') is True and not access.get('linkDetected'),'PRE_EXIT_COPY_READ_ACCESS_FAILED')
        st=work.stat();os.chown(output,st.st_uid,st.st_gid);os.chmod(output,0o700)
        script=backup/('pre-exit-replay-proof-'+proof_code_hash[:24]+'.mjs')
        if script.exists():require(script.is_file() and not script.is_symlink() and script.read_text()==PRE_EXIT_REPLAY_PROOF,'PRE_EXIT_PROOF_SCRIPT_CHANGED')
        else:private(script,PRE_EXIT_REPLAY_PROOF.encode());os.chmod(script,0o644)
        common=partition_rehearsal_args(common,progress)
        command=common[:-1]+['--mount','type=bind,source='+str(output)+',target=/output','--mount','type=bind,source='+str(script)+',target=/offline-proof.mjs,readonly','--name','adl-pre-exit-proof-'+nonce+'-replay',common[-1],'--max-old-space-size='+str(partition_heap_mib(progress)),'--import','tsx','/offline-proof.mjs']
        progress['preExitProof']['attemptLog']='pre-exit-replay-'+nonce+'.private.log';save(progress)
        pre_exit_proof_run(command,backup/progress['preExitProof']['attemptLog'],'restore_replay_serialize')
        command[command.index('--name')+1]='adl-pre-exit-proof-'+nonce+'-readback'
        pre_exit_proof_run(command+['readback'],backup/('pre-exit-readback-'+nonce+'.private.log'),'full_readback_restore')
        receipt=json.loads((output/'receipt.json').read_bytes());readback=json.loads((output/'readback.json').read_bytes())
        require(readback.get('verified') is True and readback.get('projectionSha256')==receipt.get('sha256') and readback.get('stateRows')==receipt.get('stateRows') and readback.get('stateSha256')==receipt.get('stateSha256') and len(receipt.get('inboxes',[]))==2 and {r.get('lane') for r in receipt['inboxes']}=={'prematch','inplay'} and all(type(r.get('pendingCommittedRows')) is int and r['pendingCommittedRows']>=0 and r['pendingCommittedRows']==r.get('replayedRows') and re.fullmatch('[0-9a-f]{64}',str(r.get('rawRecordSha256'))) for r in receipt['inboxes']),'PRE_EXIT_RECOVERY_RECEIPT_INVALID')
        progress['preExitProof'].update(verified=True,receiptHash=snapshot_file_hash(output/'receipt.json'),readbackHash=snapshot_file_hash(output/'readback.json'),projectionHash=snapshot_file_hash(output/'projection.json'),regularHash=snapshot_file_hash(output/'projection.json.regular-checkpoint.json'),inboxes=receipt['inboxes'],stateRows=readback['stateRows'],memory=readback);save(progress)
    require(all(snapshot_file_hash(directory/name)==sha for name,sha in hashes.items()),'PRE_EXIT_ORIGINAL_CHANGED_WHILE_FROZEN')
    current=json.loads(run(['docker','inspect',cid]))[0];require(current['Image']==progress['baseImageId'] and current['State']['Running'] and current['State'].get('Paused'),'PRE_EXIT_CONTAINER_CHANGED_AFTER_PROOF')
    emit(operation='cutover.aws',stage='partitioned_upgrade.pre_exit_recovery_verified',status='verified',proof=progress['preExitProof'],tree=tree,forceStopEvidenceVerified=True,workerStarted=False,posnetChanged=False)
    require(not progress.get('verifiedExitSignal'),'PRE_EXIT_FINALIZE_INTENT_ALREADY_RECORDED_NO_REPEAT')
    progress['verifiedExitSignal']={'containerId':cid,'imageId':current['Image'],'status':'intent','signal':'SIGKILL','recoveryReceiptHash':progress['preExitProof']['receiptHash']};save(progress)
    run(['docker','kill','--signal','SIGKILL',cid],log=backup/'verified-finalize.private.log')
    progress['verifiedExitSignal']['status']='docker_accepted';save(progress)
    confirm_pre_exit_finalization(progress,save)
    emit(operation='cutover.aws',stage='partitioned_upgrade.old_container_finalized',status='verified',containerId=cid,originalHashesUnchanged=True,forceStopEvidenceVerified=True,workerStarted=False,posnetChanged=False)

def recover_incomplete_shutdown_safely(progress,save,backup,evidence,previous,current):
    try:
        recover_completed_shutdown(progress,save,backup,evidence,allow_incomplete=True,previous=previous,current=current)
    except Exception:
        # A failed read-only restore rehearsal must leave the original worker
        # able to resume. Never strand a live container paused on a failed proof.
        workers=states('worker')
        if len(workers)==1 and workers[0].get('id')==progress.get('oldContainer') and workers[0].get('running'):
            info=json.loads(run(['docker','inspect',workers[0]['id']]))[0]
            if info.get('State',{}).get('Paused'):
                run(['docker','unpause',workers[0]['id']])
                restored=json.loads(run(['docker','inspect',workers[0]['id']]))[0]
                require(restored.get('State',{}).get('Running') and not restored.get('State',{}).get('Paused'),'PRE_EXIT_FAILED_PROOF_UNPAUSE_UNCONFIRMED')
                progress['recoveryFreeze']={'containerId':workers[0]['id'],'imageId':progress['baseImageId'],'status':'unpaused_after_failed_proof'};save(progress)
                emit(operation='cutover.aws',stage='partitioned_upgrade.pre_exit_unpause',status='restored_after_failed_proof',workerStarted=False,posnetChanged=False)
        raise

def collect_graceful_signal_evidence(progress):
    workers=states('worker');require(len(workers)==1 and workers[0]['id']==progress.get('oldContainer'),'STOP_CONTAINER_IDENTITY_CHANGED')
    worker=workers[0];info=json.loads(run(['docker','inspect',worker['id']]))[0]
    require(info['Image']==progress['baseImageId'] and info['HostConfig']['Memory']==partition_memory(progress),'STOP_IMAGE_IDENTITY_CHANGED')
    start=timeline_timestamp(info['State']['StartedAt'],'container.StartedAt');end=datetime.datetime.now(datetime.timezone.utc)
    evidence={'containerId':worker['id'],'imageId':info['Image'],'running':worker['running'],'dockerTermAccepted':False,'applicationStoppingObserved':False,'dockerHistoryCoversStart':False,'logHistoryCoversStart':False,'distributionRestartAfterRecordedStop':False,'events':[],'shutdownLogs':[],'shutdownErrors':[],'signalsSent':0}
    try:result=subprocess.run(['docker','events','--since',(start-datetime.timedelta(seconds=1)).isoformat(),'--until',end.isoformat(),'--filter','container='+worker['id'],'--format','{{json .}}'],capture_output=True,timeout=20,check=False)
    except subprocess.TimeoutExpired:result=None
    evidence['eventsReadFailed']=result is None or result.returncode!=0
    if result is not None and result.returncode==0 and len(result.stdout)<=4*1024**2:
        for line in result.stdout.decode(errors='replace').splitlines():
            try:r=json.loads(line)
            except ValueError:continue
            if (r.get('Actor') or {}).get('ID',r.get('id'))!=worker['id']:continue
            action=r.get('Action',r.get('status'));signal=str(((r.get('Actor') or {}).get('Attributes') or {}).get('signal',''));at=r.get('timeNano')
            if action=='start' and type(at) is int and abs(at/1e9-start.timestamp())<5:evidence['dockerHistoryCoversStart']=True
            if action in ('kill','stop') and signal in ('15','SIGTERM','TERM'):evidence['dockerTermAccepted']=True
            if action in ('start','kill','stop','die','oom','restart'):evidence['events'].append({'action':action,'signal':signal if signal in ('15','SIGTERM','TERM','2','SIGINT','9','SIGKILL') else 'other' if signal else None,'timeNano':at if type(at) is int else None})
    with tempfile.TemporaryFile() as raw:
        child=subprocess.Popen(['docker','logs','--since',start.isoformat(),'--tail','20000','--timestamps',worker['id']],stdout=raw,stderr=raw)
        try:code=child.wait(timeout=20)
        except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5);code=-1
        size=raw.tell();evidence['logBytes']=size;evidence['logReadExitCode']=code
        if code==0 and size<=64*1024**2:
            raw.seek(0);first=None
            for line in raw:
                m=re.match(rb'^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z) (.*)$',line)
                if not m:continue
                at=timeline_timestamp(m[1].decode(),'shutdown.log')
                if first is None:first=at
                try:r=json.loads(m[2])
                except ValueError:continue
                if not isinstance(r,dict):continue
                if r.get('operation')=='worker.shutdown' and r.get('status') in ('stopping','ok','error'):
                    evidence['shutdownLogs'].append({'atUTC':m[1].decode(),'status':r['status']})
                    if r['status']=='stopping':evidence['applicationStoppingObserved']=True
                if r.get('operation') in ('distribution.stop','distribution.status','amqp.connection','feed.apply','worker.start') and (not progress.get('supplierStoppedAtUTC') or at>=timeline_timestamp(progress['supplierStoppedAtUTC'],'supplierStoppedAtUTC')):
                    diagnostic=safe_feed_diagnostic(r)
                    if diagnostic.get('category'):evidence['shutdownErrors'].append({'atUTC':m[1].decode(),**diagnostic});evidence['shutdownErrors']=evidence['shutdownErrors'][-16:]
                if r.get('operation')=='distribution.start' and progress.get('supplierStoppedAtUTC') and at>=timeline_timestamp(progress['supplierStoppedAtUTC'],'supplierStoppedAtUTC'):evidence['distributionRestartAfterRecordedStop']=True
            evidence['logHistoryCoversStart']=first is not None and first<=start+datetime.timedelta(seconds=30)
    evidence['events']=evidence['events'][-32:];evidence['shutdownLogs']=evidence['shutdownLogs'][-16:]
    pid=info.get('State',{}).get('Pid');process_info={}
    if worker['running'] and type(pid) is int and pid>1:
        try:
            exe=Path(os.readlink('/proc/'+str(pid)+'/exe')).name;process_info['executable']=exe if exe in ('node','nodejs','tini','docker-init','dumb-init','sh','bash') else 'other'
            status=Path('/proc/'+str(pid)+'/status').read_text()
            for line in status.splitlines():
                key,_,value=line.partition(':')
                if key in ('State','VmRSS','VmSwap','Threads','SigPnd','ShdPnd','SigCgt'):process_info[key]=value.strip()
            wchan=Path('/proc/'+str(pid)+'/wchan').read_text().strip();process_info['waitChannel']=wchan if re.fullmatch('[A-Za-z0-9_]{1,100}',wchan) else 'unverified'
        except (OSError,ValueError):process_info['unavailable']=True
    evidence['process']=process_info
    return evidence

def graceful_signal_decision(progress,evidence):
    if not evidence.get('running'):return 'already_exited'
    recorded=progress.get('gracefulSignal') or {}
    if recorded:
        require(recorded.get('containerId')==evidence['containerId'] and recorded.get('imageId')==evidence['imageId'],'STOP_SIGNAL_RECEIPT_IDENTITY_CHANGED')
        if recorded.get('status')=='docker_accepted':return 'already_requested'
        if evidence.get('dockerTermAccepted') or evidence.get('applicationStoppingObserved'):return 'already_requested'
        return 'signal_intent_delivery_inconclusive'
    if evidence.get('dockerTermAccepted') or evidence.get('applicationStoppingObserved'):return 'already_requested'
    if evidence.get('dockerHistoryCoversStart') and evidence.get('logHistoryCoversStart') and not evidence.get('eventsReadFailed') and not evidence.get('distributionRestartAfterRecordedStop') and not any(r.get('action') in ('kill','stop','die','restart') for r in evidence.get('events',[])):
        return 'first_request_verified'
    return 'signal_history_inconclusive'

def request_graceful_signal_once(progress,save,backup,distribution_required=True):
    # Intent is durable BEFORE the one Docker operation. An interrupted intent
    # is never treated as proof of either delivery or absence of delivery.
    current=states('worker');require(len(current)==1 and current[0]['id']==progress['oldContainer'],'STOP_CONTAINER_IDENTITY_CHANGED')
    if not current[0]['running']:return
    info=json.loads(run(['docker','inspect',current[0]['id']]))[0]
    require(info['Image']==progress['baseImageId'] and info['HostConfig']['Memory']==partition_memory(progress) and (not distribution_required or progress.get('supplierStoppedBeforeConsumer') is True),'STOP_SIGNAL_PRECONDITIONS_UNVERIFIED')
    require(not progress.get('gracefulSignal'),'STOP_SIGNAL_ALREADY_RECORDED_NO_REPEAT')
    at=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
    progress['phase']='stop_requested';progress['stopRequestedAtUTC']=at;progress['gracefulSignal']={'containerId':current[0]['id'],'imageId':info['Image'],'signal':'SIGTERM','intentAtUTC':at,'status':'intent'};save(progress)
    run(['docker','kill','--signal','SIGTERM',current[0]['id']],log=backup/'graceful-stop.private.log')
    progress['gracefulSignal'].update(status='docker_accepted',exitCode=0,acceptedAtUTC=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'));save(progress)

def watch_upgrade_stop(sample,record,timeout=180,interval=15,now=None,sleep=None):
    now=now or time.monotonic;sleep=sleep or time.sleep;began=now();observations=[];previous=None;last_change=began
    while True:
        point=sample();require(type(point.get('running')) is bool,'STOP_OBSERVATION_STATE_UNVERIFIED');point['observationElapsedSeconds']=round(now()-began,1)
        fingerprint=json.dumps(stop_observation_fingerprint(point),sort_keys=True)
        counter_progress=bool(observations and work_counter_progress(observations[-1].get('containerWork'),point.get('containerWork'),interval))
        changed=previous is not None and (fingerprint!=previous or counter_progress)
        if changed:last_change=now()
        point['progressSincePreviousSample']=changed;point['progressKind']='checkpoint_or_log' if previous is not None and fingerprint!=previous else 'container_cpu_or_io' if counter_progress else 'none';point['assessment']='exited' if not point['running'] else 'observable_progress' if changed else 'no_new_observable_progress'
        observations.append(point);record({'samples':observations,'forceStopEvidenceVerified':False,'note':'Log/file inactivity does not prove a deadlock; live inbox/checkpoint consistency has not been verified for forced termination.'})
        if not point['running']:return observations
        elapsed=now()-began
        if elapsed>=timeout:raise RuntimeError('UPGRADE_STOP_OBSERVATION_DEADLINE_NO_MORE_SIGNALS')
        if previous is not None and now()-last_change>=90:raise RuntimeError('UPGRADE_STOP_NO_OBSERVABLE_PROGRESS_NO_MORE_SIGNALS')
        previous=fingerprint;sleep(min(interval,timeout-elapsed))

def resumed_stop_budget(progress, measured_full_recovery=False, current_sample=None):
    previous=progress.get('shutdownObservation',{}).get('samples',[])
    if progress.get('pipelineRepair') is True or measured_full_recovery is True:
        samples=[s for s in previous if isinstance(s,dict)]
        if isinstance(current_sample,dict):samples.append(current_sample)
        measured=max(((s.get('lastCompletedPersistence') or {}).get('lastDurationMs',0) for s in samples),default=0)
        # A graceful stop can complete one persist and immediately begin another
        # final pass. If that second pass is already observable, budget its measured
        # remaining stage time instead of timing out against only the prior cycle.
        if previous and measured>0:
            sample=samples[-1];completed=sample.get('lastCompletedPersistence') or {}
            records=[r for r in sample.get('records',[]) if isinstance(r,dict) and r.get('operation')=='file.persist' and r.get('stage') in ('capture','regular_checkpoint','projection')]
            active=records[-1] if records else None
            if active and active.get('loggedAtUTC') and sample.get('atUTC'):
                try:
                    active_at=datetime.datetime.fromisoformat(active['loggedAtUTC'].replace('Z','+00:00'))
                    sample_at=datetime.datetime.fromisoformat(sample['atUTC'].replace('Z','+00:00'))
                    elapsed_ms=max(0,int((sample_at-active_at).total_seconds()*1000))
                    stage=active.get('stage')
                    if stage=='regular_checkpoint':
                        remaining_ms=max(0,int(completed.get('regularDurationMs',0))-elapsed_ms)+int(completed.get('publishDurationMs',0))
                    elif stage=='projection':remaining_ms=max(0,int(completed.get('publishDurationMs',0))-elapsed_ms)
                    elif stage=='capture':remaining_ms=max(0,int(completed.get('captureDurationMs',0))-elapsed_ms)+int(completed.get('regularDurationMs',0))+int(completed.get('publishDurationMs',0))
                    else:remaining_ms=0
                    if remaining_ms>0:
                        cycles=2 if measured_full_recovery else 1
                        return min(1200,max(180,int((remaining_ms*cycles+120000+999)//1000)))
                except (TypeError,ValueError,OverflowError):pass
        if type(measured) in (int,float) and measured>0:
            cycles=2 if measured_full_recovery else 1
            return min(1200,max(180,int((measured*cycles+120000+999)//1000)))
        if partition_memory(progress)==6442450944:return 600
    # Only a pinned interrupted operation with measured write progress qualifies.
    # No repeated signal; inactivity and identity checks remain unchanged.
    return 600 if previous and previous[-1].get('progressSincePreviousSample') is True else 180

def stop_observation_fingerprint(point):
    records=point.get('records') or []
    # The diagnostic returns a rolling window. Comparing the whole list makes
    # dropping its oldest row look like progress even when no new event arrived.
    return {'files':point.get('files'),'latestRecord':records[-1] if records else None}

def sample_elapsed_seconds(previous,current):
    try:
        a=datetime.datetime.fromisoformat(previous['atUTC'].replace('Z','+00:00'))
        b=datetime.datetime.fromisoformat(current['atUTC'].replace('Z','+00:00'))
        return max(1.0,(b-a).total_seconds())
    except (KeyError,TypeError,ValueError):return 15.0

def work_counter_progress(previous,current,elapsed_seconds=15.0):
    if not isinstance(previous,dict) or not isinstance(current,dict):return False
    cpu=current.get('cpuUsageUsec',0)-previous.get('cpuUsageUsec',0)
    io=sum(current.get(k,0)-previous.get(k,0) for k in ('readBytes','writeBytes'))
    scale=max(1.0,elapsed_seconds/15.0)
    return cpu>=500000*scale or io>=1024*1024*scale

def upgrade_stop_sample(progress):
    workers=states('worker');require(len(workers)==1 and workers[0]['id']==progress.get('oldContainer'),'STOP_CONTAINER_IDENTITY_CHANGED')
    worker=workers[0];info=json.loads(run(['docker','inspect',worker['id']]))[0]
    require(info['Image']==progress['baseImageId'] and info['HostConfig']['Memory']==partition_memory(progress),'STOP_IMAGE_IDENTITY_CHANGED')
    end=datetime.datetime.now(datetime.timezone.utc);begin=end-datetime.timedelta(minutes=10)
    timeline=existing_recovery_timeline(workers,{'fromUTC':begin.isoformat().replace('+00:00','Z'),'toUTC':end.isoformat().replace('+00:00','Z')})
    records=[r for r in timeline.get('records',[]) if r.get('operation') in ('file.persist','snapshot.events','feed.coverage','worker.shutdown')][-12:]
    files=[]
    for mount in info.get('Mounts',[]):
        if mount.get('Destination')!='/app/.runtime/feed' or mount.get('Type')!='volume':continue
        volumes=json.loads(run(['docker','volume','inspect',mount['Name']]))
        require(len(volumes)==1 and (volumes[0].get('Labels') or {}).get('com.docker.compose.project')=='adl-homologation','STOP_VOLUME_UNVERIFIED')
        root=Path(volumes[0]['Mountpoint']);require(not root.is_symlink(),'STOP_VOLUME_SYMLINK')
        for target in sorted(root.glob('trade-feed.json*'))[:100]:
            try:
                if target.is_symlink() or not target.is_file():continue
                st=target.stat()
            except FileNotFoundError:continue
            kind='inbox_wal' if target.name.endswith('.inbox.sqlite-wal') else 'inbox' if target.name.endswith('.inbox.sqlite') else 'checkpoint_tmp' if '.tmp' in target.name else 'checkpoint' if target.name in ('trade-feed.json','trade-feed.json.regular-checkpoint.json') else None
            if kind:files.append({'kind':kind,'lane':'prematch' if '.prematch.' in target.name else 'inplay' if '.inplay.' in target.name else None,'bytes':st.st_size,'modifiedNs':st.st_mtime_ns})
    container_work=None
    if worker.get('running'):
        counter_probe="const fs=require('node:fs');const cpu=fs.readFileSync('/sys/fs/cgroup/cpu.stat','utf8').match(/^usage_usec (\\d+)/m),io=fs.readFileSync('/sys/fs/cgroup/io.stat','utf8');let readBytes=0,writeBytes=0;for(const line of io.split(/\\n/)){const r=line.match(/\\brbytes=(\\d+)/),w=line.match(/\\bwbytes=(\\d+)/);readBytes+=Number(r?.[1]||0);writeBytes+=Number(w?.[1]||0)}console.log(JSON.stringify({cpuUsageUsec:Number(cpu?.[1]||0),readBytes,writeBytes}))"
        try:
            candidate=json.loads(run(['docker','exec',worker['id'],'node','-e',counter_probe],timeout=15))
            if all(type(candidate.get(k)) is int and candidate[k]>=0 for k in ('cpuUsageUsec','readBytes','writeBytes')):container_work=candidate
        except (RuntimeError,subprocess.SubprocessError,ValueError,KeyError):pass
    result={'atUTC':end.isoformat().replace('+00:00','Z'),'containerId':worker['id'],'running':worker['running'],'exitCode':worker.get('exitCode'),'oomKilled':worker.get('oomKilled'),'files':files,'records':records,'containerWork':container_work,'finishedAtUTC':info.get('State',{}).get('FinishedAt'),'signalsSent':0,'distributionOperations':0}
    persisted=[r for r in records if r.get('operation')=='file.persist'];completed=[r for r in persisted if r.get('lastCompletedAtUTC')]
    result['persistenceStage']=persisted[-1].get('stage','completed' if persisted[-1].get('lastCompletedAtUTC') else 'unknown') if persisted else 'not_observed'
    result['lastCompletedPersistence']=completed[-1] if completed else None
    result['stopRequestedAtUTC']=progress.get('stopRequestedAtUTC')
    stopped=progress.get('supplierStoppedAtUTC')
    if stopped:
        result['distributionStoppedAtUTC']=stopped;result['elapsedSinceDistributionStopSeconds']=round((end-timeline_timestamp(stopped,'supplierStoppedAtUTC')).total_seconds(),1)
    return result

def resolve_prepared_upgrade(request,candidate_files):
    expected=Path(request['resumeBackup']);image=request.get('resumePreparedImage')
    checks={'backupPath':expected.parent==BACKUPS and bool(re.fullmatch('adl-partitioned-upgrade-[A-Za-z0-9_-]+',expected.name)),'backupExists':expected.is_dir(),'backupNotSymlink':not expected.is_symlink(),'backupProtected':False,'preparedImageFormatOrRemoteLookup':image is None or bool(re.fullmatch('adl-worker-partitioned:[0-9a-f]{24}',str(image)))}
    if checks['backupExists'] and checks['backupNotSymlink']:checks['backupProtected']=expected.stat().st_uid==os.geteuid() and expected.stat().st_mode&0o077==0
    emit(operation='cutover.aws',stage='partitioned_upgrade.resume_lookup',status='checking',checks=checks,backup=str(expected) if checks['backupPath'] else 'unverified_path',expectedImage=image if image is not None and checks['preparedImageFormatOrRemoteLookup'] else 'lookup_from_original_receipt' if image is None else 'unverified_image',receiptDirectory=str(SECURE),receiptPattern='partitioned-upgrade-<prepared-image-digest-prefix>.json',workerStarted=False,posnetChanged=False)
    require(all(checks.values()),'RESUME_BACKUP_OR_PREPARED_IMAGE_UNVERIFIED')
    # The preparation receipt belongs to the ORIGINAL prepared image, never to
    # the source digest of a newer executor used merely to resume it.
    path=SECURE/('partitioned-upgrade-'+image.split(':',1)[1]+'.json') if image is not None else None
    matching=[];scanned=0
    for p in sorted(SECURE.glob('partitioned-upgrade-*.json')):
        require(scanned<1024,'RESUME_RECEIPT_SCAN_LIMIT');scanned+=1
        if p.is_symlink() or not p.is_file() or p.stat().st_uid!=os.geteuid() or p.stat().st_mode&0o077 or p.stat().st_size>2*1024**2:continue
        try:record=json.loads(p.read_bytes())
        except (ValueError,UnicodeError):continue
        if isinstance(record,dict) and record.get('backup')==str(expected) and (image is None or record.get('image')==image):matching.append((p,record))
    emit(operation='cutover.aws',stage='partitioned_upgrade.resume_lookup',status='collected',expectedReceipt=str(path) if path else str(SECURE/'partitioned-upgrade-<original-image-prefix>.json'),matchedReceipts=len(matching),checkedFields=['backup','image','digest','phase','oldContainer','baseImageId'],workerStarted=False,posnetChanged=False)
    require(len(matching)==1,'RESUME_ORIGINAL_RECEIPT_NOT_FOUND' if not matching else 'RESUME_ORIGINAL_RECEIPT_NOT_UNIQUE')
    found,record=matching[0];digest=record.get('digest');image=record.get('image')
    require(isinstance(image,str) and re.fullmatch('adl-worker-partitioned:[0-9a-f]{24}',image),'RESUME_ORIGINAL_IMAGE_REFERENCE_UNVERIFIED');suffix=image.split(':',1)[1]
    if path is None:path=SECURE/('partitioned-upgrade-'+suffix+'.json')
    require(found==path and re.fullmatch('[0-9a-f]{64}',str(digest)) and digest[:24]==suffix,'RESUME_ORIGINAL_RECEIPT_DIGEST_MISMATCH')
    require(record.get('phase') in ('prepared','stop_requested','stopped','start_requested','running'),'RESUME_ORIGINAL_PHASE_UNVERIFIED')
    if record.get('phase')=='stop_requested':require(record.get('supplierStoppedBeforeConsumer') is True and re.fullmatch('[0-9a-f]{64}',str(record.get('oldContainer'))) and re.fullmatch('sha256:[0-9a-f]{64}',str(record.get('baseImageId'))),'RESUME_STOP_IDENTITY_UNVERIFIED')
    image_info=json.loads(run(['docker','image','inspect',image]))[0]
    require((image_info.get('Config',{}).get('Labels') or {}).get('eu.adl.partitioned.patch')==digest,'RESUME_PREPARED_IMAGE_LABEL_MISMATCH')
    image_id=image_info['Id'];require(re.fullmatch('sha256:[0-9a-f]{64}',image_id),'RESUME_PREPARED_IMAGE_ID_UNVERIFIED')
    export=source_export_script(PARTITION_FILES|(INDEXED_PUBLICATION_FILES if request.get('pipelineRepair') is True else set()))
    files=json.loads(run(['docker','run','--rm','--network','none','--memory','128m','--read-only','--entrypoint','node',image_id,'-e',export],timeout=30))
    expected_sources=PARTITION_FILES|(INDEXED_PUBLICATION_FILES if request.get('pipelineRepair') is True else set())
    require(isinstance(files,dict) and set(files)==expected_sources and all(isinstance(v,str) and len(v.encode())<256*1024 for v in files.values()),'RESUME_PREPARED_SOURCES_UNVERIFIED')
    require(hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest()==digest,'RESUME_PREPARED_SOURCE_DIGEST_MISMATCH')
    emit(operation='cutover.aws',stage='partitioned_upgrade.resume_resolved',status='verified',receipt=str(found),backup=str(expected),image=image,imageId=image_id,digest=digest,progressPhase=record['phase'],candidateFilesMatchPrepared=files==candidate_files,preparedSourceReused=True,workerStarted=False,imageRebuilt=False,posnetChanged=False)
    return found,record,files

def verify_stopped_retention_origin(old):
    identity=old.get('phase')=='stopped' and old.get('pipelineRepair') is True and partition_memory(old)==6442450944 and re.fullmatch('[0-9a-f]{64}',str(old.get('oldContainer')))
    interrupted=old.get('preExitProof',{}).get('verified') is True and old.get('verifiedExitContainerId')==old.get('oldContainer')
    # A graceful shutdown after a completed persistence cycle is equally safe
    # to derive from: the next phase still hashes the preserved copy and runs
    # the full restore/readback rehearsal before any worker can start. Do not
    # manufacture a pre-exit proof or replay termination for an exited worker.
    samples=old.get('shutdownObservation',{}).get('samples',[])
    final=samples[-1] if samples else {}
    graceful=(old.get('supplierStoppedBeforeConsumer') is True and final.get('running') is False and final.get('exitCode')==0 and final.get('oomKilled') is False and final.get('signalsSent')==0 and isinstance(final.get('lastCompletedPersistence'),dict) and final['lastCompletedPersistence'].get('operation')=='file.persist' and len(old.get('dataBackupHashes',{}))>=6 and all(re.fullmatch('[0-9a-f]{64}',str(value)) for value in old.get('dataBackupHashes',{}).values()) and {row.get('lane') for row in old.get('inboxIntegrity',[]) if row.get('integrity')=='ok'}=={'prematch','inplay'})
    require(identity and (interrupted or graceful),'RETENTION_REPAIR_PRIOR_RECOVERY_UNVERIFIED')

def upgrade_partitioned_unlocked(request):
    stage='partitioned_upgrade.input';backup=None;progress={}
    try:
        require(os.geteuid()==0,'ROOT_REQUIRED');phase=request['phase'];require(phase in ('prepare','activate','rollback'),'INVALID_UPGRADE_PHASE')
        files=request['files'];expected_sources=PARTITION_FILES|(INDEXED_PUBLICATION_FILES if request.get('pipelineRepair') is True else set());require(set(files)==expected_sources,'UPGRADE_FILE_LIST_UNVERIFIED')
        api_compatibility=verify_api_compatibility(request['requiredApiCommit'],request.get('requiredApiSourceManifest'),request.get('requiredApiSourceManifestSha256')) if request.get('pipelineRepair') is True else None
        require(all(isinstance(v,str) and len(v.encode())<256*1024 for v in files.values()),'UPGRADE_SOURCE_SIZE_LIMIT')
        digest=hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest();receipt_path=SECURE/('partitioned-upgrade-'+digest[:24]+'.json')
        if request.get('resumeBackup'):
            receipt_path,saved,files=resolve_prepared_upgrade(request,files);digest=saved['digest']
        meta=json.loads((SECURE/'deployment.json').read_bytes());base=partition_base(meta);before=model(base)
        require(control_status()==200,'API_NOT_HEALTHY')
        memory_limit=snapshot_memory_bytes(before['services']['worker']['mem_limit']);eight_gib_pipeline=request.get('pipelineMemoryEightGiB') is True; snapshot_eight_gib=request.get('snapshotMemoryEightGiBRepair') is True; six_gib_pressure=request.get('snapshotMemoryRepair') is True and request.get('snapshotPressureRepair') is True and request.get('livePersistenceRepair') is True;v8_heap_preserve=request.get('snapshotMemoryRepair') is True and request.get('v8HeapOomRepair') is True
        verified_eight_gib_base=eight_gib_pipeline and request.get('pipelineRepair') is True and request.get('snapshotMemoryRepair') is True and request.get('livePersistenceRepair') is True and memory_limit==8589934592 and before['services']['worker'].get('environment',{}).get('NODE_OPTIONS')=='--max-old-space-size=4608'
        verified_existing_snapshot_profile=verified_existing_snapshot_memory_profile(request.get('verifiedExistingSnapshotMemoryProfile') or {},before['services']['worker'],memory_limit)
        snapshot_headroom=snapshot_host_memory() if snapshot_eight_gib else 0
        verified_snapshot_eight_gib=snapshot_eight_gib and request.get('snapshotMemoryRepair') is True and memory_limit==8589934592 and before['services']['worker'].get('environment',{}).get('NODE_OPTIONS')=='--max-old-space-size=4608' and snapshot_headroom>=12*1024**3
        require(memory_limit==4294967296 or request.get('pipelineRepair') is True and memory_limit==6442450944 or six_gib_pressure and memory_limit==6442450944 or v8_heap_preserve and memory_limit==6442450944 or verified_eight_gib_base or verified_snapshot_eight_gib or verified_existing_snapshot_profile,'UPGRADE_REQUIRES_VERIFIED_EXISTING_MEMORY_LIMIT')
        if eight_gib_pipeline:require(request.get('pipelineRepair') is True and request.get('snapshotMemoryRepair') is True and request.get('livePersistenceRepair') is True and memory_limit in (6442450944,8589934592) and before['services']['worker'].get('environment',{}).get('NODE_OPTIONS')=='--max-old-space-size=4608','EIGHT_GIB_PROFILE_REQUIRES_VERIFIED_BASE_AND_PRESERVED_HEAP')
        inherited_heap_plan=None;defer_existing_profile_probe=False
        if request.get('pipelineRepair'):
            require((request.get('livePersistenceRepair') is True or request.get('stoppedRetentionRepair') is True and request.get('checkpointRepairBackup') and not request.get('resumeBackup')) and request.get('snapshotMemoryRepair') is True and pipeline_memory_identity_verified(memory_limit,verified_eight_gib_base,verified_existing_snapshot_profile),'PIPELINE_REQUIRES_VERIFIED_MEMORY_IDENTITY')
            require(run(['systemctl','is-active','adl-worker-cache-reserve.service']).strip()==b'active','CACHE_RESERVE_NOT_ACTIVE_NO_WORKER_CHANGE')
            if request.get('preservedHeapBudgetRepair') and request.get('resumeBackup'):
                require(before['services']['worker'].get('environment',{}).get('NODE_OPTIONS') in ('--max-old-space-size=2560','--max-old-space-size=3584'),'PIPELINE_EXISTING_HEAP_OPTIONS_CHANGED_NO_DEPLOYMENT')
            elif should_defer_existing_profile_probe(request,verified_existing_snapshot_profile,receipt_path.exists()):
                # The original 8 GiB worker has already been finalized only
                # after a hash-verified replay. Probe its exact profile after
                # loading that receipt; there is no running process to exec.
                defer_existing_profile_probe=True
            else:
                inherited_heap_plan=existing_pipeline_heap_plan(before['services']['worker'],verified_existing_snapshot_profile)
        elif verified_snapshot_eight_gib:
            current_workers=states('worker');require(len(current_workers)==1,'SNAPSHOT_EIGHT_GIB_WORKER_COUNT_UNVERIFIED')
            current_container=json.loads(run(['docker','inspect',current_workers[0]['id']]))[0]
            inherited_heap_plan=preserved_snapshot_eight_gib_heap_plan(current_workers[0],current_container,before['services']['worker'],request.get('snapshotMemorySourceBackup'),request)
        def save(p):
            tmp=SECURE/(receipt_path.name+'.tmp');private(tmp,json.dumps(p).encode());durable_replace(tmp,receipt_path)
        # A failed preserved-data rehearsal has already stopped distribution and
        # protected the data. Derive only the parser fix from that prepared image.
        prior_backup=request.get('checkpointRepairBackup')
        if not receipt_path.exists() and request.get('snapshotMemoryRepair') and prior_backup and not request.get('liveOomRepair') and not request.get('livePersistenceRepair'):
            source_backup=Path(prior_backup)
            require(source_backup.parent==BACKUPS and not source_backup.is_symlink() and source_backup.is_dir() and source_backup.stat().st_uid==os.geteuid() and source_backup.stat().st_mode&0o077==0,'CHECKPOINT_REPAIR_BACKUP_UNVERIFIED')
            previous=[]
            for rp in SECURE.glob('partitioned-upgrade-*.json'):
                require(not rp.is_symlink() and rp.is_file() and rp.stat().st_uid==os.geteuid() and rp.stat().st_size<=1024*1024,'UPGRADE_RECEIPT_UNVERIFIED')
                value=json.loads(rp.read_bytes())
                if value.get('backup')==prior_backup and value.get('phase')=='stopped' and value.get('snapshotMemoryVerified') and not value.get('oomRestoreVerified'):previous.append(value)
            superseded={r['checkpointParserSourceDigest'] for r in previous if r.get('checkpointParserSourceDigest')}
            previous=[r for r in previous if r.get('digest') not in superseded]
            require(len(previous)==1,'CHECKPOINT_REPAIR_SOURCE_NOT_UNIQUE')
            backup=source_backup
            old=previous[0];require(not any(w['running'] for w in states('worker')),'CHECKPOINT_REPAIR_REQUIRES_STOPPED_WORKER')
            if request.get('stoppedRetentionRepair'):verify_stopped_retention_origin(old)
            image_info=json.loads(run(['docker','image','inspect',old['image']]))[0]
            require((image_info.get('Config',{}).get('Labels') or {}).get('eu.adl.partitioned.patch')==old['digest'],'CHECKPOINT_REPAIR_IMAGE_UNVERIFIED')
            # The backup/context is the original image's source. Later parser
            # layers must be compared to their own verified prepared image.
            export="const fs=require('node:fs');let result={};for(const name of "+json.dumps(sorted(files))+"){result[name]=fs.readFileSync('/app/'+name,'utf8')}console.log(JSON.stringify(result))"
            old_files=json.loads(run(['docker','run','--rm','--network','none','--memory','128m','--read-only','--entrypoint','node',old['image'],'-e',export],timeout=30))
            require(set(old_files)==set(files) and all(isinstance(v,str) and len(v.encode())<256*1024 for v in old_files.values()),'CHECKPOINT_REPAIR_SOURCE_UNVERIFIED')
            require(hashlib.sha256(json.dumps(old_files,sort_keys=True,separators=(',',':')).encode()).hexdigest()==old['digest'],'CHECKPOINT_REPAIR_SOURCE_DIGEST_MISMATCH')
            changed=verify_checkpoint_repair_sources(old_files,files)
            context=source_backup/('checkpoint-fix-tagged-'+digest[:24]);context.mkdir(mode=0o700,exist_ok=True)
            for name in changed:
                target=context/'overlay'/name;target.parent.mkdir(parents=True,exist_ok=True,mode=0o755)
                if target.exists():require(target.is_file() and not target.is_symlink() and target.read_bytes()==files[name].encode(),'CHECKPOINT_REPAIR_OVERLAY_CHANGED')
                else:private(target,files[name].encode())
                os.chmod(target,0o644)
            for folder in (context/'overlay').rglob('*'):
                if folder.is_dir():os.chmod(folder,0o755)
            os.chmod(context/'overlay',0o755)
            image='adl-worker-partitioned:'+digest[:24]
            require(re.fullmatch('sha256:[0-9a-f]{64}',image_info['Id']),'CHECKPOINT_REPAIR_BASE_ID_UNVERIFIED')
            tag='adl-partition-base:'+image_info['Id'].split(':')[-1]
            run(['docker','tag',image_info['Id'],tag])
            require(json.loads(run(['docker','image','inspect',tag]))[0]['Id']==image_info['Id'],'CHECKPOINT_REPAIR_BASE_TAG_CHANGED')
            dockerfile=('FROM '+tag+'\nUSER root\nCOPY --chown=node:node overlay/ /app/\nLABEL eu.adl.partitioned.patch="'+digest+'"\nUSER node\n').encode()
            target=context/'Dockerfile'
            if target.exists():require(target.is_file() and not target.is_symlink() and target.read_bytes()==dockerfile,'CHECKPOINT_REPAIR_DOCKERFILE_CHANGED')
            else:private(target,dockerfile)
            stage='partitioned_upgrade.checkpoint_parser_image'
            log=source_backup/'checkpoint-fix-build.private.log'
            archived=source_backup/'checkpoint-fix-build.before-tagged.private.log'
            if log.exists() and not archived.exists():
                require(log.is_file() and not log.is_symlink() and log.stat().st_uid==os.geteuid(),'BUILD_LOG_NOT_PROTECTED')
                shutil.copyfile(log,archived);os.chmod(archived,0o600)
                with archived.open('rb') as fd:os.fsync(fd.fileno())
            emit(operation='cutover.aws',stage='partitioned_upgrade.checkpoint_parser_image.preflight',status='collected',baseImageId=image_info['Id'],baseReference=tag,builder='default',pull=False,workerStarted=False,posnetChanged=False)
            # The default Docker driver shares this daemon's local image store;
            # an externally selected buildx builder may not have the prepared base.
            run(['docker','build','--builder','default','--network','none','--pull=false','-t',image,str(context)],timeout=240,log=log)
            progress={**old,'digest':digest,'image':image,'snapshotMemoryVerified':False,'oomRestoreVerified':False,'projectionSerializationVerified':False,'projectionReadbackVerified':False,'projectionReceiptHash':None,'checkpointParserSourceDigest':old['digest']}
            if request.get('stoppedRetentionRepair'):progress['pipelineLoadVerified']=False
            save(progress)
        if receipt_path.exists():
            require(receipt_path.is_file() and not receipt_path.is_symlink(),'UPGRADE_RECEIPT_UNVERIFIED');progress=json.loads(receipt_path.read_bytes());require(progress['digest']==digest,'UPGRADE_DIGEST_MISMATCH');backup=Path(progress['backup'])
            if defer_existing_profile_probe:
                stopped_profile_proof=verified_stopped_profile_proof(progress,progress.get('oldContainer'))
                inherited_heap_plan=existing_pipeline_heap_plan(before['services']['worker'],verified_existing_snapshot_profile,stopped_profile_proof,progress.get('oldContainer'))
                progress['heapBudgetPlan']=inherited_heap_plan;save(progress)
            if verified_existing_snapshot_profile:
                require(request.get('fullRecovery') is True and progress.get('memoryLimitBytes')==memory_limit and progress.get('image')=='adl-worker-partitioned:'+digest[:24],'EXISTING_SNAPSHOT_MEMORY_PROFILE_RECEIPT_MISMATCH')
                progress['verifiedExistingSnapshotMemoryProfile']=True;progress['existingSnapshotMemoryNodeOptions']=before['services']['worker'].get('environment',{}).get('NODE_OPTIONS');save(progress)
            if request.get('v8HeapOomRepair'):
                require(re.fullmatch('[0-9a-f]{12,63}',str(request.get('expectedOomPrefix',''))) is not None,'EXPECTED_CURRENT_V8_OOM_PREFIX_REQUIRED')
                progress['v8HeapOomRepair']=True;progress['expectedOomPrefix']=request['expectedOomPrefix'];save(progress)
            if request.get('preservedHeapBudgetRepair'):
                progress=inherit_pressure_heap_plan(progress,request,before['services']['worker']);save(progress)
            image_info=json.loads(run(['docker','image','inspect',progress['image']]))[0]
            require((image_info.get('Config',{}).get('Labels') or {}).get('eu.adl.partitioned.patch')==digest,'UPGRADE_IMAGE_LABEL_MISMATCH')
        else:
            require(phase=='prepare','UPGRADE_MUST_BE_PREPARED');workers=states('worker');require(len(workers)==1,'UPGRADE_WORKER_COUNT_UNVERIFIED');verify_stopped_upgrade_worker(workers[0],request,'UPGRADE_REQUIRES_VERIFIED_RUNNING_OR_OOM_WORKER',False)
            # The current 8 GiB worker must first be copied and stopped safely;
            # its cgroup is part of the memory expected to be released. Require
            # 6 GiB while it is live, then keep the 10 GiB gate after confirmed
            # exit and before restore/rehearsal or starting its replacement.
            pre_stop_floor=pre_stop_memory_floor_gib(workers[0]['running'],eight_gib_pipeline,snapshot_eight_gib)
            require(snapshot_host_memory()>=pre_stop_floor*1024**3,'UPGRADE_HOST_MEMORY_HEADROOM_INSUFFICIENT');require(shutil.disk_usage('/opt').free>=(4*1024**3 if request.get('pipelineRepair') else 1024**3),'UPGRADE_DISK_HEADROOM_INSUFFICIENT')
            original_image=before['services']['worker']['image'];base_info=json.loads(run(['docker','image','inspect',original_image]))[0]
            container=json.loads(run(['docker','inspect',workers[0]['id']]))[0];require(container['Image']==base_info['Id'],'UPGRADE_RUNNING_IMAGE_MISMATCH');require(snapshot_memory_bytes(container['HostConfig']['Memory'])==memory_limit,'UPGRADE_CONTAINER_MEMORY_LIMIT_MISMATCH')
            if inherited_heap_plan and inherited_heap_plan.get('preserveExisting') is True:
                actual_env=dict(v.split('=',1) for v in container.get('Config',{}).get('Env',[]) if '=' in v)
                preserved_option='--max-old-space-size='+str(inherited_heap_plan['oldSpaceMiB'])
                require(actual_env.get('NODE_OPTIONS')==before['services']['worker'].get('environment',{}).get('NODE_OPTIONS')==preserved_option,'PIPELINE_ACTIVE_HEAP_SETTING_MISMATCH')
            if request.get('v8HeapOomRepair') and verified_snapshot_eight_gib:
                actual_env=dict(v.split('=',1) for v in container.get('Config',{}).get('Env',[]) if '=' in v)
                require(memory_limit==8589934592 and actual_env.get('NODE_OPTIONS')==before['services']['worker'].get('environment',{}).get('NODE_OPTIONS')=='--max-old-space-size=4608' and inherited_heap_plan.get('preserveExisting') is True and inherited_heap_plan.get('snapshotMemoryEightGiBRepair') is True,'V8_HEAP_EIGHT_GIB_SETTING_CHANGED_NO_DEPLOYMENT')
            elif request.get('v8HeapOomRepair'):
                actual_env=dict(v.split('=',1) for v in container.get('Config',{}).get('Env',[]) if '=' in v)
                require(memory_limit==6442450944 and actual_env.get('NODE_OPTIONS')==before['services']['worker'].get('environment',{}).get('NODE_OPTIONS')=='--max-old-space-size=4608','V8_HEAP_SETTING_CHANGED_NO_DEPLOYMENT')
                inherited_heap_plan={'evidenceVerified':True,'v8HeapCompactionPreserve':True,'previousOldSpaceMiB':4608,'oldSpaceMiB':4608,'containerLimitUnchanged':True,'measuredRedundantTimestampBytes':319*1024*1024}
            probe="const fs=require('node:fs'),h=require('node:crypto');let result={};for(const name of "+json.dumps(sorted(files))+ "){const p='/app/'+name;result[name]=fs.existsSync(p)?h.createHash('sha256').update(fs.readFileSync(p)).digest('hex'):null;}console.log(JSON.stringify(result));"
            # While the old worker is live, read its immutable source directly
            # so an 8 GiB probe container does not coexist with it. If the
            # controlled stop already completed, use the bounded 128 MiB
            # image-only probe instead.
            source_command=(['docker','exec',workers[0]['id'],'node','-e',probe] if workers[0].get('running') and workers[0].get('id') else ['docker','run','--rm','--network','none','--memory','128m','--cpus','0.5','--read-only','--entrypoint','node',original_image,'-e',probe])
            hashes=json.loads(run(source_command,timeout=30))
            # Fail on the exact changed source set before image-identity and
            # recovery-receipt checks. This is a safety preflight, not a test
            # shortcut: every patch still has to pass its mode-specific proof.
            identity_upgrade=any(request.get(key) is True for key in ('liveOomRepair','livePersistenceRepair','fullRecovery'))
            if not identity_upgrade:require(hashes==request['baseHashes'],'UPGRADE_BASE_SOURCES_CHANGED_NO_BLIND_PATCH')
            if request.get('liveOomRepair') or request.get('livePersistenceRepair') or request.get('fullRecovery'):
                identity_proof='verified_full_recovery_source' if request.get('fullRecovery') is True else verify_current_worker_identity(workers[0],request,original_image)
                if identity_proof=='verified_v8_heap_exit':
                    emit(operation='cutover.aws',stage='partitioned_upgrade.identity_comparison',status='verified',checks={'snapshotMemoryRepair':request.get('snapshotMemoryRepair') is True,'v8HeapExitIdentity':True,'workerImageMatchesCompose':container['Image']==base_info['Id'],'workerStopped':workers[0].get('running') is False},workerStarted=False,workerRestarted=False,providerRequests=0,posnetChanged=False)
                old_digest=(base_info.get('Config',{}).get('Labels') or {}).get('eu.adl.partitioned.patch');require(re.fullmatch('[0-9a-f]{64}',str(old_digest)),'CURRENT_OOM_IMAGE_LABEL_UNVERIFIED')
                old_receipt=SECURE/('partitioned-upgrade-'+old_digest[:24]+'.json');require(old_receipt.is_file() and not old_receipt.is_symlink() and old_receipt.stat().st_uid==os.geteuid() and old_receipt.stat().st_mode&0o077==0,'CURRENT_OOM_SOURCE_RECEIPT_MISSING')
                old=json.loads(old_receipt.read_bytes());verify_current_source_receipt(old,original_image,old_digest,request.get('fullRecovery') is True,BACKUPS)
                base_source_names=sorted(current_image_source_names(request.get('pipelineRepair') is True) if request.get('pipelineRepair') is True else files)
                export="const fs=require('node:fs');const names="+json.dumps(base_source_names)+";console.log(JSON.stringify(Object.fromEntries(names.map(n=>[n,fs.existsSync('/app/'+n)?fs.readFileSync('/app/'+n,'utf8'):null]))))"
                old_files=json.loads(run(['docker','run','--rm','--network','none','--memory','128m','--read-only','--entrypoint','node',original_image,'-e',export],timeout=30))
                old_files={name:value for name,value in old_files.items() if value is not None}
                verify_active_container_source_hashes(hashes,files,old_files)
                if request.get('snapshotCheckpointMemoryRepair'):
                    require(request.get('snapshotMemoryRepair') is True and request.get('liveOomRepair') is True and re.fullmatch('[0-9a-f]{12,63}',str(request.get('expectedOomPrefix',''))),'SNAPSHOT_CHECKPOINT_REPAIR_IDENTITY_REQUIRED')
                    verify_snapshot_checkpoint_memory_sources(old_files,files,old_digest)
                elif request.get('checkpointWriteBufferRepair'):
                    require(request.get('pipelineRepair') is True and request.get('livePersistenceRepair') is True and request.get('transportLifecycleRepair') is True,'CHECKPOINT_BUFFER_REQUIRES_VERIFIED_TRANSPORT_PIPELINE')
                    verify_checkpoint_buffer_sources(old_files,files,old_digest)
                elif request.get('transportLifecycleRepair'):
                    require(request.get('pipelineRepair') is True and request.get('livePersistenceRepair') is True,'TRANSPORT_LIFECYCLE_REQUIRES_LIVE_PIPELINE_IDENTITY')
                    verify_transport_lifecycle_sources(old_files,files,old_digest)
                elif request.get('publicationReserveRepair'):
                    require(request.get('pipelineRepair') is True and request.get('livePersistenceRepair') is True,'PUBLICATION_RESERVE_REQUIRES_LIVE_PIPELINE_IDENTITY')
                    verify_publication_reserve_sources(old_files,files,old_digest)
                elif request.get('pipelineRepair'):
                    legacy_files={name:old_files[name] for name in PIPELINE_BASE_FILES|PIPELINE_AUXILIARY_FILES if name in old_files}
                    added_files={name:old_files[name] for name in set(PIPELINE_ADDED_DEPENDENCY_SHA256)|set(PIPELINE_PINNED_ADDED_DEPENDENCY_SHA256) if name in old_files}
                    indexed_old_files={name:old_files[name] for name in INDEXED_PUBLICATION_FILES if name in old_files}
                    verify_pipeline_sources(legacy_files,files,old_digest,added_files,indexed_old_files)
                elif request.get('snapshotPressureRepair'):
                    require(request.get('livePersistenceRepair') is True and request.get('liveOomRepair') is not True,'PRESSURE_REPAIR_REQUIRES_VERIFIED_LIVE_WORKER')
                    verify_live_snapshot_pressure_sources(old_files,files,old_digest)
                elif request.get('fullRecovery'):
                    verify_full_recovery_sources(old_files,files,old_digest)
                else:verify_live_oom_sources(old_files,files,old_digest)
            else:require(hashes==request['baseHashes'],'UPGRADE_BASE_SOURCES_CHANGED_NO_BLIND_PATCH')
            backup=Path(tempfile.mkdtemp(prefix='adl-partitioned-upgrade-',dir=BACKUPS));os.chmod(backup,0o700)
            private(backup/'deployment.before.json',(SECURE/'deployment.json').read_bytes());private(backup/'model.before.private.json',json.dumps(before).encode())
            context=backup/'context';context.mkdir(mode=0o700)
            for name,data in files.items():
                target=context/'overlay'/name;target.parent.mkdir(parents=True,exist_ok=True,mode=0o755);private(target,data.encode());os.chmod(target,0o644)
            tag='adl-partition-base:'+base_info['Id'].split(':')[-1];run(['docker','tag',base_info['Id'],tag]);require(json.loads(run(['docker','image','inspect',tag]))[0]['Id']==base_info['Id'],'UPGRADE_BASE_TAG_CHANGED')
            image='adl-worker-partitioned:'+digest[:24]

            for directory in (context/'overlay').rglob('*'):
                if directory.is_dir():os.chmod(directory,0o755)
            os.chmod(context/'overlay',0o755)
            dockerfile='FROM '+tag+'\nUSER root\nCOPY --chown=node:node overlay/ /app/\nLABEL eu.adl.partitioned.patch="'+digest+'"\nUSER node\n'
            private(context/'Dockerfile',dockerfile.encode());stage='partitioned_upgrade.build'
            run(['docker','build','--builder','default','--network','none','--pull=false','-t',image,str(context)],timeout=240,log=backup/'build.private.log')
            stage='partitioned_upgrade.offline_validation'
            check="""import{decodeMessage}from'/app/apps/worker/src/messages.ts';import{partitionedSnapshot,subscriptionInventory}from'/app/apps/worker/src/partitioned-snapshot.ts';await import('/app/apps/worker/src/connected.ts');const sdk=await import('trade360-nodejs-sdk');if(sdk.knownEntityKeys.get(38)!=='OutrightLeagueFixtureUpdate')throw Error();const body={Competition:{Id:1,Competitions:[{Id:2,Events:[{FixtureId:3,OutrightLeague:{FixtureName:'ISOLATED OFFLINE',Status:1,LastUpdate:'2026-10-19T06:00:00Z'}}]}]}};const decoded=decodeMessage(Buffer.from(JSON.stringify({Header:{Type:38,MsgGuid:'offline-38',ServerTimestamp:1792389601000},Body:body})),{});if(decoded.events[0]?.outright?.fixture?.fixtureName!=='ISOLATED OFFLINE')throw Error();if(subscriptionInventory({fixtures:[2,1]},{Body:{Fixtures:[2,1]}}).join(',')!=='1,2')throw Error();let rejected=false;try{subscriptionInventory({fixtures:['PRIVATE_OFFLINE']},{Body:{Fixtures:['PRIVATE_OFFLINE']}})}catch(e){rejected=e.diagnostic?.snapshotValidation?.code==='inventory_invalid_ids'}if(!rejected)throw Error();let applied=0;const p=await partitionedSnapshot({async inventory(){return[11,12]},async events(ids){return ids.map(fixtureId=>({fixtureId,fixture:{status:1}}))}},{assertOpen(){},async begin(){},async batch(rows){applied+=rows.length},async progress(){}},{batchSize:1});if(p.stage!=='complete'||applied!==2)throw Error();console.log('partitioned-offline-ok');"""
            output=run(['docker','run','--rm','--network','none','--memory','384m','--cpus','0.5','--read-only','--tmpfs','/tmp:size=33554432,mode=1777','--entrypoint','node',image,'--import','tsx','--input-type=module','-e',check],timeout=30)
            require(b'partitioned-offline-ok' in output,'UPGRADE_OFFLINE_TEST_FAILED')
            inherited_v8_compaction=bool(inherited_heap_plan and inherited_heap_plan.get('v8HeapCompactionPreserve') is True and request.get('pipelineRepair') is True and request.get('snapshotMemoryRepair') is True)
            snapshot_eight_headroom=snapshot_host_memory() if verified_snapshot_eight_gib else 0
            if verified_snapshot_eight_gib:require(snapshot_eight_headroom>=12*1024**3,'SNAPSHOT_EIGHT_GIB_HOST_HEADROOM_CHANGED')
            progress={'version':1,'digest':digest,'phase':'prepared','backup':str(backup),'image':image,'baseImage':original_image,'baseImageId':base_info['Id'],'memoryLimitBytes':memory_limit,'pipelineMemoryEightGiB':eight_gib_pipeline,'snapshotMemoryEightGiBRepair':verified_snapshot_eight_gib,'snapshotMemoryEightGiBHeadroomBytes':snapshot_eight_headroom,'verifiedExistingSnapshotMemoryProfile':verified_existing_snapshot_profile,'existingSnapshotMemoryNodeOptions':before['services']['worker'].get('environment',{}).get('NODE_OPTIONS') if verified_existing_snapshot_profile else None,'pipelineRepair':request.get('pipelineRepair') is True,'snapshotMemoryRepair':request.get('snapshotMemoryRepair') is True,'snapshotPressureRepair':request.get('snapshotPressureRepair') is True,'livePersistenceRepair':request.get('livePersistenceRepair') is True,'v8HeapOomRepair':request.get('v8HeapOomRepair') is True,'inheritedV8HeapCompactionPlan':inherited_v8_compaction,**({'expectedOomPrefix':request.get('expectedOomPrefix')} if request.get('v8HeapOomRepair') else {}),**({'heapBudgetPlan':inherited_heap_plan} if inherited_heap_plan else {})};save(progress)
        if request.get('measuredSnapshotApplyHeapRepair'):
            require(request.get('pipelineRepair') is True and request.get('livePersistenceRepair') is True and request.get('snapshotMemoryRepair') is True,'MEASURED_HEAP_REQUEST_SCOPE_UNVERIFIED')
            plan=measured_snapshot_apply_heap_plan(progress,backup,states('worker'))
            if progress.get('heapBudgetPlan',{}).get('measuredSnapshotApply') is True:
                require(progress['heapBudgetPlan']==plan,'MEASURED_HEAP_PLAN_CHANGED')
            progress['heapBudgetPlan']=plan;progress['measuredSnapshotApplyHeapRepair']=True;save(progress)
            emit(operation='cutover.aws',stage='partitioned_upgrade.heap_budget',status='candidate_for_real_copy_acceptance',**plan,workerStarted=False,posnetChanged=False)
        if request.get('preservedHeapBudgetRepair'):
            if request.get('pipelineRepair'):
                require(request.get('resumeBackup') and request.get('snapshotMemoryRepair'),'HEAP_REPAIR_RESUME_SCOPE_UNVERIFIED')
                plan=progress['heapBudgetPlan'] if progress.get('heapBudgetPlan') and progress.get('oomRestoreVerified') else preserved_heap_budget_plan(progress,backup,states('worker'))
            else:
                require(request.get('resumeBackup') and request.get('snapshotMemoryRepair') and request.get('snapshotPressureRepair') and request.get('livePersistenceRepair') and progress.get('heapBudgetPlan'),'PRESERVED_PRESSURE_HEAP_RESUME_SCOPE_UNVERIFIED')
                plan=progress['heapBudgetPlan']
            partition_heap_mib({**progress,'heapBudgetPlan':plan})
            if progress.get('heapBudgetPlan') is None:
                private(backup/('heap-budget-plan-'+os.urandom(8).hex()+'.json'),json.dumps(plan).encode());progress['heapBudgetPlan']=plan;save(progress)
            require(progress['heapBudgetPlan']==plan,'HEAP_REPAIR_SAVED_PLAN_CHANGED')
            emit(operation='cutover.aws',stage='partitioned_upgrade.heap_budget',status='candidate_for_real_copy_acceptance',**plan,workerStarted=False,posnetChanged=False)
        if request.get('fixCommit')=='2aa06f7' and not progress.get('distributionFixVerified'):
            stage='partitioned_upgrade.offline_propagation'
            propagation="""import{createServer}from'node:http';import{clients}from'/app/apps/worker/src/provider.ts';import{StartMessage,DEFUALT_DISTRIBUTION_PROPAGATION_DELAY_MS}from'trade360-nodejs-sdk';if(DEFUALT_DISTRIBUTION_PROPAGATION_DELAY_MS!==2000)throw Error();let started=0,checks=0;const server=createServer(async(req,res)=>{for await(const b of req){}res.setHeader('Content-Type','application/json');if(req.url==='/Distribution/Start'){started=Date.now();res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:{Message:StartMessage.activated}}))}else{checks++;res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:{IsDistributionOn:checks>1&&Date.now()-started>=2000}}))}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{const url='http://127.0.0.1:'+server.address().port,api=clients({lane:'prematch',packageId:4511,username:'offline-only',password:'offline-only',hostname:'unused',vhost:'unused',queue:'unused',port:5672,tls:false},{snapshotUrl:url,customersUrl:url});await api.startDistribution();const last=api.distributionObservations().at(-1);if(last.stage!=='after_propagation'||last.bodyIsDistributionOn!==true||last.sdkIsDistributionOn!==true||last.elapsedSinceStartMs<2000||checks!==2)throw Error();console.log('distribution-propagation-offline-ok')}finally{await new Promise(resolve=>server.close(resolve))}"""
            output=run(['docker','run','--rm','--network','none','--memory','384m','--cpus','0.5','--read-only','--tmpfs','/tmp:size=33554432,mode=1777','--entrypoint','node',progress['image'],'--import','tsx','--input-type=module','-e',propagation],timeout=30)
            require(b'distribution-propagation-offline-ok' in output,'UPGRADE_PROPAGATION_TEST_FAILED');progress['distributionFixVerified']=True;progress['fixCommit']='2aa06f7';save(progress)
        if request.get('fullRecovery') and not progress.get('fullRecoveryVerified'):
            stage='partitioned_upgrade.offline_full_recovery'
            check="""import{mkdtemp,writeFile,rm}from'node:fs/promises';import{walkSnapshot,convertSnapshotRow}from'/app/apps/worker/src/full-snapshot.ts';const dir=await mkdtemp('/tmp/full-offline-');try{const p=dir+'/response';await writeFile(p,JSON.stringify({Body:[{FixtureId:11,Fixture:{Status:1},Markets:[]}],Header:{HttpStatusCode:200}}));let n=0;await walkSnapshot(p,async r=>{if(convertSnapshotRow(r).fixtureId!==11)throw Error();n++});if(n!==1)throw Error();await writeFile(p,'{"Body":[],"Header":{"Errors":["isolated"]}}');let rejected=false;try{await walkSnapshot(p,async()=>{})}catch{rejected=true}if(!rejected)throw Error();console.log('full-recovery-offline-ok')}finally{await rm(dir,{recursive:true,force:true})}"""
            output=run(['docker','run','--rm','--network','none','--memory','384m','--cpus','0.5','--read-only','--tmpfs','/tmp:size=33554432,mode=1777','--entrypoint','node',progress['image'],'--import','tsx','--input-type=module','-e',check],timeout=30)
            require(b'full-recovery-offline-ok' in output,'FULL_RECOVERY_OFFLINE_TEST_FAILED');progress['fullRecoveryVerified']=True;save(progress)
        if request.get('supplierOrder') and not progress.get('supplierOrderVerified'):
            stage='partitioned_upgrade.offline_supplier_order'
            check="import {session} from '/app/apps/worker/src/connected.ts';import {TradeState} from '/app/apps/worker/src/state.ts';import {EventEmitter} from 'node:events';for(const lane of ['prematch','inplay']){const order=[],state=new TradeState(),abort=new AbortController();let ready=false;const channel=Object.assign(new EventEmitter(),{async prefetch(){},async consume(){order.push('consume');return{consumerTag:'offline'};}});const connection=Object.assign(new EventEmitter(),{async createChannel(){return channel},async close(){order.push('close');connection.emit('close');}});const api={async startDistribution(){order.push('start');await new Promise(r=>setTimeout(r,5));ready=true;order.push('status_on')},async stopDistribution(){order.push('stop')},async distributionStatus(){return{isDistributionOn:true}},async snapshot(){order.push('snapshot');return[]},async catalog(){return[]}};const pkg={lane,packageId:lane==='prematch'?4511:4510,queue:'unused',hostname:'unused',vhost:'unused',username:'offline',password:'offline',port:5672,tls:false};await session(pkg,{packages:[pkg],staleMs:90000,recoveryMs:300000},state,async()=>{if(state.connections[lane].phase==='connected')abort.abort()},abort.signal,{clientFactory:()=>api,connect:async()=>{if(!ready)throw Error('connect before propagation');order.push('connect');return connection}});if(order.slice(0,5).join(',')!=='start,status_on,connect,consume,snapshot'||order.indexOf('stop')>order.indexOf('close'))throw Error('supplier sequence wrong')}console.log('supplier-order-offline-ok');"
            output=run(['docker','run','--rm','--network','none','--memory','384m','--cpus','0.5','--read-only','--tmpfs','/tmp:size=33554432,mode=1777','--entrypoint','node',progress['image'],'--import','tsx','--input-type=module','-e',check],timeout=30)
            require(b'supplier-order-offline-ok' in output,'SUPPLIER_ORDER_OFFLINE_TEST_FAILED');progress['supplierOrderVerified']=True;save(progress)
        if request.get('supplierOrder') and progress.get('supplierOrderVerified'):
            # Image rollback preserves every non-worker definition and all current data.
            # Never start the known pre-fix order automatically after restoring it.
            rollback=backup/'rollback.worker.private.json'
            if not rollback.exists():
                old_worker=json.loads((backup/'model.before.private.json').read_bytes())['services']['worker']
                private(rollback,json.dumps({'services':{'worker':old_worker}}).replace('$','$$').encode())
        if request.get('nullableEvidence') and not progress.get('nullableMarketsVerified'):
            stage='partitioned_upgrade.offline_nullable_markets'
            evidence=Path(request['nullableEvidence'])
            require(evidence.parent==BACKUPS and re.fullmatch('adl-snapshot-shape-[A-Za-z0-9_-]+',evidence.name) and evidence.is_dir() and not evidence.is_symlink() and evidence.stat().st_mode&0o077==0 and evidence.stat().st_uid==BACKUPS.stat().st_uid,'CAPTURED_EVIDENCE_DIRECTORY_UNVERIFIED')
            source=evidence/'rejected-row.private.json';report=evidence/'report.json'
            for path,limit in ((source,16*1024**2),(report,65536)):
                require(path.is_file() and not path.is_symlink() and 0<path.stat().st_size<=limit and path.stat().st_mode&0o077==0 and path.stat().st_uid==evidence.stat().st_uid,'CAPTURED_EVIDENCE_FILE_UNVERIFIED')
            row_bytes=source.read_bytes();row=json.loads(row_bytes);proof=json.loads(report.read_bytes())
            require(proof.get('rawRowSha256')==hashlib.sha256(row_bytes).hexdigest() and proof.get('rawRowBytes')==len(row_bytes),'CAPTURED_EVIDENCE_HASH_MISMATCH')
            require(row.get('FixtureId')==20563979 and 'Markets' in row and row['Markets'] is None and proof.get('rejection',{}).get('path')=='Markets' and proof['rejection'].get('actualType')=='null','CAPTURED_NULL_MARKETS_NOT_CONFIRMED')
            require(proof.get('sdk',{}).get('conversion')=='succeeded' and proof['sdk'].get('markets',{}).get('type')=='null','CAPTURED_SDK_SEMANTICS_UNCONFIRMED')
            copy_path=backup/'captured-row.private.json'
            if copy_path.exists():require(copy_path.read_bytes()==row_bytes,'CAPTURED_BACKUP_CHANGED')
            else:private(copy_path,row_bytes)
            check="import{readFileSync}from'node:fs';import{convertSnapshotRow}from'/app/apps/worker/src/full-snapshot.ts';const raw=JSON.parse(readFileSync('/evidence/rejected-row.private.json','utf8')),row=convertSnapshotRow(raw);if(row.fixtureId!==20563979||row.markets!==null||!row.fixture)throw Error('captured row changed');const bets=convertSnapshotRow({FixtureId:1,Fixture:{Status:1},Markets:[{Id:1,Bets:null}]});if(bets.markets[0].bets!==null)throw Error('bets absence changed');for(const Markets of [{},'invalid',[null],[{Id:1,Bets:{}}],[{Id:1,Bets:[null]}]]){let rejected=false;try{convertSnapshotRow({FixtureId:1,Fixture:{Status:1},Markets})}catch{rejected=true}if(!rejected)throw Error('invalid shape accepted')}console.log('nullable-markets-offline-ok');"
            output=run(['docker','run','--rm','--network','none','--memory','384m','--cpus','0.5','--read-only','--tmpfs','/tmp:size=33554432,mode=1777','--user','0','--mount','type=bind,source='+str(evidence)+',target=/evidence,readonly','--entrypoint','node',progress['image'],'--import','tsx','--input-type=module','-e',check],timeout=30)
            require(b'nullable-markets-offline-ok' in output,'CAPTURED_NULLABLE_ROW_OFFLINE_FAILED');progress['nullableMarketsVerified']=True;progress['capturedRowSha256']=proof['rawRowSha256'];save(progress)
        if request.get('throughputFix') and not progress.get('throughputVerified'):
            stage='partitioned_upgrade.offline_throughput'
            require(progress.get('nullableMarketsVerified') is True,'THROUGHPUT_REQUIRES_CAPTURED_NULLABLE_ROW_TEST')
            check="import{session,coalescedPersistence}from'/app/apps/worker/src/connected.ts';import{TradeState}from'/app/apps/worker/src/state.ts';import{EventEmitter}from'node:events';let version=1,captures=[],release=[];const save=coalescedPersistence(async()=>{captures.push(version);await new Promise(r=>release.push(r))});const one=save();await new Promise(r=>setImmediate(r));version=2;const two=save();version=3;const three=save();if(two!==three||one===two)throw Error('unsafe coalescing');release.shift()();await one;await new Promise(r=>setImmediate(r));if(captures.join(',')!=='1,3')throw Error('capture order');release.shift()();await two;const state=new TradeState(),abort=new AbortController();let writes=0;const channel=Object.assign(new EventEmitter(),{async prefetch(){},async consume(){return{consumerTag:'offline'}}}),connection=Object.assign(new EventEmitter(),{async createChannel(){return channel},async close(){connection.emit('close')}});const pkg={lane:'prematch',packageId:4511,username:'isolated',password:'isolated',hostname:'unused',queue:'unused',vhost:'unused',tls:false,port:5672};const api={async startDistribution(){},async stopDistribution(){},async distributionStatus(){return{isDistributionOn:true}},async snapshot(){throw Error('unexpected')},async catalog(){return[]},async snapshotFull(sink){const now=new Date().toISOString();await sink.progress({stage:'waiting_http',lastProgressAt:now,bytes:1,validatedRows:1600,appliedRows:0});await sink.progress({stage:'apply',lastProgressAt:now,bytes:1,validatedRows:1600,appliedRows:0});for(let i=1;i<=1600;i++)await sink.apply({fixtureId:i,fixture:{status:1},markets:null},Date.now());await sink.progress({stage:'complete',lastProgressAt:new Date().toISOString(),bytes:1,validatedRows:1600,appliedRows:1600});return{ids:new Set(Array.from({length:1600},(_,i)=>i+1)),rows:1600,bytes:1}}};await session(pkg,{packages:[pkg],staleMs:90000,recoveryMs:300000},state,async()=>{writes++;if(state.connections.prematch.phase==='connected')abort.abort()},abort.signal,{clientFactory:()=>api,connect:async()=>connection});if(writes>=15)throw Error('redundant full checkpoints');console.log('throughput-offline-ok');"
            output=run(['docker','run','--rm','--network','none','--memory','384m','--cpus','0.5','--read-only','--tmpfs','/tmp:size=33554432,mode=1777','--entrypoint','node',progress['image'],'--import','tsx','--input-type=module','-e',check],timeout=45)
            require(b'throughput-offline-ok' in output,'THROUGHPUT_OFFLINE_VALIDATION_FAILED');progress['throughputVerified']=True;save(progress)
        if request.get('durableIngress') and not progress.get('durableIngressVerified'):
            stage='partitioned_upgrade.offline_durable_ingress'
            check="import{connectDurableMq,openInbox}from'/app/apps/worker/src/durable-ingress.mjs';import{mkdtemp,rm}from'node:fs/promises';const d=await mkdtemp('/tmp/inbox-'),p=d+'/raw.sqlite';let latest;const c=await connectDurableMq({},p,m=>latest=m,{offline:true});c.offline([{content:Buffer.from('payload'),properties:{headers:{MessageType:3}},fields:{}}]);for(let i=0;i<100&&latest?.acknowledged!==1;i++)await new Promise(r=>setTimeout(r,10));if(latest?.acknowledged!==1||latest?.processed!==0)throw Error('not durable ahead of processing');await c.close();const db=openInbox(p);if(db.stats().backlog!==1)throw Error('missing replay');db.close();await rm(d,{recursive:true,force:true});console.log('durable-ingress-offline-ok');"
            if request.get('snapshotMemoryRepair'):
                check="import{connectDurableMq,openInbox}from'/app/apps/worker/src/durable-ingress.mjs';import{mkdtemp,rm}from'node:fs/promises';const d=await mkdtemp('/tmp/inbox-'),p=d+'/raw.sqlite';let latest;const c=await connectDurableMq({},p,m=>latest=m,{offline:true}),ch=await c.createChannel();await ch.consume('offline',msg=>ch.stage(msg));c.offline([{content:Buffer.from('payload'),properties:{headers:{MessageType:3}},fields:{}}]);for(let i=0;i<1000&&latest?.processed!==1;i++)await new Promise(r=>setTimeout(r,10));if(latest?.acknowledged!==1||latest?.processed!==1||latest?.checkpointed!==0||latest?.backlog!==1||latest?.processingBacklog!==0)throw Error('not durable ahead of processing');await c.close();const db=openInbox(p);if(db.stats().backlog!==1)throw Error('missing replay');db.close();await rm(d,{recursive:true,force:true});console.log('durable-ingress-offline-ok');"
            output=run(durable_ingress_proof_command(backup,progress['image'],check),timeout=45,log=backup/'durable-ingress-test.private.log')
            require(b'durable-ingress-offline-ok' in output,'DURABLE_INGRESS_OFFLINE_FAILED');progress['durableIngressVerified']=True;save(progress)
        if request.get('snapshotMemoryRepair') and not progress.get('snapshotMemoryVerified'):
            stage='partitioned_upgrade.offline_snapshot_memory'
            check="import{persistRegularCheckpoint,checkpoint,restore}from'/app/apps/worker/src/persistence.ts';import{TradeState}from'/app/apps/worker/src/state.ts';import{createPublisher}from'/app/packages/feed-store/src/index.ts';import{mkdtemp,rm}from'node:fs/promises';const dir=await mkdtemp('/tmp/checkpoint-proof-'),path=dir+'/feed.json',s=new TradeState();for(let id=1;id<=500;id++)s.apply('prematch',[{fixtureId:id,fixture:{status:1},markets:Array.from({length:8},(_,m)=>({id:m+1,status:1,bets:Array.from({length:8},(_,b)=>({id:String(b),price:'2.1',status:1}))}))}],Date.now());if(checkpoint(s,false).regular.length!==0)throw Error('full checkpoint captured');await persistRegularCheckpoint(path,s);const f=s.feed(Date.now(),true,true),g=s.feed(Date.now(),true,true);if(f.events[0]!==g.events[0])throw Error('projection cache missing');await createPublisher(path)(f,{...checkpoint(s,false),regularExternal:true},s.availabilityBlocks());const recovered=new TradeState(),result=await restore(recovered,path);if(result.rows!==500||[...recovered.rows.prematch.values()].some(r=>!r.restored))throw Error('incomplete checkpoint recovery');await rm(dir,{recursive:true,force:true});console.log('snapshot-memory-offline-ok');"
            args=durable_ingress_proof_command(backup,progress['image'],check,'snapshot-memory-proof.mjs');args[-1:-1]=['--import','tsx'];args[args.index('512m')]='1g'
            output=run(args,timeout=90,log=backup/'snapshot-memory-test.private.log')
            require(b'snapshot-memory-offline-ok' in output,'SNAPSHOT_MEMORY_OFFLINE_FAILED');progress['snapshotMemoryVerified']=True;save(progress)
        if request.get('snapshotPressureRepair') and not progress.get('snapshotPressureVerified'):
            stage='partitioned_upgrade.offline_snapshot_pressure'
            args=durable_ingress_proof_command(backup,progress['image'],SNAPSHOT_PRESSURE_PROOF,'snapshot-pressure-proof.mjs')
            args[args.index('512m')]='4g';args[args.index('0.5')]='2';args[args.index('/tmp:size=268435456,mode=1777')]='/tmp:size=1073741824,mode=1777';args[args.index('--memory')+2:args.index('--memory')+2]=['--memory-swap','4g']
            args[-1:-1]=['--max-old-space-size=2560','--import','tsx']
            output=run(args,timeout=45,log=backup/'snapshot-pressure-test.private.log')
            require(b'snapshot-pressure-offline-ok' in output,'SNAPSHOT_PRESSURE_OFFLINE_TEST_FAILED')
            progress['snapshotPressureVerified']=True;save(progress)
        if request.get('snapshotPressureRepair'):require(progress.get('snapshotPressureVerified') is True,'SNAPSHOT_PRESSURE_PROOF_REQUIRED_NO_START')
        pipeline_proof_sha256=None
        if request.get('pipelineRepair') and 'PIPELINE_LOAD_PROOF' in globals():
            pipeline_proof_sha256=pipeline_proof_revision(PIPELINE_LOAD_PROOF)
            if progress.get('pipelineLoadProofSha256')!=pipeline_proof_sha256:
                progress['pipelineLoadVerified']=False;progress['pipelineLoadProofSha256']=None;save(progress)
            if progress.get('pipelineMemoryEightGiB') is True and not progress.get('pipelineLoadVerified'):
                saved_proof=reuse_pipeline_load_proof(backup,pipeline_proof_sha256,PIPELINE_LOAD_PROOF)
                if saved_proof:
                    progress['pipelineLoadMetrics']=saved_proof['metrics'];progress['pipelineLoadVerified']=True;progress['pipelineLoadProofSha256']=pipeline_proof_sha256;progress['pipelineLoadProofReused']=saved_proof;save(progress)
                    emit(operation='cutover.aws',stage='partitioned_upgrade.offline_pipeline_load',status='reused_verified_artifact',proofSha256=pipeline_proof_sha256,privateLog=saved_proof['log'],metrics=saved_proof['metrics'],workerStarted=False,posnetChanged=False)
        elif request.get('pipelineRepair'):
            require(progress.get('pipelineLoadVerified') is True,'PIPELINE_LOAD_PROOF_SOURCE_UNAVAILABLE')
        if request.get('pipelineRepair') and not progress.get('pipelineLoadVerified'):
            stage='partitioned_upgrade.offline_pipeline_load'
            proof_name='pipeline-load-proof-'+pipeline_proof_sha256[:16]+'.mjs'
            args=durable_ingress_proof_command(backup,progress['image'],PIPELINE_LOAD_PROOF,proof_name)
            args=partition_rehearsal_args(args,progress);args[args.index('0.5')]='2'
            work=backup/'pipeline-load-work';work.mkdir(mode=0o700,exist_ok=True);os.chown(work,1000,1000)
            args[args.index('--entrypoint'):args.index('--entrypoint')]=['--mount','type=bind,source='+str(work)+',target=/proof','-e','TMPDIR=/proof']
            args[-1:-1]=['--max-old-space-size='+str(partition_heap_mib(progress)),'--import','tsx']
            log=backup/('pipeline-load-'+os.urandom(6).hex()+'.private.log')
            try:output=streamed_rehearsal_run(args,timeout=1800,log=log)
            except (subprocess.CalledProcessError,subprocess.TimeoutExpired) as error:
                raw=read_tail(log);known=re.findall(rb'(?:Error: )(PIPELINE_[A-Z_]{3,100})',raw)
                emit(operation='cutover.aws',stage=stage,status='blocked',reason='PIPELINE_LOAD_ACCEPTANCE_FAILED_NO_STOP',signals=classify(raw),knownFailureCode=known[-1].decode() if known else None,privateLog=log.name,childExitCode=getattr(error,'returncode',None),workerStarted=False,posnetChanged=False)
                raise RuntimeError('PIPELINE_LOAD_ACCEPTANCE_FAILED_NO_STOP') from None
            require(b'pipeline-load-offline-ok' in output and b'inbox-capacity-offline-ok' in output,'PIPELINE_LOAD_ACCEPTANCE_FAILED_NO_STOP')
            for line in output.decode().splitlines():
                try:r=json.loads(line)
                except ValueError:continue
                if r.get('operation')=='pipeline.offline.complete':
                    progress['pipelineLoadMetrics']={k:v for k,v in r.items() if k in ('snapshotBytes','snapshotRows','applied','preload','received','acknowledged','processed','checkpointed','finalBacklog','writes','maxPersistMs','peakRSSBytes','maxEventLoopDelayMs','readbackRows') and type(v) in (int,float)}
                    load=r.get('load') or {}
                    if isinstance(load,dict):
                        if type(load.get('sent')) in (int,float):progress['pipelineLoadMetrics']['loadSent']=load['sent']
                        if type(load.get('durationMs')) in (int,float):progress['pipelineLoadMetrics']['loadDurationMs']=load['durationMs']
            if progress.get('pipelineMemoryEightGiB') is True:
                m=progress.get('pipelineLoadMetrics',{});require(pipeline_load_metrics_valid(m,PIPELINE_LOAD_PROOF),'EIGHT_GIB_PIPELINE_ACCEPTANCE_METRICS_FAILED')
            progress['pipelineLoadVerified']=True;progress['pipelineLoadProofSha256']=pipeline_proof_sha256;save(progress)
        if request.get('pipelineRepair'):require(progress.get('pipelineLoadVerified') is True,'PIPELINE_PROOF_REQUIRED_NO_STOP')
        if phase=='prepare':
            if request.get('spoolMemoryFix') and not progress.get('spoolMemoryVerified'):
                stage='partitioned_upgrade.offline_spool_memory'
                check="import{fullSnapshotMemory}from'/app/apps/worker/src/full-snapshot.ts';import{snapshotCapacity}from'/app/apps/worker/src/snapshot-capacity.ts';process.availableMemory=()=>1024*1024*1024;fullSnapshotMemory();process.availableMemory=()=>64*1024*1024;let blocked=false;try{fullSnapshotMemory()}catch(e){blocked=e.diagnostic?.reason==='memory_budget_exceeded'}if(!blocked)throw Error('low memory guard bypassed');console.log('spool-memory-offline-ok')"
                output=run(['docker','run','--rm','--network','none','--memory','512m','--cpus','0.5','--read-only','--tmpfs','/tmp:size=33554432,mode=1777','--entrypoint','node',progress['image'],'--max-old-space-size=512','--import','tsx','--input-type=module','-e',check],timeout=60,log=backup/'spool-memory-test.private.log')
                require(b'spool-memory-offline-ok' in output,'SPOOL_MEMORY_OFFLINE_FAILED');progress['spoolMemoryVerified']=True;save(progress)
            if request.get('snapshotThroughputFix') and not progress.get('snapshotThroughputVerified'):
                stage='partitioned_upgrade.offline_snapshot_throughput'
                check="import{writeFile,mkdtemp,rm}from'node:fs/promises';import{walkSnapshot,convertSnapshotRow}from'/app/apps/worker/src/full-snapshot.ts';const d=await mkdtemp('/tmp/parser-'),p=d+'/body';let ticks=0,rows=0;const timer=setInterval(()=>ticks++,1);try{const bets=Array.from({length:300},(_,i)=>({Id:String(i+1),Price:'2.00',Status:1}));await writeFile(p,JSON.stringify({Body:Array.from({length:200},(_,i)=>({FixtureId:i+1,Fixture:{Status:1},Markets:[{Id:1,Bets:bets}]})),Header:{}}));await walkSnapshot(p,async raw=>{convertSnapshotRow(raw);rows++});if(rows!==200||ticks<2)throw Error('parser did not yield');console.log('snapshot-throughput-offline-ok')}finally{clearInterval(timer);await rm(d,{recursive:true,force:true})}"
                output=run(['docker','run','--rm','--network','none','--memory','512m','--cpus','0.5','--read-only','--tmpfs','/tmp:size=33554432,mode=1777','--entrypoint','node',progress['image'],'--max-old-space-size=384','--import','tsx','--input-type=module','-e',check],timeout=60,log=backup/'snapshot-throughput-test.private.log')
                require(b'snapshot-throughput-offline-ok' in output,'SNAPSHOT_THROUGHPUT_OFFLINE_FAILED');progress['snapshotThroughputVerified']=True;save(progress)
            emit(operation='cutover.aws',stage='partitioned_upgrade.prepared',status='ok',image=progress['image'],progressPhase=progress['phase'],offlinePipelineLoadVerified=progress.get('pipelineLoadVerified',False),offlineType38Verified=True,offlinePartitionsVerified=True,offlineRestoreVerified=progress.get('oomRestoreVerified',False),offlineSnapshotMemoryVerified=progress.get('snapshotMemoryVerified',False),offlineDurableIngressVerified=progress.get('durableIngressVerified',False),offlinePropagationVerified=progress.get('distributionFixVerified',False),offlineFullRecoveryVerified=progress.get('fullRecoveryVerified',False),offlineSupplierOrderVerified=progress.get('supplierOrderVerified',False),offlineNullableMarketsVerified=progress.get('nullableMarketsVerified',False),offlineThroughputVerified=progress.get('throughputVerified',False),offlineSpoolMemoryVerified=progress.get('spoolMemoryVerified',False),offlineSnapshotThroughputVerified=progress.get('snapshotThroughputVerified',False),offlineSnapshotPressureVerified=progress.get('snapshotPressureVerified',False),apiCompatibility=api_compatibility,workerRestarted=False,backup=str(backup),posnetChanged=False);return 0
        stage='partitioned_upgrade.fresh_mac_gate'
        handoff=request['handoff'];audit=handoff['audit'];require(audit['status']=='ok' and audit['workerLockAbsent'] and audit['matchingWorkerProcesses']==0,'MAC_SHUTDOWN_UNPROVEN')
        require(request['freshAuditAt'].endswith('Z') and -5<=time.time()-datetime.datetime.fromisoformat(request['freshAuditAt'].replace('Z','+00:00')).timestamp()<60,'MAC_REAUDIT_EXPIRED')
        digest_handoff=hashlib.sha256(json.dumps(handoff,sort_keys=True,separators=(',',':')).encode()).hexdigest();migration_receipt=SECURE/('cutover-'+digest_handoff+'.json');migration=json.loads(migration_receipt.read_bytes());require(migration.get('startRequestedAtUTC'),'MIGRATION_NOT_COMPLETE')
        saved_model=json.loads((backup/'model.before.private.json').read_bytes());current=model(partition_base(meta))
        active_api_matches=False
        if current!=saved_model:
            api=states('api')
            if len(api)==1 and api[0].get('running') is True and api[0].get('health')=='healthy':
                info=json.loads(run(['docker','inspect',api[0]['id']]))[0]
                ref=current.get('services',{}).get('api',{}).get('image')
                active_api_matches=info.get('Config',{}).get('Image')==ref
                if active_api_matches:
                    expected_id=json.loads(run(['docker','image','inspect',ref]))[0].get('Id')
                    active_api_matches=info.get('Image')==expected_id
        expected_from_saved=expected_partitioned_model(saved_model,progress,request.get('snapshotMemoryRepair') is True)
        rollback_from_saved=copy.deepcopy(saved_model) if progress.get('pipelineMemoryEightGiB') is True else copy.deepcopy(expected_from_saved)
        if progress.get('pipelineMemoryEightGiB') is not True:rollback_from_saved['services']['worker']['image']=progress['baseImage']
        activation_model=activation_base_model(saved_model,current,active_api_matches,(expected_from_saved,rollback_from_saved))
        expected=expected_partitioned_model(activation_model,progress,request.get('snapshotMemoryRepair') is True)
        rollback_expected=copy.deepcopy(activation_model) if progress.get('pipelineMemoryEightGiB') is True else copy.deepcopy(expected)
        if progress.get('pipelineMemoryEightGiB') is not True:rollback_expected['services']['worker']['image']=progress['baseImage']
        require(current==activation_model or current==expected or phase=='rollback' and current==rollback_expected,'DEPLOYMENT_CHANGED_SINCE_UPGRADE_PREPARE')
        image_id=json.loads(run(['docker','image','inspect',progress['image']]))[0]['Id']
        if phase=='rollback':
            stage='partitioned_upgrade.rollback'
            rollback=backup/'rollback.worker.private.json'
            require(progress.get('supplierOrderVerified') and rollback.is_file() and not rollback.is_symlink(),'ROLLBACK_NOT_PREPARED')
            workers=states('worker')
            rollback_recovery=progress.get('rollbackRecoveryGeneration')
            if rollback_recovery:verify_recovery_generation(backup,rollback_recovery)
            if progress['phase']=='rolled_back_stopped':
                require(not any(w['running'] for w in workers) and rollback_recovery,'ROLLED_BACK_WORKER_UNEXPECTEDLY_RUNNING')
                emit(operation='cutover.aws',stage='partitioned_upgrade.rollback',status='ok',reused=True,recoveryGeneration=rollback_recovery,workerStarted=False,oldWorkerKeptStopped=True,posnetChanged=False);return 0
            if any(w['running'] for w in workers):
                require(len(workers)==1 and progress.get('rollbackStopRequested') is not True,'ROLLBACK_STOP_PENDING_NO_MORE_SIGNALS')
                info=json.loads(run(['docker','inspect',workers[0]['id']]))[0]
                require(info['Image']==image_id,'ROLLBACK_WORKER_IDENTITY_CHANGED')
                feed_mounts=[m for m in info.get('Mounts',[]) if m.get('Destination')=='/app/.runtime/feed' and m.get('Type')=='volume']
                require(len(feed_mounts)==1,'ROLLBACK_RECOVERY_VOLUME_UNVERIFIED')
                volume=json.loads(run(['docker','volume','inspect',feed_mounts[0]['Name']]))[0]
                require((volume.get('Labels') or {}).get('com.docker.compose.project')=='adl-homologation','ROLLBACK_RECOVERY_VOLUME_PROJECT_UNVERIFIED')
                rollback_directory=Path(volume['Mountpoint']);require(not rollback_directory.is_symlink(),'ROLLBACK_RECOVERY_VOLUME_SYMLINK')
                rollback_budget=rollback_recovery_disk_preflight(rollback_directory,backup)
                emit(operation='cutover.aws',stage='partitioned_upgrade.rollback_recovery_preflight',status='verified',**rollback_budget,workerStarted=False,posnetChanged=False)
                environment=info['Config']['Env'];require(all(isinstance(v,str) and '\n' not in v and '\r' not in v for v in environment),'STOP_ENV_FORMAT_UNVERIFIED')
                env_file=backup/'rollback-stop.private.env';env_content=('\n'.join(environment)+'\n').encode()
                if env_file.exists():require(env_file.is_file() and not env_file.is_symlink() and env_file.stat().st_mode&0o077==0 and env_file.read_bytes()==env_content,'ROLLBACK_ENV_CHANGED')
                else:private(env_file,env_content)
                code="import{loadConfig}from'/app/apps/worker/src/config.ts';import{clients}from'/app/apps/worker/src/provider.ts';for(const pkg of loadConfig().packages){await clients(pkg,loadConfig()).stopDistribution()}console.log('planned-distribution-stop-ok');"
                output=run(['docker','run','--rm','--network','container:'+workers[0]['id'],'--memory','256m','--read-only','--tmpfs','/tmp:size=33554432,mode=1777','--env-file',str(env_file),'-e','NODE_OPTIONS=--max-old-space-size=128','--entrypoint','node',progress['image'],'--import','tsx','--input-type=module','-e',code],timeout=90,log=backup/'rollback-stop.private.log')
                require(b'planned-distribution-stop-ok' in output,'ROLLBACK_DISTRIBUTION_STOP_NOT_CONFIRMED')
                progress['rollbackStopRequested']=True;save(progress)
                run(['docker','kill','--signal','SIGTERM',workers[0]['id']])
                deadline=time.time()+90
                while time.time()<deadline and any(c['running'] for c in states('worker')):time.sleep(1)
            require(not any(c['running'] for c in states('worker')),'ROLLBACK_GRACEFUL_STOP_PENDING_NO_MORE_SIGNALS')
            if not rollback_recovery:
                stopped=states('worker');require(len(stopped)==1,'ROLLBACK_STOPPED_CONTAINER_IDENTITY_UNVERIFIED')
                stopped_info=json.loads(run(['docker','inspect',stopped[0]['id']]))[0]
                require(stopped_info['Image']==image_id and not stopped_info['State']['Running'],'ROLLBACK_STOPPED_IMAGE_UNVERIFIED')
                feed_mounts=[m for m in stopped_info.get('Mounts',[]) if m.get('Destination')=='/app/.runtime/feed' and m.get('Type')=='volume']
                require(len(feed_mounts)==1,'ROLLBACK_RECOVERY_VOLUME_UNVERIFIED')
                volume=json.loads(run(['docker','volume','inspect',feed_mounts[0]['Name']]))[0]
                require((volume.get('Labels') or {}).get('com.docker.compose.project')=='adl-homologation','ROLLBACK_RECOVERY_VOLUME_PROJECT_UNVERIFIED')
                rollback_directory=Path(volume['Mountpoint']);require(not rollback_directory.is_symlink(),'ROLLBACK_RECOVERY_VOLUME_SYMLINK')
                require(not (rollback_directory/'trade-feed.json.lock').exists() and not list(rollback_directory.glob('trade-feed.json*.reclaim')),'ROLLBACK_RECOVERY_LOCK_STILL_PRESENT')
                rollback_recovery=capture_recovery_generation(rollback_directory,backup)
                progress['rollbackRecoveryGeneration']=rollback_recovery;save(progress)
                verified_generation=verify_recovery_generation(backup,rollback_recovery)
                emit(operation='cutover.aws',stage='partitioned_upgrade.rollback_recovery',status='verified',**verified_generation,freeDiskBytes=rollback_recovery.get('freeBytesAfter'),workerStarted=False,posnetChanged=False)
            else:verify_recovery_generation(backup,rollback_recovery)
            # Use an override containing only the old image. Existing overrides,
            # data and journals remain authoritative; never restore old data.
            old_overlay=SECURE/('compose.worker-rollback-'+digest[:24]+'.json')
            content=json.dumps({'services':{'worker':{'image':progress['baseImage'],**({'mem_limit':'6g'} if progress.get('pipelineMemoryEightGiB') is True else {})}}}).encode()
            if old_overlay.exists():require(old_overlay.is_file() and not old_overlay.is_symlink() and old_overlay.read_bytes()==content,'ROLLBACK_OVERLAY_CHANGED')
            else:private(old_overlay,content)
            candidate=partition_base(meta)+['-f',str(old_overlay)]
            reverted=copy.deepcopy(saved_model) if progress.get('pipelineMemoryEightGiB') is True else copy.deepcopy(current)
            if progress.get('pipelineMemoryEightGiB') is not True:reverted['services']['worker']['image']=progress['baseImage']
            require(model(candidate)==reverted,'ROLLBACK_NON_WORKER_CHANGE_DETECTED')
            meta['composeOverrides']=[*meta.get('composeOverrides',[]),str(old_overlay)]
            temporary=SECURE/(receipt_path.name+'.rollback.tmp');private(temporary,json.dumps(meta).encode());durable_replace(temporary,SECURE/'deployment.json')
            run(partition_base(meta)+['--profile','feed-consumer','create','--no-deps','--no-build','--pull','never','worker'],timeout=90,log=backup/'rollback.private.log')
            progress['phase']='rolled_back_stopped';save(progress)
            emit(operation='cutover.aws',stage='partitioned_upgrade.rollback',status='ok',workerStarted=False,oldImageRestored=True,oldWorkerKeptStopped=True,dataRestored=False,recoveryGeneration=rollback_recovery,posnetChanged=False);return 0
        require(progress['phase']!='rolled_back_stopped','ROLLED_BACK_WORKER_REQUIRES_REVIEW')
        if progress['phase'] in ('start_requested','running'):
            workers=states('worker');require(len(workers)==1 and workers[0]['running'],'UPGRADED_WORKER_NOT_RUNNING_NO_BLIND_RESTART');current_container=json.loads(run(['docker','inspect',workers[0]['id']]))[0]
            require(current_container['Image']==image_id and snapshot_memory_bytes(current_container['HostConfig']['Memory'])==candidate_memory(progress),'UPGRADED_CONTAINER_MISMATCH')
            env=dict(x.split('=',1) for x in current_container['Config']['Env'] if '=' in x);require(env.get('LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT')=='true' and env.get('LSPORTS_INPLAY_STREAMED_SNAPSHOT')=='true','PARTITION_FLAG_NOT_APPLIED')
            runtime=verify_budgeted_worker_runtime(progress,workers[0]['id'],current_container,image_id) if progress.get('heapBudgetPlan') else None
            if request.get('snapshotMemoryRepair'):require(env.get('NODE_OPTIONS')=='--max-old-space-size='+str(partition_heap_mib(progress)),'WORKER_HEAP_RESERVE_NOT_APPLIED')
            if runtime:emit(operation='cutover.aws',stage='partitioned_upgrade.heap_runtime_verify',status='verified',containerId=workers[0]['id'],imageId=image_id,**runtime,posnetChanged=False)
            progress['phase']='running';save(progress);emit(operation='cutover.aws',stage='partitioned_upgrade.running',status='ok',offlineRestoreVerified=progress.get('oomRestoreVerified',False),reused=True,workerStarted=True,startedAtUTC=progress.get('startAt'),posnetChanged=False);return 0
        worker_states=states('worker')
        if progress['phase']=='prepared':
            emit(operation='cutover.aws',stage='partitioned_upgrade.old_worker.inspect',status='collected',workerStates=worker_states,backup=str(backup),posnetChanged=False)
            require(len(worker_states)==1,'OLD_WORKER_COUNT_UNVERIFIED');verify_stopped_upgrade_worker(worker_states[0],request,'OLD_WORKER_EXIT_REQUIRES_REVIEW',True,progress.get('oomContainerId'));pre_stop_floor=pre_stop_memory_floor_gib(worker_states[0]['running'],progress.get('pipelineMemoryEightGiB') is True,progress.get('snapshotMemoryEightGiBRepair') is True);require(snapshot_host_memory()>=pre_stop_floor*1024**3,'UPGRADE_HOST_MEMORY_HEADROOM_INSUFFICIENT')
            old_container=json.loads(run(['docker','inspect',worker_states[0]['id']]))[0];
            if request.get('snapshotMemoryRepair') and not worker_states[0]['running']:
                require(old_container.get('HostConfig',{}).get('RestartPolicy',{}).get('Name') in ('no',''),'OOM_RESTART_POLICY_UNSAFE')
                if worker_states[0].get('oomKilled') is True and worker_states[0].get('exitCode')==137 or request.get('v8HeapOomRepair') and worker_states[0].get('oomKilled') is False and worker_states[0].get('exitCode')==134:
                    progress['oomContainerId']=worker_states[0]['id'];save(progress)
            require(old_container['Image']==progress['baseImageId'] and snapshot_memory_bytes(old_container['HostConfig']['Memory'])==partition_memory(progress),'OLD_WORKER_IDENTITY_CHANGED_BEFORE_STOP')
            if worker_states[0]['running'] and request.get('snapshotMemoryRepair'):
                stage='partitioned_upgrade.pre_stop_disk'
                storage_before_stop(backup,old_container,progress,digest)
            if request.get('fullRecovery') and not progress.get('supplierStoppedBeforeConsumer'):
                stage='partitioned_upgrade.distribution_stop'
                info=json.loads(run(['docker','inspect',worker_states[0]['id']]))[0]
                environment=info['Config']['Env'];require(all(isinstance(v,str) and '\n' not in v and '\r' not in v for v in environment),'STOP_ENV_FORMAT_UNVERIFIED')
                env_file=backup/'stop-distribution.private.env';env_content=('\n'.join(environment)+'\n').encode()
                if env_file.exists():require(env_file.is_file() and not env_file.is_symlink() and env_file.stat().st_mode&0o077==0 and env_file.read_bytes()==env_content,'STOP_ENV_BACKUP_CHANGED')
                else:private(env_file,env_content)
                previous=distribution_stop_log_summary(backup)
                emit(operation='cutover.aws',stage='partitioned_upgrade.distribution_stop.inspect',status='collected',previousAttempt=previous,workerStates=worker_states,preparedImage=progress['image'],backup=str(backup),imageRebuilt=False,posnetChanged=False)
                helper_memory,helper_heap=('384m','256') if 'heap_exhausted' in previous.get('signals',[]) else ('256m','128')
                # Old helper may have stopped one package before failing. Query BOTH
                # current states before any Stop; an already-off package is never stopped again.
                code="""import{loadConfig}from'/app/apps/worker/src/config.ts';import{clients}from'/app/apps/worker/src/provider.ts';import{describeFailure}from'/app/apps/worker/src/diagnostics.ts';const config=loadConfig(),feeds=[];let pkgId,step='configuration';try{for(const pkg of config.packages){pkgId=pkg.packageId;step='status_before';const api=clients(pkg,config),s=await api.distributionStatus(),o=api.distributionObservations().at(-1);if(typeof o?.bodyIsDistributionOn!=='boolean'||o.bodyIsDistributionOn!==s.isDistributionOn)throw Object.assign(Error(),{code:'STATUS_SHAPE_UNVERIFIED'});console.log(JSON.stringify({operation:'upgrade.distribution_stop',observedAtUTC:new Date().toISOString(),packageId:pkgId,stage:'before',bodyIsDistributionOn:o.bodyIsDistributionOn,sdkIsDistributionOn:s.isDistributionOn,action:s.isDistributionOn?'status_only':'already_off'}));feeds.push({pkg,api,on:s.isDistributionOn})}for(const f of feeds){pkgId=f.pkg.packageId;if(f.on){step='stop';console.log(JSON.stringify({operation:'upgrade.distribution_stop',observedAtUTC:new Date().toISOString(),packageId:pkgId,stage:'before',action:'stop_requested'}));await f.api.stopDistribution()}step='status_after';const s=await f.api.distributionStatus();if(s.isDistributionOn!==false)throw Object.assign(Error(),{code:'DISTRIBUTION_STILL_ON'});console.log(JSON.stringify({operation:'upgrade.distribution_stop',observedAtUTC:new Date().toISOString(),packageId:pkgId,stage:'after',sdkIsDistributionOn:false}))}console.log('planned-distribution-stop-ok')}catch(error){const d=describeFailure(error,'distribution.stop','http');console.log(JSON.stringify({operation:'upgrade.distribution_stop',observedAtUTC:new Date().toISOString(),packageId:pkgId,stage:'failed',step,localReason:['STATUS_SHAPE_UNVERIFIED','DISTRIBUTION_STILL_ON'].includes(error?.code)?error.code:undefined,category:d.category,reason:d.reason,httpStatus:d.httpStatus,rateLimitSource:d.rateLimitSource}));process.exitCode=2}"""
                output=run(['docker','run','--rm','--network',('container:'+worker_states[0]['id']) if worker_states[0]['running'] else 'bridge','--memory',helper_memory,'--cpus','0.5','--read-only','--tmpfs','/tmp:size=33554432,mode=1777','--env-file',str(env_file),'-e','NODE_OPTIONS=--max-old-space-size='+helper_heap,'--entrypoint','node',progress['image'],'--import','tsx','--input-type=module','-e',code],timeout=90,log=backup/'distribution-stop.private.log')
                current_stop=distribution_stop_log_summary(backup);emit(operation='cutover.aws',stage='partitioned_upgrade.distribution_stop.result',status='collected',distribution=current_stop,posnetChanged=False)
                require(b'planned-distribution-stop-ok' in output,'PLANNED_DISTRIBUTION_STOP_NOT_CONFIRMED_CONSUMER_PRESERVED')
                progress['supplierStoppedBeforeConsumer']=True;progress['supplierStoppedAtUTC']=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z');save(progress)
            progress['oldContainer']=worker_states[0]['id']
            if worker_states[0]['running']:
                stage='partitioned_upgrade.graceful_stop';request_graceful_signal_once(progress,save,backup,distribution_required=request.get('fullRecovery') is True)
            else:
                progress['phase']='stopped';save(progress)
        if progress['phase']=='stop_requested':
            stage='partitioned_upgrade.stop_observation'
            current=states('worker');require(len(current)==1 and current[0]['id']==progress.get('oldContainer'),'STOP_CONTAINER_IDENTITY_CHANGED')
            if current[0]['running']:
                stage='partitioned_upgrade.stop_signal_evidence'
                evidence=collect_graceful_signal_evidence(progress);decision=graceful_signal_decision(progress,evidence)
                progress['stopSignalEvidence']=evidence;progress['stopSignalDecision']=decision;save(progress)
                emit(operation='cutover.aws',stage=stage,status='collected',decision=decision,backup=str(backup),evidence=evidence,forceStopEvidenceVerified=False,posnetChanged=False)
                require(decision not in ('signal_history_inconclusive','signal_intent_delivery_inconclusive'),'STOP_SIGNAL_HISTORY_INCONCLUSIVE_NO_REPEAT')
                if decision=='first_request_verified':request_graceful_signal_once(progress,save,backup)
                elif decision=='already_requested' and request.get('finalizeAfterRecovery') and any(r.get('status')=='ok' for r in evidence.get('shutdownLogs',[])):
                    stage='partitioned_upgrade.pre_exit_recovery';recover_completed_shutdown(progress,save,backup,evidence)
                elif decision=='already_requested' and progress.get('shutdownObservation',{}).get('samples'):
                    previous=progress['shutdownObservation']['samples'][-1];fresh=upgrade_stop_sample(progress)
                    measured_work=False
                    if fresh['running'] and previous.get('observationElapsedSeconds',0)>=90 and fresh.get('files')==previous.get('files') and fresh.get('lastCompletedPersistence')==previous.get('lastCompletedPersistence'):
                        if previous.get('containerWork') is not None:
                            measured_work=work_counter_progress(previous['containerWork'],fresh.get('containerWork'),sample_elapsed_seconds(previous,fresh))
                        elif fresh.get('containerWork') is not None:
                            time.sleep(8);later=upgrade_stop_sample(progress);measured_work=work_counter_progress(fresh.get('containerWork'),later.get('containerWork'));fresh=later
                    if fresh['running'] and not previous.get('progressSincePreviousSample') and not measured_work and previous.get('observationElapsedSeconds',0)>=90 and fresh.get('files')==previous.get('files') and fresh.get('lastCompletedPersistence')==previous.get('lastCompletedPersistence'):
                        if request.get('pipelineRepair') and request.get('finalizeAfterRecovery') and incomplete_shutdown_recovery_eligible(progress,evidence,previous,fresh):
                            emit(operation='cutover.aws',stage='partitioned_upgrade.stop_diagnosis',status='recovery_proof_required',reason='GRACEFUL_SHUTDOWN_STALLED_REPLAY_BEFORE_FINALIZE',applicationStoppingObserved=True,persistenceStage=fresh.get('persistenceStage'),checkpointFilesStable=True,distributionStayedOff=True,forceStopEvidenceVerified=False,backup=str(backup),posnetChanged=False)
                            stage='partitioned_upgrade.pre_exit_recovery';recover_incomplete_shutdown_safely(progress,save,backup,evidence,previous,fresh)
                        else:
                            emit(operation='cutover.aws',stage='partitioned_upgrade.stop_diagnosis',status='blocked',reason='SHUTDOWN_ALREADY_REQUESTED_RECOVERY_PROOF_REQUIRED',applicationStoppingObserved=evidence.get('applicationStoppingObserved'),process=evidence.get('process'),lastPersistence=fresh.get('lastCompletedPersistence'),persistenceStage=fresh.get('persistenceStage'),backup=str(backup),forceStopEvidenceVerified=False,posnetChanged=False)
                            raise RuntimeError('SHUTDOWN_ALREADY_REQUESTED_RECOVERY_PROOF_REQUIRED')
                    if measured_work:emit(operation='cutover.aws',stage='partitioned_upgrade.stop_diagnosis',status='measured_process_work',cpuOrIoAdvanced=True,containerWork=fresh.get('containerWork'),backup=str(backup),signalsSent=0,forceStopEvidenceVerified=False,posnetChanged=False)
                stage='partitioned_upgrade.stop_observation'
                def observed(report):
                    progress['shutdownObservation']=report;save(progress)
                    emit(operation='cutover.aws',stage='partitioned_upgrade.stop_observation',status='observing',backup=str(backup),**report['samples'][-1],forceStopEvidenceVerified=False,posnetChanged=False)
                if any(w['running'] for w in states('worker')):
                    initial=upgrade_stop_sample(progress)
                    budget=resumed_stop_budget(progress,request.get('fullRecovery') is True,initial) if request.get('resumeBackup') or request.get('pipelineRepair') or request.get('fullRecovery') else 180
                    emit(operation='cutover.aws',stage='partitioned_upgrade.resume_stop_status',status='collected',backup=str(backup),current=initial,shutdownLogs=evidence.get('shutdownLogs',[]),observationBudgetSeconds=budget,signalsSent=0,forceStopEvidenceVerified=False,posnetChanged=False)
                    try:watch_upgrade_stop(lambda:upgrade_stop_sample(progress),observed,timeout=budget)
                    except RuntimeError:
                        # No second signal or generic extra wait. An already completed
                        # shutdown can proceed only through the existing copy/replay proof.
                        latest=collect_graceful_signal_evidence(progress)
                        if request.get('pipelineRepair') and request.get('finalizeAfterRecovery') and any(r.get('status')=='ok' for r in latest.get('shutdownLogs',[])):
                            recover_completed_shutdown(progress,save,backup,latest)
                        elif request.get('pipelineRepair') and request.get('finalizeAfterRecovery') and progress.get('shutdownObservation',{}).get('samples'):
                            # A stopping application can remain alive after its
                            # bounded observation. Continue only if the saved
                            # samples and a fresh counter delta prove quiescence;
                            # then verify exact copied state by replay before any
                            # final signal. Never treat timeout alone as proof.
                            previous=progress['shutdownObservation']['samples'][-1]
                            fresh=upgrade_stop_sample(progress)
                            elapsed=sample_elapsed_seconds(previous,fresh)
                            no_work=not work_counter_progress(previous.get('containerWork'),fresh.get('containerWork'),elapsed)
                            if (fresh.get('running') and previous.get('observationElapsedSeconds',0)>=90 and
                                previous.get('progressSincePreviousSample') is False and
                                fresh.get('files')==previous.get('files') and
                                fresh.get('lastCompletedPersistence')==previous.get('lastCompletedPersistence') and no_work and
                                incomplete_shutdown_recovery_eligible(progress,latest,previous,fresh)):
                                emit(operation='cutover.aws',stage='partitioned_upgrade.stop_diagnosis',status='recovery_proof_required',reason='GRACEFUL_SHUTDOWN_QUIESCENT_REPLAY_BEFORE_FINALIZE',checkpointFilesStable=True,distributionStayedOff=True,containerWorkElapsedSeconds=round(elapsed,1),forceStopEvidenceVerified=False,backup=str(backup),posnetChanged=False)
                                stage='partitioned_upgrade.pre_exit_recovery';recover_incomplete_shutdown_safely(progress,save,backup,latest,previous,fresh)
                            else:raise
                        else:raise
            else:
                if progress.get('preExitProof',{}).get('verified') and progress.get('verifiedExitSignal'):confirm_pre_exit_finalization(progress,save)
                emit(operation='cutover.aws',stage='partitioned_upgrade.stop_observation',status='exited',container=current[0],backup=str(backup),signalsSent=0,posnetChanged=False)
            require(not any(c['running'] for c in states('worker')),'UPGRADE_GRACEFUL_STOP_PENDING_NO_MORE_SIGNALS');progress['phase']='stopped';save(progress)
        if request.get('measuredSnapshotRetryHeapRepair') and not progress.get('measuredSnapshotRetryHeapRepair'):
            stage='partitioned_upgrade.measured_snapshot_retry_heap'
            plan=measured_snapshot_retry_heap_plan(progress,backup,states('worker'))
            progress['heapBudgetPlan']=plan;progress['measuredSnapshotRetryHeapRepair']=True;save(progress)
            emit(operation='cutover.aws',stage=stage,status='candidate_for_real_copy_acceptance',**plan,workerStarted=False,posnetChanged=False)
        stage='partitioned_upgrade.persistence'
        api=states('api');require(len(api)==1 and api[0]['health']=='healthy','API_NOT_HEALTHY');api_info=json.loads(run(['docker','inspect',api[0]['id']]))[0]
        mounts=[m for m in api_info['Mounts'] if m['Destination']=='/app/.runtime/feed'];require(len(mounts)==1 and mounts[0]['Type']=='volume' and not mounts[0]['RW'],'FEED_VOLUME_UNVERIFIED')
        vol=json.loads(run(['docker','volume','inspect',mounts[0]['Name']]))[0];require((vol.get('Labels') or {}).get('com.docker.compose.project')=='adl-homologation','VOLUME_PROJECT_UNVERIFIED');directory=Path(vol['Mountpoint'])
        if not request.get('snapshotMemoryRepair'):require(not (directory/'trade-feed.json.lock').exists() and not list(directory.glob('trade-feed.json*.reclaim')) and not list(directory.glob('trade-feed.json.snapshot-*.lock')),'UPGRADE_LOCK_PRESENT_PRESERVED')
        if progress['phase']=='stopped' and request.get('snapshotMemoryRepair') and not progress.get('oomRestoreVerified'):
            preflight_candidates=[p for p in directory.glob('.full-snapshot-*/response.private.json') if p.is_file() and not p.is_symlink() and not p.parent.is_symlink() and re.fullmatch(r'\.full-snapshot-[A-Za-z0-9_-]{1,80}',p.parent.name) and 0<p.stat().st_size<=2*1024**3]
            preflight_spool=max(preflight_candidates,key=lambda p:p.stat().st_mtime) if preflight_candidates else None
            staged_recovery_disk_preflight(directory,backup,progress,digest,preflight_spool)
        if progress['phase']=='stopped':
            recovery_files=pre_stop_copy_files(directory)
            scheduler_journals=[p for p in directory.glob('trade-feed.json.snapshot-*.json') if re.fullmatch(r'trade-feed\.json\.snapshot-[0-9a-f]{16}\.json',p.name)]
            for source in [*recovery_files,*scheduler_journals]:
                if not source.exists():continue
                require(source.is_file() and not source.is_symlink(),'PERSISTENCE_SOURCE_UNVERIFIED');target=backup/source.name
                sqlite_source=source.name.endswith('.sqlite')
                if not target.exists():
                    if sqlite_source:
                        sqlite_meta=sqlite_consistent_backup(source,target)
                        progress.setdefault('sqliteBackupReceipts',{})[source.name]=sqlite_meta
                    else:
                        shutil.copyfile(source,target);os.chmod(target,0o600)
                        with target.open('rb') as copied:os.fsync(copied.fileno())
                # Preserve and verify the first backup even if SQLite later updates only SHM.
                recorded=progress.get('dataBackupHashes',{}).get(source.name)
                if sqlite_source:require(sqlite3_integrity(target),'SQLITE_BACKUP_READBACK_FAILED')
                require((snapshot_file_hash(target)==recorded and (sqlite_source or snapshot_file_hash(source)==recorded)) if recorded else sqlite_source or snapshot_file_hash(source)==snapshot_file_hash(target),'UPGRADE_BACKUP_HASH_MISMATCH')
                progress.setdefault('dataBackupHashes',{})[source.name]=snapshot_file_hash(target)
            save(progress)
            if request.get('snapshotMemoryRepair'):
                stage='partitioned_upgrade.oom_integrity'
                require(not any(w['running'] for w in states('worker')),'OOM_RECOVERY_REQUIRES_NO_CONSUMER')
                if progress.get('oomContainerId') or progress.get('verifiedExitContainerId'):archive_oom_locks(directory,backup,progress,states('worker'))
                require(not (directory/'trade-feed.json.lock').exists() and not list(directory.glob('trade-feed.json*.reclaim')) and not list(directory.glob('trade-feed.json.snapshot-*.lock')),'OOM_LOCKS_NOT_ARCHIVED')
                progress['inboxIntegrity']=verify_oom_inboxes(directory)
                if request.get('resumeProjectionSerialization'):
                    require(not request.get('resumeBackup') and phase in ('prepare','activate') and (phase!='activate' or request.get('verifyOnly') is True or progress.get('oomRestoreVerified') is True),'PROJECTION_RESUME_PHASE_UNVERIFIED')
                    if not progress.get('oomRestoreVerified'):
                        evidence=verify_projection_resume_artifacts(backup,progress,image_info,request.get('projectionResumeDirectory'))
                        progress.update(projectionSerializationVerified=True,projectionReadbackVerified=True,oomRestoreVerified=True,rehearsalCopyVerified=True,preservedSpoolRehearsed=True,projectionReceiptHash=snapshot_file_hash(backup/evidence['directory']/'output'/'receipt.json'),projectionResumeEvidence=evidence)
                        save(progress)
                        emit(operation='cutover.aws',stage='partitioned_upgrade.projection_resume_verified',status='ok',**evidence,posnetChanged=False)
                    else:
                        evidence=progress.get('projectionResumeEvidence') or {};resume_name=request.get('projectionResumeDirectory')
                        require(progress.get('projectionSerializationVerified') is True and progress.get('projectionReadbackVerified') is True and progress.get('preservedSpoolRehearsed') is True and evidence.get('verified') is True and evidence.get('directory')==resume_name,'PROJECTION_RESUME_RECEIPT_NOT_PRESENT')
                        resume=backup/resume_name;projection=resume/'output'/'projection.json';receipt_path=resume/'output'/'receipt.json';identity=evidence.get('projectionFileIdentity') or {}
                        require(resume.parent==backup and resume.is_dir() and not resume.is_symlink() and projection.is_file() and not projection.is_symlink() and receipt_path.is_file() and not receipt_path.is_symlink() and snapshot_file_hash(receipt_path)==progress.get('projectionReceiptHash'),'PROJECTION_RESUME_RECEIPT_CHANGED')
                        stat=projection.stat();require({'device':stat.st_dev,'inode':stat.st_ino,'size':stat.st_size,'mtimeNs':stat.st_mtime_ns}==identity and stat.st_size==evidence.get('projectionBytes'),'PROJECTION_RESUME_FILE_IDENTITY_CHANGED')
                if not progress.get('oomRestoreVerified'):reuse_pre_exit_restore(progress,backup,directory,image_info,save)
                if not progress.get('oomRestoreVerified'):
                    candidates=[p for p in directory.glob('.full-snapshot-*/response.private.json') if p.is_file() and not p.is_symlink() and not p.parent.is_symlink() and re.fullmatch(r'\.full-snapshot-[A-Za-z0-9_-]{1,80}',p.parent.name) and 0<p.stat().st_size<=2*1024**3]
                    spool=max(candidates,key=lambda p:p.stat().st_mtime) if candidates else None
                    spool_hash=snapshot_file_hash(spool) if spool else None
                    if progress.get('preservedSpoolHash'):require(progress['preservedSpoolHash']==spool_hash,'PRESERVED_SPOOL_CHANGED_NO_START')
                    progress['preservedSpoolHash']=spool_hash;save(progress)
                    rehearsal_name=progress.get('rehearsalDirectory')
                    prior_name='rehearsal-'+str(progress.get('checkpointParserSourceDigest',''))[:24]
                    if rehearsal_name is None:rehearsal_name=prior_name if re.fullmatch('rehearsal-[0-9a-f]{24}',prior_name) and (backup/prior_name).is_dir() else 'rehearsal-'+digest[:24]
                    require(isinstance(rehearsal_name,str) and re.fullmatch('rehearsal-[0-9a-f]{24}',rehearsal_name),'REHEARSAL_DIRECTORY_NAME_UNVERIFIED')
                    rehearsal=backup/rehearsal_name;require(not rehearsal.is_symlink(),'REHEARSAL_DIRECTORY_UNVERIFIED');rehearsal.mkdir(mode=0o700,exist_ok=True)
                    progress['rehearsalDirectory']=rehearsal_name;save(progress)
                    # Only the checkpoint pair and preserved snapshot spool are inputs to
                    # this restore run. Inbox DB/WAL/SHM and scheduler journals remain in
                    # the immutable backup and active volume; duplicating them in a
                    # disposable rehearsal tree does not strengthen this projection proof.
                    needed={'trade-feed.json','trade-feed.json.regular-checkpoint.json'}
                    sources=[(backup/name,rehearsal/name,sha) for name,sha in progress.get('dataBackupHashes',{}).items() if name in needed]
                    require({src.name for src,dst,sha in sources}==needed,'REHEARSAL_CHECKPOINT_COPY_SET_INCOMPLETE')
                    if spool:sources.append((spool,rehearsal/'selected.response.private.json',spool_hash))
                    user=before['services']['worker'].get('user') or image_info.get('Config',{}).get('User')
                    require(user=='node' or isinstance(user,str) and re.fullmatch(r'[1-9][0-9]{0,9}(?::[1-9][0-9]{0,9})?',user),'REHEARSAL_RUNTIME_USER_UNVERIFIED')
                    common=['docker','run','--rm','--network','none','--memory','4g','--cpus','2','--read-only','--user',user,'--mount','type=bind,source='+str(rehearsal)+',target=/recovery','--tmpfs','/tmp:size=33554432,mode=1777','--entrypoint','node',image_info['Id']]
                    common=partition_rehearsal_args(common,progress)
                    if not progress.get('projectionSerializationVerified'):
                        missing=sum(src.stat().st_size for src,dst,sha in sources if not dst.exists())
                        offline_rehearsal_disk_plan(backup,sources,progress,digest)
                        for src,dst,sha in sources:
                            require(src.is_file() and not src.is_symlink() and snapshot_file_hash(src)==sha,'REHEARSAL_SOURCE_HASH_MISMATCH')
                            dst.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
                            if not dst.exists():
                                shutil.copyfile(src,dst);os.chmod(dst,0o600)
                                with dst.open('rb') as fd:os.fsync(fd.fileno())
                            if dst.is_symlink():
                                link=os.readlink(dst)
                                emit(operation='cutover.aws',stage='partitioned_upgrade.oom_read_access.link',status='blocked',reason='REHEARSAL_COPY_SYMLINK_PRESERVED_NO_START',path='/recovery/'+str(dst.relative_to(rehearsal)),symlink=True,target=link if link.startswith('/recovery/') and '..' not in link else 'outside_rehearsal_not_followed',targetSha256=hashlib.sha256(link.encode()).hexdigest(),workerStarted=False)
                            require(dst.is_file() and not dst.is_symlink() and snapshot_file_hash(dst)==sha,'REHEARSAL_COPY_HASH_MISMATCH')
                        prior_diagnostic=oom_restore_log_summary(backup)
                        emit(operation='cutover.aws',stage='partitioned_upgrade.oom_restore.permissions.before',status='collected',previousDiagnostic=prior_diagnostic,workerStarted=False,posnetChanged=False)
                        stage='partitioned_upgrade.oom_read_access'
                        access=json.loads(run(common+['-e',REHEARSAL_ACCESS_PROBE],timeout=30))
                        emit(operation='cutover.aws',stage=stage+'.before',status='collected',access=access,workerStarted=False,posnetChanged=False)
                        require(type(access.get('uid')) is int and access['uid']>0 and type(access.get('gid')) is int and access['gid']>0,'REHEARSAL_NONROOT_IDENTITY_UNVERIFIED')
                        if access.get('opened') is not True:
                            require(access.get('code') in ('EACCES','EPERM') and not access.get('linkDetected'),'REHEARSAL_PATH_UNSAFE_OR_MISSING_NO_START')
                        permissions=rehearsal_copy_permissions(backup,rehearsal,sources,access)
                        emit(operation='cutover.aws',stage=stage+'.copy_permissions',status='verified',permissions=permissions,workerStarted=False,posnetChanged=False)
                        access=json.loads(run(common+['-e',REHEARSAL_ACCESS_PROBE],timeout=30))
                        emit(operation='cutover.aws',stage=stage,status='verified' if access.get('opened') is True else 'blocked',reason='REHEARSAL_READ_ACCESS_VERIFIED' if access.get('opened') is True else 'REHEARSAL_READ_ACCESS_NOT_VERIFIED_NO_START',access=access,user=user,imageId=image_info['Id'],mount={'source':str(rehearsal),'target':'/recovery','readOnly':False,'purpose':'unlink only hash-verified consumed rehearsal inputs before output serialization'},workerStarted=False,posnetChanged=False)
                        require(access.get('opened') is True and access.get('readBytes')==1 and not access.get('linkDetected'),'REHEARSAL_READ_ACCESS_NOT_VERIFIED_NO_START')
                    previous_log=backup/'oom-restore.private.log'
                    archived_log=backup/('oom-restore-before-'+digest[:24]+'.private.log')
                    if previous_log.exists() and not archived_log.exists():shutil.copyfile(previous_log,archived_log);os.chmod(archived_log,0o600)
                    spool_path='/recovery/selected.response.private.json' if spool else None
                    code="import{restore,persistRegularCheckpoint,checkpoint,streamCheckpoint}from'/app/apps/worker/src/persistence.ts';import{TradeState}from'/app/apps/worker/src/state.ts';import{walkSnapshot,convertSnapshotRow,fullSnapshotMemory}from'/app/apps/worker/src/full-snapshot.ts';import{writeJsonObject}from'/app/packages/feed-store/src/index.ts';import{open,writeFile,unlink,lstat}from'node:fs/promises';import{getHeapStatistics}from'node:v8';const started=Date.now();let phase='checkpoint.scan',heapPeak=0,lastRows=0;const sizes=()=>{const n={stateRows:0,markets:0,bets:0,betAt:0,betOrder:0,snapshotBets:0,freshBets:0,settlementAudit:0,timestampRecovery:0};if(typeof s!=='undefined')for(const lane of ['prematch','inplay'])for(const row of s.rows[lane].values()){n.stateRows++;n.markets+=row.markets.size;for(const market of row.markets.values())n.bets+=market.bets?.length||0;for(const key of ['betAt','betOrder','snapshotBets','freshBets','settlementAudit','timestampRecovery'])n[key]+=row[key]?.size||0;}return n};let s;const sample=(stage=phase,rows=lastRows)=>{phase=stage;lastRows=rows;const m=process.memoryUsage();heapPeak=Math.max(heapPeak,m.heapUsed);console.log(JSON.stringify({operation:'offline.memory',stage,rows,elapsedMs:Date.now()-started,heapUsedBytes:m.heapUsed,heapLimitBytes:getHeapStatistics().heap_size_limit,rssBytes:m.rss,maxRSSBytes:process.resourceUsage().maxRSS*1024,sampledHeapPeakBytes:heapPeak,externalBytes:m.external,arrayBufferBytes:m.arrayBuffers,heapTotalBytes:m.heapTotal,indexCounts:sizes()}))};const timer=setInterval(()=>sample(),5000);timer.unref();sample();s=new TradeState();const r=await restore(s,'/recovery/trade-feed.json',p=>sample(p.stage,p.rows));sample('checkpoint.complete',r.rows);let sourceSnapshotRehearsed=false,rows=0,applied=0;const spool="+json.dumps(spool_path)+";if(spool){sample('snapshot.validate',0);const ids=new Set();await walkSnapshot(spool,async raw=>{fullSnapshotMemory();const row=convertSnapshotRow(raw);if(ids.has(row.fixtureId))throw Error('duplicate fixture');ids.add(row.fixtureId);rows++;if(rows%1000===0)sample('snapshot.validate',rows);if(rows>50000)throw Error('fixture count limit')});sample('snapshot.apply',0);s.beginPartitionedSnapshot('prematch');await walkSnapshot(spool,async raw=>{fullSnapshotMemory();s.apply('prematch',[{...convertSnapshotRow(raw),marketRecovery:true}],Date.now(),{source:'snapshot',receivedAt:Date.now()});if(++applied%1000===0)sample('snapshot.apply',applied)});sample('snapshot.finalize',applied);s.finishPartitionedSnapshot('prematch',ids);}const cleanupNames=['trade-feed.json','trade-feed.json.regular-checkpoint.json',...(spool?['selected.response.private.json']:[])];let cleanupBytes=0;for(const name of cleanupNames){const path='/recovery/'+name,info=await lstat(path);if(info.isSymbolicLink()||!info.isFile())throw Error('REHEARSAL_CONSUMED_INPUT_IDENTITY');cleanupBytes+=info.size;}for(const name of cleanupNames)await unlink('/recovery/'+name);console.log(JSON.stringify({operation:'offline.rehearsal_inputs_consumed',removedFiles:cleanupNames.length,removedBytes:cleanupBytes,stage:'checkpoint_and_snapshot_fully_consumed_before_serialization'}));fullSnapshotMemory();sample('checkpoint.serialize',applied);await persistRegularCheckpoint('/output/projection.json',s);const{createHash}=await import('node:crypto');const{createReadStream}=await import('node:fs');const privateHash=createHash('sha256');for await(const chunk of createReadStream('/output/projection.json.regular-checkpoint.json'))privateHash.update(chunk);const privateCheckpointSha256=privateHash.digest('hex');sample('projection.build',applied);const feed=s.projection(Date.now(),false),out=await open('/output/projection.json','w',0o600);let receipt;sample('projection.serialize',applied);try{receipt=await writeJsonObject(out,{...feed,workerCheckpoint:{...streamCheckpoint(s),regularExternal:true}},s.availabilityBlocks());await out.sync()}finally{await out.close()}await writeFile('/output/receipt.json',JSON.stringify({...receipt,rows:feed.coverage.prematch.rowsPublished+feed.coverage.inplay.rowsPublished,stateRows:s.rows.prematch.size+s.rows.inplay.size,privateCheckpointSha256}),{mode:0o600});sourceSnapshotRehearsed=!!spool;sample('complete',r.rows);clearInterval(timer);console.log(JSON.stringify({operation:'offline.restore',rows:r.rows,sourceSnapshotRehearsed,snapshotRows:rows,rssBytes:process.memoryUsage().rss}));console.log('projection-serialize-ok');"
                    stage='partitioned_upgrade.oom_restore'
                    emit(operation='cutover.aws',stage='partitioned_upgrade.oom_restore',status='running',readOnly=True,workerStarted=False,posnetChanged=False)
                    # Fresh attempt log: historical EACCES must not diagnose this run.
                    attempt='oom-restore-attempt-'+os.urandom(8).hex()+'.private.log'
                    private(backup/attempt,b'')
                    pointer=backup/('oom-restore.latest.'+os.urandom(8).hex()+'.tmp');private(pointer,json.dumps({'name':attempt}).encode());durable_replace(pointer,backup/'oom-restore.latest.json')
                    projection_output=backup/('projection-rehearsal-'+digest[:24]);projection_output.mkdir(exist_ok=True,mode=0o700);require(projection_output.is_dir() and not projection_output.is_symlink(),'REHEARSAL_OUTPUT_PATH_UNSAFE')
                    copy_stat=rehearsal.stat();os.chown(projection_output,copy_stat.st_uid,copy_stat.st_gid);os.chmod(projection_output,0o700)
                    rehearsal_command=common[:-1]+['--mount','type=bind,source='+str(projection_output)+',target=/output',common[-1]]
                    output=b''
                    if not progress.get('projectionSerializationVerified'):
                        expected_consumed=sum(dst.stat().st_size for src,dst,sha in sources)
                        output=streamed_rehearsal_run(rehearsal_command+['--max-old-space-size='+str(partition_heap_mib(progress)),'--import','tsx','--input-type=module','-e',code],timeout=OOM_REHEARSAL_TIMEOUT_SECONDS,log=backup/attempt)
                        require(b'projection-serialize-ok' in output,'OOM_CHECKPOINT_RESTORE_FAILED_ORIGINALS_PRESERVED')
                        consumed=[]
                        for line in output.decode(errors='replace').splitlines():
                            try:record=json.loads(line)
                            except ValueError:continue
                            if record.get('operation')=='offline.rehearsal_inputs_consumed':consumed.append(record)
                        require(len(consumed)==1 and consumed[0].get('stage')=='checkpoint_and_snapshot_fully_consumed_before_serialization' and consumed[0].get('removedBytes')==expected_consumed and consumed[0].get('removedFiles')==len(sources),'REHEARSAL_INPUT_RECLAMATION_NOT_VERIFIED')
                        progress['rehearsalInputsReclaimed']={'files':consumed[0]['removedFiles'],'bytes':consumed[0]['removedBytes'],'phase':'after_checkpoint_and_snapshot_consumed_before_serialization'}
                        progress['projectionReceiptHash']=snapshot_file_hash(projection_output/'receipt.json');progress['projectionSerializationVerified']=True;progress['rehearsalMemory']=rehearsal_heap_evidence(output);save(progress)
                    require(snapshot_file_hash(projection_output/'receipt.json')==progress.get('projectionReceiptHash'),'PROJECTION_RECEIPT_CHANGED_NO_START')
                    # The first container has exited; source state cannot compete with readback.
                    stage='partitioned_upgrade.projection_readback'
                    readback_code="import{verifyProjectionFile}from'/app/apps/worker/src/full-snapshot.ts';import{snapshotCapacity}from'/app/apps/worker/src/snapshot-capacity.ts';import{getHeapStatistics}from'node:v8';import{readFile}from'node:fs/promises';console.log(JSON.stringify({operation:'offline.memory',stage:'projection.readback',heapUsedBytes:process.memoryUsage().heapUsed,heapLimitBytes:getHeapStatistics().heap_size_limit,maxRSSBytes:process.resourceUsage().maxRSS*1024}));const capacity=snapshotCapacity({...process.env,LSPORTS_PREMATCH_SNAPSHOT_MAX_RESPONSE_MB:'32'},undefined,'prematch');console.log(JSON.stringify({operation:'offline.memory_budget',stage:'projection.readback',...capacity}));const expected=JSON.parse(await readFile('/output/receipt.json','utf8'));const result=await verifyProjectionFile('/output/projection.json',expected);const{restore}=await import('/app/apps/worker/src/persistence.ts');const{TradeState}=await import('/app/apps/worker/src/state.ts');const{createHash}=await import('node:crypto');const{createReadStream}=await import('node:fs');const hash=createHash('sha256');for await(const chunk of createReadStream('/output/projection.json.regular-checkpoint.json'))hash.update(chunk);if(hash.digest('hex')!==expected.privateCheckpointSha256)throw Error('PRIVATE_CHECKPOINT_HASH_MISMATCH');const restored=new TradeState();const privateReadback=await restore(restored,'/output/projection.json');if(privateReadback.source!=='checkpoint'||privateReadback.rows!==expected.stateRows)throw Error('PRIVATE_CHECKPOINT_READBACK_MISMATCH');console.log(JSON.stringify({operation:'offline.private_readback',rows:privateReadback.rows,verified:true}));console.log(JSON.stringify({operation:'offline.projection_readback',...result,rssBytes:process.memoryUsage().rss,maxRSSBytes:process.resourceUsage().maxRSS*1024}));console.log(JSON.stringify({operation:'offline.memory',stage:'projection.readback',heapUsedBytes:process.memoryUsage().heapUsed,heapLimitBytes:getHeapStatistics().heap_size_limit,rssBytes:process.memoryUsage().rss,maxRSSBytes:process.resourceUsage().maxRSS*1024}));console.log('oom-checkpoint-restore-ok');"
                    readback_command=common[:-1]+['--mount','type=bind,source='+str(projection_output)+',target=/output,readonly',common[-1]]
                    readback_log=backup/('oom-restore-attempt-'+os.urandom(8).hex()+'.private.log');private(readback_log,b'');progress['projectionReadbackLog']=readback_log.name;save(progress);pointer=backup/('oom-restore.latest.'+os.urandom(8).hex()+'.tmp');private(pointer,json.dumps({'name':readback_log.name}).encode());durable_replace(pointer,backup/'oom-restore.latest.json')
                    readback_output=streamed_rehearsal_run(readback_command+['--max-old-space-size='+str(partition_heap_mib(progress)),'--import','tsx','--input-type=module','-e',readback_code],timeout=OOM_REHEARSAL_TIMEOUT_SECONDS,log=readback_log)
                    require(b'oom-checkpoint-restore-ok' in readback_output,'PROJECTION_READBACK_FAILED_NO_START')
                    output+=readback_output
                    progress['projectionReadbackMemory']=rehearsal_heap_evidence(readback_output)
                    for line in readback_output.decode().splitlines():
                        record=json.loads(line) if line.startswith('{') else {}
                        if record.get('operation')=='offline.memory_budget':progress['projectionReadbackBudget']={key:record[key] for key in ('budgetBytes','headroomBytes','memory','allowed')}
                    for name,sha in progress.get('dataBackupHashes',{}).items():
                        saved=backup/name
                        require(saved.is_file() and not saved.is_symlink() and snapshot_file_hash(saved)==sha,'RECOVERY_BACKUP_CHANGED_DURING_REHEARSAL')
                        if name.endswith('.sqlite'):
                            require(sqlite3_integrity(saved),'RECOVERY_SQLITE_BACKUP_INVALID')
                            original=directory/name
                            if original.exists():require(sqlite3_integrity(original),'ACTIVE_SQLITE_STATE_INVALID')
                        else:
                            original=directory/name
                            require(original.is_file() and not original.is_symlink() and snapshot_file_hash(original)==sha,'ACTIVE_SOURCE_CHANGED_DURING_REHEARSAL')
                    if spool:require(snapshot_file_hash(spool)==spool_hash,'PRESERVED_SPOOL_CHANGED_DURING_REHEARSAL')
                    progress['projectionReadbackVerified']=True;progress['oomRestoreVerified']=True;progress['rehearsalCopyVerified']=True;progress['preservedSpoolRehearsed']=spool is not None;save(progress)
            if not (backup/'migration.before.json').exists():private(backup/'migration.before.json',migration_receipt.read_bytes())
            required_host_gib=12 if progress.get('snapshotMemoryEightGiBRepair') else 10 if progress.get('pipelineMemoryEightGiB') else 6
            require(snapshot_host_memory()>=required_host_gib*1024**3,'HOST_HEADROOM_CHANGED_DURING_UPGRADE')
            if request.get('verifyOnly'):
                require(request.get('snapshotMemoryRepair') and progress.get('oomRestoreVerified'),'INVALID_VERIFY_ONLY_PHASE')
                emit(operation='cutover.aws',stage='partitioned_upgrade.persistence_verified',status='ok',offlineRestoreVerified=True,projectionReadbackVerified=progress.get('projectionReadbackVerified',False),projectionReadbackBudget=progress.get('projectionReadbackBudget'),projectionReadbackMemory=progress.get('projectionReadbackMemory'),rehearsalMemory=progress.get('rehearsalMemory'),rehearsalCopyVerified=progress.get('rehearsalCopyVerified',False),preservedSpoolRehearsed=progress.get('preservedSpoolRehearsed',False),inboxes=progress.get('inboxIntegrity'),workerStarted=False,backup=str(backup),posnetChanged=False);return 0
            overlay=SECURE/('compose.partitioned-'+digest[:24]+('-heap3584' if partition_heap_mib(progress)==3584 else '')+('-mem8g' if progress.get('pipelineMemoryEightGiB') else '-preserve8g' if progress.get('snapshotMemoryEightGiBRepair') else '')+'.json');content=json.dumps({'services':{'worker':{'image':progress['image'],**({'mem_limit':'8g'} if progress.get('pipelineMemoryEightGiB') is True else {}),'environment':{'LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT':'true','LSPORTS_INPLAY_STREAMED_SNAPSHOT':'true',**({'NODE_OPTIONS':'--max-old-space-size='+str(partition_heap_mib(progress))} if request.get('snapshotMemoryRepair') else {})}}}}).encode()
            if overlay.exists():require(overlay.read_bytes()==content,'UPGRADE_OVERLAY_CHANGED')
            else:private(overlay,content)
            candidate=partition_base(meta) if str(overlay) in meta.get('composeOverrides',[]) else partition_base(meta)+['-f',str(overlay)]
            require(model(candidate)==expected,'UPGRADE_MODEL_CHANGE_OUTSIDE_WORKER_PATCH')
            if str(overlay) not in meta.get('composeOverrides',[]):
                meta['composeOverrides']=[*meta.get('composeOverrides',[]),str(overlay)];temporary=SECURE/(receipt_path.name+'.deployment.tmp');private(temporary,json.dumps(meta).encode());durable_replace(temporary,SECURE/'deployment.json')
            progress['phase']='configured';save(progress)
        if progress['phase']=='configured':
            stage='partitioned_upgrade.start';require(not any(c['running'] for c in states('worker')),'CONSUMER_ALREADY_PRESENT')
            if progress.get('snapshotMemoryEightGiBRepair') is True:require(snapshot_host_memory()>=candidate_memory(progress)+4*1024**3,'SNAPSHOT_EIGHT_GIB_HOST_HEADROOM_CHANGED_BEFORE_START')
            started=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z');progress['startAt']=started
            migration.setdefault('partitionedUpgrades',[]).append({'digest':digest,'previousStartRequestedAtUTC':migration['startRequestedAtUTC'],'backup':str(backup)});migration['startRequestedAtUTC']=started
            temporary=SECURE/(receipt_path.name+'.migration.tmp');private(temporary,json.dumps(migration).encode());durable_replace(temporary,migration_receipt)
            progress['phase']='start_requested';save(progress)
            run(partition_base(json.loads((SECURE/'deployment.json').read_bytes()))+['--profile','feed-consumer','up','-d','--force-recreate','--no-deps','--no-build','--pull','never','worker'],timeout=90,log=backup/'start.private.log')
        if progress.get('heapBudgetPlan'):
            stage='partitioned_upgrade.heap_runtime_verify'
            active=states('worker');require(len(active)==1 and active[0]['running'],'BUDGETED_WORKER_NOT_RUNNING')
            inspected=json.loads(run(['docker','inspect',active[0]['id']]))[0]
            runtime=verify_budgeted_worker_runtime(progress,active[0]['id'],inspected,image_id)
            emit(operation='cutover.aws',stage=stage,status='verified',containerId=active[0]['id'],imageId=image_id,**runtime,posnetChanged=False)
        emit(operation='cutover.aws',stage='partitioned_upgrade.started',status='ok',offlineRestoreVerified=progress.get('oomRestoreVerified',False),workerStarted=True,startedAtUTC=progress.get('startAt'),image=progress['image'],migrationRepeated=False,composeOverridesPreserved=True,journalsRewrittenByUpgrade=False,journalsImported=False,posnetChanged=False,backup=str(backup));return 0
    except Exception as error:
        reason=str(error) if re.fullmatch('[A-Z][A-Z_]+',str(error)) else 'PRIVATE_PARTITIONED_UPGRADE_FAILED'
        if stage=='partitioned_upgrade.distribution_stop' and isinstance(error,subprocess.CalledProcessError):reason='DISTRIBUTION_STOP_HELPER_EXIT_NONZERO'
        if stage=='partitioned_upgrade.distribution_stop' and isinstance(error,subprocess.TimeoutExpired):reason='DISTRIBUTION_STOP_HELPER_TIMEOUT'
        if stage=='partitioned_upgrade.checkpoint_parser_image' and isinstance(error,(subprocess.CalledProcessError,subprocess.TimeoutExpired)):reason='CHECKPOINT_PARSER_IMAGE_BUILD_FAILED'
        if stage in ('partitioned_upgrade.oom_restore','partitioned_upgrade.projection_readback') and isinstance(error,(subprocess.CalledProcessError,subprocess.TimeoutExpired)):reason='PRESERVED_DATA_OFFLINE_REHEARSAL_FAILED_NO_START'
        detail=safe_helper_error(error)
        if reason=='PIPELINE_STOPPED_HEAP_PROFILE_HANDOFF_UNVERIFIED':
            detail['heapProbeHandoff']=stopped_profile_proof_diagnostics(progress,progress.get('oldContainer'))
        detail['exceptionDetails']=save_upgrade_exception(backup,error,stage)
        detail['exceptionType']=detail['exceptionDetails']['exceptionType']
        if stage=='partitioned_upgrade.checkpoint_parser_image' and backup:detail['checkpointImageBuild']=checkpoint_build_log_summary(backup)
        if stage in ('partitioned_upgrade.oom_restore','partitioned_upgrade.projection_readback') and backup:
            detail['offlineRehearsal']=oom_restore_log_summary(backup)
            if detail['offlineRehearsal'].get('present'):
                raw=read_tail(backup/detail['offlineRehearsal']['attemptLog']);detail['heapEvidence']=rehearsal_heap_evidence(raw)
                for line in raw.decode(errors='replace').splitlines():
                    try:record=json.loads(line)
                    except Exception:continue
                    if isinstance(record,dict) and record.get('operation')=='offline.memory_budget':
                        detail['memoryBudget']={k:v for k,v in record.items() if k in ('budgetBytes','headroomBytes','allowed') and isinstance(v,(int,bool))}
                        detail['memoryBudget']['memory']={k:v for k,v in record.get('memory',{}).items() if k in ('heapLimitBytes','heapUsedBytes','heapHeadroomBytes','availableMemoryBytes','limitingFactor') and isinstance(v,(int,str,type(None)))}
        if stage=='partitioned_upgrade.offline_durable_ingress' and backup:
            detail['offlineDurableIngress']=durable_ingress_log_summary(backup)
        if stage=='partitioned_upgrade.distribution_stop' and backup:
            detail['distributionStop']=distribution_stop_log_summary(backup);detail['workerStates']=states('worker')
        emit(operation='cutover.aws',stage=stage,status='blocked',reason=reason,backup=str(backup) if backup else None,posnetChanged=False,rawExceptionPrinted=False,**detail);return 2


def upgrade_partitioned(request):
    import fcntl
    # An interrupted SSH client must not start a second proof/upgrade concurrently.
    fd=os.open(SECURE/'partitioned-upgrade.operation.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            emit(operation='cutover.aws',stage='partitioned_upgrade.operation_lock',status='blocked',reason='REMOTE_UPGRADE_ALREADY_RUNNING_NO_DUPLICATE',workerStarted=False,posnetChanged=False)
            return 2
        return upgrade_partitioned_unlocked(request)
    finally:os.close(fd)
