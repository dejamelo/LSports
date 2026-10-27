def install_cache_reserve():
    require(os.geteuid()==0,'ROOT_REQUIRED')
    unit=Path('/etc/systemd/system/adl-worker-cache-reserve.service');script=SECURE/'worker-cache-reserve.py'
    content=('[Unit]\nDescription=ADL bounded clean-cache reserve, no worker restart\nAfter=docker.service\nRequires=docker.service\n[Service]\nType=simple\nExecStart=/usr/bin/python3 /etc/adl-homologation/worker-cache-reserve.py\nRestart=no\nUMask=0077\nMemoryMax=128M\nCPUQuota=5%\nNice=10\nNoNewPrivileges=yes\nProtectSystem=strict\nReadWritePaths=/sys/fs/cgroup\n[Install]\nWantedBy=multi-user.target\n').encode()
    expected=[(script,CACHE_RESERVE_SOURCE.encode()),(unit,content)]
    policy_hash=hashlib.sha256(CACHE_RESERVE_SOURCE.encode()).hexdigest()
    expected_verified=False
    for receipt in list(BACKUPS.glob('adl-cache-reserve-*/verified.json'))[:128]:
        if receipt.is_symlink() or not receipt.is_file() or receipt.stat().st_uid!=os.geteuid() or receipt.stat().st_mode&0o077:continue
        try:proof=json.loads(receipt.read_bytes())
        except (ValueError,OSError):continue
        if proof.get('policySha256')==policy_hash and proof.get('kernelReclaimVerifiedLimitBytes',proof.get('limitBytes'))==6442450944 and proof.get('kernelReclaimVerified') is True and proof.get('candidateWorkerLimitBytes')==8192*1024**2:
            expected_verified=True;break
    file_checks=[]
    for path,data in expected:
        st=path.stat() if path.exists() and not path.is_symlink() else None
        file_checks.append({'name':path.name,'regular':st is not None and path.is_file(),'owner':st is not None and st.st_uid==os.geteuid(),'privateMode':st is not None and st.st_mode&0o077==0,'content':st is not None and path.read_bytes()==data})
    files_match=all(all(row[k] for k in ('regular','owner','privateMode','content')) for row in file_checks)
    service_active=run(['systemctl','is-active',unit.name]).strip()==b'active'
    service_enabled=run(['systemctl','is-enabled',unit.name]).strip()==b'enabled'
    if files_match and expected_verified and service_active and service_enabled:
        emit(operation='pipeline.recovery',stage='cache_policy_installed',status='verified',reused=True,policySha256=policy_hash,kernelReclaimVerifiedLimitBytes=6442450944,candidateWorkerLimitBytes=8192*1024**2,guardUnchanged=True,workerRestarted=False,posnetChanged=False)
        return
    emit(operation='pipeline.recovery',stage='cache_policy_reuse_check',status='not_reused',filesMatch=files_match,fileChecks=file_checks,verifiedReceipt=expected_verified,serviceActive=service_active,serviceEnabled=service_enabled,workerRestarted=False)
    # Installing or replacing the host policy happens only with the measured
    # host reserve available. Reusing an exact active, receipt-backed policy
    # performs no writes and does not consume a second copy of that reserve.
    require(snapshot_host_memory()>=10*1024**3,'POSNET_HOST_RESERVE_BELOW_TEN_GIB')
    previous_script_sha256='79d34858740b082d20fb9ca5399aacf1efcadcfb98368980f860abe0314733c8'
    previous_unit_sha256='49b21d859f0634f0291e878fe259a8a0426ee34c7baf02ca6abe8e6284f2d89d'
    previous={};changed=False
    for path,data in expected:
        require(not path.is_symlink() and (not path.exists() or path.is_file() and path.stat().st_uid==0),'EXISTING_CACHE_POLICY_DIFFERS_PRESERVED')
        old=path.read_bytes() if path.exists() else None
        if old==data:continue
        allowed=(path==script and old is not None and hashlib.sha256(old).hexdigest()==previous_script_sha256) or (path==unit and old is not None and hashlib.sha256(old).hexdigest()==previous_unit_sha256) or old is None
        require(allowed,'EXISTING_CACHE_POLICY_DIFFERS_PRESERVED')
        previous[path]=old;changed=True
    backup=Path(tempfile.mkdtemp(prefix='adl-cache-reserve-',dir=BACKUPS));os.chmod(backup,0o700)
    private(backup/'installation.json',json.dumps({'unit':str(unit),'script':str(script),'unitExisted':unit.exists(),'scriptExisted':script.exists(),'previousScriptSha256':hashlib.sha256(previous[script]).hexdigest() if script in previous and previous[script] is not None else None,'previousUnitSha256':hashlib.sha256(previous[unit]).hexdigest() if unit in previous and previous[unit] is not None else None,'policySha256':hashlib.sha256(CACHE_RESERVE_SOURCE.encode()).hexdigest(),'rollback':'restore the exact files in this backup and restart only adl-worker-cache-reserve.service','workerRestarted':False}).encode())
    staged_script=backup/'worker-cache-reserve.next.py';staged_unit=backup/'adl-worker-cache-reserve.next.service';private(staged_script,CACHE_RESERVE_SOURCE.encode());private(staged_unit,content)
    run(['systemd-analyze','verify',str(staged_unit)],timeout=20,log=backup/'unit-verify.private.log')
    verified_before=False
    verified_from_limit=None
    for receipt in list(BACKUPS.glob('adl-cache-reserve-*/verified.json'))[:128]:
        if receipt.is_symlink() or not receipt.is_file() or receipt.stat().st_uid!=0 or receipt.stat().st_mode&0o077:continue
        try:proof=json.loads(receipt.read_bytes())
        except (ValueError,OSError):continue
        tested_limit=proof.get('kernelReclaimVerifiedLimitBytes',proof.get('limitBytes'))
        if proof.get('policySha256') in (policy_hash,previous_script_sha256) and tested_limit==6442450944 and proof.get('kernelReclaimVerified') is True:verified_before=True;verified_from_limit=tested_limit
    for index in range(6):
        log=backup/('reclaim-'+str(index)+'.private.log')
        try:result=run(['python3',str(staged_script),'--once'],timeout=30,log=log)
        except subprocess.CalledProcessError:
            for line in read_tail(log).decode(errors='replace').splitlines():
                try:r=json.loads(line)
                except ValueError:continue
                if r.get('status')=='blocked' and re.fullmatch('[A-Z_0-9]{3,120}',str(r.get('reason'))):raise RuntimeError(r['reason']) from None
            raise
        rows=[json.loads(line) for line in result.decode().splitlines() if line.startswith('{')];emit(operation='pipeline.recovery',stage='cache_kernel_reclaim_probe',rows=rows,backup=str(backup),workerRestarted=False)
        if verified_before and rows and all(r.get('status') in ('worker_absent_no_action','worker_stopped_no_action') for r in rows):
            emit(operation='pipeline.recovery',stage='cache_policy_proof_reused_for_stopped_worker',status='verified',previousKernelReclaimLimitBytes=verified_from_limit,newProfileBytes=8192*1024**2,guardUnchanged=True,workerRestarted=False);break
        if any(r.get('actualHeadroomBytes',0)>=1920*1024**2 or r.get('status')=='headroom_sufficient_or_no_clean_cache_no_action' and 6442450944-r.get('beforeCurrentBytes',6442450944)>=1920*1024**2 for r in rows):break
        time.sleep(5)
    else:raise RuntimeError('ACTUAL_KERNEL_RECLAIM_HEADROOM_NOT_VERIFIED_NO_DEPLOYMENT')
    for path,data in expected:
        if path not in previous:continue
        if previous[path] is None:private(path,data)
        else:
            old_copy=backup/(path.name+'.before.private');private(old_copy,previous[path])
            temp=backup/(path.name+'.next.tmp');private(temp,data);durable_replace(temp,path)
    try:
        run(['systemctl','daemon-reload']);run(['systemctl','enable','--now',unit.name]);require(run(['systemctl','is-active',unit.name]).strip()==b'active','CACHE_RESERVE_POLICY_NOT_ACTIVE')
        if changed:run(['systemctl','restart',unit.name]);require(run(['systemctl','is-active',unit.name]).strip()==b'active','CACHE_RESERVE_POLICY_NOT_ACTIVE')
    except Exception:
        for path,old in previous.items():
            if old is None:path.unlink(missing_ok=True)
            else:
                temp=backup/(path.name+'.rollback.tmp');private(temp,old);durable_replace(temp,path)
        run(['systemctl','daemon-reload'])
        if unit.exists():run(['systemctl','restart',unit.name])
        raise RuntimeError('CACHE_POLICY_UPDATE_ROLLED_BACK') from None
    private(backup/'verified.json',json.dumps({'policySha256':policy_hash,'kernelReclaimVerifiedLimitBytes':verified_from_limit or 6442450944,'kernelReclaimVerified':True,'candidateWorkerLimitBytes':8192*1024**2 if verified_from_limit else 6442450944,'eightGiBProfileBoundedByMeasuredPipelineProof':bool(verified_from_limit),'actualHeadroomTargetBytes':1920*1024**2,'maxReclaimBytes':512*1024**2,'swapPolicy':'swappiness=0'}).encode())
    emit(operation='pipeline.recovery',stage='cache_policy_installed',status='verified',backup=str(backup),kernelReclaimVerifiedLimitBytes=verified_from_limit or 6442450944,candidateWorkerLimitBytes=8192*1024**2 if verified_from_limit else 6442450944,guardUnchanged=True,workerRestarted=False,posnetChanged=False)
try:install_cache_reserve()
except Exception as error:
    emit(operation='pipeline.recovery',stage='cache_policy',status='blocked',reason=str(error) if re.fullmatch('[A-Z_0-9]{3,120}',str(error)) else 'CACHE_POLICY_INSTALL_FAILED',diagnostic=recovery_exception_details(error),workerRestarted=False)
    raise SystemExit(2)
