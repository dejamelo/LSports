"""Read-only size/export metadata for three known volumes and completed private backups."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys

VOLUMES=('posnet-demo-sso-originfix-replay-20261009','posnet-demo-sso-canary-replay-20261009','deploy_caddy_production_data')
ROOT=Path('/var/backups')

def usage(path):
    logical=allocated=entries=0
    for parent,dirs,files in os.walk(path,followlinks=False):
        for name in dirs+files:
            info=(Path(parent)/name).lstat(); entries+=1
            if stat.S_ISREG(info.st_mode): logical+=info.st_size
            allocated+=info.st_blocks*512
    return {'logicalBytes':logical,'allocatedBytes':allocated,'entries':entries,'archiveEstimateBytes':logical+entries*4096+65536}

def completed_config():
    choices=[]
    for p in ROOT.glob('posnet-resize-config-*'):
        manifest=p/'manifest.private.json'
        if p.is_symlink() or not manifest.is_file(): continue
        m=json.loads(manifest.read_bytes())
        if len(m.get('files',[]))==7 and len(m.get('running',[]))==12:
            choices.append(p)
    if not choices: raise ValueError('no_completed_config_backup')
    return max(choices,key=lambda p:(p/'manifest.private.json').stat().st_mtime_ns)

def approved_directory(value,kind):
    p=Path(value)
    prefix='posnet-resize-config-' if kind=='config' else 'posnet-local-volumes-'
    if p.parent!=ROOT or not re.fullmatch(re.escape(prefix)+r'[A-Za-z0-9_-]+',p.name) or p.is_symlink() or not p.is_dir(): raise ValueError('unexpected_source')
    return p

def export_metadata(path,kind):
    p=approved_directory(path,kind)
    manifest=json.loads((p/'manifest.private.json').read_bytes())
    if kind=='volumes':
        rows=manifest.get('volumes') or []
        if {v.get('name') for v in rows}!=set(VOLUMES) or len(rows)!=3 or any(v.get('tarCompare')!='ok' for v in rows): raise ValueError('incomplete_volume_backup')
        names=[v['archive'] for v in rows]+['manifest.private.json']
    else:
        if len(manifest.get('files',[]))!=7 or len(manifest.get('running',[]))!=12: raise ValueError('incomplete_config_backup')
        names=sorted(f.name for f in p.iterdir())
    result=[]
    for name in names:
        if not re.fullmatch(r'[A-Za-z0-9_.-]+',name): raise ValueError('unsafe_name')
        f=p/name
        if f.is_symlink() or not f.is_file(): raise ValueError('not_regular_file')
        h=hashlib.sha256()
        with f.open('rb') as source:
            for chunk in iter(lambda:source.read(1024*1024),b''): h.update(chunk)
        result.append({'name':name,'bytes':f.stat().st_size,'sha256':h.hexdigest()})
    if kind=='volumes':
        byname={f['name']:f for f in result}
        if any(byname[v['archive']]['sha256']!=v['sha256'] or byname[v['archive']]['bytes']!=v['bytes'] for v in rows): raise ValueError('archive_manifest_mismatch')
    return {'source':str(p),'kind':kind,'files':result,'totalBytes':sum(r['bytes'] for r in result)}

def main():
    action=sys.argv[1] if len(sys.argv)>1 else 'sizes'
    if action=='sizes':
        raw=subprocess.run(['docker','volume','inspect',*VOLUMES],capture_output=True,timeout=30,check=False)
        if raw.returncode: raise ValueError('volume_query_failed')
        volumes=json.loads(raw.stdout)
        if {v.get('Name') for v in volumes}!=set(VOLUMES) or len(volumes)!=3: raise ValueError('unexpected_volumes')
        sizes=[]
        for v in volumes:
            if v.get('Driver')!='local' or v.get('Options'): raise ValueError('unsupported_volume')
            source=Path(v['Mountpoint'])
            if source.is_symlink() or not source.is_dir(): raise ValueError('invalid_mountpoint')
            sizes.append({'name':v['Name'],**usage(source)})
        config=completed_config()
        print(json.dumps({'status':'ok','readOnly':True,'volumes':sizes,'configBackup':str(config),'configBytes':usage(config)['logicalBytes'],
                          'awsBackupFreeBytes':shutil.disk_usage(ROOT).free,'note':'Point-in-time sizing while services run; estimate, not a consistency check or a backup.'}))
    elif action=='exports':
        print(json.dumps(export_metadata(sys.argv[2],sys.argv[3])))
    elif action=='read':
        p=approved_directory(sys.argv[2],sys.argv[3]); name=sys.argv[4]
        if not re.fullmatch(r'[A-Za-z0-9_.-]+',name): raise ValueError('unsafe_name')
        f=p/name
        fd=os.open(f,os.O_RDONLY|os.O_NOFOLLOW)
        with os.fdopen(fd,'rb') as data:
            if not stat.S_ISREG(os.fstat(data.fileno()).st_mode): raise ValueError('not_regular')
            shutil.copyfileobj(data,sys.stdout.buffer,1024*1024)
    else: raise ValueError('unsupported_action')

if __name__=='__main__':
    try: main()
    except Exception:
        print('{"status":"failed","reason":"backup_size_or_export_unavailable_sanitized"}',file=sys.stderr)
        raise SystemExit(2)
