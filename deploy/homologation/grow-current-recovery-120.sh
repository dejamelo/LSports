#!/usr/bin/env bash
# Run only over SSH on the ADL Ubuntu host. No worker or Docker mutations.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo ROOT_REQUIRED; exit 2; }
for tool in curl python3 findmnt lsblk blockdev growpart resize2fs; do command -v "$tool" >/dev/null || { echo "MISSING_TOOL:$tool"; exit 2; }; done
ADL_MODE="${1:-grow}"
export ADL_MODE
ADL_BACKUP=/var/backups/adl-partitioned-upgrade-_o9ovt74
[ -d "$ADL_BACKUP" ] && [ ! -L "$ADL_BACKUP" ] || { echo BACKUP_UNVERIFIED; exit 2; }
ADL_SOURCE="$(findmnt -n -o SOURCE -T "$ADL_BACKUP")"
ADL_SOURCE="$(readlink -f "$ADL_SOURCE")"
[ "$ADL_SOURCE" = /dev/nvme0n1p1 ] || { echo "UNEXPECTED_FILESYSTEM_SOURCE:$ADL_SOURCE"; exit 2; }
[ "$(findmnt -n -o FSTYPE -T "$ADL_BACKUP")" = ext4 ] || { echo EXT4_REQUIRED; exit 2; }
[ "$(cat /sys/class/block/nvme0n1p1/partition)" = 1 ] || { echo PARTITION_ID_UNVERIFIED; exit 2; }
ADL_TOKEN="$(curl -fsS --connect-timeout 2 --max-time 5 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)"
ADL_IDENTITY="$(curl -fsS --connect-timeout 2 --max-time 5 -H "X-aws-ec2-metadata-token: $ADL_TOKEN" http://169.254.169.254/latest/dynamic/instance-identity/document)"
unset ADL_TOKEN
ADL_SERIAL="$(tr -d '[:space:]' < /sys/class/block/nvme0n1/device/serial)"
ADL_DEVICE_BYTES="$(blockdev --getsize64 /dev/nvme0n1)"
export ADL_IDENTITY ADL_SERIAL ADL_DEVICE_BYTES
python3 - <<'PY'
import json,os,re,stat,sys,subprocess,hashlib
from pathlib import Path
identity=json.loads(os.environ['ADL_IDENTITY']);serial=os.environ['ADL_SERIAL']
volume=serial if serial.startswith('vol-') else 'vol-'+serial[3:] if serial.startswith('vol') else ''
if identity.get('region')!='us-east-2' or identity.get('privateIp')!='172.31.41.208' or not re.fullmatch(r'i-[0-9a-f]{8,17}',identity.get('instanceId','')) or not re.fullmatch(r'vol-[0-9a-f]{8,17}',volume):sys.exit('INSTANCE_OR_EBS_IDENTITY_UNVERIFIED_NO_RESIZE')
if identity['instanceId']!='i-04690a17692088df9' or volume!='vol-03fa30ff2fc37a28e':sys.exit('EXPECTED_INSTANCE_OR_VOLUME_MISMATCH_NO_RESIZE')
pin={'instanceId':identity['instanceId'],'region':identity['region'],'privateIp':identity['privateIp'],'volumeId':volume,'device':'/dev/nvme0n1','partition':'/dev/nvme0n1p1'}
p=Path('/etc/adl-homologation/recovery-root-ebs-identity.json')
if p.is_symlink():sys.exit('EBS_IDENTITY_RECEIPT_SYMLINK')
if p.exists():
 st=p.stat()
 if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_mode&0o077 or json.loads(p.read_text())!=pin:sys.exit('EBS_IDENTITY_CHANGED_NO_RESIZE')
else:
 fd=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
 with os.fdopen(fd,'w') as f:json.dump(pin,f);f.flush();os.fsync(f.fileno())
backup=Path('/var/backups/adl-partitioned-upgrade-_o9ovt74')
receipt=Path('/etc/adl-homologation/partitioned-upgrade-27ea2d94d26bcc19d82ebf4b.json')
for protected in (backup,receipt):
 st=protected.lstat()
 if protected.is_symlink() or st.st_uid!=0 or st.st_mode&0o077:sys.exit('RECOVERY_PATH_PROTECTION_UNVERIFIED')
r=json.loads(receipt.read_bytes())
if r.get('backup')!=str(backup) or r.get('image')!='adl-worker-partitioned:27ea2d94d26bcc19d82ebf4b' or r.get('preExitProof',{}).get('verified') is not True or r.get('verifiedExitContainerId')!=r.get('oldContainer'):sys.exit('COMPLETED_RECOVERY_RECEIPT_UNVERIFIED')
image=json.loads(subprocess.check_output(['docker','image','inspect',r['image']]))[0]
if (image['Config'].get('Labels') or {}).get('eu.adl.partitioned.patch')!=r.get('digest'):sys.exit('PREPARED_IMAGE_IDENTITY_UNVERIFIED')
old=json.loads(subprocess.check_output(['docker','inspect','adl-homologation-worker-1']))[0]
if old['Id']!=r['oldContainer']:sys.exit('CURRENT_WORKER_DIFFERS_FROM_COMPLETED_RECEIPT')
print(json.dumps({'stage':'current_worker_verified','containerId':old['Id'],'running':old['State']['Running'],'oomKilled':old['State']['OOMKilled'],'exitCode':old['State']['ExitCode'],'finishedAtUTC':old['State']['FinishedAt'],'preparedImageId':image['Id'],'preExitRecoveryVerified':True}),flush=True)
if old['State']['Running']:sys.exit('OLD_CONTAINER_STILL_RUNNING_NO_GROWTH_OR_RESTART')
plans=[]
for p in backup.glob('offline-rehearsal-disk-plan*.json'):
 st=p.lstat()
 if p.is_symlink() or not p.is_file() or st.st_uid!=0 or st.st_mode&0o077 or st.st_size>1048576:continue
 v=json.loads(p.read_bytes())
 if v.get('destination')!=str(backup) or v.get('requiredFreeBytes')!=45828354109:continue
 expected=v['copyMissingBytes']+max(v['inputBytes']*8,v['failedOutputBytes']*2)+v['safetyAndActivationReserveBytes']
 if v['outputReserveBytes']!=max(v['inputBytes']*8,v['failedOutputBytes']*2) or expected!=v['requiredFreeBytes'] or v['safetyAndActivationReserveBytes']!=4*1024**3:sys.exit('SAVED_DISK_PLAN_FORMULA_MISMATCH')
 plans.append(str(p));print(json.dumps({'stage':'saved_disk_plan_verified','reportFile':str(p),'inputBytes':v['inputBytes'],'copyMissingBytes':v['copyMissingBytes'],'outputReserveBytes':v['outputReserveBytes'],'safetyAndActivationReserveBytes':v['safetyAndActivationReserveBytes'],'requiredFreeBytes':expected,'basis':v.get('budgetBasis')}),flush=True)
if not plans:sys.exit('MATCHING_SAVED_DISK_PLAN_NOT_FOUND_NO_GROWTH')
print(json.dumps({**pin,'deviceBytes':int(os.environ['ADL_DEVICE_BYTES']),'requiredEbsGiB':120}),flush=True)
if os.environ.get('ADL_MODE')=='inspect':sys.exit(0)
if int(os.environ['ADL_DEVICE_BYTES'])<120*1024**3:sys.exit('CONSOLE_EBS_EXPANSION_TO_120_GIB_REQUIRED_NO_RESIZE')
PY
unset ADL_IDENTITY ADL_SERIAL ADL_DEVICE_BYTES
[ "$ADL_MODE" != inspect ] || exit 0
ADL_GROW_LOG="$(mktemp /tmp/adl-growpart.XXXXXX)"
chmod 600 "$ADL_GROW_LOG"
if ! growpart /dev/nvme0n1 1 >"$ADL_GROW_LOG" 2>&1; then
  if ! grep -q '^NOCHANGE:' "$ADL_GROW_LOG"; then cat "$ADL_GROW_LOG"; exit 2; fi
fi
cat "$ADL_GROW_LOG"
resize2fs /dev/nvme0n1p1
python3 - <<'PY'
import json,shutil,sys
from pathlib import Path
backup=Path('/var/backups/adl-partitioned-upgrade-_o9ovt74')
plans=[]
for p in backup.glob('offline-rehearsal-disk-plan*.json'):
 if not p.is_file() or p.is_symlink() or p.stat().st_size>1048576:continue
 st=p.stat()
 if st.st_uid!=0 or st.st_mode&0o077:sys.exit('DISK_PLAN_PERMISSIONS_UNVERIFIED')
 value=json.loads(p.read_text())
 if value.get('destination')==str(backup) and type(value.get('requiredFreeBytes')) is int and value['requiredFreeBytes']>0:plans.append((st.st_mtime_ns,value['requiredFreeBytes']))
if not plans:sys.exit('DISK_PLAN_MISSING_NO_REHEARSAL')
required=max(45828354109,max(plans)[1]);usage=shutil.disk_usage(backup)
print(json.dumps({'stage':'filesystem_expanded','filesystemTotalBytes':usage.total,'availableFreeBytes':usage.free,'requiredFreeBytes':required,'marginBytes':usage.free-required}))
if usage.free<required:sys.exit('SPACE_STILL_INSUFFICIENT_NO_REHEARSAL')
PY
