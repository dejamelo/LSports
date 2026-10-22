"""Read-only interruption audit: no replay, SQLite query, signals or consumer start."""
import os,json,re,time,subprocess
from pathlib import Path

def classify(argv):
 if not argv:return None
 exe=Path(argv[0]).name;joined=' '.join(argv[1:])
 if exe in ('python3','python') and 'REMOTE_HELPER_ENVELOPE_REJECTED' in joined:return 'adl_helper_bootstrap_scope_unverified'
 if exe in ('node','nodejs','docker') and 'pendingCheckpointRows' in joined and 'baselineHighId' in joined:return 'recovery_pressure_sql_probe' if exe!='docker' else 'recovery_pressure_exec_wrapper'
 return None

def main():
 result={'operation':'interrupted_collector_audit','readOnly':True,'workerRestarted':False,'signalsSent':0,'providerRequests':0,'historicalStage':'not_recorded_by_old_collector','expectedWorkerId':'e825bef701135b9a10715d3a4e9bf74d224c739f562837b92d8cd96631c62d3f'}
 proc=subprocess.run(['docker','inspect','/adl-homologation-worker-1'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=15,check=False)
 if proc.returncode:raise RuntimeError('WORKER_INSPECT_UNAVAILABLE_NO_ACTION')
 c=json.loads(proc.stdout)[0];state=c['State'];result['worker']={'id':c['Id'],'imageId':c['Image'],'running':state['Running'],'state':state['Status'],'oomKilled':state['OOMKilled'],'exitCode':state['ExitCode'],'startedAtUTC':state['StartedAt'],'finishedAtUTC':state['FinishedAt'],'matchesPreviousId':c['Id']==result['expectedWorkerId']}
 processes=[];candidates={}
 for folder in Path('/proc').iterdir():
  if not folder.name.isdigit() or int(folder.name)==os.getpid():continue
  try:
   argv=(folder/'cmdline').read_bytes().decode(errors='replace').split('\0');kind=classify(argv)
   if not kind:continue
   status=(folder/'status').read_text();ppid=int(re.search(r'^PPid:\s*(\d+)',status,re.M)[1]);state_text=re.search(r'^State:\s*([A-Z])',status,re.M)[1]
   row={'pid':int(folder.name),'parentPid':ppid,'kind':kind,'state':state_text,'processStartTicks':int((folder/'stat').read_text().rsplit(')',1)[1].split()[19])}
   candidates[row['pid']]=row;processes.append(row)
  except (FileNotFoundError,ProcessLookupError):continue
 for row in processes:
  if row['kind']!='adl_helper_bootstrap_scope_unverified':continue
  children=[]
  for folder in Path('/proc').iterdir():
   if not folder.name.isdigit():continue
   try:
    status=(folder/'status').read_text();parent=int(re.search(r'^PPid:\s*(\d+)',status,re.M)[1])
    if parent!=row['pid']:continue
    argv=(folder/'cmdline').read_bytes().decode(errors='replace').split('\0');exe=Path(argv[0]).name
    if exe=='docker':
     action=argv[1] if len(argv)>1 and argv[1] in ('inspect','top','logs','exec','ps','volume') else 'other'
     children.append({'pid':int(folder.name),'program':'docker','operation':action})
   except (FileNotFoundError,ProcessLookupError):continue
  row['observedChildren']=children
 result['remainingDiagnosticProcesses']=processes
 result['safeToStartAnotherCollector']=not processes
 result['interpretation']='Active helper/probe found: do not duplicate or signal it; bootstrap identity alone does not prove this is the interrupted collection.' if processes else 'No matching helper/probe observed. Interrupted historical stage cannot be reconstructed without saved local progress; worker status is current.'
 print(json.dumps(result),flush=True)
try:main()
except Exception as error:
 print(json.dumps({'operation':'interrupted_collector_audit','status':'blocked','reason':str(error) if re.fullmatch('[A-Z_]+',str(error)) else 'AUDIT_FAILED','exceptionType':type(error).__name__,'workerRestarted':False,'signalsSent':0}),flush=True)
 raise SystemExit(2)
