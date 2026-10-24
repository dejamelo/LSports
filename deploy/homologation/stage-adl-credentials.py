"""Receive allowlisted provider settings over SSH stdin. No provider calls or worker starts."""
import hashlib

def merge_worker_credentials(existing,payload):
    allowed={f'LSPORTS_{lane}_{kind}' for lane in ('PREMATCH','INPLAY') for kind in ('USERNAME','PASSWORD','MQ_USERNAME','MQ_PASSWORD')}
    if not isinstance(payload,dict) or not payload or not set(payload)<=allowed:raise ValueError('CREDENTIAL_PAYLOAD_SCOPE_UNVERIFIED')
    for key,value in payload.items():
        if not isinstance(value,str) or not value.strip() or len(value)>4096 or any(c in value for c in '\r\n\x00'):raise ValueError('CREDENTIAL_VALUE_INVALID')
    text=existing.decode('utf-8');lines=text.splitlines(keepends=True);seen={};updated=[];changed=[]
    for index,line in enumerate(lines):
        content=line.rstrip('\r\n')
        if not content or content.lstrip().startswith('#') or '=' not in content:continue
        key,old=content.split('=',1)
        if key not in allowed:continue
        if key in seen:raise ValueError('WORKER_ENV_DUPLICATE_CREDENTIAL_KEY')
        seen[key]=old
        if key in payload:
            newline='\r\n' if line.endswith('\r\n') else '\n' if line.endswith('\n') else ''
            lines[index]=key+'='+payload[key]+newline
            updated.append(key)
            if payload[key]!=old:changed.append(key)
    for lane in ('PREMATCH','INPLAY'):
        for kind in ('USERNAME','PASSWORD'):
            key=f'LSPORTS_{lane}_{kind}'
            if key not in seen:raise ValueError('WORKER_ENV_PRIMARY_CREDENTIAL_MISSING')
        mq_user=f'LSPORTS_{lane}_MQ_USERNAME';mq_pass=f'LSPORTS_{lane}_MQ_PASSWORD'
        if bool(seen.get(mq_user))!=bool(seen.get(mq_pass)):raise ValueError('WORKER_ENV_MQ_PAIR_INCOMPLETE')
        if (mq_user in payload or mq_pass in payload) and (not payload.get(mq_user) or not payload.get(mq_pass)):raise ValueError('CREDENTIAL_MQ_PAIR_INCOMPLETE')
        for key in (mq_user,mq_pass):
            if key in payload and key not in seen:
                if lines and not lines[-1].endswith(('\n','\r')):lines[-1]+='\n'
                lines.append(key+'='+payload[key]+'\n');seen[key]=payload[key];updated.append(key);changed.append(key)
    if not updated or not changed:raise ValueError('CREDENTIAL_VALUES_UNCHANGED')
    return ''.join(lines).encode(),sorted(set(changed))

def credential_main():
    stage='credential_precheck';backup=None
    try:
        if os.geteuid()!=0 or any(w['running'] for w in states('worker')):raise ValueError()
        os.umask(0o077)
        payload=json.loads(sys.stdin.buffer.read(65537))
        if not isinstance(payload,dict):raise ValueError()
        meta=json.loads((SECURE/'deployment.json').read_bytes());release=Path(meta['release'])
        if release.parent!=RELEASES or not re.fullmatch('[0-9a-f]{40}',release.name) or release.is_symlink():raise ValueError()
        allowed={f'LSPORTS_{lane}_{kind}' for lane in ('PREMATCH','INPLAY') for kind in ('USERNAME','PASSWORD','MQ_USERNAME','MQ_PASSWORD')}
        if not set(payload)<=allowed:raise ValueError()
        destination=SECURE/'worker.env'
        if destination.is_symlink() or not destination.is_file() or destination.stat().st_uid!=0 or destination.stat().st_mode&0o777!=0o600:raise ValueError()
        data,changed=merge_worker_credentials(destination.read_bytes(),payload)
        stage='credential_backup';backup=Path(tempfile.mkdtemp(prefix='adl-credentials-',dir=BACKUPS))
        private(backup/'worker.before.private.env',destination.read_bytes())
        stage='credential_write'
        pending=SECURE/'worker.credentials.pending.env';private(pending,data);os.replace(pending,destination)
        if destination.stat().st_mode&0o777!=0o600 or destination.read_bytes()!=data:raise ValueError()
        emit(stage='complete',status='ok',backup=str(backup),settingsStaged=True,changedVariableNames=changed,workerStarted=False,providerRequests=0,
             unrelatedWorkerSettingsPreserved=True,composeOverridesPreserved=True,note='Only supplied credential fields were changed in protected worker.env; no provider request or consumer start.')
        return 0
    except Exception:
        emit(stage=stage,status='blocked',backup=str(backup) if backup else None,workerStarted=False,
             note='No secrets or raw errors printed. Preserve backups and inspect stage; no consumer started.')
        return 2
if __name__=='__main__':raise SystemExit(credential_main())
