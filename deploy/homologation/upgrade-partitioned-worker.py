"""Prepare a verified derived worker image, then activate once; preserve migration and POSNET."""
PARTITION_FILES={'apps/worker/src/connected.ts','apps/worker/src/connection-closer.ts','apps/worker/src/diagnostics.ts','apps/worker/src/provider.ts','apps/worker/src/snapshot-scheduler.ts','apps/worker/src/state.ts','apps/worker/src/messages.ts','apps/worker/src/league-fixtures.ts','apps/worker/src/partitioned-snapshot.ts','apps/worker/src/full-snapshot.ts','apps/worker/src/persistence.ts','packages/contracts/src/index.ts','packages/feed-store/src/index.ts'}
def partition_base(meta):
    release=Path(meta['release']);require(release.parent==RELEASES and re.fullmatch('[0-9a-f]{40}',release.name) and not release.is_symlink(),'RELEASE_UNVERIFIED')
    base=['docker','compose','-p','adl-homologation','--env-file',str(SECURE/'deploy.env'),'-f',str(release/'deploy/homologation/compose.yaml'),'-f',str(release/'deploy/homologation/compose.existing-caddy.yaml')]
    for entry in meta.get('composeOverrides',[]):
        path=Path(entry);require(path.parent==SECURE and path.is_file() and not path.is_symlink(),'OVERRIDE_UNVERIFIED');base+=['-f',entry]
    return base

def upgrade_partitioned(request):
    stage='partitioned_upgrade.input';backup=None
    try:
        require(os.geteuid()==0,'ROOT_REQUIRED');phase=request['phase'];require(phase in ('prepare','activate','rollback'),'INVALID_UPGRADE_PHASE')
        files=request['files'];require(set(files)==PARTITION_FILES,'UPGRADE_FILE_LIST_UNVERIFIED')
        require(all(isinstance(v,str) and len(v.encode())<256*1024 for v in files.values()),'UPGRADE_SOURCE_SIZE_LIMIT')
        digest=hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest();receipt_path=SECURE/('partitioned-upgrade-'+digest[:24]+'.json')
        meta=json.loads((SECURE/'deployment.json').read_bytes());base=partition_base(meta);before=model(base)
        require(control_status()==200,'API_NOT_HEALTHY')
        require(snapshot_memory_bytes(before['services']['worker']['mem_limit'])==4294967296,'UPGRADE_REQUIRES_EXISTING_FOUR_GIB_LIMIT')
        def save(p):
            tmp=SECURE/(receipt_path.name+'.tmp');private(tmp,json.dumps(p).encode());durable_replace(tmp,receipt_path)
        if receipt_path.exists():
            require(receipt_path.is_file() and not receipt_path.is_symlink(),'UPGRADE_RECEIPT_UNVERIFIED');progress=json.loads(receipt_path.read_bytes());require(progress['digest']==digest,'UPGRADE_DIGEST_MISMATCH');backup=Path(progress['backup'])
            image_info=json.loads(run(['docker','image','inspect',progress['image']]))[0]
            require((image_info.get('Config',{}).get('Labels') or {}).get('eu.adl.partitioned.patch')==digest,'UPGRADE_IMAGE_LABEL_MISMATCH')
        else:
            require(phase=='prepare','UPGRADE_MUST_BE_PREPARED');workers=states('worker');require(len(workers)==1 and workers[0]['running'],'UPGRADE_REQUIRES_SINGLE_RUNNING_WORKER')
            require(snapshot_host_memory()>=6*1024**3,'UPGRADE_HOST_MEMORY_HEADROOM_INSUFFICIENT');require(shutil.disk_usage('/opt').free>=1024**3,'UPGRADE_DISK_HEADROOM_INSUFFICIENT')
            original_image=before['services']['worker']['image'];base_info=json.loads(run(['docker','image','inspect',original_image]))[0]
            container=json.loads(run(['docker','inspect',workers[0]['id']]))[0];require(container['Image']==base_info['Id'],'UPGRADE_RUNNING_IMAGE_MISMATCH');require(snapshot_memory_bytes(container['HostConfig']['Memory'])==4294967296,'UPGRADE_CONTAINER_MEMORY_LIMIT_MISMATCH')
            probe="const fs=require('node:fs'),h=require('node:crypto');let result={};for(const name of "+json.dumps(sorted(files))+ "){const p='/app/'+name;result[name]=fs.existsSync(p)?h.createHash('sha256').update(fs.readFileSync(p)).digest('hex'):null;}console.log(JSON.stringify(result));"
            hashes=json.loads(run(['docker','run','--rm','--network','none','--memory','128m','--cpus','0.5','--read-only','--entrypoint','node',original_image,'-e',probe]))
            require(hashes==request['baseHashes'],'UPGRADE_BASE_SOURCES_CHANGED_NO_BLIND_PATCH')
            backup=Path(tempfile.mkdtemp(prefix='adl-partitioned-upgrade-',dir=BACKUPS));os.chmod(backup,0o700)
            private(backup/'deployment.before.json',(SECURE/'deployment.json').read_bytes());private(backup/'model.before.private.json',json.dumps(before).encode())
            context=backup/'context';context.mkdir(mode=0o700)
            for name,data in files.items():
                target=context/'overlay'/name;target.parent.mkdir(parents=True,exist_ok=True,mode=0o755);private(target,data.encode());os.chmod(target,0o644)
            tag='adl-partition-base:'+base_info['Id'].split(':')[-1];run(['docker','tag',base_info['Id'],tag]);require(json.loads(run(['docker','image','inspect',tag]))[0]['Id']==base_info['Id'],'UPGRADE_BASE_TAG_CHANGED')
            image='adl-worker-partitioned:'+digest[:24]

            for directory in (context/'overlay').rglob('*'):
                if directory.is_dir():os.chmod(directory,0o755)
            os.chmod(context/'overlay',0o755)
            dockerfile='FROM '+tag+'\nUSER root\nCOPY --chown=node:node overlay/ /app/\nLABEL eu.adl.partitioned.patch="'+digest+'"\nUSER node\n'
            private(context/'Dockerfile',dockerfile.encode());stage='partitioned_upgrade.build'
            run(['docker','build','--network','none','--pull=false','-t',image,str(context)],timeout=240,log=backup/'build.private.log')
            stage='partitioned_upgrade.offline_validation'
            check="""import{decodeMessage}from'/app/apps/worker/src/messages.ts';import{partitionedSnapshot,subscriptionInventory}from'/app/apps/worker/src/partitioned-snapshot.ts';await import('/app/apps/worker/src/connected.ts');const sdk=await import('trade360-nodejs-sdk');if(sdk.knownEntityKeys.get(38)!=='OutrightLeagueFixtureUpdate')throw Error();const body={Competition:{Id:1,Competitions:[{Id:2,Events:[{FixtureId:3,OutrightLeague:{FixtureName:'ISOLATED OFFLINE',Status:1,LastUpdate:'2026-10-19T06:00:00Z'}}]}]}};const decoded=decodeMessage(Buffer.from(JSON.stringify({Header:{Type:38,MsgGuid:'offline-38',ServerTimestamp:1792389601000},Body:body})),{});if(decoded.events[0]?.outright?.fixture?.fixtureName!=='ISOLATED OFFLINE')throw Error();if(subscriptionInventory({fixtures:[2,1]},{Body:{Fixtures:[2,1]}}).join(',')!=='1,2')throw Error();let rejected=false;try{subscriptionInventory({fixtures:['PRIVATE_OFFLINE']},{Body:{Fixtures:['PRIVATE_OFFLINE']}})}catch(e){rejected=e.diagnostic?.snapshotValidation?.code==='inventory_invalid_ids'}if(!rejected)throw Error();let applied=0;const p=await partitionedSnapshot({async inventory(){return[11,12]},async events(ids){return ids.map(fixtureId=>({fixtureId,fixture:{status:1}}))}},{assertOpen(){},async begin(){},async batch(rows){applied+=rows.length},async progress(){}},{batchSize:1});if(p.stage!=='complete'||applied!==2)throw Error();console.log('partitioned-offline-ok');"""
            output=run(['docker','run','--rm','--network','none','--memory','384m','--cpus','0.5','--read-only','--tmpfs','/tmp:size=33554432,mode=1777','--entrypoint','node',image,'--import','tsx','--input-type=module','-e',check],timeout=30)
            require(b'partitioned-offline-ok' in output,'UPGRADE_OFFLINE_TEST_FAILED')
            progress={'version':1,'digest':digest,'phase':'prepared','backup':str(backup),'image':image,'baseImage':original_image,'baseImageId':base_info['Id']};save(progress)
        if request.get('fixCommit')=='2aa06f7' and not progress.get('distributionFixVerified'):
            stage='partitioned_upgrade.offline_propagation'
            propagation="""import{createServer}from'node:http';import{clients}from'/app/apps/worker/src/provider.ts';import{StartMessage,DEFUALT_DISTRIBUTION_PROPAGATION_DELAY_MS}from'trade360-nodejs-sdk';if(DEFUALT_DISTRIBUTION_PROPAGATION_DELAY_MS!==2000)throw Error();let started=0,checks=0;const server=createServer(async(req,res)=>{for await(const b of req){}res.setHeader('Content-Type','application/json');if(req.url==='/Distribution/Start'){started=Date.now();res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:{Message:StartMessage.activated}}))}else{checks++;res.end(JSON.stringify({Header:{HttpStatusCode:200},Body:{IsDistributionOn:checks>1&&Date.now()-started>=2000}}))}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{const url='http://127.0.0.1:'+server.address().port,api=clients({lane:'prematch',packageId:4511,username:'offline-only',password:'offline-only',hostname:'unused',vhost:'unused',queue:'unused',port:5672,tls:false},{snapshotUrl:url,customersUrl:url});await api.startDistribution();const last=api.distributionObservations().at(-1);if(last.stage!=='after_propagation'||last.bodyIsDistributionOn!==true||last.sdkIsDistributionOn!==true||last.elapsedSinceStartMs<2000||checks!==2)throw Error();console.log('distribution-propagation-offline-ok')}finally{await new Promise(resolve=>server.close(resolve))}"""
            output=run(['docker','run','--rm','--network','none','--memory','384m','--cpus','0.5','--read-only','--tmpfs','/tmp:size=33554432,mode=1777','--entrypoint','node',progress['image'],'--import','tsx','--input-type=module','-e',propagation],timeout=30)
            require(b'distribution-propagation-offline-ok' in output,'UPGRADE_PROPAGATION_TEST_FAILED');progress['distributionFixVerified']=True;progress['fixCommit']='2aa06f7';save(progress)
        if request.get('fullRecovery') and not progress.get('fullRecoveryVerified'):
            stage='partitioned_upgrade.offline_full_recovery'
            check="""import{mkdtemp,writeFile,rm}from'node:fs/promises';import{walkSnapshot,convertSnapshotRow}from'/app/apps/worker/src/full-snapshot.ts';const dir=await mkdtemp('/tmp/full-offline-');try{const p=dir+'/response';await writeFile(p,JSON.stringify({Body:[{FixtureId:11,Fixture:{Status:1},Markets:[]}],Header:{HttpStatusCode:200}}));let n=0;await walkSnapshot(p,async r=>{if(convertSnapshotRow(r).fixtureId!==11)throw Error();n++});if(n!==1)throw Error();await writeFile(p,'{"Body":[],"Header":{"Errors":["isolated"]}}');let rejected=false;try{await walkSnapshot(p,async()=>{})}catch{rejected=true}if(!rejected)throw Error();console.log('full-recovery-offline-ok')}finally{await rm(dir,{recursive:true,force:true})}"""
            output=run(['docker','run','--rm','--network','none','--memory','384m','--cpus','0.5','--read-only','--tmpfs','/tmp:size=33554432,mode=1777','--entrypoint','node',progress['image'],'--import','tsx','--input-type=module','-e',check],timeout=30)
            require(b'full-recovery-offline-ok' in output,'FULL_RECOVERY_OFFLINE_TEST_FAILED');progress['fullRecoveryVerified']=True;save(progress)
        if request.get('supplierOrder') and not progress.get('supplierOrderVerified'):
            stage='partitioned_upgrade.offline_supplier_order'
            check="import {session} from '/app/apps/worker/src/connected.ts';import {TradeState} from '/app/apps/worker/src/state.ts';import {EventEmitter} from 'node:events';for(const lane of ['prematch','inplay']){const order=[],state=new TradeState(),abort=new AbortController();let ready=false;const channel=Object.assign(new EventEmitter(),{async prefetch(){},async consume(){order.push('consume');return{consumerTag:'offline'};}});const connection=Object.assign(new EventEmitter(),{async createChannel(){return channel},async close(){order.push('close');connection.emit('close');}});const api={async startDistribution(){order.push('start');await new Promise(r=>setTimeout(r,5));ready=true;order.push('status_on')},async stopDistribution(){order.push('stop')},async distributionStatus(){return{isDistributionOn:true}},async snapshot(){order.push('snapshot');return[]},async catalog(){return[]}};const pkg={lane,packageId:lane==='prematch'?4511:4510,queue:'unused',hostname:'unused',vhost:'unused',username:'offline',password:'offline',port:5672,tls:false};await session(pkg,{packages:[pkg],staleMs:90000,recoveryMs:300000},state,async()=>{if(state.connections[lane].phase==='connected')abort.abort()},abort.signal,{clientFactory:()=>api,connect:async()=>{if(!ready)throw Error('connect before propagation');order.push('connect');return connection}});if(order.slice(0,5).join(',')!=='start,status_on,connect,consume,snapshot'||order.indexOf('stop')>order.indexOf('close'))throw Error('supplier sequence wrong')}console.log('supplier-order-offline-ok');"
            output=run(['docker','run','--rm','--network','none','--memory','384m','--cpus','0.5','--read-only','--tmpfs','/tmp:size=33554432,mode=1777','--entrypoint','node',progress['image'],'--import','tsx','--input-type=module','-e',check],timeout=30)
            require(b'supplier-order-offline-ok' in output,'SUPPLIER_ORDER_OFFLINE_TEST_FAILED');progress['supplierOrderVerified']=True;save(progress)
        if request.get('supplierOrder') and progress.get('supplierOrderVerified'):
            # Image rollback preserves every non-worker definition and all current data.
            # Never start the known pre-fix order automatically after restoring it.
            rollback=backup/'rollback.worker.private.json'
            if not rollback.exists():
                old_worker=json.loads((backup/'model.before.private.json').read_bytes())['services']['worker']
                private(rollback,json.dumps({'services':{'worker':old_worker}}).replace('$','$$').encode())
        if request.get('nullableEvidence') and not progress.get('nullableMarketsVerified'):
            stage='partitioned_upgrade.offline_nullable_markets'
            evidence=Path(request['nullableEvidence'])
            require(evidence.parent==BACKUPS and re.fullmatch('adl-snapshot-shape-[A-Za-z0-9_-]+',evidence.name) and evidence.is_dir() and not evidence.is_symlink() and evidence.stat().st_mode&0o077==0 and evidence.stat().st_uid==BACKUPS.stat().st_uid,'CAPTURED_EVIDENCE_DIRECTORY_UNVERIFIED')
            source=evidence/'rejected-row.private.json';report=evidence/'report.json'
            for path,limit in ((source,16*1024**2),(report,65536)):
                require(path.is_file() and not path.is_symlink() and 0<path.stat().st_size<=limit and path.stat().st_mode&0o077==0 and path.stat().st_uid==evidence.stat().st_uid,'CAPTURED_EVIDENCE_FILE_UNVERIFIED')
            row_bytes=source.read_bytes();row=json.loads(row_bytes);proof=json.loads(report.read_bytes())
            require(proof.get('rawRowSha256')==hashlib.sha256(row_bytes).hexdigest() and proof.get('rawRowBytes')==len(row_bytes),'CAPTURED_EVIDENCE_HASH_MISMATCH')
            require(row.get('FixtureId')==20563979 and 'Markets' in row and row['Markets'] is None and proof.get('rejection',{}).get('path')=='Markets' and proof['rejection'].get('actualType')=='null','CAPTURED_NULL_MARKETS_NOT_CONFIRMED')
            require(proof.get('sdk',{}).get('conversion')=='succeeded' and proof['sdk'].get('markets',{}).get('type')=='null','CAPTURED_SDK_SEMANTICS_UNCONFIRMED')
            copy_path=backup/'captured-row.private.json'
            if copy_path.exists():require(copy_path.read_bytes()==row_bytes,'CAPTURED_BACKUP_CHANGED')
            else:private(copy_path,row_bytes)
            check="import{readFileSync}from'node:fs';import{convertSnapshotRow}from'/app/apps/worker/src/full-snapshot.ts';const raw=JSON.parse(readFileSync('/evidence/rejected-row.private.json','utf8')),row=convertSnapshotRow(raw);if(row.fixtureId!==20563979||row.markets!==null||!row.fixture)throw Error('captured row changed');const bets=convertSnapshotRow({FixtureId:1,Fixture:{Status:1},Markets:[{Id:1,Bets:null}]});if(bets.markets[0].bets!==null)throw Error('bets absence changed');for(const Markets of [{},'invalid',[null],[{Id:1,Bets:{}}],[{Id:1,Bets:[null]}]]){let rejected=false;try{convertSnapshotRow({FixtureId:1,Fixture:{Status:1},Markets})}catch{rejected=true}if(!rejected)throw Error('invalid shape accepted')}console.log('nullable-markets-offline-ok');"
            output=run(['docker','run','--rm','--network','none','--memory','384m','--cpus','0.5','--read-only','--tmpfs','/tmp:size=33554432,mode=1777','--user','0','--mount','type=bind,source='+str(evidence)+',target=/evidence,readonly','--entrypoint','node',progress['image'],'--import','tsx','--input-type=module','-e',check],timeout=30)
            require(b'nullable-markets-offline-ok' in output,'CAPTURED_NULLABLE_ROW_OFFLINE_FAILED');progress['nullableMarketsVerified']=True;progress['capturedRowSha256']=proof['rawRowSha256'];save(progress)
        if request.get('throughputFix') and not progress.get('throughputVerified'):
            stage='partitioned_upgrade.offline_throughput'
            require(progress.get('nullableMarketsVerified') is True,'THROUGHPUT_REQUIRES_CAPTURED_NULLABLE_ROW_TEST')
            check="import{session,coalescedPersistence}from'/app/apps/worker/src/connected.ts';import{TradeState}from'/app/apps/worker/src/state.ts';import{EventEmitter}from'node:events';let version=1,captures=[],release=[];const save=coalescedPersistence(async()=>{captures.push(version);await new Promise(r=>release.push(r))});const one=save();await new Promise(r=>setImmediate(r));version=2;const two=save();version=3;const three=save();if(two!==three||one===two)throw Error('unsafe coalescing');release.shift()();await one;await new Promise(r=>setImmediate(r));if(captures.join(',')!=='1,3')throw Error('capture order');release.shift()();await two;const state=new TradeState(),abort=new AbortController();let writes=0;const channel=Object.assign(new EventEmitter(),{async prefetch(){},async consume(){return{consumerTag:'offline'}}}),connection=Object.assign(new EventEmitter(),{async createChannel(){return channel},async close(){connection.emit('close')}});const pkg={lane:'prematch',packageId:4511,username:'isolated',password:'isolated',hostname:'unused',queue:'unused',vhost:'unused',tls:false,port:5672};const api={async startDistribution(){},async stopDistribution(){},async distributionStatus(){return{isDistributionOn:true}},async snapshot(){throw Error('unexpected')},async catalog(){return[]},async snapshotFull(sink){for(let i=1;i<=1600;i++)await sink.apply({fixtureId:i,fixture:{status:1},markets:null},Date.now());return{ids:new Set(Array.from({length:1600},(_,i)=>i+1)),rows:1600,bytes:1}}};await session(pkg,{packages:[pkg],staleMs:90000,recoveryMs:300000},state,async()=>{writes++;if(state.connections.prematch.phase==='connected')abort.abort()},abort.signal,{clientFactory:()=>api,connect:async()=>connection});if(writes>=15)throw Error('redundant full checkpoints');console.log('throughput-offline-ok');"
            output=run(['docker','run','--rm','--network','none','--memory','384m','--cpus','0.5','--read-only','--tmpfs','/tmp:size=33554432,mode=1777','--entrypoint','node',progress['image'],'--import','tsx','--input-type=module','-e',check],timeout=45)
            require(b'throughput-offline-ok' in output,'THROUGHPUT_OFFLINE_VALIDATION_FAILED');progress['throughputVerified']=True;save(progress)
        if phase=='prepare':
            emit(operation='cutover.aws',stage='partitioned_upgrade.prepared',status='ok',image=progress['image'],progressPhase=progress['phase'],offlineType38Verified=True,offlinePartitionsVerified=True,offlinePropagationVerified=progress.get('distributionFixVerified',False),offlineFullRecoveryVerified=progress.get('fullRecoveryVerified',False),offlineSupplierOrderVerified=progress.get('supplierOrderVerified',False),offlineNullableMarketsVerified=progress.get('nullableMarketsVerified',False),offlineThroughputVerified=progress.get('throughputVerified',False),workerRestarted=False,backup=str(backup),posnetChanged=False);return 0
        stage='partitioned_upgrade.fresh_mac_gate'
        handoff=request['handoff'];audit=handoff['audit'];require(audit['status']=='ok' and audit['workerLockAbsent'] and audit['matchingWorkerProcesses']==0,'MAC_SHUTDOWN_UNPROVEN')
        require(request['freshAuditAt'].endswith('Z') and -5<=time.time()-datetime.datetime.fromisoformat(request['freshAuditAt'].replace('Z','+00:00')).timestamp()<60,'MAC_REAUDIT_EXPIRED')
        digest_handoff=hashlib.sha256(json.dumps(handoff,sort_keys=True,separators=(',',':')).encode()).hexdigest();migration_receipt=SECURE/('cutover-'+digest_handoff+'.json');migration=json.loads(migration_receipt.read_bytes());require(migration.get('startRequestedAtUTC'),'MIGRATION_NOT_COMPLETE')
        saved_model=json.loads((backup/'model.before.private.json').read_bytes());expected=copy.deepcopy(saved_model);expected['services']['worker']['image']=progress['image'];expected['services']['worker']['environment']['LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT']='true'
        rollback_expected=copy.deepcopy(expected);rollback_expected['services']['worker']['image']=progress['baseImage']
        current=model(partition_base(meta));require(current==saved_model or current==expected or phase=='rollback' and current==rollback_expected,'DEPLOYMENT_CHANGED_SINCE_UPGRADE_PREPARE')
        image_id=json.loads(run(['docker','image','inspect',progress['image']]))[0]['Id']
        if phase=='rollback':
            stage='partitioned_upgrade.rollback'
            rollback=backup/'rollback.worker.private.json'
            require(progress.get('supplierOrderVerified') and rollback.is_file() and not rollback.is_symlink(),'ROLLBACK_NOT_PREPARED')
            workers=states('worker')
            if progress['phase']=='rolled_back_stopped':
                require(not any(w['running'] for w in workers),'ROLLED_BACK_WORKER_UNEXPECTEDLY_RUNNING')
                emit(operation='cutover.aws',stage='partitioned_upgrade.rollback',status='ok',reused=True,workerStarted=False,oldWorkerKeptStopped=True,posnetChanged=False);return 0
            if any(w['running'] for w in workers):
                require(len(workers)==1 and progress.get('rollbackStopRequested') is not True,'ROLLBACK_STOP_PENDING_NO_MORE_SIGNALS')
                info=json.loads(run(['docker','inspect',workers[0]['id']]))[0]
                require(info['Image']==image_id,'ROLLBACK_WORKER_IDENTITY_CHANGED')
                environment=info['Config']['Env'];require(all(isinstance(v,str) and '\n' not in v and '\r' not in v for v in environment),'STOP_ENV_FORMAT_UNVERIFIED')
                env_file=backup/'rollback-stop.private.env';env_content=('\n'.join(environment)+'\n').encode()
                if env_file.exists():require(env_file.is_file() and not env_file.is_symlink() and env_file.stat().st_mode&0o077==0 and env_file.read_bytes()==env_content,'ROLLBACK_ENV_CHANGED')
                else:private(env_file,env_content)
                code="import{loadConfig}from'/app/apps/worker/src/config.ts';import{clients}from'/app/apps/worker/src/provider.ts';for(const pkg of loadConfig().packages){await clients(pkg,loadConfig()).stopDistribution()}console.log('planned-distribution-stop-ok');"
                output=run(['docker','run','--rm','--network','container:'+workers[0]['id'],'--memory','256m','--read-only','--tmpfs','/tmp:size=33554432,mode=1777','--env-file',str(env_file),'-e','NODE_OPTIONS=--max-old-space-size=128','--entrypoint','node',progress['image'],'--import','tsx','--input-type=module','-e',code],timeout=90,log=backup/'rollback-stop.private.log')
                require(b'planned-distribution-stop-ok' in output,'ROLLBACK_DISTRIBUTION_STOP_NOT_CONFIRMED')
                progress['rollbackStopRequested']=True;save(progress)
                run(['docker','kill','--signal','SIGTERM',workers[0]['id']])
                deadline=time.time()+90
                while time.time()<deadline and any(c['running'] for c in states('worker')):time.sleep(1)
            require(not any(c['running'] for c in states('worker')),'ROLLBACK_GRACEFUL_STOP_PENDING_NO_MORE_SIGNALS')
            # Use an override containing only the old image. Existing overrides,
            # data and journals remain authoritative; never restore old data.
            old_overlay=SECURE/('compose.worker-rollback-'+digest[:24]+'.json')
            content=json.dumps({'services':{'worker':{'image':progress['baseImage']}}}).encode()
            if old_overlay.exists():require(old_overlay.is_file() and not old_overlay.is_symlink() and old_overlay.read_bytes()==content,'ROLLBACK_OVERLAY_CHANGED')
            else:private(old_overlay,content)
            candidate=partition_base(meta)+['-f',str(old_overlay)]
            reverted=copy.deepcopy(current);reverted['services']['worker']['image']=progress['baseImage']
            require(model(candidate)==reverted,'ROLLBACK_NON_WORKER_CHANGE_DETECTED')
            meta['composeOverrides']=[*meta.get('composeOverrides',[]),str(old_overlay)]
            temporary=SECURE/(receipt_path.name+'.rollback.tmp');private(temporary,json.dumps(meta).encode());durable_replace(temporary,SECURE/'deployment.json')
            run(partition_base(meta)+['--profile','feed-consumer','create','--no-deps','--no-build','--pull','never','worker'],timeout=90,log=backup/'rollback.private.log')
            progress['phase']='rolled_back_stopped';save(progress)
            emit(operation='cutover.aws',stage='partitioned_upgrade.rollback',status='ok',workerStarted=False,oldImageRestored=True,oldWorkerKeptStopped=True,dataRestored=False,posnetChanged=False);return 0
        require(progress['phase']!='rolled_back_stopped','ROLLED_BACK_WORKER_REQUIRES_REVIEW')
        if progress['phase'] in ('start_requested','running'):
            workers=states('worker');require(len(workers)==1 and workers[0]['running'],'UPGRADED_WORKER_NOT_RUNNING_NO_BLIND_RESTART');current_container=json.loads(run(['docker','inspect',workers[0]['id']]))[0]
            require(current_container['Image']==image_id and snapshot_memory_bytes(current_container['HostConfig']['Memory'])==4294967296,'UPGRADED_CONTAINER_MISMATCH')
            env=dict(x.split('=',1) for x in current_container['Config']['Env'] if '=' in x);require(env.get('LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT')=='true','PARTITION_FLAG_NOT_APPLIED')
            progress['phase']='running';save(progress);emit(operation='cutover.aws',stage='partitioned_upgrade.running',status='ok',reused=True,workerStarted=True,startedAtUTC=progress.get('startAt'),posnetChanged=False);return 0
        worker_states=states('worker')
        if progress['phase']=='prepared':
            require(len(worker_states)==1 and worker_states[0]['running'],'OLD_WORKER_NOT_RUNNING_BEFORE_STOP');require(snapshot_host_memory()>=6*1024**3,'UPGRADE_HOST_MEMORY_HEADROOM_INSUFFICIENT')
            old_container=json.loads(run(['docker','inspect',worker_states[0]['id']]))[0];require(old_container['Image']==progress['baseImageId'] and snapshot_memory_bytes(old_container['HostConfig']['Memory'])==4294967296,'OLD_WORKER_IDENTITY_CHANGED_BEFORE_STOP')
            if request.get('fullRecovery') and not progress.get('supplierStoppedBeforeConsumer'):
                stage='partitioned_upgrade.distribution_stop'
                info=json.loads(run(['docker','inspect',worker_states[0]['id']]))[0]
                environment=info['Config']['Env'];require(all(isinstance(v,str) and '\n' not in v and '\r' not in v for v in environment),'STOP_ENV_FORMAT_UNVERIFIED')
                env_file=backup/'stop-distribution.private.env';env_content=('\n'.join(environment)+'\n').encode()
                if env_file.exists():require(env_file.is_file() and not env_file.is_symlink() and env_file.stat().st_mode&0o077==0 and env_file.read_bytes()==env_content,'STOP_ENV_BACKUP_CHANGED')
                else:private(env_file,env_content)
                code="""import{loadConfig}from'/app/apps/worker/src/config.ts';import{clients}from'/app/apps/worker/src/provider.ts';const config=loadConfig();for(const pkg of config.packages){await clients(pkg,config).stopDistribution()}console.log('planned-distribution-stop-ok');"""
                output=run(['docker','run','--rm','--network','container:'+worker_states[0]['id'],'--memory','256m','--cpus','0.5','--read-only','--tmpfs','/tmp:size=33554432,mode=1777','--env-file',str(env_file),'-e','NODE_OPTIONS=--max-old-space-size=128','--entrypoint','node',progress['image'],'--import','tsx','--input-type=module','-e',code],timeout=90,log=backup/'distribution-stop.private.log')
                require(b'planned-distribution-stop-ok' in output,'PLANNED_DISTRIBUTION_STOP_NOT_CONFIRMED_CONSUMER_PRESERVED')
                progress['supplierStoppedBeforeConsumer']=True;progress['supplierStoppedAtUTC']=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z');save(progress)
            progress['phase']='stop_requested';progress['oldContainer']=worker_states[0]['id'];save(progress)
            stage='partitioned_upgrade.graceful_stop';run(['docker','kill','--signal','SIGTERM',worker_states[0]['id']])
        if progress['phase']=='stop_requested':
            deadline=time.time()+90
            while time.time()<deadline and any(c['running'] for c in states('worker')):time.sleep(1)
            require(not any(c['running'] for c in states('worker')),'UPGRADE_GRACEFUL_STOP_PENDING_NO_MORE_SIGNALS');progress['phase']='stopped';save(progress)
        stage='partitioned_upgrade.persistence'
        api=states('api');require(len(api)==1 and api[0]['health']=='healthy','API_NOT_HEALTHY');api_info=json.loads(run(['docker','inspect',api[0]['id']]))[0]
        mounts=[m for m in api_info['Mounts'] if m['Destination']=='/app/.runtime/feed'];require(len(mounts)==1 and mounts[0]['Type']=='volume' and not mounts[0]['RW'],'FEED_VOLUME_UNVERIFIED')
        vol=json.loads(run(['docker','volume','inspect',mounts[0]['Name']]))[0];require((vol.get('Labels') or {}).get('com.docker.compose.project')=='adl-homologation','VOLUME_PROJECT_UNVERIFIED');directory=Path(vol['Mountpoint'])
        require(not (directory/'trade-feed.json.lock').exists() and not list(directory.glob('trade-feed.json*.reclaim')) and not list(directory.glob('trade-feed.json.snapshot-*.lock')),'UPGRADE_LOCK_PRESENT_PRESERVED')
        if progress['phase']=='stopped':
            for source in [directory/'trade-feed.json',directory/'trade-feed.json.regular-checkpoint.json',*directory.glob('trade-feed.json.snapshot-*.json')]:
                if not source.exists():continue
                require(source.is_file() and not source.is_symlink(),'PERSISTENCE_SOURCE_UNVERIFIED');target=backup/source.name
                if not target.exists():
                    shutil.copyfile(source,target);os.chmod(target,0o600)
                    with target.open('rb') as copied:os.fsync(copied.fileno())
                require(snapshot_file_hash(source)==snapshot_file_hash(target),'UPGRADE_BACKUP_HASH_MISMATCH')
            if not (backup/'migration.before.json').exists():private(backup/'migration.before.json',migration_receipt.read_bytes())
            require(snapshot_host_memory()>=6*1024**3,'HOST_HEADROOM_CHANGED_DURING_UPGRADE')
            overlay=SECURE/('compose.partitioned-'+digest[:24]+'.json');content=json.dumps({'services':{'worker':{'image':progress['image'],'environment':{'LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT':'true'}}}}).encode()
            if overlay.exists():require(overlay.read_bytes()==content,'UPGRADE_OVERLAY_CHANGED')
            else:private(overlay,content)
            candidate=partition_base(meta) if str(overlay) in meta.get('composeOverrides',[]) else partition_base(meta)+['-f',str(overlay)]
            require(model(candidate)==expected,'UPGRADE_MODEL_CHANGE_OUTSIDE_WORKER_PATCH')
            if str(overlay) not in meta.get('composeOverrides',[]):
                meta['composeOverrides']=[*meta.get('composeOverrides',[]),str(overlay)];temporary=SECURE/(receipt_path.name+'.deployment.tmp');private(temporary,json.dumps(meta).encode());durable_replace(temporary,SECURE/'deployment.json')
            progress['phase']='configured';save(progress)
        if progress['phase']=='configured':
            stage='partitioned_upgrade.start';require(not any(c['running'] for c in states('worker')),'CONSUMER_ALREADY_PRESENT')
            started=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z');progress['startAt']=started
            migration.setdefault('partitionedUpgrades',[]).append({'digest':digest,'previousStartRequestedAtUTC':migration['startRequestedAtUTC'],'backup':str(backup)});migration['startRequestedAtUTC']=started
            temporary=SECURE/(receipt_path.name+'.migration.tmp');private(temporary,json.dumps(migration).encode());durable_replace(temporary,migration_receipt)
            progress['phase']='start_requested';save(progress)
            run(partition_base(json.loads((SECURE/'deployment.json').read_bytes()))+['--profile','feed-consumer','up','-d','--force-recreate','--no-deps','--no-build','--pull','never','worker'],timeout=90,log=backup/'start.private.log')
        emit(operation='cutover.aws',stage='partitioned_upgrade.started',status='ok',workerStarted=True,startedAtUTC=progress.get('startAt'),image=progress['image'],migrationRepeated=False,composeOverridesPreserved=True,journalsRewrittenByUpgrade=False,journalsImported=False,posnetChanged=False,backup=str(backup));return 0
    except Exception as error:
        reason=str(error) if re.fullmatch('[A-Z][A-Z_]+',str(error)) else 'PRIVATE_PARTITIONED_UPGRADE_FAILED'
        emit(operation='cutover.aws',stage=stage,status='blocked',reason=reason,backup=str(backup) if backup else None,posnetChanged=False,rawExceptionPrinted=False);return 2
