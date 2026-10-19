"""Collect ALL independent readiness sections. Read-only; no provider calls or starts."""
import shutil
import stat

def inspect_aws():
    report={'operation':'cutover.complete_preflight.aws','readOnly':True,'workerStarted':False,'providerRequests':0,'posnetChanged':False}
    errors=[]
    def section(name,action):
        try:
            result=action();report[name]=result;return result
        except Exception:
            errors.append({'stage':name,'reason':'INSPECTION_UNVERIFIED'});return None
    if os.geteuid()!=0:
        emit(**report,status='unverified',errors=[{'stage':'privileges','reason':'ROOT_REQUIRED'}]);return 2
    def deployment():
        meta=json.loads((SECURE/'deployment.json').read_bytes());release=Path(meta['release'])
        if release.parent!=RELEASES or not re.fullmatch('[0-9a-f]{40}',release.name) or release.is_symlink():raise ValueError()
        overrides=[]
        for entry in meta.get('composeOverrides',[]):
            file=Path(entry)
            if file.parent!=SECURE or file.is_symlink() or not file.is_file():raise ValueError()
            overrides.append(str(file))
        return {'releaseCommit':release.name,'savedOverrideCount':len(overrides),'overridesReadable':True}
    info=section('deployment',deployment)
    def worker_model():
        meta=json.loads((SECURE/'deployment.json').read_bytes());release=Path(meta['release'])
        if not info:raise ValueError()
        base=['docker','compose','-p','adl-homologation','--env-file',str(SECURE/'deploy.env'),'-f',str(release/'deploy/homologation/compose.yaml'),'-f',str(release/'deploy/homologation/compose.existing-caddy.yaml')]
        for file in meta.get('composeOverrides',[]):base+=['-f',file]
        worker=model(base)['services']['worker'];env=worker.get('environment',{})
        return {'memoryLimitBytes':worker.get('mem_limit'),'cpus':worker.get('cpus'),'restart':worker.get('restart'),
           'prematchCapMB':env.get('LSPORTS_PREMATCH_SNAPSHOT_MAX_RESPONSE_MB'),'inplayCapMB':env.get('LSPORTS_INPLAY_SNAPSHOT_MAX_RESPONSE_MB'),
           'gates':{'capacityApproved':env.get('ADL_CAPACITY_APPROVED')=='yes','macStopped':env.get('ADL_MAC_WORKER_STOPPED')=='yes','notBeforeConfigured':bool(env.get('ADL_SUPPLIER_NOT_BEFORE_UTC'))},
           'user':json.loads(run(['docker','image','inspect',worker['image']]))[0].get('Config',{}).get('User')}
    section('workerModel',worker_model)
    apis=section('apiContainers',lambda:states('api'));section('awsWorkerContainers',lambda:states('worker'))
    section('controlHttpStatus',control_status)
    def platform_status():
        with urllib.request.urlopen('http://127.0.0.1:13001/api/control/status',timeout=5) as r:
            value=json.loads(r.read(4096))
            return {'httpStatus':r.status,'initialized':value.get('initialized') is True,'simulation':value.get('financialMode')=='simulation',
                    'iframeOperationAndSession':'not_authenticated_or_validated_by_this_check'}
    section('platform',platform_status)
    def credentials():
        file=SECURE/'worker.env';info=file.lstat()
        if file.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_size>65536:raise ValueError()
        values=dict(line.split('=',1) for line in file.read_text().splitlines() if line and not line.startswith('#') and '=' in line)
        names=[f'LSPORTS_{lane}_{key}' for lane in ('PREMATCH','INPLAY') for key in ('USERNAME','PASSWORD')]
        return {'primaryPresent':all(values.get(k) for k in names),'missingVariableNames':[k for k in names if not values.get(k)],'fileMode':oct(info.st_mode&0o777),'directoryMode':oct(SECURE.stat().st_mode&0o777)}
    section('providerCredentials',credentials)
    def volume():
        if not apis or len(apis)!=1:raise ValueError()
        api=json.loads(run(['docker','inspect',apis[0]['id']]))[0]
        mounts=[m for m in api['Mounts'] if m['Destination']=='/app/.runtime/feed']
        if len(mounts)!=1 or mounts[0]['Type']!='volume':raise ValueError()
        volume=json.loads(run(['docker','volume','inspect',mounts[0]['Name']]))[0]
        if (volume.get('Labels') or {}).get('com.docker.compose.project')!='adl-homologation':raise ValueError()
        directory=Path(volume['Mountpoint']);state=directory/'trade-feed.json'
        return {'projectVerified':True,'apiReadOnly':not mounts[0]['RW'],'directoryUid':directory.stat().st_uid,'directoryGid':directory.stat().st_gid,
           'checkpointExists':state.exists(),'checkpointBytes':state.stat().st_size if state.is_file() else None,
           'workerLockExists':(directory/'trade-feed.json.lock').exists(),
           'schedulerJournalCount':len(list(directory.glob('trade-feed.json.snapshot-*.json'))),
           'schedulerLockCount':len(list(directory.glob('trade-feed.json.snapshot-*.lock')))+len(list(directory.glob('trade-feed.json.snapshot-*.reclaim')))}
    section('feedVolume',volume)
    section('capacity',lambda:{'availableMemoryBytes':int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')))*1024,'freeDiskBytes':shutil.disk_usage('/opt').free})
    emit(**report,status='collected' if not errors else 'unverified',errors=errors)
    return 0 if not errors else 2
if __name__=='__main__':raise SystemExit(inspect_aws())
