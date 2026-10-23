"""Three bounded, read-only WAL-aware scalar samples. No payload deserialization."""
import datetime,json,os,sqlite3,subprocess,time
from pathlib import Path

def emit(**row):print(json.dumps(row),flush=True)
def worker():
    p=subprocess.run(['docker','inspect','adl-homologation-worker-1'],capture_output=True,timeout=15,check=True)
    return json.loads(p.stdout)[0]
def sample(path,boundary=None):
    # Do NOT use immutable=1: it would omit committed records in the live WAL.
    with sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=3) as db:
        db.execute('PRAGMA query_only=ON');db.execute('PRAGMA cache_size=-2048');db.execute('BEGIN')
        seq=db.execute("SELECT seq FROM sqlite_sequence WHERE name='inbox'").fetchone()
        seq=int(seq[0]) if seq else 0
        boundary=seq if boundary is None else boundary
        old=db.execute('SELECT count(*),min(received) FROM inbox INDEXED BY inbox_processing_receipt WHERE id<=?',(boundary,)).fetchone()
        new=db.execute('SELECT count(*),min(received) FROM inbox INDEXED BY inbox_processing_receipt WHERE id>?',(boundary,)).fetchone()
        return dict(boundaryId=boundary,insertId=seq,pendingOldRows=old[0],pendingNewRows=new[0],pendingRows=old[0]+new[0],oldestReceivedMs=min([v for v in (old[1],new[1]) if v is not None],default=None))
def main():
    info=worker();identity=info['Id']
    if not info['State']['Running']:raise RuntimeError('WORKER_NOT_RUNNING_NO_OBSERVATION')
    env=dict(v.split('=',1) for v in info['Config'].get('Env',[]) if '=' in v)
    state=Path(env.get('LSPORTS_STATE_FILE','.runtime/trade-feed.json'))
    if not state.is_absolute():state=Path(info['Config'].get('WorkingDir') or '/app')/state
    mounts=[m for m in info['Mounts'] if str(state).startswith(m['Destination'].rstrip('/')+'/')]
    if len(mounts)!=1:raise RuntimeError('INBOX_MOUNT_UNVERIFIED')
    mount=mounts[0];host=Path(mount['Source'])/state.relative_to(mount['Destination'])
    paths={lane:Path(str(host)+'.'+lane+'.inbox.sqlite') for lane in ('prematch','inplay')}
    for path in paths.values():
        if not path.is_file() or path.is_symlink():raise RuntimeError('INBOX_PATH_UNVERIFIED')
    first={};last={};start=time.monotonic()
    for number in range(3):
        if number:time.sleep(45)
        current=worker()
        if current['Id']!=identity:raise RuntimeError('WORKER_CHANGED_DURING_OBSERVATION')
        for lane,path in paths.items():
            result=sample(path,first.get(lane,{}).get('boundaryId'))
            first.setdefault(lane,result);last[lane]=result
            emit(stage='inbox_retirement_sample',sample=number+1,atUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),lane=lane,workerRunning=current['State']['Running'],**result)
    elapsed=time.monotonic()-start
    for lane in paths:
        retired=first[lane]['pendingOldRows']-last[lane]['pendingOldRows']
        emit(stage='inbox_retirement_result',lane=lane,windowSeconds=elapsed,oldCohortDurablyRetiredRows=retired,oldCohortRetirementPerSecond=retired/elapsed,insertIdAdvance=last[lane]['insertId']-first[lane]['insertId'],pendingRowsStart=first[lane]['pendingRows'],pendingRowsEnd=last[lane]['pendingRows'],netPendingChange=last[lane]['pendingRows']-first[lane]['pendingRows'],decodeOrigin='not_exposed_by_decode_log',note='Old cohort predates this collection; new cohort means newly committed inbox inserts, not necessarily fresh provider timestamps. Retirement is after durable business checkpoint; no claim of snapshot/odds completion or sustainable throughput from a single window.')
    emit(stage='inbox_retirement_complete',readOnly=True,workerRestarted=False,providerRequests=0,signalsSent=0,integrationVerified=False)
if __name__=='__main__':
    try:main()
    except Exception as error:
        reason=str(error) if isinstance(error,RuntimeError) else type(error).__name__
        emit(stage='inbox_retirement',status='blocked',reason=reason,rawErrorsPrinted=False);raise SystemExit(2)
