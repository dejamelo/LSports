"""Extract already-written startup evidence from the exact newly installed worker."""
import json,re,subprocess,sys,datetime
EXPECTED='f81f8604812eb46874c81c5807a1cefec0bfda1b63cd1a2ca30f1411739796df'
def run(args):
 p=subprocess.run(args,capture_output=True,timeout=30)
 if p.returncode:raise RuntimeError('READ_COMMAND_FAILED_'+args[1].upper())
 return p.stdout+p.stderr if args[1]=='logs' else p.stdout

def extract(raw):
 rows=[]
 for line in raw.splitlines():
  try:at,body=line.split(' ',1);r=json.loads(body)
  except (ValueError,TypeError):continue
  if not isinstance(r,dict) or not re.fullmatch(r'\d{4}-\d\d-\d\dT[0-9:.]+Z',at):continue
  if r.get('lane')!='prematch' or r.get('operation') not in ('inbox.actor_failure','inbox.actor_lifecycle','worker.start','inbox.processing_progress','inbox.checkpoint','distribution.start','distribution.status','distribution.stop','amqp.connection','amqp.channel','amqp.consume'):continue
  out={'atUTC':at}
  for k in ('operation','lane','status','reason','category','ingressStage','errorType','networkCode','sessionId','ingressActorId'):
   if isinstance(r.get(k),str) and re.fullmatch('[A-Za-z0-9_.-]{1,120}',r[k]):out[k]=r[k]
  for k in ('errorCode','sqliteErrcode','exitCode','rows','waitedMs','httpStatus','amqpCode'):
   v=r.get(k)
   if type(v) is int or isinstance(v,str) and re.fullmatch('[A-Z_0-9]{1,64}',v):out[k]=v
  if type(r.get('closeRequested')) is bool:out['closeRequested']=r['closeRequested']
  if isinstance(r.get('signals'),list):out['signals']=[v for v in r['signals'][:8] if isinstance(v,str) and re.fullmatch('[A-Z_0-9]{1,80}',v)]
  if isinstance(r.get('stackFrames'),list):out['stackFrames']=[{k:f.get(k) for k in ('file','line','column')} for f in r['stackFrames'][:6] if isinstance(f,dict) and f.get('file') in ('durable-ingress.mjs','connected.ts','node:sqlite') and type(f.get('line')) is int]
  if isinstance(r.get('ingress'),dict):out['ingress']={k:r['ingress'][k] for k in ('processed','checkpointed','backlog','metricWindowEndUTC') if k in r['ingress']}
  rows.append(out)
 return rows

def main():
 expected=sys.argv[1] if len(sys.argv)>1 else EXPECTED
 if not re.fullmatch('[0-9a-f]{64}',expected):raise RuntimeError('EXPECTED_CONTAINER_ID_INVALID')
 c=json.loads(run(['docker','inspect','adl-homologation-worker-1']))[0]
 if c['Id']!=expected:raise RuntimeError('CURRENT_CONTAINER_DIFFERS_NO_ACTION')
 raw=run(['docker','logs','--timestamps','--since',c['State']['StartedAt'],'--tail','20000',expected])
 if len(raw)>32*1024**2:raise RuntimeError('LOG_WINDOW_LIMIT_NO_RETRY')
 rows=extract(raw.decode(errors='replace'));terminal=[r for r in rows if r.get('status') in ('error','blocked','failed') or r.get('operation')=='inbox.actor_failure'];failures=[r for r in rows if r.get('operation')=='inbox.actor_failure']
 print(json.dumps(dict(stage='existing_startup_evidence',capturedAtUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),workerId=expected,running=c['State']['Running'],imageId=c['Image'],startedAtUTC=c['State']['StartedAt'],rows=[r for i,r in enumerate(rows) if i>=len(rows)-80 or r.get('operation') in ('inbox.actor_failure','inbox.actor_lifecycle','worker.start','distribution.start','distribution.status','distribution.stop','amqp.connection','amqp.channel','amqp.consume')][-320:],startupFailure=failures[-1] if failures else None,lastTerminalFailure=terminal[-1] if terminal else None,diagnosticCaptureVerified=bool(failures),sanitizedExceptionRecovered=bool(failures),note='Existing logs only. No failure record is not proof of successful startup; an exception may precede actor creation or the bounded window may omit it.',providerRequests=0,signalsSent=0,workerRestarted=False)),flush=True)
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps(dict(stage='existing_startup_evidence',status='blocked',reason=str(e) if isinstance(e,RuntimeError) else 'READ_FAILED',exceptionType=type(e).__name__,signalsSent=0)),flush=True);sys.exit(2)
