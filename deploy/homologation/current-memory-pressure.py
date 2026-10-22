"""Host-side bounded observation: no docker exec, SQLite scan, spool read or consumer action."""
def memory_cgroup(pid):
    raw=Path('/proc/'+str(pid)+'/cgroup').read_text();match=re.search(r'^0::(/[^\n]*)$',raw,re.M)
    require(match is not None,'CGROUP_V2_PATH_UNAVAILABLE')
    root=Path('/sys/fs/cgroup');folder=(root/match[1].lstrip('/')).resolve();require(folder==root or root in folder.parents,'CGROUP_PATH_UNVERIFIED')
    def one(where,key):
        p=where/key
        if not p.exists():return None
        text=p.read_text().strip()
        if text=='max':return None
        if text.isdigit():return int(text)
        if key=='memory.pressure':
            return {line.split()[0]:{k:float(v) for k,v in (part.split('=') for part in line.split()[1:]) if k in ('avg10','avg60','avg300','total')} for line in text.splitlines()}
        return {k:int(v) for k,v in (line.split() for line in text.splitlines()) if v.isdigit()}
    result={key:one(folder,key) for key in ('memory.current','memory.peak','memory.max','memory.high','memory.low','memory.min','memory.swap.current','memory.swap.max','memory.events','memory.pressure')}
    stat=one(folder,'memory.stat') or {};result['stat']={k:v for k,v in stat.items() if k in ('anon','file','kernel','sock','shmem','file_dirty','file_writeback','inactive_file','active_file','slab','slab_reclaimable','pagetables','kernel_stack')}
    limits=[v for k in ('memory.max','memory.high') if isinstance((v:=result.get(k)),int)]
    result['limitMinusCurrentBytes']=max(0,min(limits)-result['memory.current']) if limits and isinstance(result['memory.current'],int) else None
    result['inactiveFileMinusDirtyWritebackBytes']=max(0,stat.get('inactive_file',0)-stat.get('file_dirty',0)-stat.get('file_writeback',0))
    result['cacheEstimateIsNotGuaranteedAllocatable']=True
    parents=[]
    for parent in list(folder.parents)[:8]:
        if parent!=root and root not in parent.parents:break
        parents.append({k:one(parent,k) for k in ('memory.current','memory.max','memory.high')})
        if parent==root:break
    result['ancestors']=parents;return result

def memory_processes():
    rows=[]
    for p in Path('/proc').iterdir():
        if not p.name.isdigit() or int(p.name)==os.getpid():continue
        try:
            status=(p/'status').read_text();rss=re.search(r'^VmRSS:\s*(\d+) kB',status,re.M)
            if not rss:continue
            exe=Path(os.readlink(p/'exe')).name;rows.append({'pid':int(p.name),'executable':exe if re.fullmatch('[A-Za-z0-9_.-]{1,60}',exe) else 'other','rssBytes':int(rss[1])*1024})
        except (OSError,ProcessLookupError):continue
    return sorted(rows,key=lambda r:r['rssBytes'],reverse=True)[:12]

def current_memory_main():
    import fcntl
    lock=os.open('/run/lock/adl-current-memory-pressure.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:raise RuntimeError('MEMORY_COLLECTOR_ALREADY_RUNNING_NO_DUPLICATE')
    workers=states('worker');require(len(workers)==1 and workers[0]['running'],'RUNNING_WORKER_REQUIRED_NO_ACTION')
    cid=workers[0]['id'];info=json.loads(run(['docker','inspect',cid]))[0];started=info['State']['StartedAt']
    mounts=[m for m in info['Mounts'] if m.get('Destination')=='/app/.runtime/feed' and m.get('Type')=='volume'];require(len(mounts)==1,'FEED_VOLUME_UNVERIFIED')
    volume=json.loads(run(['docker','volume','inspect',mounts[0]['Name']]))[0];require((volume.get('Labels') or {}).get('com.docker.compose.project')=='adl-homologation','FEED_VOLUME_PROJECT_UNVERIFIED');directory=Path(volume['Mountpoint'])
    hashes={};base=Path('/proc/'+str(info['State']['Pid'])+'/root/app')
    for name in ('apps/worker/src/snapshot-capacity.ts','apps/worker/src/full-snapshot.ts','apps/worker/src/persistence.ts','apps/worker/src/connected.ts','apps/worker/src/durable-ingress.mjs','packages/feed-store/src/index.ts'):
        p=base/name;require(p.is_file() and p.stat().st_size<256*1024,'INSTALLED_SOURCE_UNVERIFIED');hashes[name]=hashlib.sha256(p.read_bytes()).hexdigest()
    runtime={}
    for header in ('usr/local/include/node/uv/version.h','usr/local/include/node/node_version.h'):
        p=base.parent/header
        if p.is_file():
            text=p.read_text();runtime.update({k:int(v) for k,v in re.findall(r'^#define\s+((?:UV_VERSION|NODE)_(?:MAJOR|MINOR|PATCH)(?:_VERSION)?)\s+(\d+)',text,re.M)})
    env=dict(v.split('=',1) for v in info['Config'].get('Env',[]) if '=' in v)
    limits={'dockerMemoryBytes':info['HostConfig'].get('Memory'),'dockerMemoryReservationBytes':info['HostConfig'].get('MemoryReservation'),'dockerSwapLimitBytes':info['HostConfig'].get('MemorySwap'),'nodeOldSpaceMiB':[int(n) for n in re.findall(r'--max[-_]old[-_]space[-_]size(?:=|\s+)([0-9]{1,6})',env.get('NODE_OPTIONS',''))],'snapshotCapsMiB':{k:int(env[k]) for k in ('LSPORTS_PREMATCH_SNAPSHOT_MAX_RESPONSE_MB','LSPORTS_INPLAY_SNAPSHOT_MAX_RESPONSE_MB','LSPORTS_SNAPSHOT_MAX_RESPONSE_MB') if re.fullmatch('[0-9]{1,4}',env.get(k,''))}}
    samples=[]
    for index in range(4):
        current=json.loads(run(['docker','inspect',cid]))[0];require(current['State']['Running'] and current['State']['StartedAt']==started,'WORKER_CHANGED_NO_ACTION')
        metadata=pressure_metadata(directory/'trade-feed.json');host={}
        for line in Path('/proc/meminfo').read_text().splitlines():
            key,_,value=line.partition(':')
            if key in ('MemTotal','MemFree','MemAvailable','Cached','Buffers','Dirty','Writeback','SReclaimable','Shmem','SwapTotal','SwapFree'):host[key+'Bytes']=int(value.split()[0])*1024
        ids=run(['docker','ps','-q']).decode().split();require(len(ids)<=128,'CONTAINER_COUNT_LIMIT');containers=[]
        for c in json.loads(run(['docker','inspect',*ids])) if ids else []:
            name=c.get('Name','').lstrip('/');row={'id':c['Id'],'name':name if re.fullmatch('[A-Za-z0-9_.-]{1,100}',name) else 'other','memoryLimitBytes':c['HostConfig'].get('Memory'),'pid':c['State']['Pid']}
            try:row['cgroup']=memory_cgroup(c['State']['Pid'])
            except (OSError,RuntimeError):row['cgroupUnavailable']=True
            containers.append(row)
        lanes={}
        for lane in ('prematch','inplay'):
            c=metadata['connections'].get(lane,{})
            lanes[lane]={k:c.get(k) for k in ('phase','lastSnapshotAt','lastSnapshotErrorAt')}
            lanes[lane]['sessionStartedAt']=(c.get('session') or {}).get('startedAt')
            lanes[lane]['snapshot']={k:v for k,v in (c.get('fullSnapshot') or {}).items() if k in ('stage','bytes','startedAt','completedAt','lastProgressAt','validatedRows','appliedRows')}
            lanes[lane]['diagnostic']=safe_feed_diagnostic(c.get('lastSnapshotDiagnostic'))
            lanes[lane]['ingress']={k:v for k,v in (c.get('ingressProgress') or {}).items() if k in ('received','acknowledged','processed','checkpointed','processingBacklog','oldestProcessingAgeMs','metricWindowEndUTC')}
            lanes[lane]['persistence']={k:v for k,v in (c.get('persistenceProgress') or {}).items() if k in ('writes','lastCompletedAt','lastDurationMs','captureDurationMs','regularDurationMs','publishDurationMs','rssBytes','maxEventLoopDelayMs','metricWindowStartUTC','metricWindowEndUTC')}
        spools=[{'directory':p.parent.name,'bytes':p.stat().st_size,'modifiedAtUTC':datetime.datetime.fromtimestamp(p.stat().st_mtime,datetime.timezone.utc).isoformat(),'contentsRead':False} for p in list(directory.glob('.full-snapshot-*/response.private.json'))[:16] if p.is_file() and not p.is_symlink() and not p.parent.is_symlink()]
        sample={'observedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checkpointUpdatedAt':metadata.get('updatedAt'),'host':host,'workerCgroup':memory_cgroup(current['State']['Pid']),'containers':containers,'hostLargestProcesses':memory_processes(),'spools':spools,'lanes':lanes}
        samples.append(sample);emit(operation='current_memory_pressure',sample=index+1,observedAtUTC=sample['observedAtUTC'],hostMemAvailableBytes=host.get('MemAvailableBytes'),workerCgroup=sample['workerCgroup'],lanes=lanes,workerRestarted=False,providerRequests=0)
        if index<3:time.sleep(20)
    rates={}
    for lane in ('prematch','inplay'):
        a=samples[0]['lanes'][lane];b=samples[-1]['lanes'][lane];x=a['ingress'];y=b['ingress'];dt=0
        try:dt=(datetime.datetime.fromisoformat(y['metricWindowEndUTC'].replace('Z','+00:00'))-datetime.datetime.fromisoformat(x['metricWindowEndUTC'].replace('Z','+00:00'))).total_seconds()
        except (KeyError,TypeError,ValueError):pass
        observed_start=datetime.datetime.fromisoformat(samples[0]['observedAtUTC']).timestamp();observed_end=datetime.datetime.fromisoformat(samples[-1]['observedAtUTC']).timestamp()
        try:metric_end=datetime.datetime.fromisoformat(y['metricWindowEndUTC'].replace('Z','+00:00')).timestamp()
        except (KeyError,TypeError,ValueError):metric_end=0
        fresh=dt>0 and observed_start-5<=metric_end<=observed_end+5 and a['sessionStartedAt']==b['sessionStartedAt'] and all(type(x.get(k)) is int and type(y.get(k)) is int and y[k]>=x[k] for k in ('received','processed','checkpointed'))
        rates[lane]={'comparableMetricWindows':fresh,'windowSeconds':dt,'receivedPerSecond':(y['received']-x['received'])/dt if fresh else None,'processedPerSecond':(y['processed']-x['processed'])/dt if fresh else None,'checkpointedPerSecond':(y['checkpointed']-x['checkpointed'])/dt if fresh else None,'processingBacklogStart':x.get('processingBacklog'),'processingBacklogEnd':y.get('processingBacklog'),'oldestProcessingAgeMsStart':x.get('oldestProcessingAgeMs'),'oldestProcessingAgeMsEnd':y.get('oldestProcessingAgeMs'),'etaSeconds':None,'etaWithheld':'needs sustained drain, fresh metric windows and reconciliation with durable pending rows; ACKs are receipt only'}
    emit(operation='current_memory_pressure_complete',workerId=cid,imageId=info['Image'],startedAtUTC=started,installedSourceHashes=hashes,runtimeHeaders=runtime,workerLimits=limits,rates=rates,samples=samples,logs=pressure_logs(cid,started),readOnly=True,providerRequests=0,workerRestarted=False,spoolContentsRead=False,inboxScanned=False,containerProbeStarted=False,persistenceScope='shared_worker_not_independent_lane_measurements',memoryTimingScope='dated_diagnostics_are_not_simultaneous_with_host_samples')
try:current_memory_main()
except Exception as error:
    emit(operation='current_memory_pressure_failure',status='blocked',diagnostic=recovery_exception_details(error),reason=str(error) if re.fullmatch('[A-Z_]{3,100}',str(error)) else 'CURRENT_PRESSURE_COLLECTION_FAILED',workerRestarted=False,providerRequests=0)
    raise SystemExit(2)
