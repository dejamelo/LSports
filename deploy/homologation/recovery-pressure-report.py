"""Appended to helper definitions; bounded read-only pressure sampling, no consumer actions."""
def pressure_metadata(path):
    # The existing writer publishes connections before events. Read ONLY that
    # bounded prefix: this is telemetry, never proof that a snapshot is complete.
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'r',encoding='utf8') as file:
        reader=DiagnosticJson(file);reader.whitespace();require(reader.take()=='{','PRESSURE_METADATA_ROOT');out={}
        for i in range(32):
            reader.whitespace();key=reader.string(True);reader.whitespace();require(reader.take()==':','PRESSURE_METADATA_COLON');reader.whitespace()
            require(key!='events','CONNECTIONS_NOT_IN_BOUNDED_PREFIX')
            value=reader.value(key in ('connections','updatedAt','mode'))
            if key in ('connections','updatedAt','mode'):out[key]=value
            require(reader.offset+reader.pos<=1024*1024,'PRESSURE_METADATA_PREFIX_LIMIT')
            if key=='connections':return out
            reader.whitespace();require(reader.take()==',','PRESSURE_METADATA_SEPARATOR')
    raise RuntimeError('PRESSURE_METADATA_MISSING')

def pressure_logs(cid,start):
    proc=subprocess.run(['docker','logs','--timestamps','--since',start,'--tail','1500',cid],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=15,check=False)
    require(proc.returncode==0,'PRESSURE_LOG_READ_FAILED');raw=proc.stdout
    require(len(raw)<=8*1024**2,'PRESSURE_LOG_LIMIT')
    out=[]
    for line in raw.decode(errors='replace').splitlines():
        stamp,_,text=line.partition(' ')
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T[0-9:.]+Z',stamp):continue
        try:record=json.loads(text)
        except ValueError:continue
        if not isinstance(record,dict):continue
        safe={'loggedAtUTC':stamp}
        if record.get('operation') in ('snapshot.events','snapshot.apply_wait','file.persist','feed.coverage'):
            safe.update(operation=record['operation'])
            for key in ('lane','stage','status'):
                if isinstance(record.get(key),str) and re.fullmatch('[a-z_]{1,60}',record[key]):safe[key]=record[key]
            for key in ('bytes','validatedRows','appliedRows','rssBytes','heapUsedBytes','externalBytes','arrayBuffersBytes','writes','lastDurationMs','captureDurationMs','regularDurationMs','publishDurationMs','maxEventLoopDelayMs','waitedMs','maximumWaitMs','memoryBudgetBytes','memoryHeadroomBytes'):
                if type(record.get(key)) is int:safe[key]=record[key]
            if record['operation']=='snapshot.events':safe['diagnostic']=safe_feed_diagnostic(record)
            if record['operation']=='feed.coverage':
                safe['lanes']={}
                for lane in ('prematch','inplay'):
                    c=(record.get('coverage') or {}).get(lane,{})
                    safe['lanes'][lane]={'messagesByType':{str(k):v for k,v in c.get('messagesByType',{}).items() if re.fullmatch(r'\d{1,3}',str(k)) and type(v) is int},'activity':{k:v for k,v in c.get('activity',{}).items() if k in ('lastDataDecodedAt','lastMarketDecodedAt','lastControlDecodedAt','lastSettlementDecodedAt') and (v is None or isinstance(v,str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T[0-9:.]+Z',v))}}
            out.append(safe)
    return out[-80:]

def pressure_main():
    workers=states('worker');require(len(workers)==1 and workers[0]['running'],'CURRENT_RUNNING_WORKER_REQUIRED_NO_START')
    cid=workers[0]['id'];info=json.loads(run(['docker','inspect',cid]))[0];started=info['State']['StartedAt'];start_ms=int(datetime.datetime.fromisoformat(started.replace('Z','+00:00')).timestamp()*1000)
    mounts=[m for m in info['Mounts'] if m.get('Destination')=='/app/.runtime/feed' and m.get('Type')=='volume'];require(len(mounts)==1,'FEED_VOLUME_UNVERIFIED')
    volume=json.loads(run(['docker','volume','inspect',mounts[0]['Name']]))[0];require(volume.get('Labels',{}).get('com.docker.compose.project')=='adl-homologation','FEED_VOLUME_PROJECT_UNVERIFIED')
    directory=Path(volume['Mountpoint']);env=dict(v.split('=',1) for v in info['Config'].get('Env',[]) if '=' in v)
    keys=('LSPORTS_PREMATCH_SNAPSHOT_MAX_RESPONSE_MB','LSPORTS_INPLAY_SNAPSHOT_MAX_RESPONSE_MB','LSPORTS_SNAPSHOT_MAX_RESPONSE_MB');caps={k:env[k] for k in keys if k in env and re.fullmatch(r'\d{1,3}',env[k])}
    budgets={'prematch':{'path':'disk_spool_two_pass','sourceFormulaIncrementalBudgetBytes':320*1024**2,'basis':'installed source verification required; raw item bound 16 MiB, scratch estimate 32 MiB * 8 + 64 MiB'},'inplay':{'path':'SDK_response','sourceFormulaBudgetBytes':(int(caps.get(keys[1],'128'))*8+64)*1024**2}}
    samples=[];boundary={}
    for n in range(3):
        current=json.loads(run(['docker','inspect',cid]))[0];require(current['State']['Running'] and current['State']['StartedAt']==started,'WORKER_CHANGED_STOP_MEASUREMENT_NO_RESTART')
        metadata=pressure_metadata(directory/'trade-feed.json')
        inbox=json.loads(run(['docker','exec',cid,'node','--input-type=module','-e',PRESSURE_INBOX_PROBE,str(start_ms),json.dumps(boundary)],timeout=20))
        if not boundary:boundary={l:inbox['lanes'][l]['baselineHighId'] for l in ('prematch','inplay')}
        logs=pressure_logs(cid,started);lanes={}
        for lane in ('prematch','inplay'):
            c=metadata['connections'].get(lane,{})
            metrics={k:v for k,v in c.get('ingressProgress',{}).items() if k in ('received','acknowledged','processed','checkpointed','processingBacklog','oldestProcessingAgeMs','metricWindowEndUTC','headersByType')}
            if isinstance(metrics.get('headersByType'),dict):metrics['headersByType']={str(k):v for k,v in metrics['headersByType'].items() if re.fullmatch(r'\d{1,3}|unknown',str(k)) and type(v) is int and v>=0}
            snap={k:v for k,v in c.get('fullSnapshot',{}).items() if k in ('stage','bytes','validatedRows','appliedRows','lastProgressAt','startedAt','completedAt')}
            lanes[lane]={'diagnosticTimestampScope':'compare lastSnapshotErrorAt against sessionStartedAt; absent timestamps are unverified','sessionStartedAt':(c.get('session') or {}).get('startedAt'),'phase':c.get('phase'),'lastSnapshotAt':c.get('lastSnapshotAt'),'lastSnapshotErrorAt':c.get('lastSnapshotErrorAt'),'diagnostic':safe_feed_diagnostic(c.get('diagnostic')),'lastSnapshotDiagnostic':safe_feed_diagnostic(c.get('lastSnapshotDiagnostic')),'metrics':metrics,'snapshot':snap,'inbox':inbox['lanes'][lane]}
        process_memory=[]
        for line in run(['docker','top',cid,'-eo','pid,comm'],timeout=10).decode().splitlines()[1:]:
            fields=line.split()
            if len(fields)!=2 or not fields[0].isdigit() or fields[1] not in ('node','nodejs'):continue
            try:
                status=Path('/proc/'+fields[0]+'/status').read_text();mem={'hostPid':int(fields[0])}
                for key in ('VmRSS','VmHWM','VmSize'):
                    match=re.search(r'^'+key+r':\s*(\d+) kB',status,re.M)
                    if match:mem[key+'Bytes']=int(match[1])*1024
                process_memory.append(mem)
            except FileNotFoundError:pass
        spools=[{'directory':p.parent.name,'bytes':p.stat().st_size,'mtimeUTC':datetime.datetime.fromtimestamp(p.stat().st_mtime,datetime.timezone.utc).isoformat()} for p in list(directory.glob('.full-snapshot-*/response.private.json'))[:16] if not p.is_symlink() and not p.parent.is_symlink()]
        sample={'processMemory':process_memory,'spools':spools,'installedSourceHashes':inbox['installedSourceHashes'],'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checkpointUpdatedAt':metadata.get('updatedAt'),'cgroup':inbox['cgroup'],'lanes':lanes,'logs':logs};samples.append(sample)
        emit(operation='recovery_pressure',sample=n+1,atUTC=sample['atUTC'],cgroup=sample['cgroup'],lanes={l:{'processingBacklog':lanes[l]['metrics'].get('processingBacklog'),'processed':lanes[l]['metrics'].get('processed'),'snapshot':lanes[l]['snapshot'],'cohorts':lanes[l]['inbox']} for l in lanes})
        if n<2:time.sleep(20)
    duration=(datetime.datetime.fromisoformat(samples[-1]['atUTC'])-datetime.datetime.fromisoformat(samples[0]['atUTC'])).total_seconds();rates={}
    for lane in ('prematch','inplay'):
        first=samples[0]['lanes'][lane];last=samples[-1]['lanes'][lane];a=first['metrics'];b=last['metrics'];dt=(datetime.datetime.fromisoformat(b['metricWindowEndUTC'].replace('Z','+00:00'))-datetime.datetime.fromisoformat(a['metricWindowEndUTC'].replace('Z','+00:00'))).total_seconds() if a.get('metricWindowEndUTC') and b.get('metricWindowEndUTC') else 0
        comparable=dt>0 and first['sessionStartedAt']==last['sessionStartedAt'] and all(type(a.get(k)) is int and type(b.get(k)) is int and b[k]>=a[k] for k in ('received','processed','checkpointed'))
        rates[lane]={'receivedPerSecond':(b['received']-a['received'])/dt if comparable else None,'processedPerSecond':(b['processed']-a['processed'])/dt if comparable else None,'checkpointedPerSecond':(b['checkpointed']-a['checkpointed'])/dt if comparable else None,'comparableFreshMetrics':comparable,'oldCohortRetiredPerSecond':(first['inbox']['receivedBeforeWorkerStart']-last['inbox']['receivedBeforeWorkerStart'])/duration,'newPendingSinceBaseline':last['inbox']['arrivedSinceFirstSample'],'pendingCheckpointNetGrowthPerSecond':(last['inbox']['pendingCheckpointRows']-first['inbox']['pendingCheckpointRows'])/duration}
    emit(operation='recovery_pressure_complete',workerId=cid,imageId=info['Image'],startedAtUTC=started,memoryLimitBytes=info['HostConfig'].get('Memory'),caps=caps,budgets=budgets,rates=rates,samples=samples,readOnly=True,providerRequests=0,workerRestarted=False,ackMeaning='durable receipt only; cohorts count pending checkpoint, not exclusively unprocessed',budgetLimitation='Source formulas are estimates until matched to installed hashes; diagnostic memoryBudgetBytes/memoryHeadroomBytes are actual failure evidence, possibly historical; main heap comes only from dated worker logs, not probe process',snapshotCounterLimitation='old worker reports each 100 rows; zero is not proof of no validation')
try:pressure_main()
except Exception as error:
    emit(operation='recovery_pressure_exception',status='blocked',reason='PRESSURE_MEASUREMENT_FAILED',exceptionDetails=recovery_exception_details(error),readOnly=True,workerRestarted=False,providerRequests=0)
    raise SystemExit(2)
