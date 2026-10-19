"""Bundled after resume-adl-api.py helpers by the Mac launcher. No application imports in probes."""
PROBE=r'''const fs=require('node:fs');const paths=['/app/apps/api/src/index.ts','/app/packages/contracts/src/index.ts','/app/scripts/homologation-worker.ts'];console.log(JSON.stringify({uid:process.getuid(),paths:paths.map(path=>{try{fs.accessSync(path,fs.constants.R_OK);return {path,readable:true}}catch(e){return {path,readable:false,code:['EACCES','ENOENT'].includes(e.code)?e.code:'OTHER'}}})}));'''
FIX="USER root\nRUN find /app/apps /app/packages /app/scripts -type d -exec chmod 0755 {} + && find /app/apps /app/packages /app/scripts -type f -exec chmod a+r {} +\nUSER node\n"

def probe(image,root=False):
    return json.loads(run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true']+(['--user','0:0'] if root else [])+['--entrypoint','node',image,'-e',PROBE]))

def access_defect(user,root):
    return user['uid']!=0 and any(x.get('code')=='EACCES' for x in user['paths']) and all(x['readable'] for x in root['paths'])

def runtime_main():
    stage='runtime_inspect';backup=None;mutation=False
    try:
        if os.geteuid()!=0:raise PermissionError()
        meta=json.loads((SECURE/'deployment.json').read_bytes());release=Path(meta['release'])
        if release.parent!=RELEASES or not re.fullmatch('[0-9a-f]{40}',release.name) or release.is_symlink():raise ValueError()
        original='adl-homologation:'+release.name
        if meta['image']!=original:raise ValueError()
        base=['docker','compose','-p','adl-homologation','--env-file',str(SECURE/'deploy.env'),'-f',str(release/'deploy/homologation/compose.yaml'),'-f',str(release/'deploy/homologation/compose.existing-caddy.yaml')]
        for item in meta.get('composeOverrides',[]):
            path=Path(item)
            if path.parent!=SECURE or path.is_symlink() or not path.is_file():raise ValueError()
            base+=['-f',str(path)]
        apis=states('api');workers=states('worker');signals=app_log_signals(apis)
        before=model(base);image=before['services']['api']['image']
        info=json.loads(run(['docker','image','inspect',image]))[0];image_id=info['Id']
        user=probe(image_id);root=probe(image_id,True)
        emit(stage=stage,status='ok',apiContainers=apis,apiLogSignals=signals,sourceAccess=user,rootSourceAccess=root,
             sourcePermissionDefect=access_defect(user,root),rawLogPrinted=False,providerRequests=0,workerStarted=False,posnetChanged=False)
        if '--apply' not in sys.argv:return 0
        stage='evidence_gate'
        if any(w['running'] for w in workers) or len(apis)!=1:raise ValueError()
        container=json.loads(run(['docker','inspect',apis[0]['id']]))[0]
        if container['Image']!=image_id:raise ValueError()
        if control_status()==200:
            emit(stage='complete',status='already_running',workerStarted=False,posnetChanged=False);return 0
        if not access_defect(user,root) or not set(signals)&{'module_not_found','permission_denied'}:raise ValueError()
        stage='backup';os.umask(0o077)
        backup=Path(tempfile.mkdtemp(prefix='adl-runtime-repair-',dir=BACKUPS))
        private(backup/'deployment.before.private.json',(SECURE/'deployment.json').read_bytes())
        private(backup/'model.before.private.json',json.dumps(before).encode())
        private(backup/'image.before.private.json',json.dumps(info).encode())
        logs=subprocess.run(['docker','logs','--tail','200',apis[0]['id']],capture_output=True,timeout=10,check=False)
        private(backup/'api.before.private.log',logs.stdout+logs.stderr)
        stage='derive_image'
        context=backup/'context';context.mkdir(mode=0o700)
        private(context/'Dockerfile',('FROM '+image_id+'\n'+FIX).encode())
        fixed=original+'-source-access-v1'
        # Pin to immutable local image; no registry or npm requests, no mounted data.
        run(['docker','build','--network','none','--pull=false','-t',fixed,str(context)],timeout=120,log=backup/'build.private.log')
        fixed_id=json.loads(run(['docker','image','inspect',fixed]))[0]['Id']
        if not all(p['readable'] for p in probe(fixed_id)['paths']):raise ValueError()
        stage='model_validation'
        overlay=SECURE/'compose.source-access-fix.yaml'
        content='services:\n  api:\n    image: '+fixed+'\n  worker:\n    image: '+fixed+'\n'
        if overlay.exists():
            if overlay.is_symlink() or overlay.read_text()!=content:raise ValueError()
        else:private(overlay,content.encode())
        after=model(base,overlay);expected=copy.deepcopy(before)
        for service in ('api','worker'):expected['services'][service]['image']=fixed
        if after!=expected:raise ValueError()
        private(backup/'model.after.private.json',json.dumps(after).encode())
        meta['composeOverrides']=meta.get('composeOverrides',[])+[str(overlay)]
        meta['runtimeImage']=fixed;meta['runtimeRepairBackup']=str(backup)
        pending=SECURE/'deployment.runtime.pending.json';private(pending,json.dumps(meta).encode())
        os.replace(pending,SECURE/'deployment.json')
        stage='api_resume';mutation=True
        run(base+['-f',str(overlay),'up','-d','--no-build','--no-deps','--pull','never','api'],timeout=120,log=backup/'resume.private.log')
        stage='api_health';deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            current=states('api')
            if control_status()==200 and len(current)==1 and current[0]['health']=='healthy':break
            time.sleep(2)
        else:raise ValueError()
        emit(stage='complete',status='ok',backup=str(backup),controlHttpStatus=200,health='healthy',workerStarted=False,posnetChanged=False,volumesChanged=False,
             note='Only API recreated; source permissions repaired in derived image. Existing volumes/env retained. Mac worker unchanged. Include saved composeOverrides in future commands.')
        return 0
    except Exception:
        emit(stage=stage,status='failed' if mutation else 'blocked',backup=str(backup) if backup else None,apiMutationRequested=mutation,
             workerStarted=False,posnetChanged=False,rawLogPrinted=False,
             note='No raw exceptions printed. Preserve private backups, images, volumes and saved composeOverrides; do not rerun preparation or start AWS worker.')
        return 2

if __name__=='__main__':raise SystemExit(runtime_main())
