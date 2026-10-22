#!/usr/bin/env bash
# Run only over SSH on the ADL Ubuntu host. No worker or Docker mutations.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo ROOT_REQUIRED; exit 2; }
for tool in curl python3 findmnt lsblk blockdev growpart resize2fs; do command -v "$tool" >/dev/null || { echo "MISSING_TOOL:$tool"; exit 2; }; done
ADL_MODE="${1:-grow}"
export ADL_MODE
ADL_BACKUP=/var/backups/adl-partitioned-upgrade-oqxj48jd
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
import json,os,re,stat,sys
from pathlib import Path
identity=json.loads(os.environ['ADL_IDENTITY']);serial=os.environ['ADL_SERIAL']
volume=serial if serial.startswith('vol-') else 'vol-'+serial[3:] if serial.startswith('vol') else ''
if identity.get('region')!='us-east-2' or identity.get('privateIp')!='172.31.41.208' or not re.fullmatch(r'i-[0-9a-f]{8,17}',identity.get('instanceId','')) or not re.fullmatch(r'vol-[0-9a-f]{8,17}',volume):sys.exit('INSTANCE_OR_EBS_IDENTITY_UNVERIFIED_NO_RESIZE')
pin={'instanceId':identity['instanceId'],'region':identity['region'],'privateIp':identity['privateIp'],'volumeId':volume,'device':'/dev/nvme0n1','partition':'/dev/nvme0n1p1'}
p=Path('/etc/adl-homologation/recovery-root-ebs-identity.json')
if p.is_symlink():sys.exit('EBS_IDENTITY_RECEIPT_SYMLINK')
if p.exists():
 st=p.stat()
 if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_mode&0o077 or json.loads(p.read_text())!=pin:sys.exit('EBS_IDENTITY_CHANGED_NO_RESIZE')
else:
 fd=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
 with os.fdopen(fd,'w') as f:json.dump(pin,f);f.flush();os.fsync(f.fileno())
print(json.dumps({**pin,'deviceBytes':int(os.environ['ADL_DEVICE_BYTES']),'requiredEbsGiB':64}),flush=True)
if os.environ.get('ADL_MODE')=='inspect':sys.exit(0)
if int(os.environ['ADL_DEVICE_BYTES'])<64*1024**3:sys.exit('CONSOLE_EBS_EXPANSION_TO_64_GIB_REQUIRED_NO_RESIZE')
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
backup=Path('/var/backups/adl-partitioned-upgrade-oqxj48jd')
plan=backup/'offline-rehearsal-disk-plan.json'
if not plan.is_file() or plan.is_symlink():sys.exit('DISK_PLAN_MISSING_NO_REHEARSAL')
required=int(json.loads(plan.read_text())['requiredFreeBytes']);usage=shutil.disk_usage(backup)
print(json.dumps({'stage':'filesystem_expanded','filesystemTotalBytes':usage.total,'availableFreeBytes':usage.free,'requiredFreeBytes':required,'marginBytes':usage.free-required}))
if usage.free<required:sys.exit('SPACE_STILL_INSUFFICIENT_NO_REHEARSAL')
PY
