"""Observe an already scheduled snapshot; never restart or query the supplier."""
import sys,json,subprocess,tempfile,os,re
from pathlib import Path

def main():
 backup=None
 def emit(**v):print(json.dumps({'operation':'snapshot.markets_report',**v}),flush=True)
 try:
  assert os.geteuid()==0
  request=json.load(sys.stdin);code=request['code'];assert isinstance(code,str) and len(code)<30000
  def run(args):return subprocess.check_output(args,timeout=20,stderr=subprocess.DEVNULL)
  ids=run(['docker','ps','-q','--filter','label=com.docker.compose.project=adl-homologation','--filter','label=com.docker.compose.service=worker']).decode().split()
  if len(ids)!=1:raise ValueError('SINGLE_RUNNING_WORKER_REQUIRED')
  info=json.loads(run(['docker','inspect',ids[0]]))[0]
  if not info['State']['Running']:raise ValueError('WORKER_NOT_RUNNING')
  mounts=[m for m in info['Mounts'] if m.get('Destination')=='/app/.runtime/feed' and m.get('Type')=='volume']
  if len(mounts)!=1:raise ValueError('FEED_VOLUME_UNVERIFIED')
  volume=mounts[0]['Name'];vi=json.loads(run(['docker','volume','inspect',volume]))[0]
  if (vi.get('Labels') or {}).get('com.docker.compose.project')!='adl-homologation':raise ValueError('VOLUME_PROJECT_UNVERIFIED')
  image=info['Image']
  if not re.fullmatch('sha256:[0-9a-f]{64}',image):raise ValueError('IMAGE_ID_UNVERIFIED')
  backup=Path(tempfile.mkdtemp(prefix='adl-snapshot-shape-',dir='/var/backups'));os.chmod(backup,0o700)
  emit(status='ready',backup=str(backup),workerImageId=image,feedMountReadOnly=True,network='none',providerRequests=0,workerRestarted=False,posnetChanged=False)
  with (backup/'capture.private.log').open('xb') as err:
   os.chmod(backup/'capture.private.log',0o600)
   proc=subprocess.Popen(['docker','run','--rm','-i','--network','none','--memory','384m','--cpus','0.5','--read-only','--tmpfs','/tmp:size=33554432,mode=1777','--user','0','--mount',f'type=volume,source={volume},target=/app/.runtime/feed,readonly','--mount',f'type=bind,source={backup},target=/evidence','--entrypoint','node',image,'--import','tsx','--input-type=module'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err,text=True)
   proc.stdin.write(code);proc.stdin.close()
   for line in proc.stdout:
    try:row=json.loads(line)
    except ValueError:continue
    if row.get('operation')=='snapshot.markets_evidence':print(json.dumps(row),flush=True)
   code=proc.wait(timeout=30)
  emit(status='collected' if code==0 else 'blocked',exitCode=code,backup=str(backup),providerRequests=0,workerRestarted=False,posnetChanged=False,macWorkerStarted=False)
  return code
 except Exception as error:
  reason=str(error) if re.fullmatch('[A-Z_]+',str(error)) else 'PRIVATE_CAPTURE_FAILED_NO_RAW_ERROR'
  emit(status='blocked',reason=reason,backup=str(backup) if backup else None,providerRequests=0,workerRestarted=False,posnetChanged=False);return 2
if __name__=='__main__':sys.exit(main())
