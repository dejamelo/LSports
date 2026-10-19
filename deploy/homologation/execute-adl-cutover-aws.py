"""Restricted journal import + fenced worker start. Bundled with existing private helpers."""
import hashlib
import math
import shutil
import datetime

def durable_replace(source,target):
    os.replace(source,target)
    fd=os.open(target.parent,os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)

def require(ok, reason):
    if not ok: raise RuntimeError(reason)
def schedule_checked(s):
    require(isinstance(s,dict) and isinstance(s.get('due'),dict) and isinstance(s.get('failures'),dict),'INVALID_SCHEDULE')
    for n in [s.get('nextAt'),*s['due'].values(),*s['failures'].values()]:
        require(type(n) in (int,float) and math.isfinite(n) and 0<=n<=8640000000000000,'INVALID_SCHEDULE')
    return s

def merge_schedule(old, incoming):
    old=schedule_checked(old);incoming=schedule_checked(incoming)
    # Preserve remote request evidence; union maxima NEVER shortens either host/operation cooldown.
    merged=dict(old)
    merged['nextAt']=max(old['nextAt'],incoming['nextAt'])
    for key in ('due','failures'):
        merged[key]={k:max(old[key].get(k,0),incoming[key].get(k,0)) for k in old[key].keys()|incoming[key].keys()}
    return merged

def cutover_main():
    stage='input';backup=None;written=[];worker_requested=False
    try:
        require(os.geteuid()==0,'ROOT_REQUIRED')
        raw=sys.stdin.buffer.read(1024*1024+1);require(len(raw)<=1024*1024,'HANDOFF_SIZE_LIMIT')
        request=json.loads(raw);action=request.get('action')
        if action=='patch_worker':return patch_worker(request)
        if action=='preflight':return inspect_aws()
        handoff=request['handoff'];audit=handoff['audit']
        require(action in ('import','start','status'),'INVALID_ACTION')
        require(audit['status']=='ok' and audit['workerLockAbsent'] is True and audit['matchingWorkerProcesses']==0,'MAC_SHUTDOWN_UNPROVEN')
        require(audit['operation']=='cutover.audit' and audit['readOnly'] is True,'INVALID_AUDIT')
        deadline=datetime.datetime.fromisoformat(audit['notBeforeUTC'].replace('Z','+00:00')).timestamp()
        require(audit['notBeforeUTC'].endswith('Z') and math.isfinite(deadline),'INVALID_DEADLINE')
        digest=hashlib.sha256(json.dumps(handoff,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        stage='deployment'
        meta=json.loads((SECURE/'deployment.json').read_bytes());release=Path(meta['release'])
        require(release.parent==RELEASES and re.fullmatch('[0-9a-f]{40}',release.name) and not release.is_symlink(),'RELEASE_UNVERIFIED')
        base=['docker','compose','-p','adl-homologation','--env-file',str(SECURE/'deploy.env'),'-f',str(release/'deploy/homologation/compose.yaml'),'-f',str(release/'deploy/homologation/compose.existing-caddy.yaml')]
        for entry in meta.get('composeOverrides',[]):
            f=Path(entry);require(f.parent==SECURE and f.is_file() and not f.is_symlink(),'OVERRIDE_UNVERIFIED');base+=['-f',entry]
        apis=states('api');require(len(apis)==1 and apis[0]['health']=='healthy','API_NOT_HEALTHY')
        api=json.loads(run(['docker','inspect',apis[0]['id']]))[0]
        mounts=[m for m in api['Mounts'] if m['Destination']=='/app/.runtime/feed']
        require(len(mounts)==1 and mounts[0]['Type']=='volume' and not mounts[0]['RW'],'FEED_MOUNT_UNVERIFIED')
        volume=json.loads(run(['docker','volume','inspect',mounts[0]['Name']]))[0]
        require((volume.get('Labels') or {}).get('com.docker.compose.project')=='adl-homologation','VOLUME_PROJECT_UNVERIFIED')
        directory=Path(volume['Mountpoint']);require(not directory.is_symlink(),'VOLUME_SYMLINK')
        receipt=SECURE/('cutover-'+digest+'.json')
        if action=='status':
            saved=json.loads(receipt.read_bytes());return cutover_status(directory,saved.get('startRequestedAtUTC'))
        if request.get('expectedWorkerImage'):require(model(base)['services']['worker']['image']==request['expectedWorkerImage'],'WORKER_IMAGE_NOT_EXPECTED_CORRECTION')
        stage='no_consumer_gate'
        running=[c for c in states('worker') if c['running']]
        if action=='start' and running:
            require(len(running)==1 and receipt.is_file(),'UNEXPECTED_RUNNING_WORKER')
            saved=json.loads(receipt.read_bytes());require(saved.get('digest')==digest and saved.get('startRequestedAtUTC'),'RUNNING_WORKER_RECEIPT_UNVERIFIED')
            container=json.loads(run(['docker','inspect',running[0]['id']]))[0]
            expected_image=model(base)['services']['worker']['image'];expected_id=json.loads(run(['docker','image','inspect',expected_image]))[0]['Id']
            require(container['Image']==expected_id,'RUNNING_WORKER_IMAGE_MISMATCH')
            env=dict(item.split('=',1) for item in container.get('Config',{}).get('Env',[]) if '=' in item)
            require(env.get('ADL_CAPACITY_APPROVED')=='yes' and env.get('ADL_MAC_WORKER_STOPPED')=='yes' and env.get('ADL_SUPPLIER_NOT_BEFORE_UTC')==saved['notBeforeUTC'],'RUNNING_WORKER_GATES_MISMATCH')
            started=datetime.datetime.fromisoformat(container['State']['StartedAt'].replace('Z','+00:00')).timestamp()
            intended=datetime.datetime.fromisoformat(saved['startRequestedAtUTC'].replace('Z','+00:00')).timestamp()
            require(started>=intended-5 and started>=datetime.datetime.fromisoformat(saved['notBeforeUTC'].replace('Z','+00:00')).timestamp(),'RUNNING_WORKER_START_PREDATES_RECEIPT_OR_BARRIER')
            emit(operation='cutover.aws',stage='start',status='ok',reused=True,workerStarted=True,posnetChanged=False);return 0
        require(not running,'AWS_WORKER_ALREADY_RUNNING')
        require(not (directory/'trade-feed.json.lock').exists(),'AWS_WORKER_LOCK_PRESENT')
        require(not list(directory.glob('trade-feed.json.snapshot-*.lock')) and not list(directory.glob('trade-feed.json*.reclaim')),'AWS_SCHEDULER_LOCK_PRESENT')
        require(len(handoff['schedules'])==audit['journals'] and len(handoff['schedules'])>0,'JOURNAL_COUNT_MISMATCH')
        incoming={}
        for entry in handoff['schedules']:
            require(re.fullmatch(r'\.snapshot-[0-9a-f]{16}\.json',entry['name']),'INVALID_JOURNAL_NAME')
            name='trade-feed.json'+entry['name'];require(name not in incoming,'DUPLICATE_JOURNAL')
            incoming[name]=schedule_checked(entry['schedule'])
        if action=='import':
            stage='journal_backup'
            if receipt.exists():
                saved=json.loads(receipt.read_bytes());require(saved['digest']==digest,'HANDOFF_RECEIPT_MISMATCH')
                for name,schedule in incoming.items():
                    target=directory/name;require(target.is_file() and not target.is_symlink() and target.stat().st_size<=1024*1024,'IMPORTED_JOURNAL_MISSING')
                    current=schedule_checked(json.loads(target.read_bytes()));require(merge_schedule(current,schedule)==current,'IMPORTED_JOURNAL_REGRESSED')
                deadline=max(deadline,datetime.datetime.fromisoformat(saved['notBeforeUTC'].replace('Z','+00:00')).timestamp())
                for target in directory.glob('trade-feed.json.snapshot-*.json'):
                    current=schedule_checked(json.loads(target.read_bytes()));deadline=max(deadline,current['nextAt']/1000,*[n/1000 for n in current['due'].values()])
                emit(operation='cutover.aws',stage='import',status='ok',reused=True,backup=saved['backup'],journals=len(incoming),notBeforeUTC=datetime.datetime.fromtimestamp(deadline,datetime.timezone.utc).isoformat().replace('+00:00','Z'),workerStarted=False,posnetChanged=False);return 0
            backup=Path(tempfile.mkdtemp(prefix='adl-cutover-',dir=BACKUPS));os.chmod(backup,0o700)
            private(backup/'deployment.before.json',(SECURE/'deployment.json').read_bytes())
            uid=directory.stat().st_uid;gid=directory.stat().st_gid
            require(uid==1000,'WORKER_VOLUME_OWNER_UNVERIFIED')
            planned={}
            for name,schedule in incoming.items():
                target=directory/name
                if target.exists():
                    require(target.is_file() and not target.is_symlink() and target.stat().st_size<=1024*1024,'JOURNAL_UNVERIFIED')
                    data=target.read_bytes();private(backup/name,data)
                    require(hashlib.sha256(data).digest()==hashlib.sha256((backup/name).read_bytes()).digest(),'BACKUP_HASH_MISMATCH')
                    schedule=merge_schedule(json.loads(data),schedule)
                planned[name]=schedule
            for name,schedule in planned.items():
                stage='journal_import';target=directory/name;tmp=directory/(name+'.cutover-'+digest[:12]+'.tmp')
                private(tmp,json.dumps(schedule).encode());os.chown(tmp,uid,gid);durable_replace(tmp,target);written.append(name)
                require(schedule==json.loads(target.read_bytes()),'IMPORT_READBACK_MISMATCH')
            # Include any independent remote journal deadlines in admission, not just imported files.
            for target in directory.glob('trade-feed.json.snapshot-*.json'):
                require(not target.is_symlink() and target.stat().st_size<=1024*1024,'JOURNAL_UNVERIFIED')
                s=schedule_checked(json.loads(target.read_bytes()));deadline=max(deadline,s['nextAt']/1000,*[n/1000 for n in s['due'].values()])
            barrier=datetime.datetime.fromtimestamp(deadline,datetime.timezone.utc).isoformat().replace('+00:00','Z')
            private(receipt,json.dumps({'digest':digest,'backup':str(backup),'notBeforeUTC':barrier,'journals':written,'stage':'imported'}).encode())
            emit(operation='cutover.aws',stage='import',status='ok',backup=str(backup),journals=len(written),notBeforeUTC=barrier,workerStarted=False,posnetChanged=False)
            return 0
        stage='receipt'
        saved=json.loads(receipt.read_bytes());require(saved['digest']==digest,'HANDOFF_RECEIPT_MISMATCH');backup=Path(saved['backup'])
        deadline=datetime.datetime.fromisoformat(saved['notBeforeUTC'].replace('Z','+00:00')).timestamp()
        for target in directory.glob('trade-feed.json.snapshot-*.json'):
            require(not target.is_symlink() and target.stat().st_size<=1024*1024,'JOURNAL_UNVERIFIED')
            s=schedule_checked(json.loads(target.read_bytes()));deadline=max(deadline,s['nextAt']/1000,*[n/1000 for n in s['due'].values()])
        require(time.time()>=deadline,'COOLDOWN_NOT_ELAPSED')
        require(request['freshAuditAt'].endswith('Z') and -5<=time.time()-datetime.datetime.fromisoformat(request['freshAuditAt'].replace('Z','+00:00')).timestamp()<60,'MAC_REAUDIT_EXPIRED')
        require(not saved.get('startRequestedAtUTC'),'WORKER_START_ALREADY_ATTEMPTED_INSPECT_BEFORE_RETRY')
        stage='gates_overlay'
        previous=model(base);overlay=SECURE/('compose.cutover-'+digest[:16]+'.json')
        gates={'ADL_CAPACITY_APPROVED':'yes','ADL_MAC_WORKER_STOPPED':'yes','ADL_SUPPLIER_NOT_BEFORE_UTC':saved['notBeforeUTC']}
        private(overlay,json.dumps({'services':{'worker':{'environment':gates}}}).encode())
        proposed=model(base+['-f',str(overlay)])
        expected=copy.deepcopy(previous);expected['services']['worker']['environment'].update(gates)
        require(proposed==expected,'UNEXPECTED_COMPOSE_MODEL_CHANGE')
        require(str(proposed['services']['worker']['mem_limit'])=='4294967296','MEMORY_LIMIT_CHANGED')
        stage='save_overlay';meta['composeOverrides']=[*meta.get('composeOverrides',[]),str(overlay)]
        temporary=SECURE/('deployment.cutover-'+digest[:16]+'.tmp');private(temporary,json.dumps(meta).encode());durable_replace(temporary,SECURE/'deployment.json')
        stage='start_worker'
        saved['startRequestedAtUTC']=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
        temporary=SECURE/('receipt-start-'+digest[:16]+'.tmp');private(temporary,json.dumps(saved).encode());durable_replace(temporary,receipt)
        worker_requested=True
        run(base+['-f',str(overlay),'--profile','feed-consumer','up','-d','--no-deps','--no-build','--pull','never','worker'],timeout=90,log=backup/'worker-start.private.log')
        emit(operation='cutover.aws',stage='start',status='ok',workerStarted=True,posnetChanged=False,composeOverridesPreserved=True,backup=str(backup))
        return 0
    except Exception as error:
        reason=str(error) if re.fullmatch('[A-Z][A-Z_]+',str(error)) else 'PRIVATE_OPERATION_FAILED'
        emit(operation='cutover.aws',stage=stage,status='blocked',reason=reason,backup=str(backup) if backup else None,journalsWritten=written,workerStartRequested=worker_requested,workerStarted=None if worker_requested else False,posnetChanged=False,rawExceptionPrinted=False)
        return 2

def cutover_status(directory,start_requested):
    consumers=states('worker');path=directory/'trade-feed.json';result={'operation':'cutover.aws','stage':'status','readOnly':True,'workers':consumers,'posnetChanged':False}
    if not path.exists():
        emit(**result,status='waiting_checkpoint');return 0
    require(path.is_file() and not path.is_symlink() and path.stat().st_size<=256*1024*1024,'CHECKPOINT_SIZE_LIMIT')
    available=int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')))*1024
    require(available>path.stat().st_size*8+64*1024*1024,'DIAGNOSTIC_MEMORY_BUDGET')
    feed=json.loads(path.read_bytes());lanes={}
    fields=('phase','session','lastSnapshotAt','lastSnapshotAttemptAt','recoveryProgress')
    for lane in ('prematch','inplay'):
        source=feed.get('connections',{}).get(lane,{})
        lanes[lane]={k:source.get(k) for k in fields}
        coverage=(feed.get('coverage',{}).get(lane,{}) or {}).get('activity',{})
        lanes[lane]['updates']={k:coverage.get(k) for k in ('lastDataDecodedAt','lastMarketDecodedAt','lastSettlementDecodedAt','lastControlDecodedAt')}
        for key in ('diagnostic','lastSnapshotDiagnostic'):
            d=source.get(key) or {};lanes[lane][key]={k:d[k] for k in ('operation','category','reason','httpStatus','amqpCode','rateLimitSource','retryAt') if k in d}
    events=feed.get('events',[]);selectable=0;markets=0;prices=0;reasons={}
    for event in events:
        for market in event.get('markets',[]):
            markets+=1
            for selection in market.get('selections',[]):
                if type(selection.get('odds')) in (int,float) and selection['odds']>1:prices+=1
                if selection.get('available') is True:selectable+=1
                for reason in selection.get('unavailableReasons',[]):
                    if re.fullmatch('[a-z_]{1,80}',reason):reasons[reason]=reasons.get(reason,0)+1
    def epoch(value):
        try:return datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()
        except Exception:return 0
    fresh=0<=time.time()-epoch(feed.get('updatedAt'))<20
    current_sessions=bool(start_requested) and all(epoch((c.get('session') or {}).get('startedAt'))>=epoch(start_requested)-5 and epoch(c.get('lastSnapshotAt'))>=epoch((c.get('session') or {}).get('startedAt')) for c in lanes.values())
    ready=fresh and current_sessions and len(consumers)==1 and consumers[0].get('running') is True and all(c.get('phase')=='connected' and (c.get('recoveryProgress') or {}).get('regularSnapshotReady') is True and c.get('lastSnapshotAt') for c in lanes.values())
    emit(**result,status='snapshots_ready' if ready else 'recovering',updatedAt=feed.get('updatedAt'),lanes=lanes,events=len(events),markets=markets,pricedSelections=prices,selectableSelections=selectable,blockedReasons=reasons,iframeAuthenticated=False)
    return 0
if __name__=='__main__':raise SystemExit(cutover_main())
