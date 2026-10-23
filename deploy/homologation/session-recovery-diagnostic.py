# Read-only host inspection. No signals, container exec/run, provider calls or data writes.
import json,re,subprocess,datetime

def run(args):
 p=subprocess.run(args,capture_output=True,timeout=25)
 if p.returncode:raise RuntimeError('READ_ONLY_COMMAND_FAILED_'+args[1].upper().replace('-','_'))
 return p.stdout+p.stderr if args[1]=='logs' else p.stdout

def emit(**row):print(json.dumps(row),flush=True)
try:
 info=json.loads(run(['docker','inspect','adl-homologation-worker-1']))[0];state=info['State']
 emit(stage='worker_identity',id=info['Id'],imageId=info['Image'],image=info['Config']['Image'],running=state['Running'],oomKilled=state['OOMKilled'],exitCode=state['ExitCode'],startedAtUTC=state['StartedAt'],finishedAtUTC=state['FinishedAt'],memoryLimitBytes=info['HostConfig']['Memory'])
 raw=run(['docker','logs','--timestamps','--since','30m','--tail','1200',info['Id']])[-2*1024**2:]
 allowed={'file.persist','worker.shutdown','inbox.intake_capacity','inbox.capacity_drain','snapshot.events','snapshot.apply_wait','state.publication_wait','distribution.start','distribution.stop','distribution.status','snapshot.timestamp_recovery','snapshot.timestamp_safe_point'}
 records=[]
 for line in raw.decode(errors='replace').splitlines():
  try:stamp,body=line.split(' ',1);r=json.loads(body)
  except (ValueError,TypeError):continue
  if not isinstance(r,dict):continue
  if r.get('operation') not in allowed and r.get('lane') not in ('prematch','inplay'):continue
  if not re.fullmatch(r'\d{4}-\d\d-\d\dT[0-9:.]+Z',stamp):continue
  safe={'atUTC':stamp}
  for key in ('lane','operation','stage','status','category','reason','retryPolicy','rateLimitSource','publicationStage','sessionId','ingressActorId'):
   v=r.get(key)
   if isinstance(v,str) and re.fullmatch('[a-zA-Z0-9_.-]{1,100}',v):safe[key]=v
  for key in ('bytes','validatedRows','appliedRows','writes','lastDurationMs','captureDurationMs','regularDurationMs','publishDurationMs','waitedMs','publicationElapsedMs','elapsedMs','rows','rssBytes','heapUsedBytes','heapHeadroomBytes'):
   if type(r.get(key)) in (int,float):safe[key]=r[key]
  if isinstance(r.get('ingress'),dict):safe['ingress']={k:r['ingress'][k] for k in ('received','acknowledged','processed','checkpointed','backlog','processingBacklog','oldestProcessingAgeMs','metricWindowStartUTC','metricWindowEndUTC','intakePaused') if k in r['ingress']}
  records.append(safe)
 records.sort(key=lambda r:datetime.datetime.fromisoformat(r['atUTC'].replace('Z','+00:00')))
 for r in records[-100:]:emit(stage='recent_lifecycle',record=r)
 p=run(['docker','top',info['Id'],'-eo','pid,ppid,stat,comm']).decode().splitlines() if state['Running'] else []
 emit(stage='process_tree',rows=[line.split()[:4] for line in p[:33]],argumentsPrinted=False)
 emit(stage='summary',capturedAtUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),readOnly=True,providerRequests=0,signalsSent=0,containersStarted=0,recordsFound=len(records),awaitedJavaScriptPromise='not_exposed_by_installed_telemetry',note='Automatic recovery label is a validator classification; infer no reconnect success from it. No new executor or deployment started.')
except Exception as error:
 emit(stage='inspection',status='blocked',reason=str(error) if re.fullmatch('[A-Z_0-9]{3,100}',str(error)) else 'READ_ONLY_INSPECTION_FAILED',signalsSent=0);raise SystemExit(2)
