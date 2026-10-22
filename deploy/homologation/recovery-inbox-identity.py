"""One targeted read-only observation: no restore, restart, checkpoint or vendor calls."""
IDENTITY_STAGE='input'
IDENTITY_GUARD_FD=None
def identity_guard(path):
    import fcntl,stat
    require(path.parent.is_dir() and not path.parent.is_symlink() and path.parent.stat().st_uid==os.geteuid() and path.parent.stat().st_mode&0o022==0,'COLLECTOR_GUARD_DIRECTORY_UNVERIFIED')
    fd=os.open(path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        info=os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid==os.geteuid() and info.st_nlink==1 and info.st_mode&0o077==0,'COLLECTOR_GUARD_IDENTITY_UNVERIFIED')
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        return fd
    except BlockingIOError:
        os.close(fd);raise RuntimeError('COLLECTOR_ALREADY_RUNNING_NO_DUPLICATION')
    except BaseException:
        os.close(fd);raise
def identity_progress(stage):
    global IDENTITY_STAGE
    IDENTITY_STAGE=stage
    emit(operation='recovery_inbox_identity_progress',stage=stage,readOnly=True,workerRestarted=False)

def inbox_identity_main():
    global IDENTITY_GUARD_FD
    identity_progress('collector_guard')
    IDENTITY_GUARD_FD=identity_guard(Path('/etc/adl-homologation/inbox-identity-diagnostic.lock'))
    identity_progress('worker_identity')
    cid='e825bef701135b9a10715d3a4e9bf74d224c739f562837b92d8cd96631c62d3f'
    workers=states('worker');require(len(workers)==1 and workers[0]['id']==cid and workers[0]['running'],'OBSERVED_WORKER_CHANGED_NO_ACTION')
    info=json.loads(run(['docker','inspect',cid]))[0]
    require(info['Image']=='sha256:702122d02cd113c7a0ec1256f5c94d08c167141da924af04da2ade617b09d397','OBSERVED_IMAGE_CHANGED_NO_ACTION')
    identity_progress('volume_identity')
    mounts=[m for m in info['Mounts'] if m.get('Type')=='volume' and m.get('Destination')=='/app/.runtime/feed'];require(len(mounts)==1,'FEED_VOLUME_UNVERIFIED')
    volume=json.loads(run(['docker','volume','inspect',mounts[0]['Name']]))[0];require(volume.get('Labels',{}).get('com.docker.compose.project')=='adl-homologation','FEED_VOLUME_PROJECT_UNVERIFIED');directory=Path(volume['Mountpoint'])
    identity_progress('directory_file_identities')
    names={'trade-feed.json.'+lane+'.inbox.sqlite'+suffix for lane in ('prematch','inplay') for suffix in ('','-wal','-shm')}
    files={}
    for name in sorted(names):
        path=directory/name
        if path.exists():
            require(not path.is_symlink(),'INBOX_SYMLINK_UNVERIFIED');st=path.stat();files[name]={'device':st.st_dev,'inode':st.st_ino,'bytes':st.st_size}
    identity_progress('node_descriptor_identities')
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
        source_hashes={}
        for filename in ('durable-ingress.mjs','connected.ts','persistence.ts'):
            path=Path('/proc/'+pid+'/root/app/apps/worker/src')/filename
            require(path.is_file() and not path.is_symlink() and path.stat().st_size<=1024**2,'INSTALLED_SOURCE_IDENTITY_UNVERIFIED')
            source_hashes[filename]=hashlib.sha256(path.read_bytes()).hexdigest()
        processes.append({'hostPid':int(pid),'executable':exe,'memory':memory,'inboxDescriptors':fds,'installedSourceHashes':source_hashes})
    require(processes,'NODE_PROCESS_IDENTITY_UNVERIFIED')
    identity_progress('complete')
    emit(operation='recovery_inbox_identity',readOnly=True,providerRequests=0,workerRestarted=False,workerId=cid,atUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),files=files,processes=processes,sqliteQueriesExecuted=0,checkpointRead=False,workerLogsRead=False,reusedEvidence='uploaded recovery-pressure JSON; no rate measurement repeated')
import signal
def identity_timeout(_signal,_frame):raise TimeoutError('INBOX_IDENTITY_AUDIT_DEADLINE')
signal.signal(signal.SIGALRM,identity_timeout)
signal.alarm(30)
try:inbox_identity_main()
except Exception as error:
    emit(operation='recovery_inbox_identity',status='blocked',reason=str(error) if re.fullmatch('[A-Z_]{3,100}',str(error)) else 'INBOX_IDENTITY_OBSERVATION_FAILED',stage=IDENTITY_STAGE,exceptionDetails=recovery_exception_details(error),readOnly=True,workerRestarted=False)
    raise SystemExit(2)
finally:
    signal.alarm(0)
    if IDENTITY_GUARD_FD is not None:os.close(IDENTITY_GUARD_FD)
