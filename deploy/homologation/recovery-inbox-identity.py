"""One targeted read-only observation: no restore, restart, checkpoint or vendor calls."""
def inbox_identity_main():
    cid='e825bef701135b9a10715d3a4e9bf74d224c739f562837b92d8cd96631c62d3f'
    workers=states('worker');require(len(workers)==1 and workers[0]['id']==cid and workers[0]['running'],'OBSERVED_WORKER_CHANGED_NO_ACTION')
    info=json.loads(run(['docker','inspect',cid]))[0]
    require(info['Image']=='sha256:702122d02cd113c7a0ec1256f5c94d08c167141da924af04da2ade617b09d397','OBSERVED_IMAGE_CHANGED_NO_ACTION')
    mounts=[m for m in info['Mounts'] if m.get('Type')=='volume' and m.get('Destination')=='/app/.runtime/feed'];require(len(mounts)==1,'FEED_VOLUME_UNVERIFIED')
    volume=json.loads(run(['docker','volume','inspect',mounts[0]['Name']]))[0];require(volume.get('Labels',{}).get('com.docker.compose.project')=='adl-homologation','FEED_VOLUME_PROJECT_UNVERIFIED');directory=Path(volume['Mountpoint'])
    names={'trade-feed.json.'+lane+'.inbox.sqlite'+suffix for lane in ('prematch','inplay') for suffix in ('','-wal','-shm')}
    files={}
    for name in sorted(names):
        path=directory/name
        if path.exists():
            require(not path.is_symlink(),'INBOX_SYMLINK_UNVERIFIED');st=path.stat();files[name]={'device':st.st_dev,'inode':st.st_ino,'bytes':st.st_size}
    processes=[]
    for line in run(['docker','top',cid,'-eo','pid,comm']).decode().splitlines()[1:]:
        fields=line.split(None,1)
        if len(fields)!=2 or not fields[0].isdigit():continue
        pid=fields[0]
        try:exe=Path(os.readlink('/proc/'+pid+'/exe')).name
        except FileNotFoundError:continue
        if exe not in ('node','nodejs'):continue
        fds=[];status=Path('/proc/'+pid+'/status').read_text();memory={}
        for key in ('VmRSS','VmHWM','VmSize'):
            match=re.search(r'^'+key+r':\s*(\d+) kB',status,re.M)
            if match:memory[key+'Bytes']=int(match[1])*1024
        for fd in Path('/proc/'+pid+'/fd').iterdir():
            try:
                target=os.readlink(fd);name=Path(target.removesuffix(' (deleted)')).name
                if name not in names:continue
                st=fd.stat();expected=files.get(name);fds.append({'fd':int(fd.name),'file':name,'device':st.st_dev,'inode':st.st_ino,'deleted':target.endswith(' (deleted)'),'matchesDirectoryFile':bool(expected and (expected['device'],expected['inode'])==(st.st_dev,st.st_ino))})
            except FileNotFoundError:continue
        processes.append({'hostPid':int(pid),'executable':exe,'memory':memory,'inboxDescriptors':fds})
    require(processes,'NODE_PROCESS_IDENTITY_UNVERIFIED')
    metadata=pressure_metadata(directory/'trade-feed.json')
    start_ms=int(datetime.datetime.fromisoformat(info['State']['StartedAt'].replace('Z','+00:00')).timestamp()*1000)
    inbox=json.loads(run(['docker','exec',cid,'node','--input-type=module','-e',PRESSURE_INBOX_PROBE,str(start_ms),'{}'],timeout=20))
    logs=pressure_logs(cid,info['State']['StartedAt'])
    emit(operation='recovery_inbox_identity',readOnly=True,providerRequests=0,workerRestarted=False,workerId=cid,atUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),checkpointUpdatedAt=metadata.get('updatedAt'),files=files,processes=processes,inbox=inbox,lanes={lane:{'sessionStartedAt':metadata['connections'].get(lane,{}).get('session',{}).get('startedAt'),'ingressProgress':{k:v for k,v in metadata['connections'].get(lane,{}).get('ingressProgress',{}).items() if k in ('received','processed','checkpointed','processingBacklog','metricWindowEndUTC')},'snapshot':{k:v for k,v in metadata['connections'].get(lane,{}).get('fullSnapshot',{}).items() if k in ('stage','startedAt','lastProgressAt','validatedRows','appliedRows','bytes')},'diagnostic':safe_feed_diagnostic(metadata['connections'].get(lane,{}).get('lastSnapshotDiagnostic'))} for lane in ('prematch','inplay')},logs=logs)
try:inbox_identity_main()
except Exception as error:
    emit(operation='recovery_inbox_identity',status='blocked',reason='INBOX_IDENTITY_OBSERVATION_FAILED',exceptionDetails=recovery_exception_details(error),readOnly=True,workerRestarted=False)
    raise SystemExit(2)
