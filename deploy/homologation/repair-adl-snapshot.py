"""Dimensioned, evidence-gated snapshot limit repair. Never touches POSNET or journals."""
def snapshot_file_hash(path):
    digest=hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda:source.read(1024*1024),b''):digest.update(block)
    return digest.hexdigest()

def snapshot_plan(capacities, failures):
    wanted={};budget=256*1024*1024*8+64*1024*1024
    for lane in ('prematch','inplay'):
        cap=capacities[lane]
        if any(d.get('reason')=='response_size_limit' and d.get('responseLimitBytes')==128*1024*1024 and d.get('httpStatus')==200 for d in failures.get(lane,[])):
            if cap['limitBytes']==128*1024*1024:wanted[lane]=256
    return wanted,budget

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
        require(before['services']['worker']['mem_limit']==4294967296 and worker['HostConfig']['Memory']==4294967296,'WORKER_MEMORY_LIMIT_UNEXPECTED')
        image=json.loads(run(['docker','image','inspect',before['services']['worker']['image']]))[0]['Id'];require(worker['Image']==image,'RUNNING_IMAGE_MISMATCH')
        mount=[m for m in worker['Mounts'] if m['Destination']=='/app/.runtime/feed'];require(len(mount)==1 and mount[0]['Type']=='volume' and mount[0]['RW'],'FEED_MOUNT_UNVERIFIED')
        volume=json.loads(run(['docker','volume','inspect',mount[0]['Name']]))[0];require((volume.get('Labels') or {}).get('com.docker.compose.project')=='adl-homologation','VOLUME_PROJECT_UNVERIFIED')
        directory=Path(volume['Mountpoint']);require(not directory.is_symlink(),'VOLUME_SYMLINK')
        probe="""import fs from 'node:fs';import{createHash}from'node:crypto';import{snapshotCapacity}from'/app/apps/worker/src/snapshot-capacity.ts';const read=p=>{try{return fs.readFileSync(p,'utf8').trim()}catch{return null}};const hashes={};for(const p of ['provider.ts','diagnostics.ts','snapshot-capacity.ts'])hashes[p]=createHash('sha256').update(fs.readFileSync('/app/apps/worker/src/'+p)).digest('hex');console.log(JSON.stringify({capacities:{prematch:snapshotCapacity(process.env,undefined,'prematch'),inplay:snapshotCapacity(process.env,undefined,'inplay')},proposed:snapshotCapacity({...process.env,LSPORTS_PREMATCH_SNAPSHOT_MAX_RESPONSE_MB:'256'},undefined,'prematch'),cgroup:{max:read('/sys/fs/cgroup/memory.max'),current:read('/sys/fs/cgroup/memory.current')},sourceHashes:hashes}));"""
        observed=json.loads(run(['docker','exec',workers[0]['id'],'node','--import','tsx','--input-type=module','-e',probe],timeout=25))
        require(observed['sourceHashes']==request['sourceHashes'],'SNAPSHOT_RUNTIME_SOURCE_DIFFERS_NO_BLIND_PATCH')
        failures={lane:[] for lane in ('prematch','inplay')};evidence=feed_evidence(directory,workers)
        for d in evidence['recentErrors']:
            if d.get('lane') in failures:failures[d['lane']].append(d)
        checkpoint=directory/'trade-feed.json'
        if checkpoint.is_file():
            require(not checkpoint.is_symlink() and checkpoint.stat().st_size<=256*1024*1024,'CHECKPOINT_SIZE_LIMIT')
            available=int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')))*1024
            require(available>checkpoint.stat().st_size*8+64*1024*1024,'DIAGNOSTIC_MEMORY_BUDGET')
            feed=json.loads(checkpoint.read_bytes())
            for lane in failures:
                connection=feed.get('connections',{}).get(lane,{})
                failures[lane].append(safe_feed_diagnostic(connection.get('lastSnapshotDiagnostic')))
                failures[lane].append(safe_feed_diagnostic(connection.get('diagnostic')))
        wanted,budget=snapshot_plan(observed['capacities'],failures)
        emit(operation='cutover.aws',stage=stage,status='inspected',effective=observed,failures=failures,plannedLaneLimitsMB=wanted,evidence=evidence,workerStarted=False,posnetChanged=False)
        if not wanted:
            emit(operation='cutover.aws',stage=stage,status='ok',changed=False,reason='NO_CURRENT_128_MIB_LANE_REQUIRES_CHANGE',workerRunning=True,posnetChanged=False);return 0
        require(observed['proposed']['allowed'],'SNAPSHOT_REPAIR_MEMORY_ADMISSION_REFUSED')
        cg=observed['cgroup'];require(str(cg['max']).isdigit() and str(cg['current']).isdigit() and int(cg['max'])-int(cg['current'])>=budget,'SNAPSHOT_REPAIR_CGROUP_HEADROOM_INSUFFICIENT')
        require(shutil.disk_usage('/opt').free>checkpoint.stat().st_size*2+128*1024*1024 if checkpoint.exists() else shutil.disk_usage('/opt').free>128*1024*1024,'BACKUP_DISK_HEADROOM_INSUFFICIENT')
        backup=Path(tempfile.mkdtemp(prefix='adl-snapshot-capacity-',dir=BACKUPS));os.chmod(backup,0o700)
        private(backup/'deployment.before.json',(SECURE/'deployment.json').read_bytes());private(backup/'inspection.json',json.dumps(observed).encode())
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
        stage='snapshot_repair.overlay'
        env={'LSPORTS_'+lane.upper()+'_SNAPSHOT_MAX_RESPONSE_MB':str(limit) for lane,limit in wanted.items()}
        overlay=SECURE/('compose.snapshot-'+backup.name+'.json');private(overlay,json.dumps({'services':{'worker':{'environment':env}}}).encode())
        after=model(base+['-f',str(overlay)]);expected=copy.deepcopy(before);expected['services']['worker']['environment'].update(env);require(after==expected,'UNEXPECTED_COMPOSE_MODEL_CHANGE')
        meta['composeOverrides']=[*meta.get('composeOverrides',[]),str(overlay)]
        tmp=SECURE/(backup.name+'.deployment.tmp');private(tmp,json.dumps(meta).encode());durable_replace(tmp,SECURE/'deployment.json')
        # Refresh only validation-session time; preserve receipts and the historical migration.
        handoff=request['handoff'];digest=hashlib.sha256(json.dumps(handoff,sort_keys=True,separators=(',',':')).encode()).hexdigest();receipt=SECURE/('cutover-'+digest+'.json')
        saved=json.loads(receipt.read_bytes());private(backup/'receipt.before.json',receipt.read_bytes())
        saved.setdefault('capacityRestarts',[]).append({'previousStartRequestedAtUTC':saved['startRequestedAtUTC'],'backup':str(backup),'limitsMB':wanted})
        saved['startRequestedAtUTC']=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
        tmp=SECURE/(backup.name+'.receipt.tmp');private(tmp,json.dumps(saved).encode());durable_replace(tmp,receipt)
        stage='snapshot_repair.start'
        require(not any(c['running'] for c in states('worker')),'CONSUMER_PRESENT_BEFORE_RESTART')
        run(base+['-f',str(overlay),'--profile','feed-consumer','up','-d','--force-recreate','--no-deps','--no-build','--pull','never','worker'],timeout=90,log=backup/'start.private.log')
        emit(operation='cutover.aws',stage=stage,status='ok',changed=True,laneLimitsMB=wanted,workerStarted=True,backup=str(backup),journalsModified=False,composeOverridesPreserved=True,posnetChanged=False)
        return 0
    except Exception as error:
        reason=str(error) if re.fullmatch('[A-Z][A-Z_]+',str(error)) else 'PRIVATE_SNAPSHOT_REPAIR_FAILED'
        emit(operation='cutover.aws',stage=stage,status='blocked',reason=reason,backup=str(backup) if backup else None,workerStopped=stopped,locksPreserved=True,posnetChanged=False,rawExceptionPrinted=False);return 2
