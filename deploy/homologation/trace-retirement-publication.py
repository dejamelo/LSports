"""One current-container log correlation. No waiting, service changes or provider calls."""
import datetime,json,re,subprocess,sys

def stamp(v):
 try:return datetime.datetime.fromisoformat(v.replace('Z','+00:00'))
 except (ValueError,TypeError):return None

def correlate(lines,started,now):
 rows=[];actors={};last_commit={};ignored=0
 for line in lines:
  try:at,body=line.split(' ',1);r=json.loads(body)
  except (ValueError,TypeError):continue
  when=stamp(at)
  if not when or when<started:ignored+=1;continue
  operation=r.get('operation');lane=r.get('lane')
  if operation not in ('inbox.checkpoint','inbox.processing_progress','file.persist','state.publication_wait','snapshot.apply_wait','snapshot.events','worker.shutdown') and not (lane in ('prematch','inplay') and r.get('category')):continue
  safe={'atUTC':at}
  for k in ('operation','lane','status','stage','publicationStage','sessionId','ingressActorId','reason','category'):
   if isinstance(r.get(k),str) and re.fullmatch('[A-Za-z0-9_.-]{1,120}',r[k]):safe[k]=r[k]
  for k in ('rows','writes','waitedMs','elapsedMs','publicationElapsedMs','lastDurationMs','regularDurationMs','publishDurationMs','captureDurationMs','appliedRows','validatedRows'):
   if type(r.get(k)) in (int,float):safe[k]=r[k]
  if isinstance(r.get('ingress'),dict):
   m=r['ingress'];safe['ingress']={k:m[k] for k in ('received','acknowledged','processed','checkpointed','backlog','processingBacklog','oldestProcessingAgeMs','metricWindowStartUTC','metricWindowEndUTC') if k in m}
   end=stamp(m.get('metricWindowEndUTC'));safe['metricAgeSeconds']=max(0,(now-end).total_seconds()) if end else None
   key=(lane,r.get('sessionId'),r.get('ingressActorId'));actors[key]=safe
  if operation=='file.persist' and r.get('status')=='ok':last_commit['shared']=safe
  if operation=='inbox.checkpoint' and r.get('status')=='persisted':last_commit[lane]=safe
  rows.append(safe)
 return {'timeline':rows[-240:],'timelineTruncated':len(rows)>240,'currentActorSamples':list(actors.values())[-24:],'lastCompletedPublications':last_commit,'historicalRowsExcluded':ignored,'note':'publicationElapsedMs and waitedMs are cumulative waits, not isolated write durations. Missing completion in a bounded log window is not proof of a stuck write. Checkpoint logs lacking session/actor IDs cannot be assigned across overlapping sessions with certainty.'}

def main():
 def run(args):
  p=subprocess.run(args,capture_output=True,timeout=30)
  if p.returncode:raise RuntimeError('READ_COMMAND_FAILED_'+args[1].upper())
  return p.stdout+p.stderr if args[1]=='logs' else p.stdout
 c=json.loads(run(['docker','inspect','adl-homologation-worker-1']))[0];s=c['State'];labels=c['Config'].get('Labels') or {}
 if labels.get('com.docker.compose.project')!='adl-homologation' or labels.get('com.docker.compose.service')!='worker':raise RuntimeError('WORKER_IDENTITY_UNVERIFIED')
 raw=run(['docker','logs','--timestamps','--since',s['StartedAt'],'--tail','20000',c['Id']]);now=datetime.datetime.now(datetime.timezone.utc)
 if len(raw)>32*1024**2:raise RuntimeError('TARGETED_LOG_WINDOW_TOO_LARGE')
 result=correlate(raw.decode(errors='replace').splitlines(),stamp(s['StartedAt']),now)
 current=json.loads(run(['docker','inspect',c['Id']]))[0]
 print(json.dumps(dict(stage='retirement_publication_trace',capturedAtUTC=now.isoformat(),worker=dict(id=c['Id'],imageId=c['Image'],running=current['State']['Running'],startedAtUTC=s['StartedAt']),**result,readOnly=True,providerRequests=0,signalsSent=0,workerRestarted=False,integrationVerified=False)),flush=True)
if __name__=='__main__':
 try:main()
 except Exception as e:
  print(json.dumps(dict(stage='retirement_publication_trace',status='blocked',reason=str(e) if isinstance(e,RuntimeError) else 'TARGETED_TRACE_FAILED',exceptionType=type(e).__name__,readOnly=True)),flush=True);sys.exit(2)
