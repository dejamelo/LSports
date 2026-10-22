"""Read-only scheduler/attempt observation after the verified live capacity change."""
LIMIT_APPLIED_AT='2026-10-22T17:55:09.819775Z'
def scheduler_time(value):
    try:return datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()
    except (TypeError,ValueError,AttributeError):return 0

def post_limit_decision(connection,threshold):
    snapshot=connection.get('fullSnapshot') or {};recovery=connection.get('recoveryProgress') or {}
    started=max(scheduler_time(snapshot.get('startedAt')),scheduler_time(recovery.get('startedAt')));progress=scheduler_time(snapshot.get('lastProgressAt'));error=scheduler_time(connection.get('lastSnapshotErrorAt'))
    completed=scheduler_time(connection.get('lastSnapshotAt'))
    ready=recovery.get('regularSnapshotReady') is True
    if completed>=threshold and ready and completed>=max(started,error):return 'snapshot_completed_after_limit'
    if error>=threshold and error>=max(started,progress):return 'failure_after_limit'
    if started>=threshold:return 'post_limit_attempt_in_progress'
    if progress>=threshold:return 'existing_spool_progress_after_limit'
    return 'waiting_for_post_limit_attempt_or_fresh_progress'

def apply_pending_processes(cid):
    lines=run(['docker','top',cid,'-eo','pid,ppid,stat,comm']).decode().splitlines()[1:]
    require(len(lines)<=64,'CONTAINER_PROCESS_COUNT_LIMIT');out=[]
    for line in lines:
        fields=line.split();require(len(fields)==4 and fields[0].isdigit() and fields[1].isdigit(),'CONTAINER_PROCESS_IDENTITY_UNVERIFIED')
        pid=int(fields[0]);p=Path('/proc/'+str(pid))
        try:
            raw=(p/'stat').read_text();stat=raw[raw.rfind(')')+2:].split();wchan=(p/'wchan').read_text().strip()
            out.append({'hostPid':pid,'parentHostPid':int(fields[1]),'state':fields[2] if re.fullmatch('[A-Za-z+<NsLl]*',fields[2]) else 'other','executable':fields[3] if fields[3] in ('node','docker-init','tini') else 'other','cpuUserTicks':int(stat[11]),'cpuSystemTicks':int(stat[12]),'startTicks':int(stat[19]),'waitChannel':wchan if re.fullmatch('[A-Za-z0-9_]{1,100}',wchan) else 'unverified'})
        except FileNotFoundError:out.append({'hostPid':pid,'exitedDuringObservation':True})
    return out

def post_limit_main():
    import fcntl
    lock=os.open('/run/lock/adl-post-limit-watch.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    workers=states('worker');require(len(workers)==1 and workers[0]['running'],'UNIQUE_CURRENT_WORKER_REQUIRED')
    cid=workers[0]['id'];require(cid.startswith('176d57fbd609'),'CURRENT_WORKER_IDENTITY_UNVERIFIED')
    info=json.loads(run(['docker','inspect',cid]))[0];pid=info['State']['Pid'];started=info['State']['StartedAt']
    require(info['HostConfig']['Memory']==6442450944 and memory_cgroup(pid)['memory.max']==6442450944,'VERIFIED_SIX_GIB_LIMIT_CHANGED')
    base=Path('/proc/'+str(pid)+'/root/app')
    for name,digest in WATCH_SOURCE_HASHES.items():
        source=base/name;require(source.is_file() and source.stat().st_size<262144 and hashlib.sha256(source.read_bytes()).hexdigest()==digest,'INSTALLED_SCHEDULER_OR_GUARD_SOURCE_DIFFERS')
    mounts=[m for m in info['Mounts'] if m.get('Destination')=='/app/.runtime/feed' and m.get('Type')=='volume'];require(len(mounts)==1,'FEED_VOLUME_UNVERIFIED')
    volume=json.loads(run(['docker','volume','inspect',mounts[0]['Name']]))[0];require((volume.get('Labels') or {}).get('com.docker.compose.project')=='adl-homologation','FEED_VOLUME_PROJECT_UNVERIFIED')
    directory=Path(volume['Mountpoint']);threshold=scheduler_time(LIMIT_APPLIED_AT)
    # Lightweight, separate Node process: verifies the same available-memory API/cgroup,
    # not an injected measurement of the running worker's heap.
    if not WATCH_COST_MODE:
        probe=json.loads(run(['docker','exec',cid,'node','--max-old-space-size=32','--input-type=module','-e',"console.log(JSON.stringify({node:process.versions.node,libuv:process.versions.uv,constrainedMemoryBytes:process.constrainedMemory(),availableMemoryBytes:process.availableMemory(),probeIsSeparateProcess:true}))"],timeout=15))
        require(probe.get('constrainedMemoryBytes')==6442450944,'NODE_RUNTIME_DOES_NOT_SEE_SIX_GIB_LIMIT')
        emit(operation='post_limit_scheduler',stage='runtime_capacity_verified',workerId=cid,appliedAtUTC=LIMIT_APPLIED_AT,probe=probe,runningWorkerHeapNotProbed=True,workerRestarted=False,providerRequests=0)
    else:
        # Do not start an extra Node in the nearly full worker cgroup.
        host_available=int(re.search(r'^MemAvailable:\s+(\d+)',Path('/proc/meminfo').read_text(),re.M)[1])*1024
        require(host_available>=2*1024**3+128*1024**2,'HOST_HEADROOM_INSUFFICIENT_FOR_ISOLATED_PLAN_READER')
        plans=[]
        for lane in ('prematch','inplay'):
            reader='adl-metric-plan-'+os.urandom(6).hex()
            try:
                plans.append(json.loads(run(['docker','run','--rm','--name',reader,'--network','none','--memory','128m','--memory-swap','128m','--cpus','0.25','--read-only','--user','1000:1000','--mount','type=volume,src='+mounts[0]['Name']+',dst=/app/.runtime/feed,readonly','--entrypoint','node',info['Image'],'--max-old-space-size=32','--input-type=module','-e',INBOX_PLAN_PROBE,'/app/.runtime/feed/trade-feed.json.'+lane+'.inbox.sqlite'],timeout=20)))
            finally:subprocess.run(['docker','rm','-f',reader],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10,check=False)
        emit(operation='post_limit_scheduler',stage='inbox_receipt_metric_query_plan_read_only',plans=plans,indexCreated=False,aggregateQueryExecuted=False,workerCgroupProbeStarted=False,isolatedReaderMemoryBytes=128*1024**2)
    began=time.monotonic();samples=[];result=None
    for index in range(WATCH_SAMPLE_COUNT):
        current=json.loads(run(['docker','inspect',cid]))[0];require(current['State']['Running'] and current['State']['StartedAt']==started and current['Image']==info['Image'],'WORKER_CHANGED_NO_ACTION')
        now=datetime.datetime.now(datetime.timezone.utc).isoformat();metadata=pressure_metadata(directory/'trade-feed.json');connections=metadata.get('connections') or {};schedules=[]
        paths=list(directory.glob('trade-feed.json.snapshot-*.json'));require(len(paths)<=32,'SCHEDULER_FILE_COUNT_LIMIT')
        for path in paths:
            require(not path.is_symlink() and path.stat().st_size<=1024*1024,'SCHEDULER_FILE_UNVERIFIED');saved=json.loads(path.read_bytes());requests=saved.get('requests') or {}
            rows={}
            for key,r in requests.items():
                if not re.fullmatch(r'(4510|4511):snapshot\.(events|outright\.fixtures|outright\.markets)',key):continue
                rows[key]={k:r[k] for k in ('packageId','pid','at','completedAt','outcome','operation') if k in r}
                if isinstance(r.get('failure'),dict):rows[key]['failure']=safe_feed_diagnostic(r['failure'])
            lockpath=Path(str(path)+'.lock');owner=None
            if lockpath.exists():
                require(not lockpath.is_symlink() and lockpath.stat().st_size<64,'SCHEDULER_LOCK_UNVERIFIED');value=lockpath.read_text().strip();owner=int(value) if value.isdigit() else None
            schedules.append({'file':path.name,'hostNextAtUTC':datetime.datetime.fromtimestamp(saved['nextAt']/1000,datetime.timezone.utc).isoformat() if type(saved.get('nextAt')) in (int,float) else None,'dueUTC':{k:datetime.datetime.fromtimestamp(v/1000,datetime.timezone.utc).isoformat() for k,v in (saved.get('due') or {}).items() if k in rows and type(v) in (int,float)},'requests':rows,'lastRequest':{k:v for k,v in (saved.get('lastRequest') or {}).items() if k in ('packageId','operation','pid','at','completedAt','outcome')},'lockPresent':lockpath.exists(),'ownerNamespacePid':owner,'ownerProcPresent':(base.parent/'proc'/str(owner)).exists() if owner else None,'operationOwnerMatches':owner==(saved.get('lastRequest') or {}).get('pid') if owner else None,'activityEvidence':'reservation_with_live_owner_not_proof_of_forward_progress' if owner and (base.parent/'proc'/str(owner)).exists() and (saved.get('lastRequest') or {}).get('outcome')=='reserved' else 'no_live_reservation_proven'})
        lanes={}
        for lane in ('prematch','inplay'):
            c=connections.get(lane) or {};ingress=c.get('ingressProgress') or {}
            lanes[lane]={'decision':post_limit_decision(c,threshold),'phase':c.get('phase'),'sessionStartedAt':(c.get('session') or {}).get('startedAt'),'snapshot':{k:v for k,v in (c.get('fullSnapshot') or {}).items() if k in ('stage','bytes','startedAt','lastProgressAt','validatedRows','appliedRows','completedAt')},'recovery':{k:v for k,v in (c.get('recoveryProgress') or {}).items() if k in ('stage','startedAt','lastProgressAt','nextRegularAttemptAt','regularSnapshotReady','completedAt')},'lastSnapshotAt':c.get('lastSnapshotAt'),'lastSnapshotErrorAt':c.get('lastSnapshotErrorAt'),'errorIsHistorical':0<scheduler_time(c.get('lastSnapshotErrorAt'))<threshold,'diagnostic':safe_feed_diagnostic(c.get('lastSnapshotDiagnostic')),'ingress':{k:v for k,v in ingress.items() if k in ('received','acknowledged','processed','checkpointed','processingBacklog','oldestProcessingAgeMs','metricWindowEndUTC')},'updates':{k:v for k,v in ({**(c.get('updates') or {}),**{k:v for k,v in c.items() if k in ('lastMarketDecodedAt','lastDataDecodedAt','lastControlDecodedAt')}}).items() if k in ('lastMarketDecodedAt','lastDataDecodedAt','lastControlDecodedAt')},'persistence':{k:v for k,v in (c.get('persistenceProgress') or {}).items() if k in ('writes','lastCompletedAt','lastDurationMs','metricWindowEndUTC')}}
        spools=[{'directory':p.parent.name,'bytes':p.stat().st_size,'modifiedAtUTC':datetime.datetime.fromtimestamp(p.stat().st_mtime,datetime.timezone.utc).isoformat(),'validityNotAssumed':True} for p in directory.glob('.full-snapshot-*/response.private.json') if not p.is_symlink() and not p.parent.is_symlink()][:16]
        cg=memory_cgroup(pid);sample={'atUTC':now,'elapsedSeconds':round(time.monotonic()-began,1),'memoryMaxBytes':cg['memory.max'],'memoryCurrentBytes':cg['memory.current'],'availableByCgroupBytes':cg['limitMinusCurrentBytes'],'lanes':lanes,'schedules':schedules,'spools':spools,'recentPostLimitLogs':pressure_logs(cid,LIMIT_APPLIED_AT)[-5:],'applicationProcesses':apply_pending_processes(cid) if WATCH_SAMPLE_COUNT in (3,7) else None,'workerCgroup':cg if WATCH_COST_MODE else None,'hostMemAvailableBytes':int(re.search(r'^MemAvailable:\s+(\d+)',Path('/proc/meminfo').read_text(),re.M)[1])*1024 if WATCH_COST_MODE else None,'hostLargestProcesses':memory_processes() if WATCH_COST_MODE else None};samples.append(sample)
        emit(operation='post_limit_scheduler',stage='observation',**sample,workerRestarted=False,providerRequests=0)
        decision=lanes['prematch']['decision']
        if decision in ('failure_after_limit','snapshot_completed_after_limit'):result=decision;break
        if index==WATCH_SAMPLE_COUNT-1:break
        time.sleep(WATCH_SAMPLE_INTERVAL)
    correlations={}
    for lane in ('prematch','inplay'):
        a=samples[0]['lanes'][lane];b=samples[-1]['lanes'][lane];x=a['ingress'];y=b['ingress'];dt=scheduler_time(y.get('metricWindowEndUTC'))-scheduler_time(x.get('metricWindowEndUTC'))
        fresh=dt>0 and a.get('sessionStartedAt')==b.get('sessionStartedAt') and scheduler_time(x.get('metricWindowEndUTC'))>=scheduler_time(samples[0]['atUTC'])-5 and scheduler_time(y.get('metricWindowEndUTC'))>=scheduler_time(samples[-1]['atUTC'])-30 and all(type(x.get(k)) is int and type(y.get(k)) is int and y[k]>=x[k] for k in ('received','processed','checkpointed'))
        correlations[lane]={'comparableMetricWindows':fresh,'windowSeconds':dt,'processingBacklogStart':x.get('processingBacklog'),'processingBacklogEnd':y.get('processingBacklog'),'receivedPerSecond':(y['received']-x['received'])/dt if fresh else None,'processedPerSecond':(y['processed']-x['processed'])/dt if fresh else None,'checkpointedPerSecond':(y['checkpointed']-x['checkpointed'])/dt if fresh else None,'persistentWritesStart':a['persistence'].get('writes'),'persistentWritesEnd':b['persistence'].get('writes'),'etaSeconds':None}
    logs=pressure_logs(cid,LIMIT_APPLIED_AT)
    emit(operation='post_limit_scheduler_complete',result=result or 'observation_deadline_not_proof_of_stall',applyCounterPublicationGranularityRows=100,applyZeroCounterMeaning='zero_to_99_completed_rows_or_wait_before_first_row_not_distinguishable_without_new_worker_instrumentation',observedAtUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),workerId=cid,appliedAtUTC=LIMIT_APPLIED_AT,samples=samples,correlations=correlations,postLimitLogs=logs,workerRestarted=False,providerRequests=0,integrationVerified=False,spoolReusePolicy='existing_active_attempt_only_no_external_replay_or_cooldown_reset',backlogEtaSeconds=None)
try:post_limit_main()
except Exception as error:
    emit(operation='post_limit_scheduler_failure',status='blocked',reason=str(error) if re.fullmatch('[A-Z_0-9]{3,120}',str(error)) else 'POST_LIMIT_SCHEDULER_OBSERVATION_FAILED',diagnostic=recovery_exception_details(error),workerRestarted=False,providerRequests=0)
    raise SystemExit(2)
