"""Receive allowlisted provider settings over SSH stdin. No provider calls or worker starts."""
import hashlib

def credential_main():
    stage='credential_precheck';backup=None
    try:
        if os.geteuid()!=0 or any(w['running'] for w in states('worker')):raise ValueError()
        os.umask(0o077)
        payload=json.loads(sys.stdin.buffer.read(65537))
        if not isinstance(payload,dict):raise ValueError()
        meta=json.loads((SECURE/'deployment.json').read_bytes());release=Path(meta['release'])
        if release.parent!=RELEASES or not re.fullmatch('[0-9a-f]{40}',release.name) or release.is_symlink():raise ValueError()
        example=(release/'deploy/homologation/worker.env.example').read_text()
        defaults=dict(line.split('=',1) for line in example.splitlines() if line and not line.startswith('#'))
        allowed={f'LSPORTS_{lane}_{kind}' for lane in ('PREMATCH','INPLAY') for kind in ('USERNAME','PASSWORD','MQ_USERNAME','MQ_PASSWORD')}
        if not set(payload)<=allowed:raise ValueError()
        for k,v in payload.items():
            if not isinstance(v,str) or len(v)>4096 or any(c in v for c in '\r\n\x00'):raise ValueError()
            defaults[k]=v
        if any(not defaults.get(f'LSPORTS_{lane}_{kind}') for lane in ('PREMATCH','INPLAY') for kind in ('USERNAME','PASSWORD')):raise ValueError()
        for lane in ('PREMATCH','INPLAY'):
            if bool(defaults.get(f'LSPORTS_{lane}_MQ_USERNAME'))!=bool(defaults.get(f'LSPORTS_{lane}_MQ_PASSWORD')):raise ValueError()
        destination=SECURE/'worker.env'
        if destination.is_symlink() or not destination.is_file():raise ValueError()
        stage='credential_backup';backup=Path(tempfile.mkdtemp(prefix='adl-credentials-',dir=BACKUPS))
        private(backup/'worker.before.private.env',destination.read_bytes())
        stage='credential_write'
        data=''.join(k+'='+v+'\n' for k,v in defaults.items()).encode()
        pending=SECURE/'worker.credentials.pending.env';private(pending,data);os.replace(pending,destination)
        if destination.stat().st_mode&0o777!=0o600 or destination.read_bytes()!=data:raise ValueError()
        emit(stage='complete',status='ok',backup=str(backup),credentialsStored=True,workerStarted=False,providerRequests=0,
             composeOverridesPreserved=True,note='Provider credentials stored only in protected worker.env. API/browser/Mac files unchanged; cutover gates remain closed.')
        return 0
    except Exception:
        emit(stage=stage,status='blocked',backup=str(backup) if backup else None,workerStarted=False,
             note='No secrets or raw errors printed. Preserve backups and inspect stage; no consumer started.')
        return 2
if __name__=='__main__':raise SystemExit(credential_main())
