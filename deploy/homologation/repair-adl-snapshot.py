"""Dimensioned, evidence-gated snapshot limit repair. Never touches POSNET or journals."""
def snapshot_memory_operand(value):
    # Only bounded numeric representations may be echoed. Unexpected text stays private.
    report={'type':type(value).__name__}
    if value is None or type(value) is bool:report['value']=value
    elif type(value) is int and -(2**63)<=value<=2**63-1:report['value']=value
    elif type(value) is float and math.isfinite(value) and abs(value)<=2**63-1:report['value']=value
    elif isinstance(value,str) and re.fullmatch(r'[0-9]{1,19}',value):report['value']=value
    else:report['valueRedacted']=True
    return report

def snapshot_memory_bytes(value):
    # Compose config JSON can serialize bytes as a decimal string; Docker uses an int.
    # Do not coerce booleans, floats, units, unlimited/zero, missing or malformed values.
    if type(value) is int:result=value
    elif isinstance(value,str) and re.fullmatch(r'[1-9][0-9]{0,18}',value):result=int(value)
    else:raise RuntimeError('WORKER_MEMORY_LIMIT_UNVERIFIED')
    require(0<result<=2**63-1,'WORKER_MEMORY_LIMIT_UNVERIFIED')
    return result

def snapshot_memory_model(value):
    result=copy.deepcopy(value)
    result['services']['worker']['mem_limit']=snapshot_memory_bytes(result['services']['worker'].get('mem_limit'))
    return result

def snapshot_file_hash(path):
    digest=hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda:source.read(1024*1024),b''):digest.update(block)
    return digest.hexdigest()

def snapshot_volume_failures(failures):
    proven={lane:[] for lane in ('prematch','inplay')}
    for lane in proven:
        for d in failures.get(lane,[]):
            nested=(d.get('coordinator') or {}).get('failure') or {}
            for candidate in (d,nested):
                if candidate.get('operation') in (None,'snapshot.events') and candidate.get('reason')=='response_size_limit' and candidate.get('responseLimitBytes')==128*1024*1024 and candidate.get('httpStatus')==200:
                    proven[lane].append({'httpStatus':200,'responseLimitBytes':128*1024*1024,'reason':'response_size_limit'})
    return proven

def snapshot_utc(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T[0-9:.]+Z',value):return None
    try:return datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()
    except (ValueError,OverflowError):return None

def correlate_snapshot_failures(capacities,worker_started,feed,evidence,historical=None):
    rows=[];start=snapshot_utc(worker_started)
    def add(lane,d,source,logged=None):
        if lane not in ('prematch','inplay') or not isinstance(d,dict):return
        coordinator=d.get('coordinator') if isinstance(d.get('coordinator'),dict) else {}
        candidates=[(d,coordinator,logged),(coordinator.get('failure'),coordinator,None)]
        for failure,c,log_time in candidates:
            if not isinstance(failure,dict) or failure.get('reason')!='response_size_limit':continue
            if failure.get('operation') not in (None,'snapshot.events') or c.get('operation') not in (None,'snapshot.events'):continue
            limit=failure.get('responseLimitBytes');current=capacities[lane]['limitBytes']
            if type(limit) is not int or limit<=0 or limit>2**40:continue
            attempted=c.get('at');completed=c.get('completedAt');a=snapshot_utc(attempted);b=snapshot_utc(completed);log=snapshot_utc(log_time)
            timing='unproven_age'
            # A cooldown can print an older failure: never use its new log time for the nested failure.
            if start is not None:
                if b is not None and b<start:timing='before_current_container'
                elif a is not None and a>=start and (b is None or b>=a):timing='current_container'
                elif a is None and b is not None and b>=start:timing='current_container'
                elif a is None and b is None and log is not None:timing='current_container' if log>=start else 'before_current_container'
            if timing=='before_current_container':classification='historical_before_current_configuration'
            elif timing=='current_container':classification='current_limit_exceeded' if limit==current else 'current_runtime_limit_mismatch'
            else:classification='insufficient_timestamp_evidence'
            success_value=((feed.get('connections') or {}).get(lane) or {}).get('lastSnapshotAt')
            success=snapshot_utc(success_value);failure_time=b if b is not None else log
            if classification=='current_limit_exceeded' and success is not None and start is not None and success>=start and failure_time is not None and success>failure_time:classification='superseded_by_later_successful_snapshot'
            row={'lane':lane,'packageId':4511 if lane=='prematch' else 4510,'source':source,'httpStatus':failure.get('httpStatus') if type(failure.get('httpStatus')) is int else None,'attemptLimitBytes':limit,'effectiveLimitBytes':current,'containerStartedAt':worker_started if start is not None else None,'requestAt':attempted if a is not None else None,'failedAt':completed if b is not None else None,'loggedAt':log_time if log is not None else None,'timing':timing,'classification':classification,'lastSuccessfulSnapshotAt':success_value if success is not None else None}
            rows.append(row)
    def collect(e,source):
        if not isinstance(e,dict):return
        for d in e.get('recentErrors',[]):add(d.get('lane'),d,source+'.logs',d.get('loggedAt'))
        for schedule in e.get('schedulers',[]):
            for item in schedule.get('operations',[]):
                if item.get('operation')!='snapshot.events':continue
                lane={4511:'prematch',4510:'inplay'}.get(item.get('packageId'))
                add(lane,{'coordinator':item.get('coordinator',{})},source+'.journal')
    collect(evidence,'current')
    for lane in ('prematch','inplay'):
        connection=(feed.get('connections') or {}).get(lane,{})
        for key in ('diagnostic','lastSnapshotDiagnostic'):add(lane,connection.get(key),key)
    if isinstance(historical,dict):
        collect(historical.get('evidence'),'saved_validation')
        for lane,connection in (historical.get('lanes') or {}).items():
            for key in ('diagnostic','lastSnapshotDiagnostic'):add(lane,connection.get(key),'saved_validation.'+key)
    unique={}
    for row in rows:
        key=tuple(row[k] for k in ('lane','attemptLimitBytes','requestAt','failedAt','loggedAt','classification'))
        if key in unique:unique[key]['sources'].append(row['source'])
        else:unique[key]={**row,'sources':[row['source']]}
    rows=list(unique.values())
    decisions={}
    for lane in ('prematch','inplay'):
        current=[r for r in rows if r['lane']==lane and r['classification']=='current_limit_exceeded' and r['httpStatus']==200]
        mismatch=any(r['lane']==lane and r['classification']=='current_runtime_limit_mismatch' for r in rows)
        if current and capacities[lane]['limitBytes']>=256*1024**2:decision='bounded_partitioned_recovery_required_no_cap_increase'
        elif current:decision='confirmed_128_mib_limit_can_be_reviewed_for_256'
        elif mismatch:decision='runtime_limit_mismatch_requires_source_investigation'
        else:decision='no_current_size_failure_proven_do_not_change_limits'
        decisions[lane]=decision
    blockers=[]
    for lane in ('prematch','inplay'):
        d=((feed.get('connections') or {}).get(lane) or {}).get('diagnostic') or {}
        if d.get('reason')=='unsupported_message_type':blockers.append({'lane':lane,'diagnostic':safe_feed_diagnostic(d),'action':'explicit_handler_required_no_discard'})
    return {'readOnly':True,'providerRequests':0,'rows':rows,'decisions':decisions,'independentMessageBlockers':blockers,'currentEffectiveLimitsBytes':{lane:capacities[lane]['limitBytes'] for lane in ('prematch','inplay')}}

def snapshot_plan(capacities, failures):
    proven=snapshot_volume_failures(failures)
    wanted={lane:256 for lane in proven if proven[lane] and capacities[lane]['limitBytes']==128*1024*1024}
    return wanted,256*1024*1024*8+64*1024*1024

def snapshot_host_memory():
    return int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')))*1024

def snapshot_sizing(model_limit,container_limit,cgroup,host_available,wanted,capacities):
    GiB=1024**3;target=4*GiB;reserve=2*GiB;budget=2112*1024**2
    require(model_limit in (2*GiB,4*GiB) and container_limit in (2*GiB,4*GiB),'WORKER_MEMORY_LIMIT_OUTSIDE_APPROVED_PLAN')
    require(str(cgroup.get('max')).isdigit() and int(cgroup['max'])==container_limit and str(cgroup.get('current')).isdigit(),'CGROUP_LIMIT_UNVERIFIED')
    needs_large=any(v.get('limitBytes')==256*1024**2 for v in capacities.values()) or bool(wanted)
    resize=needs_large and (model_limit!=target or container_limit!=target)
    changing=bool(wanted) or resize
    if changing:
        required=target+reserve
        require(host_available>=required,'SNAPSHOT_REPAIR_HOST_HEADROOM_INSUFFICIENT')
        if container_limit==target:require(container_limit-int(cgroup['current'])>=budget,'SNAPSHOT_REPAIR_CGROUP_HEADROOM_INSUFFICIENT')
    return {'changed':changing,'resize':resize,'targetMemoryBytes':target if resize else model_limit,'hostAvailableBytes':host_available,'hostReserveBytes':reserve,'conversionBudgetBytes':budget,'targetHeapMB':3072}

def repair_snapshot(request):
    stage='snapshot_repair.inspect';backup=None;stopped=False
    try:
        require(os.geteuid()==0,'ROOT_REQUIRED')
        audit=request['handoff']['audit'];require(audit['status']=='ok' and audit['workerLockAbsent'] and audit['matchingWorkerProcesses']==0,'MAC_SHUTDOWN_UNPROVEN')
        require(request['freshAuditAt'].endswith('Z') and -5<=time.time()-datetime.datetime.fromisoformat(request['freshAuditAt'].replace('Z','+00:00')).timestamp()<60,'MAC_REAUDIT_EXPIRED')
        meta=json.loads((SECURE/'deployment.json').read_bytes());release=Path(meta['release'])
        require(release.parent==RELEASES and re.fullmatch('[0-9a-f]{40}',release.name) and not release.is_symlink(),'RELEASE_UNVERIFIED')
        base=['docker','compose','-p','adl-homologation','--env-file',str(SECURE/'deploy.env'),'-f',str(release/'deploy/homologation/compose.yaml'),'-f',str(release/'deploy/homologation/compose.existing-caddy.yaml')]
        for entry in meta.get('composeOverrides',[]):
            f=Path(entry);require(f.parent==SECURE and f.is_file() and not f.is_symlink(),'OVERRIDE_UNVERIFIED');base+=['-f',entry]
        workers=states('worker');require(len(workers)==1 and workers[0]['running'],'REPAIR_REQUIRES_ONE_RUNNING_WORKER')
        require(control_status()==200,'API_NOT_HEALTHY')
        worker=json.loads(run(['docker','inspect',workers[0]['id']]))[0];before=model(base)
        model_raw=before['services']['worker'].get('mem_limit');container_raw=worker.get('HostConfig',{}).get('Memory')
        emit(operation='cutover.aws',stage='snapshot_repair.memory_comparison',status='inspected',compose=snapshot_memory_operand(model_raw),docker=snapshot_memory_operand(container_raw),workerStopped=False,backup=None,posnetChanged=False)
        model_limit=snapshot_memory_bytes(model_raw);container_limit=snapshot_memory_bytes(container_raw)
        before=snapshot_memory_model(before)
        layers=[];initial=base[:base.index('-f')+4]
        # Report only numeric worker limits, never Compose output or env-file contents.
        for count in range(len(initial),len(base)+1,2):
            raw=model(base[:count])['services']['worker'].get('mem_limit')
            try:normalized=snapshot_memory_bytes(raw)
            except RuntimeError:normalized=None
            layers.append({'layer':len(layers),'operand':snapshot_memory_operand(raw),'memoryLimitBytes':normalized})
        deploy_values=dict(line.split('=',1) for line in (SECURE/'deploy.env').read_text().splitlines() if line and not line.startswith('#') and '=' in line)
        memory_var=deploy_values.get('ADL_WORKER_MEMORY_LIMIT')
        var_bytes={'2g':2147483648,'4g':4294967296,'2147483648':2147483648,'4294967296':4294967296}.get((memory_var or '').lower())
        origin={'deploymentVariablePresent':memory_var is not None,'deploymentVariableBytes':var_bytes,'savedOverrideLayers':len(meta.get('composeOverrides',[]))}
        emit(operation='cutover.aws',stage='snapshot_repair.memory_origin',status='inspected',composeMemoryBytes=model_limit,containerMemoryBytes=container_limit,layers=layers,origin=origin,workerStopped=False,posnetChanged=False)
        image=json.loads(run(['docker','image','inspect',before['services']['worker']['image']]))[0]['Id'];require(worker['Image']==image,'RUNNING_IMAGE_MISMATCH')
        mount=[m for m in worker['Mounts'] if m['Destination']=='/app/.runtime/feed'];require(len(mount)==1 and mount[0]['Type']=='volume' and mount[0]['RW'],'FEED_MOUNT_UNVERIFIED')
        volume=json.loads(run(['docker','volume','inspect',mount[0]['Name']]))[0];require((volume.get('Labels') or {}).get('com.docker.compose.project')=='adl-homologation','VOLUME_PROJECT_UNVERIFIED')
        directory=Path(volume['Mountpoint']);require(not directory.is_symlink(),'VOLUME_SYMLINK')
        probe="""import fs from 'node:fs';import{createHash}from'node:crypto';import{snapshotCapacity}from'/app/apps/worker/src/snapshot-capacity.ts';const read=p=>{try{return fs.readFileSync(p,'utf8').trim()}catch{return null}};const hashes={};for(const p of ['provider.ts','diagnostics.ts','snapshot-capacity.ts'])hashes[p]=createHash('sha256').update(fs.readFileSync('/app/apps/worker/src/'+p)).digest('hex');console.log(JSON.stringify({capacities:{prematch:snapshotCapacity(process.env,undefined,'prematch'),inplay:snapshotCapacity(process.env,undefined,'inplay')},proposed:snapshotCapacity({...process.env,LSPORTS_PREMATCH_SNAPSHOT_MAX_RESPONSE_MB:'256'},undefined,'prematch'),cgroup:{max:read('/sys/fs/cgroup/memory.max'),current:read('/sys/fs/cgroup/memory.current')},sourceHashes:hashes}));"""
        observed=json.loads(run(['docker','exec',workers[0]['id'],'node','--import','tsx','--input-type=module','-e',probe],timeout=25))
        failures={lane:[] for lane in ('prematch','inplay')};evidence=feed_evidence(directory,workers)
        for d in evidence['recentErrors']:
            if d.get('lane') in failures:failures[d['lane']].append(d)
        for scheduler in evidence.get('schedulers',[]):
            for entry in scheduler.get('operations',[]):
                if entry.get('operation')=='snapshot.events' and entry.get('packageId') in (4510,4511):
                    lane='prematch' if entry['packageId']==4511 else 'inplay'
                    failures[lane].append({'operation':'snapshot.events','coordinator':entry.get('coordinator',{})})
        feed={}
        checkpoint=directory/'trade-feed.json'
        if checkpoint.is_file():
            require(not checkpoint.is_symlink() and checkpoint.stat().st_size<=256*1024*1024,'CHECKPOINT_SIZE_LIMIT')
            available=snapshot_host_memory()
            require(available>checkpoint.stat().st_size*8+64*1024*1024,'DIAGNOSTIC_MEMORY_BUDGET')
            feed=json.loads(checkpoint.read_bytes())
            for lane in failures:
                connection=feed.get('connections',{}).get(lane,{})
                failures[lane].append(safe_feed_diagnostic(connection.get('lastSnapshotDiagnostic')))
                failures[lane].append(safe_feed_diagnostic(connection.get('diagnostic')))
        correlation=correlate_snapshot_failures(observed['capacities'],worker.get('State',{}).get('StartedAt'),feed,evidence,request.get('historicalValidation'))
        if request.get('inspectOnly') is True:
            emit(operation='cutover.aws',stage='snapshot_repair.correlation',status='ok',report=correlation,runtimeSourceMatchesExpected=observed['sourceHashes']==request['sourceHashes'],workerRunning=True,readOnly=True,workerStopped=False,limitsChanged=False,posnetChanged=False)
            return 0
        wanted,budget=snapshot_plan(observed['capacities'],failures)
        emit(operation='cutover.aws',stage=stage,status='inspected',effective=observed,failures=failures,plannedLaneLimitsMB=wanted,responseLimitFailuresByLane=snapshot_volume_failures(failures),evidence=evidence,workerStarted=False,posnetChanged=False)
        require(observed['sourceHashes']==request['sourceHashes'],'SNAPSHOT_RUNTIME_SOURCE_DIFFERS_NO_BLIND_PATCH')
        sizing=snapshot_sizing(model_limit,container_limit,observed['cgroup'],snapshot_host_memory(),wanted,observed['capacities'])
        emit(operation='cutover.aws',stage='snapshot_repair.sizing',status='inspected',sizing=sizing,plannedLaneLimitsMB=wanted,workerStopped=False,posnetChanged=False)
        if not sizing['changed']:
            emit(operation='cutover.aws',stage=stage,status='ok',changed=False,reason='NO_CURRENT_128_MIB_LANE_REQUIRES_CHANGE',workerRunning=True,posnetChanged=False);return 0
        require(shutil.disk_usage('/opt').free>checkpoint.stat().st_size*2+128*1024*1024 if checkpoint.exists() else shutil.disk_usage('/opt').free>128*1024*1024,'BACKUP_DISK_HEADROOM_INSUFFICIENT')
        handoff=request['handoff'];digest=hashlib.sha256(json.dumps(handoff,sort_keys=True,separators=(',',':')).encode()).hexdigest();receipt=SECURE/('cutover-'+digest+'.json')
        require(receipt.is_file() and not receipt.is_symlink(),'CUTOVER_RECEIPT_UNVERIFIED')
        saved=json.loads(receipt.read_bytes());require(isinstance(saved.get('startRequestedAtUTC'),str),'CUTOVER_START_RECEIPT_UNVERIFIED')
        backup=Path(tempfile.mkdtemp(prefix='adl-snapshot-capacity-',dir=BACKUPS));os.chmod(backup,0o700)
        private(backup/'deployment.before.json',(SECURE/'deployment.json').read_bytes());private(backup/'receipt.before.json',receipt.read_bytes());private(backup/'inspection.json',json.dumps({'observed':observed,'sizing':sizing,'memoryLayers':layers}).encode())
        # SIGTERM only. No Docker stop timeout escalation/SIGKILL and no lock removal.
        stage='snapshot_repair.graceful_stop'
        run(['docker','kill','--signal','SIGTERM',workers[0]['id']])
        until=time.time()+90
        while time.time()<until:
            if not any(c['running'] for c in states('worker')):stopped=True;break
            time.sleep(1)
        require(stopped,'AWS_GRACEFUL_STOP_PENDING_NO_MORE_SIGNALS')
        require(not (directory/'trade-feed.json.lock').exists() and not list(directory.glob('trade-feed.json*.reclaim')) and not list(directory.glob('trade-feed.json.snapshot-*.lock')),'AWS_LOCKS_PRESERVED_RESTART_BLOCKED')
        stage='snapshot_repair.backup'
        for f in [checkpoint,*directory.glob('trade-feed.json.snapshot-*.json')]:
            if not f.exists():continue
            require(f.is_file() and not f.is_symlink(),'BACKUP_SOURCE_UNVERIFIED');target=backup/f.name
            shutil.copyfile(f,target);os.chmod(target,0o600)
            with target.open('rb') as copied:os.fsync(copied.fileno())
            require(snapshot_file_hash(f)==snapshot_file_hash(target),'SNAPSHOT_BACKUP_MISMATCH')
        # An append-only worker environment override; every other Compose field stays exact.
        require(snapshot_host_memory()>=sizing['targetMemoryBytes']+sizing['hostReserveBytes'],'HOST_HEADROOM_CHANGED_AFTER_GRACEFUL_STOP')
        stage='snapshot_repair.overlay'
        env={'LSPORTS_'+lane.upper()+'_SNAPSHOT_MAX_RESPONSE_MB':str(limit) for lane,limit in wanted.items()}
        # Three GiB heap inside the approved four GiB physical cap, retaining other Node options.
        options=before['services']['worker'].get('environment',{}).get('NODE_OPTIONS','')
        require(isinstance(options,str),'NODE_OPTIONS_UNVERIFIED')
        heap_option=re.compile(r'--max[-_]old[-_]space[-_]size(?:=|\s+)\d+')
        require(len(heap_option.findall(options))<=1,'AMBIGUOUS_NODE_HEAP_OPTIONS')
        proposed_options=heap_option.sub('--max-old-space-size=3072',options) if heap_option.search(options) else (options+' --max-old-space-size=3072').strip()
        if proposed_options!=options:env['NODE_OPTIONS']=proposed_options
        change={'mem_limit':sizing['targetMemoryBytes'],'environment':env}
        overlay=SECURE/('compose.snapshot-'+backup.name+'.json');private(overlay,json.dumps({'services':{'worker':change}}).encode())
        after=snapshot_memory_model(model(base+['-f',str(overlay)]));expected=copy.deepcopy(before);expected['services']['worker']['environment'].update(env);expected['services']['worker']['mem_limit']=sizing['targetMemoryBytes'];require(after==expected,'UNEXPECTED_COMPOSE_MODEL_CHANGE')
        meta['composeOverrides']=[*meta.get('composeOverrides',[]),str(overlay)]
        tmp=SECURE/(backup.name+'.deployment.tmp');private(tmp,json.dumps(meta).encode());durable_replace(tmp,SECURE/'deployment.json')
        # Refresh only validation-session time; preserve receipts and the historical migration.
        saved.setdefault('capacityRestarts',[]).append({'previousStartRequestedAtUTC':saved['startRequestedAtUTC'],'backup':str(backup),'limitsMB':wanted,'sizing':sizing})
        saved['startRequestedAtUTC']=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
        tmp=SECURE/(backup.name+'.receipt.tmp');private(tmp,json.dumps(saved).encode());durable_replace(tmp,receipt)
        stage='snapshot_repair.start'
        require(not any(c['running'] for c in states('worker')),'CONSUMER_PRESENT_BEFORE_RESTART')
        run(base+['-f',str(overlay),'--profile','feed-consumer','up','-d','--force-recreate','--no-deps','--no-build','--pull','never','worker'],timeout=90,log=backup/'start.private.log')
        require(len(states('worker'))==1,'RESTART_CONTAINER_COUNT_UNEXPECTED')
        actual=json.loads(run(['docker','inspect',states('worker')[0]['id']]))[0]
        require(snapshot_memory_bytes(actual['HostConfig']['Memory'])==sizing['targetMemoryBytes'] and actual['Image']==image,'RESTART_LIMIT_OR_IMAGE_MISMATCH')
        emit(operation='cutover.aws',stage=stage,status='ok',changed=True,actualMemoryBytes=actual['HostConfig']['Memory'],laneLimitsMB=wanted,workerStarted=True,backup=str(backup),journalsModified=False,composeOverridesPreserved=True,posnetChanged=False)
        return 0
    except Exception as error:
        reason=str(error) if re.fullmatch('[A-Z][A-Z_]+',str(error)) else 'PRIVATE_SNAPSHOT_REPAIR_FAILED'
        emit(operation='cutover.aws',stage=stage,status='blocked',reason=reason,backup=str(backup) if backup else None,workerStopped=stopped,locksPreserved=True,posnetChanged=False,rawExceptionPrinted=False);return 2
