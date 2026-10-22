"""Retire only the positively identified suspended local executor; never signal AWS."""
import os,sys,json,subprocess,shlex,hashlib,signal,time
from pathlib import Path
EXPECTED='8b034a3b3efe52a4a9b380673e67aef07105515fb54d34c824801624f53c2b51'
def run(args):
 return subprocess.run(args,capture_output=True,text=True,timeout=10).stdout.strip()
def read_process(pid):
 parts=run(['/bin/ps','-p',str(pid),'-o','pid=,ppid=,uid=,state=,comm=']).split(None,4)
 if len(parts)!=5:return None
 return dict(pid=int(parts[0]),parentPid=int(parts[1]),uid=int(parts[2]),state=parts[3],executable=os.path.basename(parts[4]))
def require(condition,reason):
 if not condition:raise RuntimeError(reason)
def verify(node,ssh,argv,digest,owner):
 require(node and node['pid']==13014 and node['parentPid']==13001 and node['uid']==owner and node['state'].startswith('T') and node['executable']=='node','STOPPED_EXECUTOR_IDENTITY_CHANGED_NO_SIGNAL')
 require(ssh and ssh['pid']==13723 and ssh['parentPid']==13014 and ssh['uid']==owner and ssh['state'].startswith('T') and ssh['executable']=='ssh','STOPPED_SSH_IDENTITY_CHANGED_NO_SIGNAL')
 require(len(argv)>1 and os.path.isabs(argv[1]) and Path(argv[1]).name=='complete-adl-cutover.mjs' and digest==EXPECTED,'EXECUTOR_ENTRY_HASH_UNVERIFIED_NO_SIGNAL')
def main():
 listeners=run(['/usr/sbin/lsof','-nP','-t','-iTCP:43761','-sTCP:LISTEN']).split()
 if not listeners:print(json.dumps({'operation':'local_executor_retirement','status':'already_absent','signalsSent':0}),flush=True);return
 require(listeners==['13014'],'LOCAL_LISTENER_CHANGED_NO_SIGNAL')
 node,ssh=read_process(13014),read_process(13723)
 argv=shlex.split(run(['/bin/ps','-p','13014','-ww','-o','args=']))
 p=Path(argv[1]) if len(argv)>1 else Path('/nonexistent')
 require(p.is_absolute() and p.is_file() and not p.is_symlink() and p.stat().st_size<=524288,'EXECUTOR_ENTRY_UNVERIFIED_NO_SIGNAL')
 digest=hashlib.sha256(p.read_bytes()).hexdigest();verify(node,ssh,argv,digest,os.getuid())
 require('--pid' in argv and '--parent' in argv,'EXECUTOR_ARGUMENTS_UNVERIFIED_NO_SIGNAL')
 require(argv[argv.index('--pid')+1]=='12811' and argv[argv.index('--parent')+1]=='12809','EXECUTOR_OWNER_CHANGED_NO_SIGNAL')
 # Both are still stopped. Queue termination on BOTH before waking either;
 # SIGCONT releases pending SIGTERM, not permission to resume the old operation.
 require(read_process(13014)==node and read_process(13723)==ssh,'PROCESS_CHANGED_BEFORE_SIGNAL')
 os.kill(13014,signal.SIGTERM);os.kill(13723,signal.SIGTERM)
 for pid in (13723,13014):
  try:os.kill(pid,signal.SIGCONT)
  except ProcessLookupError:pass
 def exited(pid):
  row=read_process(pid);return row is None or row['state'].startswith('Z')
 deadline=time.monotonic()+10
 while time.monotonic()<deadline:
  if exited(13014) and exited(13723):break
  time.sleep(.2)
 require(exited(13014) and exited(13723),'LOCAL_TERMINATION_PENDING_NO_MORE_SIGNALS')
 require(not run(['/usr/sbin/lsof','-nP','-t','-iTCP:43761','-sTCP:LISTEN']),'LOCAL_PORT_STILL_OCCUPIED_NO_RESUME')
 print(json.dumps({'operation':'local_executor_retirement','status':'verified','nodePid':13014,'sshPid':13723,'signals':['SIGTERM queued before SIGCONT'],'remoteSignalsSent':0,'workerRestarted':False}),flush=True)
if __name__=='__main__':
 try:main()
 except Exception as error:
  print(json.dumps({'operation':'local_executor_retirement','status':'blocked','reason':str(error) if isinstance(error,RuntimeError) else 'LOCAL_RETIREMENT_FAILED','exceptionType':type(error).__name__}),flush=True);raise SystemExit(2)
