"""Derive only worker image from the verified existing runtime. No consumers/provider calls."""
import hashlib
import shutil

def patch_worker(request):
    backup=None;stage='worker_image.input'
    try:
        require(os.geteuid()==0,'ROOT_REQUIRED')
        patch=request['patch'];files=patch['files']
        require(set(files)=={'connected.ts','connection-closer.ts'},'WORKER_PATCH_FILES_UNVERIFIED')
        for name,value in files.items():
            require(isinstance(value,str) and len(value.encode())<128*1024,'WORKER_PATCH_SIZE_LIMIT')
        digest=hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        stage='worker_image.deployment'
        meta=json.loads((SECURE/'deployment.json').read_bytes());release=Path(meta['release'])
        require(release.parent==RELEASES and re.fullmatch('[0-9a-f]{40}',release.name) and not release.is_symlink(),'RELEASE_UNVERIFIED')
        require(not any(c['running'] for c in states('worker')),'AWS_WORKER_MUST_REMAIN_STOPPED')
        base=['docker','compose','-p','adl-homologation','--env-file',str(SECURE/'deploy.env'),'-f',str(release/'deploy/homologation/compose.yaml'),'-f',str(release/'deploy/homologation/compose.existing-caddy.yaml')]
        for value in meta.get('composeOverrides',[]):
            file=Path(value);require(file.parent==SECURE and file.is_file() and not file.is_symlink(),'SAVED_OVERRIDE_UNVERIFIED');base+=['-f',value]
        before=model(base);worker=before['services']['worker'];base_image=worker['image']
        image_info=json.loads(run(['docker','image','inspect',base_image]))[0]
        saved=meta.get('cutoverWorkerPatch')
        if saved:
            require(saved.get('digest')==digest and saved.get('image')==base_image,'WORKER_PATCH_STATE_CHANGED')
            labels=image_info.get('Config',{}).get('Labels') or {}
            require(labels.get('eu.adl.cutover.patch')==digest,'WORKER_PATCH_LABEL_MISMATCH')
            emit(operation='cutover.image',stage='worker_image',status='ok',reused=True,image=base_image,workerStarted=False,posnetChanged=False,composeOverridesPreserved=True);return 0
        stage='worker_image.base_source'
        probe="const fs=require('node:fs'),c=require('node:crypto');console.log(c.createHash('sha256').update(fs.readFileSync('/app/apps/worker/src/connected.ts')).digest('hex'));"
        actual=run(['docker','run','--rm','--network','none','--memory','128m','--cpus','0.5','--read-only','--entrypoint','node',base_image,'-e',probe],timeout=30).decode().strip()
        require(actual==patch.get('baseConnectedSha256'),'BASE_WORKER_SOURCE_MISMATCH')
        require(shutil.disk_usage('/opt').free>512*1024*1024,'WORKER_PATCH_DISK_HEADROOM_INSUFFICIENT')
        backup=Path(tempfile.mkdtemp(prefix='adl-worker-patch-',dir=BACKUPS));os.chmod(backup,0o700)
        private(backup/'deployment.before.json',(SECURE/'deployment.json').read_bytes())
        context=backup/'context';context.mkdir(mode=0o700)
        for name,value in files.items():private(context/name,value.encode())
        base_id=image_info['Id'];tag='adl-cutover-base:'+base_id.split(':')[-1]
        run(['docker','tag',base_id,tag]);require(json.loads(run(['docker','image','inspect',tag]))[0]['Id']==base_id,'BASE_IMAGE_TAG_CHANGED')
        image='adl-worker-cutover:'+digest[:24]
        dockerfile='FROM '+tag+'\nUSER root\nCOPY --chown=node:node --chmod=644 connected.ts connection-closer.ts /app/apps/worker/src/\nLABEL eu.adl.cutover.patch="'+digest+'"\nUSER node\n'
        private(context/'Dockerfile',dockerfile.encode())
        stage='worker_image.build'
        cached=subprocess.run(['docker','image','inspect',image],capture_output=True,timeout=10)
        if cached.returncode==0:
            require((json.loads(cached.stdout)[0].get('Config',{}).get('Labels') or {}).get('eu.adl.cutover.patch')==digest,'CACHED_PATCH_IMAGE_MISMATCH')
        else:run(['docker','build','--network','none','--pull=false','-t',image,str(context)],timeout=240,log=backup/'build.private.log')
        stage='worker_image.offline_test'
        test="import{EventEmitter}from'node:events';import{connectionCloser}from'/app/apps/worker/src/connection-closer.ts';let calls=0;const c=Object.assign(new EventEmitter(),{close(){calls++;queueMicrotask(()=>c.emit('close'));return new Promise(()=>{});}});await Promise.race([connectionCloser(c)(),new Promise((_,r)=>setTimeout(()=>r(Error()),1500))]);if(calls!==1)throw Error();console.log('offline-close-ok');"
        checked=run(['docker','run','--rm','--network','none','--memory','256m','--cpus','0.5','--read-only','--tmpfs','/tmp:size=16777216,mode=1777','--entrypoint','node',image,'--import','tsx','--input-type=module','-e',test],timeout=20).decode()
        require('offline-close-ok' in checked,'WORKER_IMAGE_OFFLINE_TEST_FAILED')
        stage='worker_image.overlay'
        overlay=SECURE/('compose.worker-close-'+digest[:16]+'.json')
        content=json.dumps({'services':{'worker':{'image':image}}}).encode()
        if overlay.exists():require(overlay.read_bytes()==content,'WORKER_PATCH_OVERLAY_CHANGED')
        else:private(overlay,content)
        after=model(base+['-f',str(overlay)]);expected=copy.deepcopy(before);expected['services']['worker']['image']=image
        require(after==expected,'WORKER_PATCH_UNEXPECTED_MODEL_CHANGE')
        meta['composeOverrides']=[*meta.get('composeOverrides',[]),str(overlay)]
        meta['cutoverWorkerPatch']={'digest':digest,'image':image,'baseImageId':base_id,'backup':str(backup)}
        temporary=SECURE/('deployment.patch-'+digest[:16]+'.tmp')
        private(temporary,json.dumps(meta).encode());durable_replace(temporary,SECURE/'deployment.json')
        emit(operation='cutover.image',stage='worker_image',status='ok',image=image,backup=str(backup),offlineCloseVerified=True,workerStarted=False,posnetChanged=False,composeOverridesPreserved=True);return 0
    except Exception as error:
        reason=str(error) if re.fullmatch('[A-Z][A-Z_]+',str(error)) else 'PRIVATE_WORKER_IMAGE_OPERATION_FAILED'
        emit(operation='cutover.image',stage=stage,status='blocked',reason=reason,backup=str(backup) if backup else None,workerStarted=False,posnetChanged=False);return 2
