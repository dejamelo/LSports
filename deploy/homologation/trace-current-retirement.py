"""Read existing actor/checkpoint/publication evidence once; no polling or feed API."""
import datetime,json,re,subprocess,sys
EXPECTED='0d8d0c7837573feaa10f0bd2a09c299d4f2d69f58fa99e653c5648a94d1ceef7'
IMAGE='sha256:e4ec062c6118a676a67c577b79c3fec0381ad0b7e60f640e3c82c748debc8b41'
OPS={'inbox.checkpoint','inbox.processing_progress','inbox.actor_lifecycle','inbox.actor_failure','distribution.recovery_gate','worker.start','worker.shutdown','snapshot.apply_wait','state.publication_wait','file.persist','snapshot.events','amqp.connection'}
STR={'operation','lane','status','stage','publicationStage','sessionId','ingressActorId','batchId','ingressStage','reason','category','errorType','networkCode','atUTC','lastCompletedAt','metricWindowStartUTC','metricWindowEndUTC'}
NUM={'publicationId','rows','waitedMs','elapsedMs','publicationElapsedMs','writes','lastDurationMs','captureDurationMs','regularDurationMs','publishDurationMs','maxEventLoopDelayMs','heapUsedBytes','heapHeadroomBytes','rssBytes','validatedRows','appliedRows','bytes','errorCode','sqliteErrcode','exitCode','workerEventLoopMaxMs'}
def extract(raw):
 rows=[]
 for line in raw.splitlines():
  try:at,body=line.split(' ',1);r=json.loads(body)
  except (ValueError,TypeError):continue
  if not isinstance(r,dict) or r.get('operation') not in OPS:continue
  if r.get('lane') not in (None,'prematch'):continue
  if not re.fullmatch(r'\d{4}-\d\d-\d\dT[0-9:.]+Z',at):continue
  out={'loggedAtUTC':at}
  for k in STR:
   v=r.get(k)
   if isinstance(v,str) and re.fullmatch(r'[A-Za-z0-9_.:+-]{1,160}',v):out[k]=v
  for k in NUM:
   v=r.get(k)
   if type(v) in (int,float) and abs(v)<2**53:out[k]=v
  if isinstance(r.get('ingress'),dict):out['ingress']={k:v for k,v in r['ingress'].items() if k in ('received','acknowledged','processed','checkpointed','backlog','processingBacklog','oldestProcessingAgeMs','metricWindowStartUTC','metricWindowEndUTC') and type(v) in (int,float,str)}
  if isinstance(r.get('signals'),list):out['signals']=[v for v in r['signals'][:8] if isinstance(v,str) and re.fullmatch('[A-Z_0-9]{1,80}',v)]
  rows.append(out)
 return sorted(rows,key=lambda r:r['loggedAtUTC'])
def correlate(rows):
 actors={}
 for r in rows:
  if r.get('sessionId') and r.get('ingressActorId'):actors.setdefault(r['sessionId'],set()).add(r['ingressActorId'])
 outstanding={};pairs=[];unmatched=[]
 for r in rows:
  if r.get('operation')!='inbox.checkpoint' or r.get('lane')!='prematch':continue
  session=r.get('sessionId');actor=r.get('ingressActorId');known=actors.get(session,set())
  if actor is None and len(known)==1:actor=next(iter(known))
  if not session or not actor:unmatched.append(r);continue
  key=(session,actor)
  if r.get('status')=='waiting_persistence':
   if key in outstanding:unmatched.append(outstanding[key])
   outstanding[key]=r
  if r.get('status')=='reserved_before_capture':
   waiting=outstanding.get(key)
   if waiting and waiting.get('batchId')==r.get('batchId'):
    outstanding[key]={**waiting,'rows':r.get('rows'),'publicationId':r.get('publicationId'),'reservedAtUTC':r['loggedAtUTC']}
   else:unmatched.append(r)
  if r.get('status')=='persisted':
   waiting=outstanding.get(key)
   if waiting and waiting.get('rows')==r.get('rows') and (not waiting.get('batchId') or waiting.get('batchId')==r.get('batchId')):
    pairs.append({'sessionId':session,'ingressActorId':actor,'rows':r['rows'],'batchId':r.get('batchId'),'publicationId':r.get('publicationId'),'requestedAtUTC':waiting['loggedAtUTC'],'persistedAtUTC':r['loggedAtUTC'],'waitedMs':r.get('waitedMs')});del outstanding[key]
   else:unmatched.append(r)
 return {'completedCheckpoints':pairs[-20:],'waitingCheckpoints':list(outstanding.values()),'unmatchedCheckpointEvents':unmatched[-8:],'correlationRule':'One serialized background checkpoint per session/actor; count and ordered request/completion must match. Shared publication completion alone is insufficient.'}
def run(args,timeout=20,input=None):
 r=subprocess.run(args,capture_output=True,text=True,timeout=timeout,input=input)
 if r.returncode:raise RuntimeError('READ_FAILED_'+args[0].upper())
 return r.stdout

def main():
 c=json.loads(run(['docker','inspect','adl-homologation-worker-1']))[0]
 if c['Id']!=EXPECTED or c['Image']!=IMAGE:raise RuntimeError('CURRENT_WORKER_IDENTITY_DIFFERS_NO_ACTION')
 state=c['State'];print(json.dumps({'stage':'identity','containerId':c['Id'],'imageId':c['Image'],'running':state['Running'],'oomKilled':state['OOMKilled'],'exitCode':state['ExitCode'],'startedAtUTC':state['StartedAt'],'finishedAtUTC':state['FinishedAt']}),flush=True)
 r=subprocess.run(['docker','logs','--timestamps','--since',state['StartedAt'],'--tail','8000',c['Id']],capture_output=True,text=True,timeout=25)
 if r.returncode:raise RuntimeError('LOG_READ_FAILED')
 raw=r.stdout+'\n'+r.stderr
 if len(raw)>16*1024**2:raise RuntimeError('LOG_WINDOW_TOO_LARGE_NO_RETRY')
 rows=extract(raw)
 selected={op:[v for v in rows if v['operation']==op][-12:] for op in OPS if op!='file.persist'}
 publications=[v for v in rows if v['operation']=='file.persist']
 selected['completedPublications']=[v for v in publications if v.get('lastCompletedAt')][-8:]
 selected['publicationWaitsOrStages']=[v for v in publications if not v.get('lastCompletedAt')][-12:]
 print(json.dumps({'stage':'existing_checkpoint_trace',**correlate(rows),'events':selected,'logsMayBeTruncated':len(raw.splitlines())>=8000,'providerRequests':0}),flush=True)
 if not state['Running']:
  print(json.dumps({'stage':'durable_count','status':'skipped','reason':'WORKER_NOT_RUNNING_NO_OBSERVATION'}),flush=True);return
 # A bounded, WAL-aware READ ONLY query; no payload decoding, checkpoint or vacuum.
 js="""const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/app/.runtime/feed/trade-feed.json.prematch.inbox.sqlite',{readOnly:true});db.exec('PRAGMA busy_timeout=2000');const r=db.prepare('SELECT COUNT(*) AS pendingRows, MIN(id) AS oldestPendingId, MAX(id) AS latestPendingId, MIN(received) AS oldestReceivedMs FROM inbox').get();db.close();console.log(JSON.stringify({stage:'durable_count',...r,capturedAtUTC:new Date().toISOString(),memoryCurrentBytes:Number(fs.readFileSync('/sys/fs/cgroup/memory.current','utf8')),memoryMaxBytes:Number(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8')),memoryStat:fs.readFileSync('/sys/fs/cgroup/memory.stat','utf8').split('\\n').filter(s=>/^(anon|file|inactive_file|file_dirty|file_writeback) /.test(s)),probeIsSeparateProcess:true}));"""
 print(run(['docker','exec',c['Id'],'node','--max-old-space-size=128','-e',js],timeout=15).strip(),flush=True)
 print(json.dumps({'stage':'trace_complete','integrationVerified':False,'workerRestarted':False,'providerRequests':0,'signalsSent':0,'pollingSamples':0}),flush=True)
if __name__=='__main__':
 try:main()
 except Exception as e:
  print(json.dumps({'stage':'checkpoint_trace','status':'blocked','reason':str(e) if isinstance(e,RuntimeError) else 'BOUNDED_READ_FAILED','exceptionType':type(e).__name__,'workerRestarted':False}),flush=True);sys.exit(2)
