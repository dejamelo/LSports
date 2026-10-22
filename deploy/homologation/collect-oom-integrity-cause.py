"""Read-only targeted evidence. Never imports the upgrade main or opens inbox DBs."""
import datetime,errno,json,os,re,stat,traceback
from pathlib import Path
backup=Path('/var/backups/adl-partitioned-upgrade-oqxj48jd')
receipt=Path('/etc/adl-homologation/partitioned-upgrade-184df259e1da7f2d92408106.json')
def protected(path):
 st=path.lstat()
 if path.is_symlink() or not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_mode&0o077 or st.st_size>4*1024**2:raise RuntimeError('PROTECTED_EVIDENCE_IDENTITY_UNVERIFIED')
 return st
def summary(error):
 return {'type':type(error).__name__,'code':errno.errorcode.get(getattr(error,'errno',None)),'stack':[{'file':Path(f.filename).name,'line':f.lineno,'function':f.name} for f in traceback.extract_tb(error.__traceback__)],'rawMessagePrinted':False}
protected(receipt);r=json.loads(receipt.read_bytes())
if r.get('backup')!=str(backup):raise RuntimeError('PREPARATION_BACKUP_MISMATCH')
report={'operation':'oom_integrity_cause_readonly','capturedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'backup':str(backup),'receipt':str(receipt),'phase':r.get('phase'),'verifiedExitContainerId':r.get('verifiedExitContainerId'),'preExitRecoveryVerified':r.get('preExitProof',{}).get('verified'),'oomRestoreVerified':r.get('oomRestoreVerified',False),'workerStarted':False,'providerRequests':0,'reports':[],'privateLogs':[],'historicalExceptionRecovered':False}
for name in ('offline-rehearsal-disk-plan.json','pre-exit-disk-plan.json'):
 p=backup/name
 if not p.exists():report['reports'].append({'file':name,'exists':False});continue
 st=protected(p);entry={'file':name,'exists':True,'mtimeUTC':datetime.datetime.fromtimestamp(st.st_mtime,datetime.timezone.utc).isoformat()}
 entry['oldCodeOperation']='exclusive_create_existing_disk_report'
 entry['predictedOldCodeFailure']={'type':'FileExistsError','code':'EEXIST','evidence':'protected report already exists; exclusive-create failure reproduced locally, not executed remotely'}
 report['reports'].append(entry)
logs=sorted((p for p in backup.glob('*.private.log') if p.is_file() and not p.is_symlink()),key=lambda p:p.stat().st_mtime,reverse=True)[:8]
for p in logs:
 if not re.fullmatch('[A-Za-z0-9_.-]{1,150}',p.name):continue
 st=p.stat()
 if st.st_uid!=0 or st.st_mode&0o077:continue
 with p.open('rb') as f:f.seek(max(0,st.st_size-128*1024));tail=f.read().decode(errors='replace')
 frames=[];types=[];codes=[]
 for line in tail.splitlines():
  frame=re.match(r'\s*File "([^"\n]+)", line (\d+), in ([A-Za-z0-9_<>]+)',line)
  if frame:frames.append({'file':Path(frame[1]).name,'line':int(frame[2]),'function':frame[3]})
  match=re.match(r'(FileExistsError|PermissionError|FileNotFoundError|NameError|TypeError|ValueError|KeyError|OperationalError|DatabaseError|OSError|RuntimeError):',line)
  if match:types.append(match[1])
  code=re.search(r'\[Errno (\d+)\]',line)
  if code:codes.append(errno.errorcode.get(int(code[1]),'UNKNOWN'))
 record={'file':p.name,'mtimeUTC':datetime.datetime.fromtimestamp(st.st_mtime,datetime.timezone.utc).isoformat(),'bytes':st.st_size,'tailOnly':st.st_size>128*1024,'exceptionTypes':types[-4:],'osCodes':codes[-4:],'stack':frames[-12:]}
 if 'FileExistsError' in types and 'offline-rehearsal-disk-plan.json' in tail:record['matchedOperation']='exclusive_create_existing_disk_report';report['historicalExceptionRecovered']=True
 report['privateLogs'].append(record)
if not report['historicalExceptionRecovered']:report['limitation']='Original exception stack not found in inspected log tails; old handler discarded exception text/trace. Reproduced EEXIST is a confirmed local defect, not proof of historical exception.'
print(json.dumps(report))
