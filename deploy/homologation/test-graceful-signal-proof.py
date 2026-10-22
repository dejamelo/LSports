import copy,json,tempfile,unittest,types,datetime
from pathlib import Path
HERE=Path(__file__).parent

def load():
 ns={'__name__':'tested'}
 for name in ('resume-adl-api.py','repair-adl-snapshot.py','upgrade-partitioned-worker.py','execute-adl-cutover-aws.py'):exec((HERE/name).read_text().split("if __name__=='__main__':")[0],ns)
 return ns
class SignalProof(unittest.TestCase):
 def setUp(self):
  self.ns=load();self.progress={'oldContainer':'a'*64,'baseImageId':'sha256:'+'b'*64,'supplierStoppedBeforeConsumer':True};self.evidence={'containerId':'a'*64,'imageId':'sha256:'+'b'*64,'running':True,'events':[]}
 def decide(self,**changes):return self.ns['graceful_signal_decision'](self.progress,{**self.evidence,**changes})
 def test_legacy_phase_or_null_timestamp_does_not_prove_missing_signal(self):
  self.progress.update(phase='stop_requested',stopRequestedAtUTC=None);self.assertEqual(self.decide(),'signal_history_inconclusive')
 def test_positive_docker_or_application_receipt_prevents_repeat(self):
  self.assertEqual(self.decide(dockerTermAccepted=True),'already_requested');self.assertEqual(self.decide(applicationStoppingObserved=True),'already_requested')
 def test_first_request_requires_both_histories_and_no_other_stop_or_restart(self):
  self.assertEqual(self.decide(dockerHistoryCoversStart=True,logHistoryCoversStart=True),'first_request_verified')
  self.assertEqual(self.decide(dockerHistoryCoversStart=True),'signal_history_inconclusive')
  self.assertEqual(self.decide(dockerHistoryCoversStart=True,logHistoryCoversStart=True,events=[{'action':'kill','signal':'2'}]),'signal_history_inconclusive')
  self.assertEqual(self.decide(dockerHistoryCoversStart=True,logHistoryCoversStart=True,distributionRestartAfterRecordedStop=True),'signal_history_inconclusive')
 def test_interrupted_intent_is_not_replayed_without_delivery_proof(self):
  self.progress['gracefulSignal']={**self.evidence,'status':'intent'};self.assertEqual(self.decide(dockerHistoryCoversStart=True,logHistoryCoversStart=True),'signal_intent_delivery_inconclusive');self.assertEqual(self.decide(dockerTermAccepted=True),'already_requested')
 def test_signal_once_is_journaled_before_docker_and_not_reissued(self):
  saved=[];calls=[];worker={'id':'a'*64,'running':True};info={'Image':self.progress['baseImageId'],'HostConfig':{'Memory':4294967296}}
  def run(args,**kw):
   calls.append(args)
   if args[:2]==['docker','inspect']:return json.dumps([info]).encode()
   self.assertEqual(args,['docker','kill','--signal','SIGTERM','a'*64]);self.assertEqual(saved[-1]['gracefulSignal']['status'],'intent');return b''
  self.ns.update(states=lambda _: [worker],run=run)
  with tempfile.TemporaryDirectory() as tmp:
   self.ns['request_graceful_signal_once'](self.progress,lambda p:saved.append(copy.deepcopy(p)),Path(tmp))
   self.assertEqual(saved[-1]['gracefulSignal']['status'],'docker_accepted')
   with self.assertRaisesRegex(RuntimeError,'STOP_SIGNAL_ALREADY_RECORDED_NO_REPEAT'):self.ns['request_graceful_signal_once'](self.progress,lambda p:saved.append(copy.deepcopy(p)),Path(tmp))
  self.assertEqual(sum(c[:2]==['docker','kill'] for c in calls),1)
 def test_current_container_events_and_stopping_log_are_correlated(self):
  start='2026-10-22T04:44:14Z';cid=self.progress['oldContainer'];dt=datetime.datetime.fromisoformat(start.replace('Z','+00:00'))
  events=[{'Actor':{'ID':cid},'Action':'start','timeNano':int(dt.timestamp()*10**9)},{'Actor':{'ID':cid,'Attributes':{'signal':'15'}},'Action':'kill','timeNano':int((dt.timestamp()+100)*10**9)}]
  logs=b'2026-10-22T04:44:15.000Z {"operation":"worker.start","status":"ok"}\n2026-10-22T05:01:35.000Z {"operation":"worker.shutdown","status":"stopping"}\n'
  info={'Image':self.progress['baseImageId'],'HostConfig':{'Memory':4294967296},'State':{'StartedAt':start,'Pid':0}};calls=[]
  def popen(args,**kw):
   calls.append(args);self.assertEqual(args[:2],['docker','logs']);kw['stdout'].write(logs);kw['stdout'].flush();return types.SimpleNamespace(wait=lambda **_:0)
  def events_run(args,**kw):
   calls.append(args);self.assertEqual(args[:2],['docker','events']);return types.SimpleNamespace(returncode=0,stdout=('\n'.join(json.dumps(e) for e in events)).encode())
  self.ns.update(states=lambda _:[{'id':cid,'running':True}],run=lambda *a,**k:json.dumps([info]).encode(),subprocess=types.SimpleNamespace(run=events_run,Popen=popen))
  evidence=self.ns['collect_graceful_signal_evidence'](self.progress)
  self.assertTrue(evidence['dockerTermAccepted']);self.assertTrue(evidence['applicationStoppingObserved']);self.assertTrue(evidence['dockerHistoryCoversStart']);self.assertTrue(evidence['logHistoryCoversStart']);self.assertEqual(evidence['signalsSent'],0);self.assertEqual(self.ns['graceful_signal_decision'](self.progress,evidence),'already_requested');self.assertFalse(any('kill' in args[:2] for args in calls))
 def test_changed_container_is_never_signaled(self):
  self.ns['states']=lambda _:[{'id':'c'*64,'running':True}]
  with tempfile.TemporaryDirectory() as tmp:
   with self.assertRaisesRegex(RuntimeError,'STOP_CONTAINER_IDENTITY_CHANGED'):self.ns['request_graceful_signal_once'](self.progress,lambda p:None,Path(tmp))
if __name__=='__main__':unittest.main()
