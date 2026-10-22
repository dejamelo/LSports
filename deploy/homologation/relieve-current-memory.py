"""Bounded live admission repair. Never changes heap, data, guards or worker identity."""
GiB=1024**3
REQUIRED=1536*1024**2  # simultaneous 320+1088 MiB admission, plus 128 MiB

def relief_plan(cgroup,host_available):
    old=cgroup.get('memory.max');require(old in (4*GiB,6*GiB),'CURRENT_CONTAINER_LIMIT_NOT_EXPECTED_4_OR_6_GIB')
    require(cgroup.get('memory.high') in (None,old),'DISTINCT_MEMORY_HIGH_REQUIRES_REVIEW')
    require(host_available>=(10*GiB if old==4*GiB else 8*GiB),'HOST_RESERVE_BELOW_8_GIB_AFTER_PROPOSED_INCREASE')
    stat=cgroup['stat'];clean=max(0,stat.get('inactive_file',0)-stat.get('file_dirty',0)-stat.get('file_writeback',0)-stat.get('shmem',0))
    return {'reclaimBytes':min(clean,REQUIRED),'oldLimitBytes':old,'newLimitBytes':6*GiB,'hostReserveAfterIncreaseBytes':host_available-(6*GiB-old),'requiredActualHeadroomBytes':REQUIRED,'cleanInactiveEstimateBytes':clean}

def relief_main():
    import errno,fcntl
    lock=os.open('/run/lock/adl-memory-relief.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    workers=states('worker');require(len(workers)==1 and workers[0]['running'],'UNIQUE_RUNNING_WORKER_REQUIRED')
    cid=workers[0]['id'];require(cid.startswith('176d57fbd609'),'CURRENT_WORKER_IDENTITY_DIFFERS_FROM_CONFIRMED_REPORT');info=json.loads(run(['docker','inspect',cid]))[0];pid=info['State']['Pid'];started=info['State']['StartedAt'];before=memory_cgroup(pid)
    host=int(re.search(r'^MemAvailable:\s+(\d+)',Path('/proc/meminfo').read_text(),re.M)[1])*1024
    plan=relief_plan(before,host)
    require(not info['State'].get('OOMKilled'),'CURRENT_WORKER_OOM_REQUIRES_REVIEW')
    # No swap-based reclaim: unsupported swappiness=0 fails closed, never retry byte-only.
    raw=Path('/proc/'+str(pid)+'/cgroup').read_text();match=re.search(r'^0::(/[^\n]*)$',raw,re.M)
    require(match is not None,'CGROUP_PATH_UNVERIFIED');root=Path('/sys/fs/cgroup');folder=(root/match[1].lstrip('/')).resolve()
    require(root in folder.parents and cid[:12] in str(folder),'WORKER_CGROUP_IDENTITY_UNVERIFIED')
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup=Path('/etc/adl-homologation')/('memory-relief-'+stamp+'-'+os.urandom(4).hex()+'.json')
    receipt={'containerId':cid,'imageId':info['Image'],'startedAtUTC':started,'originalMemoryBytes':info['HostConfig']['Memory'],'originalMemorySwapBytes':info['HostConfig']['MemorySwap'],'before':before,'plan':plan,'workerRestarted':False,'posnetChanged':False}
    fd=os.open(backup,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(fd,'w') as out:json.dump(receipt,out);out.flush();os.fsync(out.fileno())
    emit(operation='memory_relief',stage='verified_identity_and_backup',**plan,receipt=str(backup))
    def identity():
        now=json.loads(run(['docker','inspect',cid]))[0]
        require(now['State']['Running'] and now['State']['Pid']==pid and now['State']['StartedAt']==started and now['Image']==info['Image'],'WORKER_CHANGED_NO_ACTION')
    identity();reclaim='not_needed'
    if before['limitMinusCurrentBytes']<REQUIRED and plan['reclaimBytes']:
        try:
            with (folder/'memory.reclaim').open('w') as out:out.write(str(plan['reclaimBytes'])+' swappiness=0\n')
            reclaim='kernel_request_completed'
        except OSError as error:
            require(error.errno in (errno.EINVAL,errno.ENOENT,errno.EAGAIN,errno.EOPNOTSUPP),'CGROUP_RECLAIM_UNEXPECTED_FAILURE')
            reclaim='unsupported_or_partial_errno_'+str(error.errno)
    after=memory_cgroup(pid);emit(operation='memory_relief',stage='cache_reclaim',result=reclaim,actualHeadroomBytes=after['limitMinusCurrentBytes'],memoryCurrentBytes=after['memory.current'])
    if after['limitMinusCurrentBytes']<REQUIRED:
        require(plan['oldLimitBytes']==4*GiB,'PRESSURE_PERSISTS_AT_6_GIB_NO_FURTHER_INCREASE')
        identity();host_now=int(re.search(r'^MemAvailable:\s+(\d+)',Path('/proc/meminfo').read_text(),re.M)[1])*1024
        relief_plan(after,host_now)
        swap=info['HostConfig']['MemorySwap'];args=['docker','update','--memory',str(6*GiB)]
        if swap==4*GiB:args+=['--memory-swap',str(6*GiB)]  # retain no-swap policy
        elif swap>0:require(swap>=6*GiB,'EXISTING_SWAP_POLICY_INCOMPATIBLE_NO_UPDATE')
        run(args+[cid]);identity();after=memory_cgroup(pid)
        require(after['memory.max']==6*GiB,'LIVE_MEMORY_UPDATE_NOT_EFFECTIVE')
        emit(operation='memory_relief',stage='live_limit_increased_no_restart',newLimitBytes=6*GiB,hostReserveAfterIncreaseBytes=host_now-2*GiB)
    require(after['limitMinusCurrentBytes']>=REQUIRED,'ACTUAL_HEADROOM_INSUFFICIENT_AFTER_RELIEF')
    require(after['memory.events'].get('oom_kill',0)==before['memory.events'].get('oom_kill',0),'NEW_OOM_DURING_RELIEF')
    emit(operation='memory_relief_complete',containerId=cid,receipt=str(backup),actualHeadroomBytes=after['limitMinusCurrentBytes'],workerRestarted=False,providerRequests=0,posnetChanged=False,integrationVerified=False)
try:relief_main()
except Exception as error:
    emit(operation='memory_relief_failure',status='blocked',reason=str(error) if re.fullmatch('[A-Z_0-9]{3,120}',str(error)) else 'MEMORY_RELIEF_FAILED',diagnostic=recovery_exception_details(error),workerRestarted=False)
    raise SystemExit(2)
