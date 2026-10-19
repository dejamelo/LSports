"""Receive source, build an image and start only the isolated ADL API. No worker/Caddy/POSNET changes."""
import json
import ipaddress
import socket
import time
import urllib.request
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile

ROOT=Path('/opt/adl-homologation/releases')
SECURE=Path('/etc/adl-homologation')
def emit(**v): print(json.dumps(v),flush=True)
def main():
    stage='precheck'; release=None
    try:
        sha=sys.argv[1]
        if os.geteuid()!=0 or not re.fullmatch(r'[0-9a-f]{40}',sha): raise ValueError()
        if sys.version_info<(3,12): raise ValueError()
        available=int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')))*1024
        if available<4*1024**3 or shutil.disk_usage('/opt').free<10*1024**3: raise ValueError()
        # Never allow another project's tree, volumes, deployment or daemon to be changed.
        # Isolated API requires a free port and the already-existing Caddy network.
        with socket.socket() as sock: sock.bind(('127.0.0.1',13001))
        projects=subprocess.run(['docker','ps','-aq','--filter','label=com.docker.compose.project=adl-homologation'],capture_output=True,check=False)
        if projects.returncode or projects.stdout.strip(): raise ValueError()
        if subprocess.run(['docker','network','inspect','deploy_default'],capture_output=True,check=False).returncode: raise ValueError()
        client=ipaddress.ip_address(sys.argv[2].split()[0])
        stage='receive_source';os.umask(0o077)
        ROOT.mkdir(parents=True,exist_ok=True)
        release=ROOT/sha
        release.mkdir(mode=0o700,exist_ok=False)
        with tarfile.open(fileobj=sys.stdin.buffer,mode='r|') as archive:
            archive.extractall(release,filter='data')
        if any(p.exists() for p in (release/'.env',release/'.runtime',release/'.git')): raise ValueError()
        stage='build_image'
        logfile=release/'build.private.log'
        with open(logfile,'xb') as log:
            os.chmod(logfile,0o600)
            result=subprocess.run(['docker','build','-f',str(release/'Dockerfile.homologation'),'-t','adl-homologation:'+sha,str(release)],stdout=log,stderr=subprocess.STDOUT,timeout=1200,check=False)
        if result.returncode: raise ValueError()
        stage='protected_configuration'
        secure=SECURE;secure.mkdir(mode=0o700,exist_ok=True)
        if secure.is_symlink(): raise ValueError()
        os.chmod(secure,0o700)
        def private(name,content):
            fd=os.open(secure/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'w') as f: f.write(content);f.flush();os.fsync(f.fileno())
        domain='sportbook.apuestadeportiva.lat'
        private('api.env','PLATFORM_PUBLIC_ORIGIN=https://'+domain+'\nHOMOLOGATION_HOST='+domain+'\n')
        private('worker.env',(release/'deploy/homologation/worker.env.example').read_text())
        private('deploy.env','ADL_IMAGE=adl-homologation:'+sha+'\nAPI_ENV_FILE=/etc/adl-homologation/api.env\nWORKER_ENV_FILE=/etc/adl-homologation/worker.env\nADL_CADDY_NETWORK=deploy_default\nADL_CAPACITY_APPROVED=no\nADL_MAC_WORKER_STOPPED=no\nADL_SUPPLIER_NOT_BEFORE_UTC=\n')
        private('deployment.json',json.dumps({'release':str(release),'image':'adl-homologation:'+sha,'domain':domain,'adminCidr':str(client)+('/32' if client.version==4 else '/128')}))
        compose=['docker','compose','-p','adl-homologation','--env-file',str(secure/'deploy.env'),'-f',str(release/'deploy/homologation/compose.yaml'),'-f',str(release/'deploy/homologation/compose.existing-caddy.yaml')]
        def run(args):
            with open(release/'deploy.private.log','ab') as log:
                if subprocess.run(args,stdout=log,stderr=subprocess.STDOUT,timeout=120,check=False).returncode: raise ValueError()
        stage='api_configuration';run(compose+['config','--quiet'])
        stage='api_start';run(compose+['up','-d','--no-deps','api'])
        stage='api_health'
        healthy=False
        for _ in range(30):
            try:
                with urllib.request.urlopen('http://127.0.0.1:13001/control',timeout=3) as r: healthy=r.status==200
            except Exception: pass
            if healthy: break
            time.sleep(1)
        if not healthy: raise ValueError()
        (release/'release.json').write_text(json.dumps({'commit':sha,'image':'adl-homologation:'+sha,'source':'git_archive','apiStarted':True,'workerStarted':False}))
        emit(stage='complete',status='ok',release=str(release),image='adl-homologation:'+sha,
             apiStarted=True,workerStarted=False,posnetChanged=False,domain='sportbook.apuestadeportiva.lat',
             note='Isolated API ready on loopback13001; no Caddy reload, bootstrap, provider credentials or consumer. Mac data/consumer unchanged.')
        return 0
    except Exception:
        emit(stage=stage,status='failed',release=str(release) if release else None,posnetChanged=False,workerStarted=False,
             note='Preserve partial release/private logs. Only ADL API may have started; worker/Caddy/POSNET untouched. No provider calls or raw exceptions printed.')
        return 2

if __name__=='__main__':raise SystemExit(main())
