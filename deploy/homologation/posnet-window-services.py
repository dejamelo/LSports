"""Explicit approved-window stop/return only. Never changes EC2, policies or containers."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

STAGE='approval_gate'
ROOT=Path('/var/backups')
CADDYS={'/deploy-caddy-production-1','/posnet-sso-originfix-private-https','/posnet-sso-private-https'}
EXPECTED={
'3b61ea33cd2212bcf26f9cc54a9740eb05e40913e19f921e190942ff6978a70b',
'e2ed00f069290108331e7a8c568f337e0b423eb9df9de4a8f199f8fc8146d9d7',
'3ef69dc72f8cff7bbb209f615ac89e33f2a9fc21cee2624697e519f16ba6f419',
'2323753931e54bbd66daf876fa417465408c54884f9bcd21019942723618ba5c',
'b030b0e88ed77c1db9b216045e9db5349a1b7dd8bd0e0212f18908ce21e71841',
'a3e5bb8fe52831383d876d042b1c5962bde2ae1736aa97bdc668d05364df194d',
'b7d4d72f5bb96ffeafe405cebc5c68f001bfa661ce22b52e8a39511c1516632c',
'a6a19a1afe3b75745e4fb4188923f24f7d56361eb19076153624c745c7b36bd6',
'b226a835a8a532c34a855f2283d5e439ac44cea2399bc75db7cb8e4427e2a95b',
'12ace14153f9f99d3a36959ed82a383678a8e0770ae673a0543a2ceb87799083',
'e0428b3131b3a9df39da17744e2bf3b8a8ba0ee74c070f6184077806973362e2',
'81a718f0d6ce7129e8142e6ea76ee5821d0b10930c6d8f27edc7a3d4cd685b82'}
TEMPFILES={'/tmp/Caddyfile.posnet-originfix-private','/tmp/Caddyfile.posnet-private-test'}

def call(args,timeout=60):
    p=subprocess.run(args,capture_output=True,timeout=timeout,check=False)
    if p.returncode: raise RuntimeError()
    return p.stdout

def shape(item):
    nets=(item.get('NetworkSettings') or {}).get('Networks') or {}
    return {'id':item['Id'],'name':item['Name'],'image':item['Image'],'mounts':item.get('Mounts'),
            'ports':(item.get('HostConfig') or {}).get('PortBindings'),
            'networks':{k:sorted(v.get('Aliases') or []) for k,v in nets.items()}}

def restore_temp(backup,manifest):
    for row in manifest['files']:
        if row['source'] not in TEMPFILES: continue
        source=backup/row['backupFile']
        data=source.read_bytes()
        if hashlib.sha256(data).hexdigest()!=row['sha256']: raise ValueError()
        dest=Path(row['source'])
        if dest.is_symlink(): raise ValueError()
        if dest.exists():
            if not dest.is_file() or dest.read_bytes()!=data: raise ValueError()
        else:
            fd=os.open(dest,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'wb') as f: f.write(data); f.flush(); os.fsync(f.fileno())

def main():
    global STAGE
    STAGE='approval_gate'
    action=sys.argv[1] if len(sys.argv)>1 else ''
    if action not in ('stop','return') or '--approved' not in sys.argv or action=='stop' and '--quiesced' not in sys.argv: raise ValueError()
    if os.geteuid()!=0: raise PermissionError()
    STAGE='identity_gate'
    choices=[]
    for p in ROOT.glob('posnet-resize-config-*'):
        file=p/'manifest.private.json'
        if p.is_symlink() or not file.is_file(): continue
        m=json.loads(file.read_bytes())
        if {r['id'] for r in m.get('running',[])}==EXPECTED: choices.append((file.stat().st_mtime_ns,p,m))
    if not choices: raise ValueError()
    _,backup,manifest=max(choices,key=lambda v:v[0])
    items=json.loads(call(['docker','inspect',*sorted(EXPECTED)]))
    if {i['Id'] for i in items}!=EXPECTED: raise ValueError()
    for item in items:
        original=json.loads((backup/(item['Id']+'.inspect.private.json')).read_bytes())[0]
        if shape(item)!=shape(original): raise ValueError()
    proxies=[i['Id'] for i in items if i['Name'] in CADDYS]
    apps=[i['Id'] for i in items if i['Name'] not in CADDYS]
    if len(proxies)!=3 or len(apps)!=9: raise ValueError()
    if action=='stop':
        STAGE='stop_proxies'; call(['docker','stop','--time','120',*proxies],timeout=150)
        STAGE='stop_apps'; call(['docker','stop','--time','120',*apps],timeout=150)
        STAGE='verify_stopped'
        after=json.loads(call(['docker','inspect',*sorted(EXPECTED)]))
        if any(i['State'].get('Running') or i['State'].get('ExitCode')==137 or i['State'].get('OOMKilled') for i in after): raise ValueError()
        print(json.dumps({'stage':'complete','status':'ok','action':'stop','containers':12,'next':'Offline volume backup; on failure return the same services. EC2 has not been stopped.'}))
    else:
        STAGE='restore_missing_temp_files'; restore_temp(backup,manifest)
        STAGE='start_apps'; call(['docker','start',*apps],timeout=150)
        STAGE='start_proxies'; call(['docker','start',*proxies],timeout=150)
        STAGE='verify_running'
        after=json.loads(call(['docker','inspect',*sorted(EXPECTED)]))
        if any(not i['State'].get('Running') for i in after): raise ValueError()
        print(json.dumps({'stage':'complete','status':'running_not_application_validated','action':'return','containers':12,
                          'next':'Wait for healthchecks and validate POSNET/SSO/public routes before reopening operations. No database restore or EC2 change performed.'}))

if __name__=='__main__':
    # Stage emitted by guarded operations is tracked without printing exceptions/configs.
    try: main()
    except Exception:
        print(json.dumps({'stage':STAGE,'status':'failed','reason':'window_action_failed_sanitized','action':'A partial stop/start may have occurred; preserve backups. Review Docker status and use approved return procedure, not recreate or restore.'}))
        raise SystemExit(2)
