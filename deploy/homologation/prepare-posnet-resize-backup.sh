#!/usr/bin/env bash
# Configuration backup only. No stop/start/restart, update, migrations or paid AWS calls.
set -u
command -v python3 >/dev/null || { echo 'python3_missing'; exit 2; }
exec python3 - <<'PY'
import datetime
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile

FILES=[
 '/home/ubuntu/pixel-lottery-hub/deploy/Caddyfile.production',
 '/home/ubuntu/pixel-lottery-hub/deploy/docker-compose.yml',
 '/home/ubuntu/pixel-lottery-hub/deploy/docker-compose.demo.yml',
 '/home/ubuntu/pixel-lottery-hub/deploy/docker-compose.sso-canary.yml',
 '/tmp/posnet-sso-originfix.override.yml',
 '/tmp/Caddyfile.posnet-originfix-private',
 '/tmp/Caddyfile.posnet-private-test',
]
ROOT='/var/backups'

def emit(**v): print(json.dumps(v),flush=True)
def call(args):
    p=subprocess.run(args,capture_output=True,timeout=30,check=False)
    if p.returncode: raise RuntimeError('command_failed')
    return p.stdout

def write(path,data):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as f:
        f.write(data); f.flush(); os.fsync(f.fileno())

def main():
    stage='precheck'; backup=None
    try:
        if os.geteuid()!=0: raise PermissionError()
        # Current membership is needed for the backup, not another feed/pricing diagnosis.
        ids=call(['docker','ps','-aq']).decode().split()
        if not ids: raise ValueError()
        if shutil.disk_usage(ROOT).free < 256*1024*1024: raise ValueError()
        stage='configuration_backup'
        os.umask(0o077)
        backup=Path(tempfile.mkdtemp(prefix='posnet-resize-config-',dir=ROOT))
        manifest={'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'files':[], 'running':[], 'databaseBackup':'not_verified', 'containsSecrets':'private_root_only_do_not_upload'}
        for index,source in enumerate(FILES):
            data=Path(source).read_bytes()
            if len(data)>8*1024*1024: raise ValueError()
            dest='file-'+str(index)+'.private'
            write(backup/dest,data)
            manifest['files'].append({'source':source,'backupFile':dest,'sha256':hashlib.sha256(data).hexdigest()})
        hints=set()
        local_persistence=[]
        for cid in ids:
            # Full inspect stays only in a root-only local backup: never print/upload it.
            raw=call(['docker','inspect',cid])
            item=json.loads(raw)[0]
            write(backup/(item['Id']+'.inspect.private.json'),raw)
            if (item.get('State') or {}).get('Running'):
                manifest['running'].append({'id':item['Id'],'name':item.get('Name'),'image':item.get('Image'), 'restartPolicy':((item.get('HostConfig') or {}).get('RestartPolicy') or {}).get('Name')})
                container_hints=set()
                for pair in (item.get('Config') or {}).get('Env') or []:
                    name=pair.split('=',1)[0].upper()
                    # Presence alone, never values/URLs. Not proof of which database is authoritative.
                    for family in ('SUPABASE','POSTGRES','MYSQL','SQLITE','DATABASE','MONGO'):
                        if family in name:
                            hints.add(family.lower()); container_hints.add(family.lower())
                # diff is read-only. Keep raw paths private: they may identify users/files.
                diff=call(['docker','diff',cid])
                write(backup/(item['Id']+'.diff.private.txt'),diff)
                paths=[line[2:] for line in diff.decode(errors='replace').splitlines() if len(line)>2 and line[0] in 'AC']
                db_count=sum(bool(re.search(r'(?i)\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$',v)) for v in paths)
                uploads_count=sum(bool(re.search(r'(?i)/(uploads?|replays?|data|storage)(?:/|$)',v)) for v in paths)
                local_persistence.append({'container':item.get('Name'), 'configurationFamiliesPresent':sorted(container_hints),
                    'mounts':[{'type':v.get('Type'),'destination':v.get('Destination'),'rw':v.get('RW')} for v in item.get('Mounts',[])],
                    'writableLayerChangedPaths':len(paths),'databaseFileCandidates':db_count,'dataOrUploadPathCandidates':uploads_count,
                    'note':'Presence/classification only. No file contents read; absence does not prove statelessness. Raw paths stay in protected backup.'})
        stage='caddy_private_backup'
        data=call(['docker','exec','e0428b3131b3a9df39da17744e2bf3b8a8ba0ee74c070f6184077806973362e2','wget','-qO-','-T','5','http://127.0.0.1:2019/config/'])
        json.loads(data)
        write(backup/'caddy-active.private.json',data)
        manifest['databaseConfigurationHints']=sorted(hints)
        manifest['localPersistence']=local_persistence
        write(backup/'manifest.private.json',json.dumps(manifest,indent=2).encode())
        stage='readback'
        for item in manifest['files']:
            if hashlib.sha256((backup/item['backupFile']).read_bytes()).hexdigest()!=item['sha256']: raise ValueError()
        dirfd=os.open(backup,os.O_RDONLY)
        try: os.fsync(dirfd)
        finally: os.close(dirfd)
        for row in local_persistence:
            emit(stage='local_persistence',**row)
        emit(stage='complete',status='ok',backup=str(backup),configurationFiles=len(FILES),runningContainers=len(manifest['running']),
             databaseConfigurationHints=sorted(hints),databaseBackup='not_verified',
             noRestartRequested=True,note='Configuration backup only; database/volume data not copied. Do not upload private files. Preserve all existing backups.')
        return 0
    except Exception:
        emit(stage=stage,status='failed',backup=str(backup) if backup else None,noRestartRequested=True,
             note='Partial backup preserved; no services changed. Do not treat as completed backup.')
        return 2

if __name__=='__main__': raise SystemExit(main())
PY
