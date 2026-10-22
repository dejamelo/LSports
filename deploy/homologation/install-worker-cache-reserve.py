def install_cache_reserve():
    require(os.geteuid()==0,'ROOT_REQUIRED');require(snapshot_host_memory()>=8*1024**3,'POSNET_HOST_RESERVE_BELOW_EIGHT_GIB')
    unit=Path('/etc/systemd/system/adl-worker-cache-reserve.service');script=SECURE/'worker-cache-reserve.py'
    content=('[Unit]\nDescription=ADL bounded clean-cache reserve, no worker restart\nAfter=docker.service\nRequires=docker.service\n[Service]\nType=simple\nExecStart=/usr/bin/python3 /etc/adl-homologation/worker-cache-reserve.py\nRestart=no\nUMask=0077\nMemoryMax=128M\nCPUQuota=5%\nNice=10\nNoNewPrivileges=yes\nProtectSystem=strict\nReadWritePaths=/sys/fs/cgroup\n[Install]\nWantedBy=multi-user.target\n').encode()
    expected=[(script,CACHE_RESERVE_SOURCE.encode()),(unit,content)]
    for path,data in expected:
        require(not path.is_symlink() and (not path.exists() or path.is_file() and path.stat().st_uid==0 and path.read_bytes()==data),'EXISTING_CACHE_POLICY_DIFFERS_PRESERVED')
    backup=Path(tempfile.mkdtemp(prefix='adl-cache-reserve-',dir=BACKUPS));os.chmod(backup,0o700)
    private(backup/'installation.json',json.dumps({'unit':str(unit),'script':str(script),'unitExisted':unit.exists(),'scriptExisted':script.exists(),'policySha256':hashlib.sha256(CACHE_RESERVE_SOURCE.encode()).hexdigest(),'rollback':'systemctl disable --now adl-worker-cache-reserve.service','workerRestarted':False}).encode())
    for path,data in expected:
        if not path.exists():private(path,data)
    run(['systemd-analyze','verify',str(unit)],timeout=20,log=backup/'unit-verify.private.log')
    policy_hash=hashlib.sha256(CACHE_RESERVE_SOURCE.encode()).hexdigest()
    verified_before=False
    for receipt in list(BACKUPS.glob('adl-cache-reserve-*/verified.json'))[:128]:
        if receipt.is_symlink() or not receipt.is_file() or receipt.stat().st_uid!=0 or receipt.stat().st_mode&0o077:continue
        try:proof=json.loads(receipt.read_bytes())
        except (ValueError,OSError):continue
        if proof.get('policySha256')==policy_hash and proof.get('limitBytes')==6442450944 and proof.get('kernelReclaimVerified') is True:verified_before=True
    for index in range(6):
        log=backup/('reclaim-'+str(index)+'.private.log')
        try:result=run(['python3',str(script),'--once'],timeout=30,log=log)
        except subprocess.CalledProcessError:
            for line in read_tail(log).decode(errors='replace').splitlines():
                try:r=json.loads(line)
                except ValueError:continue
                if r.get('status')=='blocked' and re.fullmatch('[A-Z_0-9]{3,120}',str(r.get('reason'))):raise RuntimeError(r['reason']) from None
            raise
        rows=[json.loads(line) for line in result.decode().splitlines() if line.startswith('{')];emit(operation='pipeline.recovery',stage='cache_kernel_reclaim_probe',rows=rows,backup=str(backup),workerRestarted=False)
        if verified_before and rows and all(r.get('status') in ('worker_absent_no_action','worker_stopped_no_action') for r in rows):
            emit(operation='pipeline.recovery',stage='cache_policy_proof_reused_for_stopped_worker',status='verified',workerRestarted=False);break
        if any(r.get('actualHeadroomBytes',0)>=1408*1024**2 or r.get('status')=='headroom_sufficient_or_no_clean_cache_no_action' and 6442450944-r.get('beforeCurrentBytes',6442450944)>=1408*1024**2 for r in rows):break
        time.sleep(5)
    else:raise RuntimeError('ACTUAL_KERNEL_RECLAIM_HEADROOM_NOT_VERIFIED_NO_DEPLOYMENT')
    run(['systemctl','daemon-reload']);run(['systemctl','enable','--now',unit.name]);require(run(['systemctl','is-active',unit.name]).strip()==b'active','CACHE_RESERVE_POLICY_NOT_ACTIVE')
    private(backup/'verified.json',json.dumps({'policySha256':policy_hash,'limitBytes':6442450944,'kernelReclaimVerified':True}).encode())
    emit(operation='pipeline.recovery',stage='cache_policy_installed',status='verified',backup=str(backup),limitBytes=6442450944,guardUnchanged=True,workerRestarted=False,posnetChanged=False)
try:install_cache_reserve()
except Exception as error:
    emit(operation='pipeline.recovery',stage='cache_policy',status='blocked',reason=str(error) if re.fullmatch('[A-Z_0-9]{3,120}',str(error)) else 'CACHE_POLICY_INSTALL_FAILED',diagnostic=recovery_exception_details(error),workerRestarted=False)
    raise SystemExit(2)
