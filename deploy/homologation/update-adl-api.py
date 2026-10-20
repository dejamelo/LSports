"""API-only update: private online backups, offline schema gate, image-only rollback."""
import copy, fcntl, hashlib, json, os, re, shutil, sqlite3, subprocess, sys, tarfile, tempfile, time, urllib.request, urllib.error
from pathlib import Path
SECURE=Path('/etc/adl-homologation')
BACKUPS=Path('/var/backups')

def emit(**v): print(json.dumps(v),flush=True)
def require(ok,code):
    if not ok: raise RuntimeError(code)
def run(args,timeout=60,log=None,input=None,env=None):
    p=subprocess.run(args,input=input,capture_output=True,timeout=timeout,env=env)
    if log:
        with open(log,'ab') as f: f.write(p.stdout);f.write(p.stderr)
    require(p.returncode==0,'COMMAND_FAILED_PRIVATE_LOG');return p.stdout

def private(path,data):
    with open(path,'xb') as f:
        os.chmod(path,0o600);f.write(data);f.flush();os.fsync(f.fileno())
def atomic(path,data):
    temporary=path.with_name(path.name+'.pending')
    private(temporary,data);os.replace(temporary,path)
def schema(db):
    return list(db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"))
def compatible_schema(before,after):
    old={(r[0],r[1]):r for r in before};new={(r[0],r[1]):r for r in after}
    require(all(new.get(k)==v for k,v in old.items()),'EXISTING_SCHEMA_CHANGED')
    additions=[v for k,v in new.items() if k not in old]
    expected='CREATE TABLE operation_terminals(operation_id TEXT NOT NULL REFERENCES operations(id),terminal_id TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(operation_id,terminal_id))'
    normalize=lambda s:re.sub(r'\s+','',s or '').lower()
    for item in additions:
        require(item[:3]==('table','operation_terminals','operation_terminals') and normalize(item[3])==normalize(expected),'UNREVIEWED_SCHEMA_ADDITION')
    return [r[1] for r in additions]
def backup_db(source,destination):
    require(not source.is_symlink(),'SYMLINK_DATABASE_REJECTED')
    with sqlite3.connect(source.as_uri()+'?mode=ro',uri=True,timeout=10) as src, sqlite3.connect(destination) as dst:
        src.backup(dst,pages=256,sleep=.05)
        require(dst.execute('PRAGMA integrity_check').fetchone()==('ok',),'BACKUP_INTEGRITY_FAILED')
    os.chmod(destination,0o600)
def compare_models(before,after,image):
    expected=copy.deepcopy(before);expected['services']['api']['image']=image
    require(expected==after,'UNRELATED_COMPOSE_CHANGE')
def identities():
    ids=run(['docker','ps','-aq']).decode().split()
    return {i['Id']:(i['State']['StartedAt'],i['RestartCount'],i['Image'],i['State']['Status']) for i in json.loads(run(['docker','inspect',*ids])) if ((i['Config'].get('Labels') or {}).get('com.docker.compose.project')!='adl-homologation' or (i['Config'].get('Labels') or {}).get('com.docker.compose.service')!='api')}
def request(path,origin='http://127.0.0.1:13001'):
    with urllib.request.urlopen(origin+path,timeout=10) as r:return r.status,r.read(4*1024*1024)
def health():
    for _ in range(45):
        try:
            status,body=request('/api/control/status');d=json.loads(body)
            if status==200 and d.get('financialMode')=='simulation':return d
        except Exception:pass
        time.sleep(1)
    raise RuntimeError('API_HEALTH_FAILED')
def compose(meta):
    release=Path(meta['release'])
    require(release.parent==Path('/opt/adl-homologation/releases') and re.fullmatch('[a-f0-9]{40}',release.name),'RELEASE_INVALID')
    files=[release/'deploy/homologation/compose.yaml',release/'deploy/homologation/compose.existing-caddy.yaml']
    for p in meta.get('composeOverrides',[]):
        p=Path(p);require(p.parent==SECURE and not p.is_symlink() and p.is_file(),'OVERRIDE_INVALID');files.append(p)
    return ['docker','compose','-p','adl-homologation','--env-file',str(SECURE/'deploy.env')]+sum((['-f',str(p)] for p in files),[])
PROBE=r'''
import {PlatformStore} from '@lsports/feed-store/platform';
import {OperationTickets} from '/app/packages/feed-store/src/operation-tickets.ts';
import {TicketStore} from '@lsports/feed-store/tickets';
import {existsSync} from 'node:fs';
const p=new PlatformStore('/check');
for(const id of p.allOperationIds()){const op=p.operation(id);if(existsSync(`/check/clients/${op.clientId}/operations/${id}/tickets.sqlite`)){const t=new OperationTickets(p,id);t.close();}}
if(existsSync('/check/legacy-test-tickets.sqlite'))new TicketStore('/check/legacy-test-tickets.sqlite').close();
console.log(JSON.stringify({adminPresent:p.hasPlatformAdmin(),operations:p.allOperationIds().length}));p.close();
'''
def receive_source(stream,context):
    with tarfile.open(fileobj=stream,mode='r|') as archive:
        for item in archive:
            require((item.isfile() or item.isdir()) and not item.name.startswith('/') and '..' not in Path(item.name).parts,'ARCHIVE_PATH_REJECTED')
            require(item.name.split('/')[0] in ('apps','packages','scripts','package.json','package-lock.json','tsconfig.json'),'SOURCE_SCOPE_REJECTED')
            require(not re.search(r'(^|/)(\.env[^/]*|\.runtime|node_modules|backups|\.local-synthetic-demo)(/|$)|\.(sqlite|pem|key|log)(\.|$)|synthetic|\.test\.',item.name,re.I),'PRIVATE_OR_TEST_SOURCE_REJECTED')
            archive.extract(item,context,filter='data')

def main():
    stage='preflight';emit(stage=stage,status='running');backup=None;mutated=False;oldmeta=None;base=None;protected=None
    try:
        require(os.geteuid()==0,'ROOT_REQUIRED');os.umask(0o077)
        lock=open(SECURE/'api-update.lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        oldmeta=(SECURE/'deployment.json').read_bytes();meta=json.loads(oldmeta);base=compose(meta)
        before=json.loads(run(base+['--profile','*','config','--format','json']))
        require(before['services']['api']['environment'].get('PLATFORM_ENABLED')=='true','PLATFORM_NOT_ENABLED')
        require(before['services']['api']['environment'].get('DATA_MODE')=='connected','CONNECTED_MODE_REQUIRED')
        ids=run(['docker','ps','-q','--filter','label=com.docker.compose.project=adl-homologation','--filter','label=com.docker.compose.service=api']).decode().split()
        require(len(ids)==1,'EXACTLY_ONE_RUNNING_API_REQUIRED')
        api=json.loads(run(['docker','inspect',ids[0]]))[0]
        protected=identities()
        mount=next(m for m in api['Mounts'] if m['Destination']=='/app/.runtime/platform')
        require(mount['Type']=='volume','PLATFORM_VOLUME_REQUIRED');platform=Path(mount['Source'])
        available=int(next(l.split()[1] for l in Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:')))*1024
        require(available>=1536*1024**2 and shutil.disk_usage('/var/backups').free>3*1024**3,'BUILD_CAPACITY_INSUFFICIENT')
        sha=sys.argv[1];require(re.fullmatch('[a-f0-9]{40}',sha),'COMMIT_INVALID')
        backup=Path(tempfile.mkdtemp(prefix='adl-api-update-',dir=BACKUPS));log=backup/'update.private.log'
        private(backup/'deployment.before.private.json',oldmeta);private(backup/'model.before.private.json',json.dumps(before).encode())
        # Compose reparses interpolation on manual rollback: escape literal dollars.
        def literal(v):
            if isinstance(v,str):return v.replace('$','$$')
            if isinstance(v,list):return [literal(x) for x in v]
            if isinstance(v,dict):return {k:literal(x) for k,x in v.items()}
            return v
        private(backup/'rollback.compose.private.json',json.dumps(literal(before)).encode())
        context=backup/'context';context.mkdir()
        stage='receive_source';emit(stage=stage,status='running')
        receive_source(sys.stdin.buffer,context)
        # Reuse installed dependencies only if the exact lockfile matches.
        oldlock=run(['docker','exec','--user','0:0',ids[0],'sha256sum','/app/package-lock.json']).decode().split()[0]
        require(hashlib.sha256((context/'package-lock.json').read_bytes()).hexdigest()==oldlock,'DEPENDENCY_LOCK_CHANGED_FULL_BUILD_REQUIRED')
        parent='adl-api-parent:'+api['Image'].split(':')[1];run(['docker','image','tag',api['Image'],parent])
        image='adl-api-ui:'+sha
        dockerfile=f'''FROM {parent}\nLABEL org.opencontainers.image.revision={sha}\nUSER root\nCOPY apps /app/apps\nCOPY packages /app/packages\nCOPY scripts /app/scripts\nCOPY package.json package-lock.json tsconfig.json /app/\nRUN chmod a+r /app/package.json /app/package-lock.json /app/tsconfig.json && find /app/apps /app/packages /app/scripts -type d -exec chmod 0755 {{}} + && find /app/apps /app/packages /app/scripts -type f -exec chmod a+r {{}} + && find /app/apps /app/packages -type f -name '*.test.*' -delete && find /app/scripts -type f -name '*synthetic*' -delete && rm -f /app/scripts/validate-* /app/scripts/local-embed-demo* && NODE_OPTIONS=--max-old-space-size=768 npm run build -w @lsports/web\nUSER node\n'''
        private(context/'Dockerfile',dockerfile.encode());stage='build_api_image';emit(stage=stage,status='running')
        env=dict(os.environ,DOCKER_BUILDKIT='0')
        run(['docker','build','--network','none','--pull=false','--memory','1g','--memory-swap','1g','--cpu-quota','100000','-t',image,str(context)],timeout=900,log=log,env=env)
        stage='online_database_backup';emit(stage=stage,status='running');data=backup/'platform';data.mkdir()
        files=sorted(platform.rglob('*.sqlite'))
        require(any(p.name=='control.sqlite' for p in files),'CONTROL_DATABASE_REQUIRED')
        for src in files:
            dst=data/src.relative_to(platform);dst.parent.mkdir(parents=True,exist_ok=True);backup_db(src,dst)
        private(backup/'sha256.json',json.dumps({str(p.relative_to(data)):hashlib.sha256(p.read_bytes()).hexdigest() for p in data.rglob('*.sqlite')}).encode())
        # Probe a separate copy. Neither feed nor live platform mounted in test container.
        check=backup/'compatibility';shutil.copytree(data,check)
        for p in [check,*check.rglob('*')]:os.chown(p,1000,1000)
        schemas={str(p.relative_to(data)):schema(sqlite3.connect(p)) for p in data.rglob('*.sqlite')}
        stage='offline_compatibility';emit(stage=stage,status='running')
        run(['docker','run','--rm','--network','none','--memory','512m','--read-only','--tmpfs','/tmp:size=64m','--cap-drop','ALL','--security-opt','no-new-privileges:true','-v',str(check)+':/check','--entrypoint','node',image,'--import','tsx','--input-type=module','-e',PROBE],log=log)
        afterfiles={str(p.relative_to(check)) for p in check.rglob('*.sqlite')}
        require(afterfiles==set(schemas),'DATABASE_SET_CHANGED_REQUIRES_MAINTENANCE')
        additions={}
        for rel,s in schemas.items():
            with sqlite3.connect(check/rel) as db:
                added=compatible_schema(s,schema(db))
                if added:additions[rel]=added
        private(backup/'compatibility.json',json.dumps({'compatible':True,'additiveTables':additions}).encode())
        with sqlite3.connect(data/'control.sqlite') as db:
            admins=db.execute("SELECT id,email,password,role,client_id FROM admins WHERE role='platform_admin' ORDER BY id").fetchall()
        stage='compose_gate';emit(stage=stage,status='running')
        overlay=SECURE/('compose.api-ui-'+sha+'.yaml')
        content=('services:\n  api:\n    image: '+image+'\n').encode()
        if overlay.exists():require(overlay.read_bytes()==content,'OVERLAY_CONFLICT')
        else:private(overlay,content)
        after=json.loads(run(base+['-f',str(overlay),'--profile','*','config','--format','json']))
        compare_models(before,after,image)
        require((SECURE/'deployment.json').read_bytes()==oldmeta,'DEPLOYMENT_CHANGED_EXTERNALLY')
        stage='api_replace';emit(stage=stage,status='running');mutated=True
        newbase=base+['-f',str(overlay)]
        run(newbase+['up','-d','--no-deps','--no-build','--pull','never','api'],timeout=120,log=log)
        stage='installed_version';emit(stage=stage,status='running');status=health()
        current_ids=run(['docker','ps','-q','--filter','label=com.docker.compose.project=adl-homologation','--filter','label=com.docker.compose.service=api']).decode().split()
        require(len(current_ids)==1,'INSTALLED_API_COUNT_INVALID')
        installed=json.loads(run(['docker','inspect',current_ids[0]]))[0]
        built=json.loads(run(['docker','image','inspect',image]))[0]
        require(installed['Image']==built['Id'] and (built['Config'].get('Labels') or {}).get('org.opencontainers.image.revision')==sha,'INSTALLED_IMAGE_VERSION_MISMATCH')
        source_hashes={str(p.relative_to(context)):hashlib.sha256(p.read_bytes()).hexdigest() for p in context.rglob('*') if p.is_file() and p.name!='Dockerfile'}
        verify="const fs=require('fs'),crypto=require('crypto');let raw='';process.stdin.on('data',x=>raw+=x);process.stdin.on('end',()=>{const items=Object.entries(JSON.parse(raw));const valid=items.every(([p,h])=>crypto.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex')===h);console.log(JSON.stringify({valid,count:items.length}));process.exitCode=valid?0:2;});"
        verified=json.loads(run(['docker','exec','-i','--user','0:0',current_ids[0],'node','-e',verify],input=json.dumps(source_hashes).encode(),log=log))
        require(verified.get('valid') is True,'INSTALLED_SOURCE_MISMATCH')
        emit(stage='installed_version',status='ok',installedCommit=sha,installedImageId=installed['Image'],installedSourceVerified=True,verifiedSourceFiles=verified['count'])
        stage='protected_panel_routes';emit(stage=stage,status='running')
        for route in ('/api/control/feed-overview','/api/control/feed-preview'):
            try:code,_=request(route)
            except urllib.error.HTTPError as e:code=e.code
            require(code==401,'PANEL_ROUTE_AUTH_GUARD_FAILED')
        code,_=request('/control/sportsbook-preview');require(code==200,'SPORTSBOOK_SHELL_FAILED')
        emit(stage=stage,status='ok',anonymousDataAccessBlocked=True,sportsbookShellVerified=True)
        stage='health_and_https';emit(stage=stage,status='running')
        code,html=request('/control');require(code==200 and b'<html' in html.lower(),'LOCAL_PANEL_FAILED')
        assets=re.findall(rb'(?:src|href)=[\"\'](/assets/[a-zA-Z0-9_.-]+\.js)[\"\']',html)
        require(bool(assets),'BUILT_ASSET_MISSING')
        for asset in assets[:1]:
            local_code,local_body=request(asset.decode());public_code,public_body=request(asset.decode(),'https://sportbook.apuestadeportiva.lat')
            require(local_code==public_code==200 and hashlib.sha256(local_body).digest()==hashlib.sha256(public_body).digest(),'HTTPS_ASSET_MISMATCH')
        require(identities()==protected,'PROTECTED_CONTAINER_CHANGED_EXTERNALLY')
        with sqlite3.connect((platform/'control.sqlite').as_uri()+'?mode=ro',uri=True) as db:
            current=db.execute("SELECT id,email,password,role,client_id FROM admins WHERE role='platform_admin' ORDER BY id").fetchall()
        require(admins==current,'ADMIN_CHANGED_DURING_UPDATE')
        meta['composeOverrides']=list(dict.fromkeys(meta.get('composeOverrides',[])+[str(overlay)]));meta['apiUiCommit']=sha;meta['apiUiBackup']=str(backup)
        atomic(SECURE/'deployment.json',json.dumps(meta).encode())
        private(backup/'success.json',json.dumps({'commit':sha,'adminPresent':bool(admins),'image':image,'installedImageId':installed['Image'],'installedSourceVerified':True}).encode())
        emit(stage='complete',status='ok',backup=str(backup),commit=sha,installedCommit=sha,installedImageId=installed['Image'],installedSourceVerified=True,httpsVerified=True,applicationVerified=True,panelRoutesVerified=True,administratorPreserved=bool(admins),initializationRequired=not bool(admins),schemaCompatible=True,additiveTables=additions,workersUnchanged=True,posnetChanged=False,composeOverridesPreserved=True,syntheticDataTransferred=False,panel='https://sportbook.apuestadeportiva.lat/control')
        return 0
    except Exception as e:
        code=str(e) if isinstance(e,RuntimeError) and re.fullmatch('[A-Z_]+',str(e)) else 'PRIVATE_ERROR_SEE_STAGE'
        rollback='not_needed'
        if mutated and base:
            try:
                run(base+['up','-d','--no-deps','--no-build','--pull','never','api'],timeout=120,log=backup/'rollback.private.log');health()
                if oldmeta:atomic(SECURE/'deployment.json',oldmeta)
                rollback='previous_api_healthy'
            except Exception:rollback='failed_preserve_private_logs'
        emit(stage=stage,status='blocked' if not mutated else 'failed',reason=code,backup=str(backup) if backup else None,rollback=rollback,workerMutationRequested=False,posnetChanged=False,rawErrorsPrinted=False)
        return 2
def bootstrap_main():
    try:
        require(os.geteuid()==0,'ROOT_REQUIRED');os.umask(0o077)
        lock=open(SECURE/'api-update.lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        require(health().get('initialized') is False,'ADMIN_ALREADY_EXISTS_PRESERVED')
        payload=sys.stdin.buffer.read(4097);require(len(payload)<=4096,'INPUT_TOO_LARGE')
        data=json.loads(payload);require(set(data)=={'email','password'},'INPUT_INVALID')
        ids=run(['docker','ps','-q','--filter','label=com.docker.compose.project=adl-homologation','--filter','label=com.docker.compose.service=api']).decode().split();require(len(ids)==1,'EXACTLY_ONE_RUNNING_API_REQUIRED')
        script="import {PlatformStore} from '@lsports/feed-store/platform';let raw='';for await(const part of process.stdin)raw+=part;const d=JSON.parse(raw);const p=new PlatformStore();try{await p.bootstrap(d.email,d.password);}finally{p.close();}"
        run(['docker','exec','-i',ids[0],'node','--import','tsx','--input-type=module','-e',script],input=payload)
        require(health().get('initialized') is True,'BOOTSTRAP_NOT_CONFIRMED')
        emit(stage='administrator_initialization',status='ok',existingAdministratorReset=False)
        return 0
    except Exception:
        emit(stage='administrator_initialization',status='blocked',existingAdministratorReset=False,rawErrorsPrinted=False);return 2
if __name__=='__main__':raise SystemExit(bootstrap_main() if '--bootstrap' in sys.argv else main())
