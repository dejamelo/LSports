"""Read-only decision before any controlled worker change; no supplier calls."""
def pressure_patch_decision(connection,installed,candidate):
    if installed==candidate:return 'validate_existing_candidate'
    if installed!='9d1eeedc680a92ee1ee1a95e95e9a9727c19848e2b8aa648fd68805227ff4a91':return 'unknown_installed_source_no_patch'
    if connection.get('phase')=='connected' and connection.get('recoveryProgress',{}).get('regularSnapshotReady') and connection.get('lastSnapshotAt'):return 'validate_existing_recovery'
    full=connection.get('fullSnapshot') or {};diag=connection.get('lastSnapshotDiagnostic') or {}
    def epoch(value):
        try:return datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()
        except (AttributeError,ValueError):return 0
    failure=epoch(connection.get('lastSnapshotErrorAt'));begin=epoch(full.get('startedAt'));progress=epoch(full.get('lastProgressAt'))
    if diag.get('reason')=='memory_budget_exceeded' and diag.get('memoryBudgetBytes')==335544320 and full.get('stage') in ('validate','apply') and type(full.get('bytes')) is int and full['bytes']>0 and failure>=begin>0 and failure>=progress:return 'apply_verified_spool_pressure_patch'
    return 'snapshot_progress_or_unproven_current_failure_no_patch'

def pressure_preflight_main():
    require(re.fullmatch('[0-9a-f]{64}',PRESSURE_CANDIDATE_SHA),'CANDIDATE_SOURCE_SHA_UNVERIFIED')
    workers=states('worker');require(len(workers)==1 and workers[0]['running'] and not workers[0].get('oomKilled'),'ACTIVE_WORKER_REQUIRED_NO_RESTART')
    c=json.loads(run(['docker','inspect',workers[0]['id']]))[0]
    mounts=[m for m in c['Mounts'] if m.get('Destination')=='/app/.runtime/feed' and m.get('Type')=='volume'];require(len(mounts)==1,'FEED_VOLUME_UNVERIFIED')
    volume=json.loads(run(['docker','volume','inspect',mounts[0]['Name']]))[0];require((volume.get('Labels') or {}).get('com.docker.compose.project')=='adl-homologation','FEED_VOLUME_PROJECT_UNVERIFIED')
    source=Path('/proc/'+str(c['State']['Pid'])+'/root/app/apps/worker/src/full-snapshot.ts');require(source.is_file() and not source.is_symlink() and source.stat().st_size<256*1024,'PRESSURE_SOURCE_UNVERIFIED')
    sha=hashlib.sha256(source.read_bytes()).hexdigest();metadata=pressure_metadata(Path(volume['Mountpoint'])/'trade-feed.json');connection=metadata['connections'].get('prematch',{})
    updated=datetime.datetime.fromisoformat(metadata['updatedAt'].replace('Z','+00:00'));require(-5<=(datetime.datetime.now(datetime.timezone.utc)-updated).total_seconds()<120,'PRESSURE_METADATA_NOT_CURRENT_NO_PATCH')
    action=pressure_patch_decision(connection,sha,PRESSURE_CANDIDATE_SHA)
    emit(operation='snapshot_pressure_preflight',readOnly=True,providerRequests=0,workerRestarted=False,workerId=c['Id'],imageId=c['Image'],imageRef=c['Config']['Image'],installedSourceSha256=sha,action=action,phase=connection.get('phase'),lastSnapshotAt=connection.get('lastSnapshotAt'),lastSnapshotErrorAt=connection.get('lastSnapshotErrorAt'),snapshot={k:v for k,v in (connection.get('fullSnapshot') or {}).items() if k in ('stage','bytes','validatedRows','appliedRows','startedAt','lastProgressAt')},diagnostic=safe_feed_diagnostic(connection.get('lastSnapshotDiagnostic')))
try:pressure_preflight_main()
except Exception as error:
    emit(operation='snapshot_pressure_preflight',status='blocked',reason=str(error) if re.fullmatch('[A-Z_]{3,100}',str(error)) else 'PRESSURE_PREFLIGHT_FAILED',exceptionDetails=recovery_exception_details(error),workerRestarted=False)
    raise SystemExit(2)
