"""Bounded multi-checkpoint observation of the existing worker. No provider calls/mutations."""
import datetime,json,os,re,sqlite3,subprocess,time,urllib.request,urllib.error
from pathlib import Path
GAP_SECONDS=420;MAX_SECONDS=1080;INTERVAL=45

def emit(**row):print(json.dumps(row),flush=True)
def inspect():
 p=subprocess.run(['docker','inspect','adl-homologation-worker-1'],capture_output=True,timeout=15,check=True);return json.loads(p.stdout)[0]
def stamp(v):
 try:return datetime.datetime.fromisoformat(v.replace('Z','+00:00')).timestamp()
 except (ValueError,TypeError,AttributeError):return None

def inbox_sample(path,boundary=None):
 with sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=3) as db:
  db.execute('PRAGMA query_only=ON');db.execute('PRAGMA cache_size=-2048');db.execute('BEGIN')
  seq=db.execute("SELECT seq FROM sqlite_sequence WHERE name='inbox'").fetchone();seq=int(seq[0]) if seq else 0;boundary=seq if boundary is None else boundary
  old=db.execute('SELECT count(*),min(received) FROM inbox INDEXED BY inbox_processing_receipt WHERE id<=?',(boundary,)).fetchone()
  new=db.execute('SELECT count(*),min(received) FROM inbox INDEXED BY inbox_processing_receipt WHERE id>?',(boundary,)).fetchone()
  oldest=min([v for v in (old[1],new[1]) if v is not None],default=None)
 return dict(boundaryId=boundary,insertId=seq,pendingOldRows=old[0],pendingNewRows=new[0],pendingRows=old[0]+new[0],oldestReceivedMs=oldest,oldestAgeMs=max(0,int(time.time()*1000)-oldest) if oldest is not None else None)

def metadata(path):
 # Bounded top-level prefix only. Never parse events or the full checkpoint.
 with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb') as f:text=f.read(1024**2).decode('utf8',errors='ignore')
 decoder=json.JSONDecoder();pos=1
 if not text.startswith('{'):raise RuntimeError('PUBLICATION_PREFIX_UNVERIFIED')
 for _ in range(32):
  while text[pos].isspace() or text[pos]==',':pos+=1
  key,pos=decoder.raw_decode(text,pos)
  while text[pos].isspace():pos+=1
  if text[pos]!=':':raise RuntimeError('PUBLICATION_PREFIX_COLON')
  pos+=1
  while text[pos].isspace():pos+=1
  if key=='events':raise RuntimeError('CONNECTIONS_NOT_IN_PREFIX')
  value,pos=decoder.raw_decode(text,pos)
  if key=='connections':return value
 raise RuntimeError('CONNECTIONS_PREFIX_MISSING')

def safe_connection(c,activity=None):
 activity=activity or {}
 session=c.get('session') or {};full=c.get('fullSnapshot') or {};progress=c.get('recoveryProgress') or {};start=stamp(session.get('startedAt'));last=stamp(c.get('lastSnapshotAt'))
 keys=('stage','startedAt','completedAt','lastProgressAt','bytes','validatedRows','appliedRows')
 market_decoded=stamp(activity.get('lastMarketDecodedAt'));market_received=stamp(activity.get('lastMarketReceivedAt'))
 diagnostic=c.get('diagnostic') or {};safe_diagnostic={k:v for k,v in diagnostic.items() if k in ('operation','category','reason','protocol','networkCode','amqpCode','errorType') and (type(v) is int or isinstance(v,str) and re.fullmatch('[A-Za-z0-9_.-]{1,100}',v))}
 return dict(phase=c.get('phase'),diagnostic=safe_diagnostic,consumerRegisteredAt=(c.get('consumerProgress') or {}).get('registeredAt'),consumerActive=(c.get('consumerProgress') or {}).get('active'),sessionId=session.get('id'),sessionStartedAt=session.get('startedAt'),snapshot={k:full[k] for k in keys if k in full},lastSnapshotAt=c.get('lastSnapshotAt'),regularSnapshotReady=progress.get('regularSnapshotReady'),snapshotCurrentSession=bool(progress.get('regularSnapshotReady') and last is not None and start is not None and last>=start),marketReceiveAndDecodeCurrentSession=bool(start is not None and market_decoded is not None and market_received is not None and market_decoded>=start and market_received>=start),updateEvidenceSource='feed.coverage' if activity else 'not_observed_in_log_window',updates={k:activity.get(k) for k in ('lastDataDecodedAt','lastMarketDecodedAt','lastMarketReceivedAt','lastSettlementDecodedAt','lastControlDecodedAt')},headersByType={str(k):v for k,v in ((c.get('ingressProgress') or {}).get('headersByType') or {}).items() if re.fullmatch(r'\d{1,3}|unknown',str(k)) and type(v) is int})

def logs(cid,since):
 p=subprocess.run(['docker','logs','--timestamps','--since',since,'--tail','3000',cid],capture_output=True,timeout=20,check=True);raw=p.stdout+p.stderr
 if len(raw)>8*1024**2:raise RuntimeError('CYCLE_LOG_WINDOW_TOO_LARGE')
 rows=[]
 for line in raw.decode(errors='replace').splitlines():
  try:at,body=line.split(' ',1);r=json.loads(body)
  except (ValueError,TypeError):continue
  if not isinstance(r,dict) or not re.fullmatch(r'\d{4}-\d\d-\d\dT[0-9:.]+Z',at):continue
  op=r.get('operation')
  if op not in ('file.persist','state.publication_wait','snapshot.apply_wait','snapshot.events','inbox.checkpoint','inbox.processing_progress','inbox.actor_failure','inbox.transport_ack','feed.coverage','inbox.intake_capacity','inbox.capacity_drain','amqp.connection'):continue
  out={'atUTC':at,'operation':op}
  for k in ('lane','stage','status','publicationStage','sessionId','ingressActorId','ingressStage','reason','errorType','batchId'):
   if isinstance(r.get(k),str) and re.fullmatch('[A-Za-z0-9_.-]{1,120}',r[k]):out[k]=r[k]
  for k in ('publicationId','rows','writes','lastDurationMs','captureDurationMs','regularDurationMs','publishDurationMs','maxEventLoopDelayMs','elapsedMs','publicationElapsedMs','waitedMs','appliedRows','validatedRows','rssBytes','heapUsedBytes','errorCode'):
   if type(r.get(k)) in (int,float):out[k]=r[k]
  if isinstance(r.get('errorCode'),str) and re.fullmatch('[A-Z_0-9]{1,64}',r['errorCode']):out['errorCode']=r['errorCode']
  if isinstance(r.get('signals'),list):out['signals']=[v for v in r['signals'][:8] if isinstance(v,str) and re.fullmatch('[A-Z_0-9]{1,80}',v)]
  if isinstance(r.get('checkpointIo'),dict):out['checkpointIo']={k:v for k,v in r['checkpointIo'].items() if type(v) in (int,float)}
  if isinstance(r.get('ingress'),dict):out['ingress']={k:r['ingress'][k] for k in ('processed','checkpointed','backlog','metricWindowEndUTC') if k in r['ingress']}
  if op=='feed.coverage':out['coverage']={lane:{k:(r.get('coverage',{}).get(lane) or {}).get(k) for k in ('eventsWithSelectableOdds','rowsPublished','messagesByType','activity')} for lane in ('prematch','inplay')}
  rows.append(out)
 return sorted(rows,key=lambda r:r['atUTC'])

def drain_summary(points,elapsed,checkpoint_advances):
 first,last=points[0],points[-1];old=first['pendingOldRows']-last['pendingOldRows'];insert=last['insertId']-first['insertId'];retired=first['pendingRows']+insert-last['pendingRows'];net=first['pendingRows']-last['pendingRows']
 intervals=[(a['pendingRows']-b['pendingRows'])/(b['elapsedSeconds']-a['elapsedSeconds']) for a,b in zip(checkpoint_advances,checkpoint_advances[1:]) if b['elapsedSeconds']>a['elapsedSeconds']]
 sustained=len(intervals)>=3 and all(v>0 for v in intervals[-3:]);net_rate=(checkpoint_advances[-4]['pendingRows']-checkpoint_advances[-1]['pendingRows'])/(checkpoint_advances[-1]['elapsedSeconds']-checkpoint_advances[-4]['elapsedSeconds']) if sustained else None
 return dict(oldCohortDurablyRetiredRows=old,insertIdAdvance=insert,totalDurablyRetiredRows=retired,pendingRowsStart=first['pendingRows'],pendingRowsEnd=last['pendingRows'],netPendingDecrease=net,windowSeconds=elapsed,receivedPerSecond=insert/elapsed if elapsed else None,durablyRetiredPerSecond=retired/elapsed if elapsed else None,netDrainPerSecond=net_rate,sustainedNetDrainVerified=sustained,measuredCompleteCheckpointIntervals=len(intervals),etaSeconds=last['pendingRows']/net_rate if sustained else None,etaCondition='Conditional on the measured last three checkpoint intervals; excludes future snapshot work and arrival changes.' if sustained else 'Withheld until at least three complete checkpoint intervals have positive net drain.')

def qualify_current_drain(summary,connection,points):
 # SQLite retirement remains valid even after disconnect/final-flush. It does
 # not establish sustainable service of a live session with new arrivals.
 result=dict(summary);result['positiveHistoricalCheckpointIntervals']=result['sustainedNetDrainVerified']
 active=connection.get('phase') in ('connected','recovering') and connection.get('consumerActive') is True
 arrival_current=len(points)>=2 and points[-1]['insertId']>points[-2]['insertId']
 result['currentConsumerAndArrivalsVerified']=active and arrival_current
 if not active or not arrival_current:
  result.update(sustainedNetDrainVerified=False,etaSeconds=None,netDrainPerSecond=None,etaCondition='Withheld: consumer inactive/disconnected or no new durable receipts in the latest interval. Historical retirement remains counted.')
 return result

def retirement_gap(elapsed,last_progress,publications,last_progress_publications):
 return elapsed-last_progress>=GAP_SECONDS and publications-last_progress_publications>=3

def container_resources(pid):
 try:
  lines=Path('/proc/'+str(pid)+'/cgroup').read_text().splitlines();line=next(v for v in lines if v.startswith('0::'))
  root=Path('/sys/fs/cgroup');folder=(root/line[3:].lstrip('/')).resolve()
  if folder!=root and root not in folder.parents:raise RuntimeError('CGROUP_PATH_UNVERIFIED')
  result={}
  for name in ('memory.current','memory.max','memory.peak'):
   p=folder/name
   if p.is_file():
    value=p.read_text().strip();result[name]=int(value) if value.isdigit() else None
  for name in ('memory.events','memory.stat'):
   values=dict(v.split() for v in (folder/name).read_text().splitlines())
   result[name]={k:int(v) for k,v in values.items() if k in ('oom','oom_kill','anon','file','inactive_file','file_dirty','file_writeback')}
  return result
 except Exception as e:return {'available':False,'errorType':type(e).__name__}

def api_evidence():
 result={}
 try:
  try:response=urllib.request.urlopen('http://127.0.0.1:13001/api/health',timeout=8)
  except urllib.error.HTTPError as e:response=e
  result['httpStatus']=response.code;raw=response.read(512*1024+1);response.close()
  if len(raw)>512*1024:raise RuntimeError('API_HEALTH_RESPONSE_LIMIT')
  data=json.loads(raw);result.update(status=data.get('status'),apiEventCount=data.get('apiEventCount'),lanes={lane:{'eventsWithSelectableOdds':(data.get('coverage',{}).get(lane) or {}).get('eventsWithSelectableOdds'),'apiSelectableOddsObserved':((data.get('coverage',{}).get(lane) or {}).get('eventsWithSelectableOdds') or 0)>0 if result['httpStatus']==200 else None,'activity':(data.get('coverage',{}).get(lane) or {}).get('activity')} for lane in ('prematch','inplay')})
 except Exception as e:result['errorType']=type(e).__name__
 return result

def main():
 c=inspect();cid=c['Id'];start=c['State']['StartedAt'];labels=c['Config'].get('Labels') or {}
 if not c['State']['Running'] or labels.get('com.docker.compose.project')!='adl-homologation':raise RuntimeError('RUNNING_WORKER_IDENTITY_REQUIRED')
 js="const fs=require('node:fs'),c=require('node:crypto');console.log(c.createHash('sha256').update(fs.readFileSync('/app/apps/worker/src/persistence.ts')).digest('hex'));"
 found=subprocess.run(['docker','exec',cid,'node','--max-old-space-size=64','-e',js],capture_output=True,text=True,timeout=15,check=True).stdout.strip()
 emit(stage='native_checkpoint_source_identity',expectedSha256='b6fe1226cf3333fab7735d3fccd1b2c2a656cf726241d21d1c1bf57c31ba5f5a',foundSha256=found,verified=found=='b6fe1226cf3333fab7735d3fccd1b2c2a656cf726241d21d1c1bf57c31ba5f5a',containerId=cid,imageId=c['Image'])
 if found!='b6fe1226cf3333fab7735d3fccd1b2c2a656cf726241d21d1c1bf57c31ba5f5a':raise RuntimeError('NATIVE_CHECKPOINT_SOURCE_NOT_INSTALLED_NO_OBSERVATION')
 env=dict(v.split('=',1) for v in c['Config'].get('Env',[]) if '=' in v);state=Path(env.get('LSPORTS_STATE_FILE','.runtime/trade-feed.json'))
 if not state.is_absolute():state=Path(c['Config'].get('WorkingDir') or '/app')/state
 mounts=[m for m in c['Mounts'] if str(state).startswith(m['Destination'].rstrip('/')+'/')]
 if len(mounts)!=1:raise RuntimeError('FEED_MOUNT_UNVERIFIED')
 host=Path(mounts[0]['Source'])/state.relative_to(mounts[0]['Destination']);paths={lane:Path(str(host)+'.'+lane+'.inbox.sqlite') for lane in ('prematch','inplay')}
 for p in [host,*paths.values()]:
  if not p.is_file() or p.is_symlink():raise RuntimeError('PRESERVED_FILE_IDENTITY_UNVERIFIED')
 begin=time.monotonic();window_start=time.time();since=datetime.datetime.now(datetime.timezone.utc).isoformat();points={l:[] for l in paths};advances={l:[] for l in paths};seen=set();publications=[];recent=[];critical=[];latest={};last_progress=0;last_progress_publications=0;reason=None
 emit(stage='durable_cycles_started',containerId=cid,imageId=c['Image'],startedAtUTC=start,maxObservationSeconds=MAX_SECONDS,sampleIntervalSeconds=INTERVAL,readOnly=True,providerRequests=0,workerRestarted=False)
 while True:
  current=inspect()
  if current['Id']!=cid or current['State']['StartedAt']!=start or not current['State']['Running']:raise RuntimeError('WORKER_CHANGED_OR_STOPPED_NO_RESTART')
  elapsed=time.monotonic()-begin
  fresh=logs(cid,since)
  for row in fresh:
   key=json.dumps(row,sort_keys=True)
   if key in seen:continue
   seen.add(key);recent.append(row)
   if row['operation'] in ('inbox.actor_failure','inbox.actor_lifecycle','worker.start','inbox.transport_ack','inbox.intake_capacity','amqp.connection'):
    critical.append(row);critical=critical[-64:];emit(**{**row,'stage':'current_lane_lifecycle'})
   if row['operation']=='file.persist' and row.get('status')=='ok':publications.append(row);emit(**{**row,'stage':'publication_cycle_completed'})
   if row['operation']=='inbox.checkpoint' and row.get('status')=='persisted':emit(**{**row,'stage':'business_checkpoint_completed'})
  if fresh:since=fresh[-1]['atUTC']
  recent=recent[-1000:]
  for lane,path in paths.items():
   sample=inbox_sample(path,points[lane][0]['boundaryId'] if points[lane] else None);sample['elapsedSeconds']=time.monotonic()-begin
   if points[lane] and sample['pendingOldRows']<points[lane][-1]['pendingOldRows']:
    advances[lane].append(sample)
    if lane=='prematch':last_progress=elapsed;last_progress_publications=len(publications)
   points[lane].append(sample)
   emit(stage='durable_cycle_sample',lane=lane,containerId=cid,**sample,checkpointAdvanceObservations=len(advances[lane]),completedPublications=len(publications))
  try:
   coverage=next((r for r in reversed(recent) if r['operation']=='feed.coverage'),{})
   latest={l:{**safe_connection(v,((coverage.get('coverage') or {}).get(l) or {}).get('activity')),'coverageLoggedAtUTC':coverage.get('atUTC')} for l,v in metadata(host).items() if l in paths}
  except Exception as e:emit(stage='publication_metadata_unavailable',errorType=type(e).__name__)
  emit(stage='cycle_wait_context',elapsedSeconds=round(elapsed,1),containerResources=container_resources(current['State']['Pid']),latestWaits=[r for r in recent if r['operation'] in ('state.publication_wait','snapshot.apply_wait','file.persist')][-6:],lanes=latest,readOnly=True)
  if latest.get('prematch',{}).get('phase') in ('error','stopped'):
   reason='PREMATCH_SESSION_NOT_ACTIVE_NO_SUSTAINED_RATE_CLAIM';break
  if points['prematch'][-1]['pendingRows']==0:reason='PREMATCH_INBOX_DRAINED';break
  if len(advances['prematch'])>=4:reason='THREE_COMPLETE_DURABLE_CHECKPOINT_INTERVALS_MEASURED';break
  if retirement_gap(elapsed,last_progress,len(publications),last_progress_publications):reason='NO_PREMATCH_DURABLE_ADVANCE_ACROSS_COMPLETED_PUBLICATIONS';break
  if elapsed>=MAX_SECONDS:reason='BOUNDED_OBSERVATION_FINISHED_NOT_PROOF_OF_STALL';break
  time.sleep(INTERVAL)
 elapsed=time.monotonic()-begin
 summary={lane:qualify_current_drain(drain_summary(p,elapsed,advances[lane]),latest.get(lane,{}),p) for lane,p in points.items()}
 totals={k:sum(r.get(k,0) for r in publications) for k in ('captureDurationMs','regularDurationMs','publishDurationMs','lastDurationMs')}
 emit(stage='durable_cycles_result',reason=reason,containerId=cid,lanes=summary,feedEvidence=latest,api=api_evidence(),publicationCompletedCycles=len(publications),publicationDurationTotalsMs=totals,publicationMetricMeaning='Only completed file.persist metrics are summed. publicationElapsedMs is cumulative and cannot identify a single write duration. checkpointIo contains private write/fsync and remaining wall time; remaining wall time includes encoding and scheduling, not pure CPU.',recentEvents=recent[-100:],recentCriticalEvents=critical,readOnly=True,providerRequests=0,workerRestarted=False,posnetChanged=False,integrationVerified=False)
if __name__=='__main__':
 try:main()
 except Exception as e:emit(stage='durable_cycles_result',status='blocked',reason=str(e) if isinstance(e,RuntimeError) else 'READ_ONLY_CYCLE_OBSERVATION_FAILED',exceptionType=type(e).__name__,workerRestarted=False,providerRequests=0,integrationVerified=False);sys.exit(2)
