#!/usr/bin/env bash
# Explicit mutation only when operator runs this script. Never stops/restarts containers.
set -u
command -v python3 >/dev/null || { echo 'python3_missing'; exit 2; }
exec python3 - <<'PY'
import datetime
import hashlib
import json
import os
import subprocess
import tempfile

TARGETS = [
 ('3b61ea33cd2212bcf26f9cc54a9740eb05e40913e19f921e190942ff6978a70b', '/posnet-sso-originfix-demo-sso-canary-1','demo-canary-release-20261009'),
 ('e2ed00f069290108331e7a8c568f337e0b423eb9df9de4a8f199f8fc8146d9d7', '/posnet-sso-originfix-production-sso-canary-1','production-canary-release-20261009')]
BACKUP_ROOT='/var/backups'

def emit(**fields): print(json.dumps(fields),flush=True)
def call(args):
    p=subprocess.run(args,capture_output=True,timeout=30,check=False)
    if p.returncode: raise RuntimeError('command_failed')
    return p.stdout

def sha(data): return hashlib.sha256(json.dumps(data,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def inspect(cid):
    rows=json.loads(call(['docker','inspect',cid]))
    if len(rows)!=1: raise ValueError('unexpected_inspect')
    return rows[0]

def summary(item):
    host=dict(item.get('HostConfig') or {})
    policy=host.pop('RestartPolicy',{})
    cfg=item.get('Config') or {}
    state=item.get('State') or {}
    net=(item.get('NetworkSettings') or {}).get('Networks') or {}
    return {'id':item.get('Id'),'name':item.get('Name'),'imageId':item.get('Image'),
      'running':state.get('Running'),'health':(state.get('Health') or {}).get('Status'),
      'pid':state.get('Pid'),'startedAt':state.get('StartedAt'),
      'restartPolicy':policy,'mounts':item.get('Mounts',[]),'networks':net,
      'portBindings':host.get('PortBindings'), 'hostConfigExceptRestartSha256':sha(host),
      'configSha256':sha(cfg)}

def validate(item,target):
    cid,name,alias=target
    snap=summary(item)
    if snap['id']!=cid or snap['name']!=name or not snap['running'] or snap['health']!='healthy':
        raise ValueError('identity_or_health_mismatch')
    if snap['restartPolicy'].get('Name') not in ('no','unless-stopped'):
        raise ValueError('unexpected_previous_policy')
    if alias not in (snap['networks'].get('posnet-sso-canary_default',{}).get('Aliases') or []):
        raise ValueError('required_alias_missing')
    if 'posnet-sso-originfix_default' not in snap['networks']:
        raise ValueError('required_network_missing')
    return snap

def unchanged(before,after):
    # Health may transition naturally. Running/PID/StartedAt must remain unchanged.
    return all(before.get(k)==after.get(k) for k in before if k not in ('restartPolicy','health'))

def save(directory,name,data):
    fd=os.open(os.path.join(directory,name),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f:
        json.dump(data,f,indent=2); f.write('\n'); f.flush(); os.fsync(f.fileno())
    dirfd=os.open(directory,os.O_RDONLY)
    try: os.fsync(dirfd)
    finally: os.close(dirfd)

def main():
    stage='precheck'; directory=None
    try:
        if os.geteuid()!=0: raise PermissionError('requires_existing_sudo')
        before=[validate(inspect(t[0]),t) for t in TARGETS]
        stage='backup'
        os.umask(0o077)
        directory=tempfile.mkdtemp(prefix='posnet-boot-policy-',dir=BACKUP_ROOT)
        save(directory,'before.json',{'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'containers':before})
        emit(stage='backup',status='ok',directory=directory)
        # All backups must succeed before either update. Nothing else is changed.
        rollback=[['docker','update','--restart='+s['restartPolicy']['Name'],s['id']] for s in before]
        save(directory,'rollback.json',rollback)
        for i,(target,original) in enumerate(zip(TARGETS,before)):
            stage='pre_update_'+str(i+1)
            current=validate(inspect(target[0]),target)
            if current!=original: raise ValueError('concurrent_change_before_update')
            stage='update_'+str(i+1)
            save(directory,'intent-'+str(i+1)+'.json',{'id':target[0],'desiredPolicy':'unless-stopped'})
            if original['restartPolicy'].get('Name')!='unless-stopped':
                call(['docker','update','--restart=unless-stopped',target[0]])
            stage='verify_'+str(i+1)
            after=summary(inspect(target[0]))
            save(directory,'after-'+str(i+1)+'.json',after)
            if after['restartPolicy'].get('Name')!='unless-stopped' or not unchanged(original,after):
                raise ValueError('post_update_mismatch')
            emit(stage=stage,status='ok',id=target[0],policy='unless-stopped',identityStorageNetworkAndProcessUnchanged=True)
        stage='final_verification'
        for original,target in zip(before,TARGETS):
            final=summary(inspect(target[0]))
            if not unchanged(original,final) or final['restartPolicy'].get('Name')!='unless-stopped':
                raise ValueError('final_mismatch')
        save(directory,'completed.json',{'status':'ok','containers':2,'noRestartRequested':True})
        emit(stage='complete',status='ok',backup=directory,noRestartRequested=True)
        return 0
    except Exception:
        # No raw errors, docker replies, headers, environment or inspect data on stdout.
        emit(stage=stage,status='failed',backup=directory,
             changesPossible=stage.startswith(('update_','verify_')) or stage=='final_verification' or stage=='pre_update_2',
             action='Preserve backup. Inspect both policies; use rollback.json if reverting. No automatic rollback or restart performed.')
        return 2

if __name__=='__main__': raise SystemExit(main())
PY
