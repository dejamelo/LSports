"""Inspect private ADL deploy evidence; repair only the proven tmpfs error. Never build/start worker or touch POSNET."""
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.request

SECURE=Path('/etc/adl-homologation')
RELEASES=Path('/opt/adl-homologation/releases')
BACKUPS=Path('/var/backups')
BAD=['/tmp:size=67108864','mode=1777']
GOOD=['/tmp:size=67108864,mode=1777']
OVERRIDE='services:\n  api:\n    tmpfs: !override\n      - "/tmp:size=67108864,mode=1777"\n  worker:\n    tmpfs: !override\n      - "/tmp:size=67108864,mode=1777"\n'


def emit(**v):print(json.dumps(v),flush=True)
def run(args,timeout=30,log=None):
    p=subprocess.run(args,capture_output=True,timeout=timeout,check=False)
    if log:
        with open(log,'ab') as f: f.write(p.stdout);f.write(p.stderr)
    if p.returncode:raise RuntimeError('command_failed')
    return p.stdout

def private(path,data):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())

def read_tail(file,limit=128*1024):
    if not file.is_file():return b''
    with file.open('rb') as f:
        f.seek(0,2);f.seek(max(0,f.tell()-limit));return f.read(limit)

def classify(data):
    text=data.decode(errors='replace').lower()
    rules={
        'invalid_tmpfs_mount_path':lambda:'mode=1777' in text and ('invalid mount path' in text or 'mount path must be absolute' in text),
        'port_conflict':lambda:'port is already allocated' in text or 'address already in use' in text,
        'image_unavailable':lambda:'no such image' in text or 'pull access denied' in text,
        'network_missing':lambda:'network' in text and 'not found' in text,
        'disk_full':lambda:'no space left on device' in text,
        'permission_denied':lambda:'permission denied' in text or 'eacces' in text,
        'sqlite_open_failed':lambda:'sqlite_cantopen' in text or 'unable to open database' in text,
        'read_only_filesystem':lambda:'read-only file system' in text or 'erofs' in text,
        'production_origin_invalid':lambda:'production requires' in text and 'origin' in text,
    }
    return [code for code,fn in rules.items() if fn()]

def states(service):
    ids=run(['docker','ps','-aq','--filter','label=com.docker.compose.project=adl-homologation','--filter','label=com.docker.compose.service='+service]).decode().split()
    if not ids:return []
    items=json.loads(run(['docker','inspect',*ids]));result=[]
    for i in items:
        labels=(i.get('Config') or {}).get('Labels') or {}
        if labels.get('com.docker.compose.project')!='adl-homologation' or labels.get('com.docker.compose.service')!=service:raise ValueError()
        state=i.get('State') or {}
        result.append({'id':i['Id'],'name':i.get('Name'),'state':state.get('Status'),'running':state.get('Running'),
                       'exitCode':state.get('ExitCode'),'health':(state.get('Health') or {}).get('Status'),
                       'oomKilled':state.get('OOMKilled'),'errorSignals':classify(str(state.get('Error','')).encode())})
    return result

def app_log_signals(containers):
    signals=set()
    for item in containers:
        try:
            p=subprocess.run(['docker','logs','--tail','80',item['id']],capture_output=True,timeout=10,check=False)
            if p.returncode==0:signals.update(classify(p.stdout+p.stderr))
        except Exception:pass
    return sorted(signals)

def control_status():
    try:
        with urllib.request.urlopen('http://127.0.0.1:13001/control',timeout=2) as r:return r.status
    except Exception:return None

def model(base,override=None):
    args=base+(['-f',str(override)] if override else [])
    return json.loads(run(args+['--profile','*','config','--format','json']))

def expected_model(before):
    expected=copy.deepcopy(before)
    for service in ('api','worker'):
        if before['services'][service].get('tmpfs')!=BAD:raise ValueError('not_the_known_defect')
        expected['services'][service]['tmpfs']=GOOD
    return expected

def main():
    stage='inspect';backup=None;api_mutation_requested=False
    try:
        if os.geteuid()!=0:raise PermissionError()
        metadata=json.loads((SECURE/'deployment.json').read_bytes())
        release=Path(metadata['release'])
        if release.parent!=RELEASES or not re.fullmatch('[0-9a-f]{40}',release.name) or release.is_symlink():raise ValueError()
        if metadata.get('image')!='adl-homologation:'+release.name:raise ValueError()
        base=['docker','compose','-p','adl-homologation','--env-file',str(SECURE/'deploy.env'),'-f',str(release/'deploy/homologation/compose.yaml'),'-f',str(release/'deploy/homologation/compose.existing-caddy.yaml')]
        reasons=classify(read_tail(release/'deploy.private.log'))
        apis=states('api');workers=states('worker')
        before=model(base)
        report={'stage':'inspect','status':'ok','readOnly':True,'release':str(release),'deployLogSignals':reasons,
                'apiContainers':apis,'apiLogSignals':app_log_signals(apis),'workerContainers':workers,'controlHttpStatus':control_status(),
                'apiTmpfs':before['services']['api'].get('tmpfs'),'workerTmpfs':before['services']['worker'].get('tmpfs'),
                'rawLogPrinted':False,'providerRequests':0}
        emit(**report)
        if '--apply' not in sys.argv:return 0
        stage='repair_gate'
        if any(w['running'] for w in workers):raise ValueError()
        if len(apis)>1:raise ValueError()
        if report['controlHttpStatus']==200 and any(a['running'] for a in apis):
            emit(stage='complete',status='already_running',apiStarted=True,workerStarted=False,posnetChanged=False,note='No restart or changes made; inspect configuration separately.')
            return 0
        if 'invalid_tmpfs_mount_path' not in reasons:raise ValueError('production_cause_not_confirmed')
        expected=expected_model(before)
        # Ensure the image exists: no rebuild/pull, fresh volumes, env changes or profile activation.
        run(['docker','image','inspect',metadata['image']])
        stage='backup';os.umask(0o077)
        backup=Path(tempfile.mkdtemp(prefix='adl-api-resume-',dir=BACKUPS))
        private(backup/'deployment.before.private.json',(SECURE/'deployment.json').read_bytes())
        private(backup/'model.before.private.json',json.dumps(before).encode())
        overlay=SECURE/'compose.tmpfs-fix.yaml'
        if overlay.exists():
            if overlay.is_symlink() or overlay.read_text()!=OVERRIDE:raise ValueError()
        else:private(overlay,OVERRIDE.encode())
        stage='model_validation'
        after=model(base,overlay)
        if after!=expected:raise ValueError('unrelated_configuration_changes')
        private(backup/'model.after.private.json',json.dumps(after).encode())
        # Save the composition for future ADL operations; do not alter the original release.
        metadata['composeOverrides']=[str(overlay)]
        metadata['apiResumeFix']='quoted_tmpfs_v1'
        private(SECURE/'deployment.tmpfs.pending.json',json.dumps(metadata).encode())
        os.replace(SECURE/'deployment.tmpfs.pending.json',SECURE/'deployment.json')
        stage='api_resume'
        api_mutation_requested=True
        run(base+['-f',str(overlay),'up','-d','--no-build','--no-deps','--pull','never','api'],timeout=120,log=backup/'resume.private.log')
        stage='api_health'
        deadline=time.monotonic()+45
        while time.monotonic()<deadline:
            if control_status()==200:break
            time.sleep(1)
        else:raise ValueError('api_not_healthy')
        emit(stage='complete',status='ok',release=str(release),backup=str(backup),apiStarted=True,controlHttpStatus=200,
             workerStarted=False,posnetChanged=False,imageRebuilt=False,volumesDeleted=False,
             note='Existing image/data retained. Only tmpfs definition changed; keep Mac worker running. Include saved composeOverrides in future ADL commands.')
        return 0
    except Exception:
        # Show additional known signals only; never the private reply or container log body.
        signals=[]
        if backup:
            signals=classify(read_tail(backup/'resume.private.log'))
        apis=[]
        if api_mutation_requested:
            try:apis=states('api');signals=sorted(set(signals+app_log_signals(apis)))
            except Exception:pass
        emit(stage=stage,status='blocked' if not api_mutation_requested else 'failed',backup=str(backup) if backup else None,
             apiMutationRequested=api_mutation_requested,apiContainers=apis,signals=signals,workerStarted=False,posnetChanged=False,
             note='Preserve image, env, volumes and private logs. Do not rerun initial preparation, start worker, delete volumes or print raw logs.')
        return 2

if __name__=='__main__':raise SystemExit(main())
