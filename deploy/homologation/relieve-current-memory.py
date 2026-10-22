"""Bounded live admission repair. Never changes heap, data, guards or worker identity."""
GiB=1024**3
REQUIRED=1536*1024**2  # simultaneous 320+1088 MiB admission, plus 128 MiB

def relief_plan(cgroup,host_available):
    old=cgroup.get('memory.max');require(old in (4*GiB,6*GiB),'CURRENT_CONTAINER_LIMIT_NOT_EXPECTED_4_OR_6_GIB')
    require(cgroup.get('memory.high') in (None,old),'DISTINCT_MEMORY_HIGH_REQUIRES_REVIEW')
    require(host_available>=(10*GiB if old==4*GiB else 8*GiB),'HOST_RESERVE_BELOW_8_GIB_AFTER_PROPOSED_INCREASE')
    stat=cgroup['stat'];clean=max(0,stat.get('inactive_file',0)-stat.get('file_dirty',0)-stat.get('file_writeback',0)-stat.get('shmem',0))
    return {'reclaimBytes':min(clean,REQUIRED),'oldLimitBytes':old,'plannedLimitBytes':6*GiB,'hostReserveAfterIncreaseBytes':host_available-(6*GiB-old),'requiredActualHeadroomBytes':REQUIRED,'cleanInactiveEstimateBytes':clean}

def relief_main():
    import errno,fcntl
    lock=os.open('/run/lock/adl-memory-relief.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    workers=states('worker');require(len(workers)==1 and workers[0]['running'],'UNIQUE_RUNNING_WORKER_REQUIRED')
    cid=workers[0]['id'];require(cid.startswith('176d57fbd609'),'CURRENT_WORKER_IDENTITY_DIFFERS_FROM_CONFIRMED_REPORT');info=json.loads(run(['docker','inspect',cid]))[0];pid=info['State']['Pid'];started=info['State']['StartedAt'];before=memory_cgroup(pid)
    host=int(re.search(r'^MemAvailable:\s+(\d+)',Path('/proc/meminfo').read_text(),re.M)[1])*1024
    plan=relief_plan(before,host)
    require(info['HostConfig']['Memory']==before['memory.max'],'INITIAL_DOCKER_CGROUP_LIMIT_MISMATCH')
    require(not info['State'].get('OOMKilled'),'CURRENT_WORKER_OOM_REQUIRES_REVIEW')
    # No swap-based reclaim: unsupported swappiness=0 fails closed, never retry byte-only.
    raw=Path('/proc/'+str(pid)+'/cgroup').read_text();match=re.search(r'^0::(/[^\n]*)$',raw,re.M)
    require(match is not None,'CGROUP_PATH_UNVERIFIED');root=Path('/sys/fs/cgroup');folder=(root/match[1].lstrip('/')).resolve()
    require(root in folder.parents and cid[:12] in str(folder),'WORKER_CGROUP_IDENTITY_UNVERIFIED')
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup=SECURE/('memory-relief-'+stamp+'-'+os.urandom(4).hex()+'.json')
    receipt={'containerId':cid,'imageId':info['Image'],'startedAtUTC':started,'originalMemoryBytes':info['HostConfig']['Memory'],'originalMemorySwapBytes':info['HostConfig']['MemorySwap'],'before':before,'plan':plan,'workerRestarted':False,'posnetChanged':False}
    fd=os.open(backup,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(fd,'w') as out:json.dump(receipt,out);out.flush();os.fsync(out.fileno())
    emit(operation='memory_relief',stage='verified_identity_and_backup',limitApplicationStatus='planned_not_yet_applied',**plan,receipt=str(backup))
    def identity():
        now=json.loads(run(['docker','inspect',cid]))[0]
        require(now['State']['Running'] and now['State']['Pid']==pid and now['State']['StartedAt']==started and now['Image']==info['Image'],'WORKER_CHANGED_NO_ACTION')
    # The previous run reclaimed cache and skipped the conditional update. Cache refilled.
    # Now persist and verify the sized capacity regardless of transient cache headroom.
    deployment=SECURE/'deployment.json'
    require(deployment.is_file() and not deployment.is_symlink(),'DEPLOYMENT_METADATA_UNVERIFIED')
    deployment_raw=deployment.read_bytes();meta=json.loads(deployment_raw);base=partition_base(meta);original_model=model(base)
    expected=copy.deepcopy(original_model);change={'mem_limit':6*GiB}
    original_swap=info['HostConfig']['MemorySwap']
    if original_swap==4*GiB:
        change['memswap_limit']=6*GiB
    elif original_swap>0:require(original_swap>=6*GiB,'EXISTING_SWAP_POLICY_INCOMPATIBLE_NO_UPDATE')
    expected['services']['worker'].update(change)
    overlay=SECURE/('compose.memory-capacity-'+stamp+'-'+os.urandom(4).hex()+'.json')
    private(overlay,json.dumps({'services':{'worker':change}}).encode())
    proposed=model(base+['-f',str(overlay)])
    require(proposed==expected,'PERSISTENT_OVERRIDE_CHANGED_UNEXPECTED_FIELDS')
    private(backup.with_suffix('.deployment.private.json'),deployment_raw)
    identity();host_now=int(re.search(r'^MemAvailable:\s+(\d+)',Path('/proc/meminfo').read_text(),re.M)[1])*1024
    relief_plan(memory_cgroup(pid),host_now)
    args=['docker','update','--memory',str(6*GiB)]
    if original_swap==4*GiB:args+=['--memory-swap',str(6*GiB)]
    if info['HostConfig']['Memory']!=6*GiB:run(args+[cid])
    identity();actual=json.loads(run(['docker','inspect',cid]))[0];after=memory_cgroup(pid)
    require(actual['HostConfig']['Memory']==6*GiB and after['memory.max']==6*GiB,'LIVE_DOCKER_CGROUP_LIMIT_MISMATCH')
    require(after.get('memory.high') in (None,6*GiB),'EFFECTIVE_MEMORY_HIGH_REMAINS_RESTRICTIVE')
    require(deployment.read_bytes()==deployment_raw,'DEPLOYMENT_METADATA_CHANGED_CONCURRENTLY_NO_OVERWRITE')
    meta['composeOverrides']=[*meta.get('composeOverrides',[]),str(overlay)]
    tmp=SECURE/('memory-capacity-'+os.urandom(8).hex()+'.deployment.tmp')
    private(tmp,json.dumps(meta).encode());durable_replace(tmp,deployment)
    require(model(partition_base(json.loads(deployment.read_bytes())))==expected,'PERSISTED_COMPOSE_MODEL_NOT_EFFECTIVE')
    emit(operation='memory_relief',stage='persistent_limit_verified',dockerMemoryBytes=actual['HostConfig']['Memory'],cgroupMemoryMaxBytes=after['memory.max'],composeMemoryBytes=proposed['services']['worker']['mem_limit'],override=str(overlay),workerRestarted=False,heapChanged=False,cacheReclaimRepeated=False)
    require(after['limitMinusCurrentBytes']>=REQUIRED,'ACTUAL_HEADROOM_INSUFFICIENT_AFTER_RELIEF')
    require(after['memory.events'].get('oom_kill',0)==before['memory.events'].get('oom_kill',0),'NEW_OOM_DURING_RELIEF')
    emit(operation='memory_relief_complete',containerId=cid,receipt=str(backup),actualHeadroomBytes=after['limitMinusCurrentBytes'],workerRestarted=False,providerRequests=0,posnetChanged=False,integrationVerified=False,appliedAtUTC=datetime.datetime.now(datetime.timezone.utc).isoformat())
try:relief_main()
except Exception as error:
    emit(operation='memory_relief_failure',status='blocked',reason=str(error) if re.fullmatch('[A-Z_0-9]{3,120}',str(error)) else 'MEMORY_RELIEF_FAILED',diagnostic=recovery_exception_details(error),workerRestarted=False)
    raise SystemExit(2)
