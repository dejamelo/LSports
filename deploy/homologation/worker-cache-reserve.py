"""Worker-specific actual kernel reclaim; no credits of estimated cache as free memory."""
import os,json,re,time,errno,subprocess,datetime
from pathlib import Path
MiB=1024**2;TARGET=1920*MiB;VERIFIED_LIMITS=(6144*MiB,8192*MiB)

def require(ok,reason):
    if not ok:raise RuntimeError(reason)

def plan(current,limit,stat):
    require(limit in VERIFIED_LIMITS,'CACHE_POLICY_LIMIT_UNVERIFIED')
    clean=max(0,min(stat.get('file',0),stat.get('inactive_file',0))-stat.get('file_dirty',0)-stat.get('file_writeback',0)-stat.get('shmem',0))
    deficit=max(0,TARGET-max(0,limit-current))
    return min(deficit,clean//2,512*MiB)

def sample(path):
    stat=dict((k,int(v)) for k,v in (line.split() for line in (path/'memory.stat').read_text().splitlines()))
    return {'current':int((path/'memory.current').read_text()),'max':int((path/'memory.max').read_text()),'stat':stat,'events':dict((k,int(v)) for k,v in (line.split() for line in (path/'memory.events').read_text().splitlines())),'swap':int((path/'memory.swap.current').read_text())}

def once(target='adl-homologation-worker-1'):
    p=subprocess.run(['docker','inspect',target],capture_output=True,timeout=10)
    if p.returncode:return {'status':'worker_absent_no_action'}
    c=json.loads(p.stdout)[0];labels=c['Config'].get('Labels') or {}
    require(labels.get('com.docker.compose.project')=='adl-homologation' and labels.get('com.docker.compose.service')=='worker' or labels.get('eu.adl.recovery.cache-policy') in ('six-gib-verified','bounded-reclaim-verified'),'CACHE_POLICY_CONTAINER_IDENTITY_UNVERIFIED')
    if not c['State']['Running']:return {'status':'worker_stopped_no_action'}
    require(c['HostConfig']['Memory'] in VERIFIED_LIMITS,'CACHE_POLICY_DOCKER_LIMIT_CHANGED')
    raw=Path('/proc/'+str(c['State']['Pid'])+'/cgroup').read_text();m=re.search(r'^0::(/[^\n]*)$',raw,re.M);require(m is not None,'CACHE_POLICY_CGROUP_UNVERIFIED')
    root=Path('/sys/fs/cgroup');path=(root/m[1].lstrip('/')).resolve();require(root in path.parents and c['Id'][:12] in str(path),'CACHE_POLICY_CGROUP_IDENTITY_UNVERIFIED')
    limit=c['HostConfig']['Memory'];high=(path/'memory.high').read_text().strip();require(high in ('max',str(limit)),'CACHE_POLICY_DISTINCT_MEMORY_HIGH')
    before=sample(path);amount=plan(before['current'],before['max'],before['stat'])
    row={'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'containerId':c['Id'],'beforeCurrentBytes':before['current'],'requestedReclaimBytes':amount,'targetActualHeadroomBytes':TARGET,'workerRestarted':False}
    if not amount:return {**row,'status':'headroom_sufficient_or_no_clean_cache_no_action'}
    # swappiness=0 is mandatory. Never fall back to anonymous swapping or global drop_caches.
    try:
        with (path/'memory.reclaim').open('w') as out:out.write(str(amount)+' swappiness=0\n')
    except OSError as error:
        if error.errno!=errno.EAGAIN:raise RuntimeError('CACHE_RECLAIM_UNSUPPORTED_OR_DENIED_ERRNO_'+str(error.errno)) from None
    after=sample(path)
    require(after['events'].get('oom_kill',0)==before['events'].get('oom_kill',0),'NEW_OOM_DURING_CACHE_POLICY')
    row.update(status='kernel_reclaim_measured',afterCurrentBytes=after['current'],actualHeadroomBytes=max(0,after['max']-after['current']),fileBytesBefore=before['stat'].get('file'),fileBytesAfter=after['stat'].get('file'),swapBytesBefore=before['swap'],swapBytesAfter=after['swap'])
    return row

def main():
    failures=0
    while True:
        try:
            targets=['adl-homologation-worker-1'];other=subprocess.run(['docker','ps','-q','--filter','label=eu.adl.recovery.cache-policy=six-gib-verified'],capture_output=True,timeout=10,check=True);other8=subprocess.run(['docker','ps','-q','--filter','label=eu.adl.recovery.cache-policy=bounded-reclaim-verified'],capture_output=True,timeout=10,check=True);targets+=other.stdout.decode().split()+other8.stdout.decode().split();targets=list(dict.fromkeys(targets));require(len(targets)<=5,'CACHE_POLICY_TARGET_COUNT_LIMIT');rows=[]
            for target in targets:
                try:rows.append(once(target))
                except (FileNotFoundError,ProcessLookupError):rows.append({'status':'target_disappeared_no_action'})
            row=rows[0];[print(json.dumps(r),flush=True) for r in rows]
            if row.get('requestedReclaimBytes',0) and row.get('actualHeadroomBytes',0)<TARGET and row.get('afterCurrentBytes',0)>=row.get('beforeCurrentBytes',0):failures+=1
            else:failures=0
            require(failures<3,'CACHE_RECLAIM_NO_EFFECT_POLICY_STOPPED')
        except Exception as error:
            reason=str(error) if re.fullmatch('[A-Z_0-9]{3,120}',str(error)) else 'CACHE_POLICY_FAILURE'
            print(json.dumps({'status':'blocked','reason':reason,'workerRestarted':False}),flush=True);raise SystemExit(2)
        if '--once' in __import__('sys').argv:return
        time.sleep(5)
if __name__=='__main__':main()
