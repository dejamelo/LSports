#!/usr/bin/env bash
# Offline volume backup only. NEVER stops/pauses/starts containers or changes EC2.
# Run only in an approved window after application quiescence and writer shutdown.
set -u
command -v python3 >/dev/null || { echo 'python3_missing'; exit 2; }
exec python3 - <<'PY'
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

VOLUMES=('posnet-demo-sso-originfix-replay-20261009','posnet-demo-sso-canary-replay-20261009','deploy_caddy_production_data')
ROOT='/var/backups'

def emit(**data): print(json.dumps(data),flush=True)
def call(args):
    p=subprocess.run(args,capture_output=True,timeout=300,check=False)
    if p.returncode: raise RuntimeError('command_failed')
    return p.stdout

def active_writers(items):
    return [{'id':i.get('Id'),'name':i.get('Name')} for i in items if (i.get('State') or {}).get('Running') and any(m.get('Type')=='volume' and m.get('Name') in VOLUMES and m.get('RW') for m in i.get('Mounts',[]))]

def write(path,data):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f:
        json.dump(data,f,indent=2); f.write('\n'); f.flush(); os.fsync(f.fileno())

def digest(path):
    value=hashlib.sha256()
    with open(path,'rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''): value.update(chunk)
    return value.hexdigest()

def main():
    stage='writer_gate'; backup=None
    try:
        if os.geteuid()!=0: raise PermissionError()
        ids=call(['docker','ps','-aq']).decode().split()
        if not ids: raise ValueError()
        items=json.loads(call(['docker','inspect',*ids]))
        writers=active_writers(items)
        if writers:
            emit(stage=stage,status='blocked',reason='volume_writers_still_running',writers=writers,noStopRequested=True,
                 note='Expected outside approved downtime. No archive created, no service changed. Do not stop anything just to bypass this gate.')
            return 2
        stage='source_validation'
        volumes=json.loads(call(['docker','volume','inspect',*VOLUMES]))
        if len(volumes)!=len(VOLUMES) or {v.get('Name') for v in volumes}!=set(VOLUMES): raise ValueError()
        total=0
        for volume in volumes:
            source=Path(volume['Mountpoint'])
            if volume.get('Driver')!='local' or volume.get('Options') or source.is_symlink() or not source.is_dir(): raise ValueError()
            for parent,dirs,files in os.walk(source,followlinks=False):
                for name in files:
                    p=Path(parent)/name
                    if not p.is_symlink(): total+=p.stat().st_size
        if shutil.disk_usage(ROOT).free < total*2+128*1024*1024: raise ValueError()
        os.umask(0o077)
        backup=Path(tempfile.mkdtemp(prefix='posnet-local-volumes-',dir=ROOT))
        manifest={'method':'offline_filesystem_copy','applicationRestoreTested':False,
                  'requires':'application quiescence, no external host writers and no concurrent container startup', 'volumes':[]}
        for n,volume in enumerate(volumes):
            stage='archive_'+str(n+1)
            archive=backup/(volume['Name']+'.private.tar')
            fd=os.open(archive,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); os.close(fd)
            call(['tar','--create','--file',str(archive),'--numeric-owner','--acls','--xattrs','--directory',volume['Mountpoint'],'.'])
            stage='verify_'+str(n+1)
            # Byte/metadata comparison while no writers may run. Never extract into production.
            call(['tar','--compare','--file',str(archive),'--acls','--xattrs','--directory',volume['Mountpoint']])
            with open(archive,'rb') as f: os.fsync(f.fileno())
            manifest['volumes'].append({'name':volume['Name'],'archive':archive.name,'bytes':archive.stat().st_size,'sha256':digest(archive),'tarCompare':'ok'})
        stage='final_writer_gate'
        if active_writers(json.loads(call(['docker','inspect',*ids]))): raise ValueError()
        write(backup/'manifest.private.json',manifest)
        dirfd=os.open(backup,os.O_RDONLY)
        try: os.fsync(dirfd)
        finally: os.close(dirfd)
        emit(stage='complete',status='ok',backup=str(backup),volumes=len(volumes),tarCompare='ok',noStopRequested=True,
             applicationRestoreTested=False,note='Offline archives verified against sources; not an application restore test. Same-EBS backup requires protected off-host copy for disk-loss protection.')
        return 0
    except Exception:
        emit(stage=stage,status='failed',backup=str(backup) if backup else None,noStopRequested=True,
             note='Partial archives preserved. No raw paths/errors/contents printed; do not use as completed backup or restart writers while investigating.')
        return 2

if __name__=='__main__': raise SystemExit(main())
PY
