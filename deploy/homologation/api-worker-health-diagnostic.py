# Read only; never changes containers, limits, healthchecks, data, or provider state.
import json,re,subprocess,datetime,time,urllib.request,urllib.error,shutil
from pathlib import Path

def api_emit(**row):print(json.dumps(row),flush=True)
def api_run(args,timeout=15):
 p=subprocess.run(args,capture_output=True,timeout=timeout)
 if p.returncode:raise RuntimeError('READ_COMMAND_FAILED_'+args[1].upper().replace('-','_'))
 return p.stdout

def api_classify(running,health,probe,oom):
 if not running:return 'api_exited_oom_confirmed' if oom else 'api_exited_not_oom_proven'
 if probe==200:return 'api_responding_docker_health_not_healthy' if health!='healthy' else 'api_currently_responding_and_healthy'
 if probe==503:return 'control_shell_unavailable_not_feed_health_endpoint'
 if probe in (401,403):return 'control_login_access_rejected'
 return 'api_endpoint_unavailable_or_timeout'

def api_probe():
 begin=time.monotonic();result={'endpoint':'http://127.0.0.1:13001/control'}
 try:
  with urllib.request.urlopen(result['endpoint'],timeout=4) as r:result['status']=r.status
 except urllib.error.HTTPError as e:
  result['status']=e.code
  try:
   body=json.loads(e.read(1024));result['knownCode']=body.get('code') if body.get('code') in ('WEB_BUILD_REQUIRED',) else None
  except Exception:pass
 except Exception as e:result.update(status=None,errorType=type(e).__name__,causeType=type(getattr(e,'reason',e)).__name__,errno=getattr(getattr(e,'reason',e),'errno',None))
 result['elapsedMs']=round((time.monotonic()-begin)*1000);return result

def api_log_signals(raw):
 rows=[]
 for line in raw.decode(errors='replace').splitlines():
  flags=[name for name,pattern in [('timeout',r'timed? out|timeout'),('connection_refused',r'ECONNREFUSED'),('connection_reset',r'ECONNRESET'),('node_heap_exhausted',r'heap out of memory|heap limit|Ineffective mark-compacts'),('permission_denied',r'\bEACCES\b|permission denied'),('missing_file',r'\bENOENT\b'),('file_size_limit',r'ERR_FS_FILE_TOO_LARGE|Invalid string length'),('sqlite_busy',r'SQLITE_BUSY|database is locked'),('json_parse_error',r'SyntaxError|Unexpected token|Unexpected end of JSON'),('memory_allocation_failed',r'\bENOMEM\b') ] if re.search(pattern,line,re.I)]
  frames=[{'file':m[0],'line':int(m[1]),'column':int(m[2])} for m in re.findall(r'/app/((?:apps|packages)/[A-Za-z0-9_./-]+\.(?:mjs|js|ts)):(\d+):(\d+)',line)]
  if flags or frames:
   stamp=re.match(r'^(\d{4}-\d\d-\d\dT[0-9:.]+Z)',line)
   rows.append({'atUTC':stamp[1] if stamp else None,'signals':flags,'stackFrames':frames})
 return rows[-24:]

def inspect_api_worker_health():
 now=datetime.datetime.now(datetime.timezone.utc);since=(now-datetime.timedelta(minutes=90)).isoformat();report={'stage':'api_health_evidence','readOnly':True,'capturedAtUTC':now.isoformat(),'windowSinceUTC':since,'providerRequests':0,'signalsSent':0,'containersStarted':0}
 try:
  c=json.loads(api_run(['docker','inspect','adl-homologation-api-1']))[0];state=c['State'];labels=c['Config'].get('Labels') or {}
  if labels.get('com.docker.compose.project')!='adl-homologation' or labels.get('com.docker.compose.service')!='api':raise RuntimeError('API_IDENTITY_UNVERIFIED')
  health=state.get('Health') or {};test=(c['Config'].get('Healthcheck') or {}).get('Test',[])
  probe=api_probe();internal={'status':None,'available':False}
  if state['Running'] and shutil.which('nsenter') and shutil.which('curl'):
   p=subprocess.run(['nsenter','-t',str(state['Pid']),'-n','curl','-sS','--max-time','4','-o','/dev/null','-w','%{http_code}','http://127.0.0.1:3001/control'],capture_output=True,timeout=6)
   internal={'available':True,'status':int(p.stdout) if re.fullmatch(rb'[1-5][0-9]{2}',p.stdout) else None,'exitCode':p.returncode}
  report.update(id=c['Id'],imageId=c['Image'],running=state['Running'],health=health.get('Status'),restartCount=c['RestartCount'],oomKilled=state['OOMKilled'],exitCode=state['ExitCode'],startedAtUTC=state['StartedAt'],finishedAtUTC=state['FinishedAt'],failingStreak=health.get('FailingStreak'),healthcheckTargetsControl='http://127.0.0.1:3001/control' in str(test),healthcheckTimeoutNs=(c['Config'].get('Healthcheck') or {}).get('Timeout'),endpointProbe=probe,containerNetworkProbe=internal,memoryLimitBytes=c['HostConfig']['Memory'],nanoCpus=c['HostConfig'].get('NanoCpus'),classification=api_classify(state['Running'],health.get('Status'),probe.get('status'),state['OOMKilled']))
  report['healthcheckEndpoints']=sorted(set(re.findall(r'http://127\.0\.0\.1:[0-9]+/(?:control|api/health)',str(test))))
  report['healthHistory']=[{'startUTC':r.get('Start'),'endUTC':r.get('End'),'exitCode':r.get('ExitCode'),'signals':api_log_signals(str(r.get('Output','')).encode())} for r in health.get('Log',[])[-5:]]
  logs=subprocess.run(['docker','logs','--timestamps','--since',since,'--tail','300',c['Id']],capture_output=True,timeout=15);report['apiLogSignals']=api_log_signals((logs.stdout+logs.stderr)[-1024**2:])
  events=api_run(['docker','events','--since',since,'--until',now.isoformat(),'--filter','type=container','--filter','container='+c['Id'],'--format','{{json .}}'],timeout=10);report['containerEvents']=[]
  for line in events.splitlines():
   try:r=json.loads(line)
   except ValueError:continue
   if r.get('Action') in ('oom','die','start','restart','stop','health_status: unhealthy','health_status: healthy'):
    report['containerEvents'].append({'timeUnix':r.get('time'),'action':r['Action'],'exitCode':r.get('Actor',{}).get('Attributes',{}).get('exitCode')})
  report['containerEvents']=report['containerEvents'][-32:];report['dockerEventHistoryMayBeIncomplete']=True
  kernel=subprocess.run(['journalctl','-k','--since','-90min','--output=json','--no-pager'],capture_output=True,timeout=10);report['kernelLogAvailable']=kernel.returncode==0;report['kernelOOM']=[]
  for line in kernel.stdout[-1024**2:].splitlines():
   try:k=json.loads(line);message=str(k.get('MESSAGE',''))
   except ValueError:continue
   if re.search(r'oom-kill|Out of memory|Killed process|Memory cgroup out of memory',message,re.I):
    pid=re.search(r'Killed process (\d+)',message)
    report['kernelOOM'].append({'timeUnixMicroseconds':k.get('__REALTIME_TIMESTAMP'),'matchesApiContainerId':c['Id'][:12] in message,'killedPid':int(pid[1]) if pid else None})
  report['kernelOOM']=report['kernelOOM'][-16:]
  if state['Running']:
   groups=Path('/proc/'+str(state['Pid'])+'/cgroup').read_text();m=re.search(r'^0::(/[^\n]*)$',groups,re.M)
   if m:
    base=(Path('/sys/fs/cgroup')/m[1].lstrip('/')).resolve()
    if Path('/sys/fs/cgroup') in base.parents and c['Id'][:12] in str(base):
     report['apiCgroup']={name:(base/name).read_text().strip() for name in ('memory.current','memory.max','memory.peak','memory.stat','memory.swap.current','memory.events','cpu.stat','cpu.max','io.stat') if (base/name).is_file()}
 except Exception as error:report.update(inspectionErrorType=type(error).__name__,inspectionErrorCode=str(error) if re.fullmatch('[A-Z_0-9]{3,100}',str(error)) else None)
 memory=dict(re.findall(r'^(MemAvailable|MemFree|SwapFree):\s+(\d+)',Path('/proc/meminfo').read_text(),re.M));report['hostMemoryBytes']={k:int(v)*1024 for k,v in memory.items()}
 report['filesystemFreeBytes']=shutil.disk_usage('/var/backups').free
 try:
  stats=api_run(['docker','stats','--no-stream','--format','{{json .}}','adl-homologation-api-1','adl-homologation-worker-1'],timeout=15)
  report['containerResources']=[{k:r[k] for k in ('Name','CPUPerc','MemUsage','MemPerc','PIDs','BlockIO') if k in r} for r in map(json.loads,stats.splitlines())]
 except Exception as error:report['resourceInspectionErrorType']=type(error).__name__
 api_emit(**report)
inspect_api_worker_health()
