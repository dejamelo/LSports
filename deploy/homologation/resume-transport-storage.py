"""Read-only discovery bound to a protected preparation receipt; no provider calls."""
import datetime,json,os,re,shutil,subprocess,sys
from pathlib import Path

def run(args):
 p=subprocess.run(args,capture_output=True,timeout=30)
 if p.returncode:raise RuntimeError('COMMAND_FAILED_'+args[0]+'_'+str(p.returncode))
 return json.loads(p.stdout)
def main():
 expected=json.loads(sys.argv[1]);backup=Path(expected['backup']);secure=Path('/etc/adl-homologation')
 if backup.parent!=Path('/var/backups') or not re.fullmatch('adl-partitioned-upgrade-[A-Za-z0-9_-]+',backup.name):raise RuntimeError('BACKUP_PATH_UNVERIFIED')
 if backup.is_symlink() or not backup.is_dir() or backup.stat().st_uid!=0 or backup.stat().st_mode&0o077:raise RuntimeError('BACKUP_IDENTITY_UNVERIFIED')
 matches=[]
 for p in secure.glob('partitioned-upgrade-*.json'):
  if p.is_symlink() or not p.is_file() or p.stat().st_size>2*1024**2 or p.stat().st_uid!=0 or p.stat().st_mode&0o077:continue
  r=json.loads(p.read_bytes())
  if r.get('backup')==str(backup) and r.get('image')==expected['image']:matches.append((p,r))
 if len(matches)!=1:raise RuntimeError('PREPARATION_RECEIPT_NOT_UNIQUE')
 path,r=matches[0];digest=r.get('digest','')
 if not re.fullmatch('[0-9a-f]{64}',digest) or r['image']!='adl-worker-partitioned:'+digest[:24] or path.name!='partitioned-upgrade-'+digest[:24]+'.json':raise RuntimeError('RECEIPT_DIGEST_UNVERIFIED')
 image=run(['docker','image','inspect',r['image']])[0]
 if (image['Config'].get('Labels') or {}).get('eu.adl.partitioned.patch')!=digest:raise RuntimeError('PREPARED_IMAGE_IDENTITY_UNVERIFIED')
 c=run(['docker','inspect','adl-homologation-worker-1'])[0];state=c['State']
 if c['Id']!=r.get('oldContainer'):raise RuntimeError('ORIGINAL_CONTAINER_CHANGED_NO_ACTION')
 plans=[]
 for p in backup.glob('offline-rehearsal-disk-plan*.json'):
  if p.is_symlink() or not p.is_file() or p.stat().st_size>2*1024**2 or p.stat().st_uid!=0 or p.stat().st_mode&0o077:continue
  row=json.loads(p.read_bytes())
  if row.get('destination')==str(backup):plans.append((p.stat().st_mtime_ns,p,row))
 if not plans:raise RuntimeError('SAVED_DISK_PLAN_MISSING_NO_REHEARSAL')
 _,plan,prior=max(plans,key=lambda item:item[0]) # Latest plan IN the exact validated preparation, never select backup by time.
 required=prior['requiredFreeBytes'];free=shutil.disk_usage(backup).free
 if not isinstance(required,int) or required<=0:raise RuntimeError('DISK_REQUIREMENT_INVALID')
 filesystem=run(['findmnt','--json','--bytes','--target',str(backup),'--output','SOURCE,TARGET,FSTYPE,SIZE,AVAIL'])
 devices=run(['lsblk','--json','--bytes','--output','NAME,SIZE,TYPE,PKNAME,SERIAL,MOUNTPOINTS'])
 proof={k:r[k] for k in ('phase','stopRequestedAtUTC','supplierStoppedAtUTC','verifiedExitContainerId','oomContainerId','preExitRecoveryVerified','forceStopEvidenceVerified','oomRestoreVerified','verifiedExitSignal') if k in r}
 proof['preExitProofVerified']=r.get('preExitProof',{}).get('verified') is True
 proof['verifiedFinalizationMatchesContainer']=r.get('verifiedExitContainerId')==c['Id'] and r.get('preExitProof',{}).get('verified') is True
 proof['exitExplanation']='recorded_post_recovery_finalization' if proof['verifiedFinalizationMatchesContainer'] and r.get('verifiedExitSignal',{}).get('signal')=='SIGKILL' else 'not_proven_by_current_receipt'
 print(json.dumps(dict(stage='storage_resume_preflight',status='verified' if free>=required else 'blocked',reason=None if free>=required else 'OFFLINE_REHEARSAL_DISK_EXPANSION_REQUIRED_NO_START',receipt=str(path),backup=str(backup),image=r['image'],imageId=image['Id'],diskPlan=str(plan),diskPlanAtUTC=datetime.datetime.fromtimestamp(plan.stat().st_mtime,datetime.timezone.utc).isoformat(),freeDiskBytes=free,requiredFreeBytes=required,missingBytes=max(0,required-free),filesystem=filesystem,blockDevices=devices,worker=dict(id=c['Id'],running=state['Running'],exitCode=state['ExitCode'],oomKilled=state['OOMKilled'],finishedAtUTC=state['FinishedAt']),receiptEvidence=proof,exit137IsNotOomProof=True,readOnly=True,signalsSent=0,posnetChanged=False)),flush=True)
 return 0 if free>=required else 2
try:sys.exit(main())
except Exception as e:
 print(json.dumps(dict(stage='storage_resume_preflight',status='blocked',exceptionType=type(e).__name__,reason=str(e) if isinstance(e,RuntimeError) else 'READ_ONLY_PREFLIGHT_FAILED',readOnly=True,signalsSent=0)),flush=True);sys.exit(2)
