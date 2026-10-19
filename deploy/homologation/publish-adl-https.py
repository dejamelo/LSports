"""Bundled with resume helpers. Adds only ADL to the existing Caddy; never starts worker."""
import ipaddress
import hashlib
import fcntl
DOMAIN='sportbook.apuestadeportiva.lat'
CADDY='deploy-caddy-production-1'
HOST=Path('/home/ubuntu/pixel-lottery-hub/deploy/Caddyfile.production')

def command(args,data=None):
    p=subprocess.run(args,input=data,capture_output=True,timeout=30,check=False)
    if p.returncode:raise RuntimeError('command_failed')
    return p.stdout

def adapt(data):return json.loads(command(['docker','exec','-i',CADDY,'caddy','adapt','--config','/dev/stdin','--adapter','caddyfile'],data))
def active():return json.loads(command(['docker','exec',CADDY,'wget','-qO-','-T','5','http://127.0.0.1:2019/config/']))
def reload(data):command(['docker','exec','-i',CADDY,'caddy','reload','--config','/dev/stdin','--adapter','caddyfile'],data)
def write_host(data):
    with HOST.open('r+b') as f:f.seek(0);f.write(data);f.truncate();f.flush();os.fsync(f.fileno())

def unchanged_except_adl(before,after):
    candidate=copy.deepcopy(after);removed=0
    for server in candidate.get('apps',{}).get('http',{}).get('servers',{}).values():
        routes=server.get('routes',[]);keep=[]
        for route in routes:
            matches=route.get('match',[])
            if matches==[{'host':[DOMAIN]}]:removed+=1
            else:keep.append(route)
        server['routes']=keep
    return removed==1 and candidate==before

def site(cidr):
    network=ipaddress.ip_network(cidr,strict=True)
    if network.prefixlen==0:raise ValueError()
    return f'''\n# ADL isolated homologation — preserve POSNET sites above.
{DOMAIN} {{
  log_skip
  header {{
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
  }}
  @privateAdmin {{
    path /control /control/* /api/control /api/control/* /api/diagnostics /api/diagnostics/*
    not remote_ip {network} 127.0.0.1/32 ::1/128
  }}
  respond @privateAdmin 403
  @developmentOnly path /demo /demo/* /local-demo/* /synthetic/*
  respond @developmentOnly 404
  reverse_proxy adl-homologation-api:3001
}}
'''.encode()

def https_main():
    stage='https_precheck';backup=None;changed=False;old=None
    try:
        if os.geteuid()!=0:raise PermissionError()
        os.umask(0o077)
        with (SECURE/'https.publish.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            meta=json.loads((SECURE/'deployment.json').read_bytes())
            if meta.get('domain')!=DOMAIN or control_status()!=200 or any(w['running'] for w in states('worker')):raise ValueError()
            # Read saved overrides without rewriting them; the healthy API is not recreated.
            for value in meta.get('composeOverrides',[]):
                path=Path(value)
                if path.parent!=SECURE or path.is_symlink() or not path.is_file():raise ValueError()
            info=json.loads(command(['docker','inspect',CADDY]))[0]
            if info['Name']!='/'+CADDY or not info['State']['Running']:raise ValueError()
            mounts=[m for m in info['Mounts'] if m['Destination']=='/etc/caddy/Caddyfile']
            if len(mounts)!=1 or mounts[0]['Type']!='bind' or mounts[0]['Source']!=str(HOST) or HOST.is_symlink():raise ValueError()
            argv=(info['Config'].get('Entrypoint') or [])+(info['Config'].get('Cmd') or [])
            if any(a=='--resume' or a.startswith('--resume=') for a in argv) or '--config' not in argv or argv[argv.index('--config')+1]!='/etc/caddy/Caddyfile':raise ValueError()
            old=HOST.read_bytes()
            if len(old)>2*1024*1024 or command(['docker','exec',CADDY,'cat','/etc/caddy/Caddyfile'])!=old:raise ValueError()
            baseline=adapt(old)
            if active()!=baseline:raise ValueError('loaded_boot_differ')
            if DOMAIN.encode() in old:
                emit(stage='https_existing',status='blocked',note='ADL site already present; verify HTTPS rather than append again.',workerStarted=False);return 2
            candidate=old+site(meta['adminCidr']);proposed=adapt(candidate)
            if not unchanged_except_adl(baseline,proposed):raise ValueError('unrelated_route_changes')
            emit(stage=stage,status='ok',existingRoutesUnchanged=True,composeOverridesPreserved=True,workerStarted=False)
            if '--apply' not in sys.argv:return 0
            stage='https_backup';backup=Path(tempfile.mkdtemp(prefix='adl-https-',dir=BACKUPS))
            private(backup/'Caddyfile.before.private',old)
            private(backup/'active.before.private.json',json.dumps(baseline).encode())
            private(backup/'Caddyfile.after.private',candidate)
            private(backup/'deployment.before.private.json',(SECURE/'deployment.json').read_bytes())
            stage='https_reload'
            if HOST.read_bytes()!=old or active()!=baseline:raise ValueError()
            changed=True;write_host(candidate);reload(candidate)
            if active()!=proposed or command(['docker','exec',CADDY,'cat','/etc/caddy/Caddyfile'])!=candidate:raise ValueError()
            stage='https_verify'
            # Normal TLS verification. Certificate issuance may require time; no -k/HTTP downgrade.
            deadline=time.monotonic()+90;verified=False
            while time.monotonic()<deadline:
                try:
                    with urllib.request.urlopen('https://'+DOMAIN+'/sportsbook',timeout=8) as response:
                        verified=response.status==200 and b'<html' in response.read(1024*1024).lower()
                    if verified:break
                except Exception:pass
                time.sleep(3)
            emit(stage='complete',status='ok' if verified else 'https_pending',backup=str(backup),httpsVerified=verified,
                 caddyReloaded=True,existingRoutesUnchanged=True,composeOverridesPreserved=True,workerStarted=False,
                 note='No container restart or consumer change. If HTTPS pending, inspect certificate issuance safely; do not append site again.')
            return 0 if verified else 2
    except Exception:
        rollback='not_needed'
        if changed and old is not None:
            try:write_host(old);reload(old);rollback='restored' if active()==adapt(old) else 'unverified'
            except Exception:rollback='failed'
        emit(stage=stage,status='blocked',backup=str(backup) if backup else None,rollback=rollback,workerStarted=False,
             note='No raw configuration/errors printed. Preserve backups; no AWS worker/POSNET containers restarted.')
        return 2
if __name__=='__main__':raise SystemExit(https_main())
