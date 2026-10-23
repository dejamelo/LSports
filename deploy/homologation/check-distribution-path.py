"""One bounded, credential-free transport check; no HTTP/provider operations."""
import datetime,json,subprocess,sys

def run(args,timeout=20,input=None):
 r=subprocess.run(args,input=input,capture_output=True,text=True,timeout=timeout)
 if r.returncode:raise RuntimeError('COMMAND_FAILED_'+args[0].upper())
 return r.stdout

def main():
 c=json.loads(run(['docker','inspect','adl-homologation-worker-1']))[0]
 identity={'containerId':c['Id'],'imageId':c['Image'],'running':c['State']['Running'],'startedAtUTC':c['State']['StartedAt']}
 print(json.dumps({'stage':'identity',**identity}),flush=True)
 if not identity['running']:raise RuntimeError('WORKER_NOT_RUNNING_NO_PROBE')
 # Existing structured events only. Never print raw logs, messages or SDK errors.
 r=subprocess.run(['docker','logs','--timestamps','--since','2026-10-23T17:40:00Z','--tail','12000',c['Id']],capture_output=True,text=True,timeout=20)
 if r.returncode:raise RuntimeError('LOG_READ_FAILED')
 events=[]
 for line in (r.stdout+'\n'+r.stderr).splitlines():
  try:at,body=line.split(' ',1);v=json.loads(body)
  except (ValueError,TypeError):continue
  if not isinstance(v,dict) or v.get('lane')!='prematch' or v.get('operation') not in ('distribution.status','distribution.start','inbox.actor_lifecycle','inbox.actor_failure','worker.start','amqp.connection','inbox.checkpoint'):continue
  safe={'atUTC':at}
  for k in ('operation','status','reason','errorType','networkCode','sessionId','ingressActorId','ingressStage','timeoutMs','elapsedMs','durationMs','httpStatus','rows'):
   value=v.get(k)
   if type(value) in (int,float,bool):safe[k]=value
   elif isinstance(value,str) and len(value)<=120 and all(ch.isalnum() or ch in '_.-' for ch in value):safe[k]=value
  events.append(safe)
 print(json.dumps({'stage':'existing_events','events':events[-50:],'windowMayBeTruncated':len(events)>50}),flush=True)
 source=r"""
const fs=require('node:fs'),tls=require('node:tls'),dns=require('node:dns').promises;
const {monitorEventLoopDelay}=require('node:perf_hooks');
const read=p=>{try{return fs.readFileSync(p,'utf8').trim()}catch{return null}};
const start=Date.now(),lag=monitorEventLoopDelay({resolution:20});lag.enable();
(async()=>{
 const url=new URL(process.env.LSPORTS_CUSTOMERS_URL||'https://stm-api.lsports.eu');
 if(url.protocol!=='https:'||url.username||url.password)throw Error('ENDPOINT_CONFIGURATION_REJECTED');
 const out={stage:'bounded_dns_tls',httpRequests:0,endpointIsDefault:url.hostname==='stm-api.lsports.eu',proxyConfigured:!!(process.env.HTTPS_PROXY||process.env.https_proxy||process.env.ALL_PROXY||process.env.all_proxy),directTlsBypassesConfiguredProxy:true};
 const stat0=read('/sys/fs/cgroup/cpu.stat');
 try {const t=Date.now();const addresses=await dns.lookup(url.hostname,{all:true});out.dnsMs=Date.now()-t;out.addressCount=addresses.length;out.addressFamilies=[...new Set(addresses.map(x=>x.family))];}
 catch(e){out.dnsErrorCode=/^[A-Z_0-9]+$/.test(e.code||'')?e.code:'OTHER';}
 const t=Date.now();
 await new Promise(resolve=>{let done=false;const s=tls.connect({host:url.hostname,port:Number(url.port)||443,servername:url.hostname,rejectUnauthorized:true});const finish=(code)=>{if(done)return;done=true;clearTimeout(timer);out.tlsMs=Date.now()-t;out.tlsResult=code;s.destroy();resolve()};const timer=setTimeout(()=>finish('DEADLINE_10000MS'),10000);s.once('secureConnect',()=>finish('VERIFIED'));s.once('error',e=>finish(/^[A-Z_0-9]+$/.test(e.code||'')?e.code:'OTHER'));});
 lag.disable();out.probeEventLoopMaxMs=lag.max/1e6;out.probeEventLoopIsNotWorkerEventLoop=true;out.elapsedMs=Date.now()-start;
 out.cpuStatBefore=stat0;out.cpuStatAfter=read('/sys/fs/cgroup/cpu.stat');out.memoryCurrentBytes=Number(read('/sys/fs/cgroup/memory.current'));out.memoryMaxBytes=read('/sys/fs/cgroup/memory.max');
 console.log(JSON.stringify(out));
})().catch(()=>{console.log(JSON.stringify({stage:'bounded_dns_tls',status:'failed',reason:'ENDPOINT_OR_PROBE_ERROR'}));process.exitCode=2});
"""
 # Same network namespace, DNS and cgroup. Separate tiny Node probe, no consumer.
 print(run(['docker','exec','-i',c['Id'],'node','-'],timeout=25,input=source).strip(),flush=True)
 after=json.loads(run(['docker','inspect',c['Id']]))[0]
 if after['State']['StartedAt']!=identity['startedAtUTC'] or not after['State']['Running']:raise RuntimeError('WORKER_CHANGED_DURING_PROBE')
 print(json.dumps({'stage':'complete','providerHttpRequests':0,'signalsSent':0,'workerRestarted':False,'integrationVerified':False,'note':'TLS success does not prove authenticated distribution endpoint health; proxy and worker event-loop remain distinct.'}),flush=True)

if __name__=='__main__':
 try:main()
 except Exception as e:
  print(json.dumps({'stage':'bounded_distribution_check','status':'blocked','reason':str(e) if isinstance(e,RuntimeError) else 'BOUNDED_READ_FAILED','exceptionType':type(e).__name__}),flush=True);sys.exit(2)
