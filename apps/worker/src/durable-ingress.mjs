// Private disk inbox + AMQP transport. No business logic, JSON payload decode or snapshot here.
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync,statSync,statfsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {EventEmitter} from 'node:events';

const reviveBuffers=(_key,value)=>value?.type==='Buffer'&&Array.isArray(value.data)?Buffer.from(value.data):value;

export function openInbox(path, maxBytes=2*1024**3){
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const db=new DatabaseSync(path);chmodSync(path,0o600);
 db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS inbox(id INTEGER PRIMARY KEY AUTOINCREMENT, received INTEGER NOT NULL, content BLOB NOT NULL, properties TEXT NOT NULL, fields TEXT NOT NULL); CREATE TABLE IF NOT EXISTS recovery(id INTEGER PRIMARY KEY CHECK(id=1), safe_seconds INTEGER); CREATE INDEX IF NOT EXISTS inbox_processing_receipt ON inbox(id,received);');
 const add=db.prepare('INSERT INTO inbox(received,content,properties,fields) VALUES(?,?,?,?)');
 const count=db.prepare('SELECT count(*) AS backlog,coalesce(sum(length(content)+length(cast(properties as blob))+length(cast(fields as blob))),0) AS bytes,min(received) AS oldest FROM inbox');
 // Cover receipt metrics without visiting payload pages for every pending message.
 // Preserve exact MIN(received), including out-of-order clocks, and the existing id cursor.
 const processingCount=db.prepare('SELECT count(*) AS processingBacklog,min(received) AS oldest FROM inbox WHERE id>?');
 const pending=db.prepare('SELECT id,received,content,properties,fields FROM inbox WHERE id>? ORDER BY id LIMIT ?');
 const del=db.prepare('DELETE FROM inbox WHERE id=?');
 const initial=count.get();let usage=Number(initial.bytes),backlog=Number(initial.backlog);
 const rowSize=db.prepare('SELECT length(content)+length(cast(properties as blob))+length(cast(fields as blob)) AS bytes FROM inbox WHERE id=?');
 const stats=()=>{const oldest=db.prepare('SELECT received FROM inbox ORDER BY id LIMIT 1').get()?.received;return {backlog,bytes:usage,oldestAgeMs:oldest?Math.max(0,Date.now()-Number(oldest)):0,databaseBytes:statSync(path).size,walBytes:(()=>{try{return statSync(path+'-wal').size;}catch{return 0;}})()};};
 return {
  append(messages){const space=statfsSync(dirname(path));if(Number(space.bavail)*Number(space.bsize)<128*1024**2)throw Error('INBOX_CAPACITY_EXCEEDED');
   const bytes=messages.reduce((n,m)=>n+m.content.byteLength+Buffer.byteLength(JSON.stringify(m.properties||{}))+Buffer.byteLength(JSON.stringify(m.fields||{})),0);if(bytes>16*1024**2)throw Error('INBOX_MESSAGE_TOO_LARGE');if(usage+bytes>maxBytes)throw Error('INBOX_CAPACITY_EXCEEDED');
   if(messages.some(m=>Buffer.byteLength(JSON.stringify(m.properties||{}))+Buffer.byteLength(JSON.stringify(m.fields||{}))>64*1024))throw Error('INBOX_MESSAGE_TOO_LARGE');
   const ids=[];db.exec('BEGIN IMMEDIATE');try{for(const m of messages)ids.push(Number(add.run(m.received||Date.now(),m.content,JSON.stringify(m.properties||{}),JSON.stringify(m.fields||{})).lastInsertRowid));db.exec('COMMIT');usage+=bytes;backlog+=messages.length;return ids;}catch(e){db.exec('ROLLBACK');throw e;}},
  peek(limit=4096,after=0){const rows=pending.iterate(after,Math.min(limit,4096));const out=[];let bytes=0;for(const row of rows){const size=row.content.byteLength+Buffer.byteLength(row.properties)+Buffer.byteLength(row.fields);if(bytes+size>16*1024**2&&out.length)break;bytes+=size;out.push({...row,content:Buffer.from(row.content),properties:JSON.parse(row.properties,reviveBuffers),fields:JSON.parse(row.fields,reviveBuffers)});}return out;},
  complete(ids){db.exec('BEGIN IMMEDIATE');try{let removed=0,bytes=0;for(const id of ids){const row=rowSize.get(id);if(row){bytes+=Number(row.bytes);removed++;del.run(id);}}db.exec('COMMIT');usage-=bytes;backlog-=removed;}catch(e){db.exec('ROLLBACK');throw e;}},
  safePoint(seconds,checkpointPrefix=false){if(!Number.isSafeInteger(seconds)||seconds<0||backlog!==0&&!checkpointPrefix)throw Error('SAFE_POINT_REQUIRES_DRAINED_INBOX');if(backlog){const oldest=Number(db.prepare('SELECT received FROM inbox ORDER BY id LIMIT 1').get().received);seconds=Math.min(seconds,Math.max(0,Math.floor(oldest/1000)-2));}
   db.prepare('INSERT INTO recovery(id,safe_seconds) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET safe_seconds=excluded.safe_seconds').run(seconds);return seconds;},
  processingStats(after){const row=processingCount.get(after);return{processingBacklog:Number(row.processingBacklog),oldestProcessingAgeMs:row.oldest?Math.max(0,Date.now()-Number(row.oldest)):0};},
  safeSeconds(){return db.prepare('SELECT safe_seconds FROM recovery WHERE id=1').get()?.safe_seconds;},stats,
  close(){db.close();}
 };
}

// SQLite receipt and AMQP acknowledgement are different commit boundaries.
// A closed channel cannot invalidate a successful journal write or make it retry.
export function persistIngressBatch(inbox,batch,acknowledge,{canAcknowledge=()=>true,onCommitted=()=>{},onAcknowledged=()=>{},onAckFailure=error=>{throw error;}}={}){
 const started=performance.now();inbox.append(batch);onCommitted(performance.now()-started);
 let acknowledged=0;
 for(const message of batch){
  if(!canAcknowledge())break;
  try{acknowledge(message);}catch(error){onAckFailure(error);break;}
  acknowledged++;onAcknowledged();
 }
 return {committedRows:batch.length,acknowledged};
}
export function isClosedIngressChannel(error){return error?.name==='IllegalOperationError'&&/^(?:Channel|Connection) clos(?:ed|ing)$/.test(error?.message||'');}

// Explicit allowlists: never log error messages, credentials, payloads or absolute paths.
export function ingressFailureDetails(error,stage){
 const stages=new Set(['actor.ownership','actor.spawn','actor.ready','actor.thread','actor.exit','actor.shutdown','inbox.open','inbox.pump','inbox.append','inbox.complete','inbox.metrics','amqp.connect','amqp.channel','amqp.prefetch','amqp.consume','amqp.ack','transport.close']);
 const types=new Set(['Error','TypeError','RangeError','SyntaxError','AggregateError','SystemError','IllegalOperationError']);
 const codes=new Set(['EACCES','EPERM','ENOENT','ENOTDIR','EISDIR','EEXIST','ENOSPC','EMFILE','ENFILE','EIO','ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','ERR_SQLITE_ERROR','SQLITE_BUSY','SQLITE_LOCKED','SQLITE_CORRUPT','SQLITE_FULL','SQLITE_IOERR','SQLITE_CANTOPEN','SQLITE_READONLY','SQLITE_NOTADB','ERR_WORKER_OUT_OF_MEMORY','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID','ERR_SSL_WRONG_VERSION_NUMBER']);
 const signals=['INBOX_ACTOR_ALREADY_OWNED','INBOX_CAPACITY_EXCEEDED','INBOX_STAGE_IDENTITY','INBOX_COMPLETION_IDENTITY','CONSUMER_CANCELLED'].filter(v=>error?.message===v);
 let handshakeCode;
 if(stage==='amqp.connect'){
  const text=typeof error?.message==='string'?error.message.slice(0,4096):'';
  const server=/^Handshake terminated by server:\s*(\d{3})\b/.exec(text);
  if(server){handshakeCode=Number(server[1]);signals.push('HANDSHAKE_SERVER_CLOSED');const names={320:'CONNECTION_FORCED',403:'ACCESS_REFUSED',405:'RESOURCE_LOCKED',530:'NOT_ALLOWED'};if(names[handshakeCode])signals.push(names[handshakeCode]);}
  if(text==='Socket closed abruptly during opening handshake')signals.push('HANDSHAKE_SOCKET_CLOSED');
  if(/^SASL mechanism .* is not provided by the server$/.test(text))signals.push('SASL_MECHANISM_UNAVAILABLE');
  if(/^Expected ConnectionOpenOk; got <ConnectionClose channel:0>$/.test(text))signals.push('HANDSHAKE_SERVER_CLOSE_BEFORE_OPEN_OK');
  else if(/^Expected ConnectionStart; got <ConnectionClose channel:0>$/.test(text))signals.push('HANDSHAKE_SERVER_CLOSE_BEFORE_START');
  else if(/^Expected (?:Connection\w+|.* during handshake); got /.test(text)||/^Frame on channel != 0 during handshake:/.test(text))signals.push('UNEXPECTED_HANDSHAKE_FRAME');
  if(text==="Wasn't expecting to have to go through secure")signals.push('HANDSHAKE_SECURE_NOT_SUPPORTED');
  if(text==='connect ETIMEDOUT')signals.push('CONNECT_TIMEOUT');
 }

 const frames=[];for(const line of String(error?.stack||'').split('\n').slice(1,12)){const m=/(durable-ingress\.mjs|connected\.ts|node:sqlite):(\d+)(?::(\d+))?/.exec(line);if(m)frames.push({file:m[1],line:Number(m[2]),column:m[3]?Number(m[3]):null});}
 const numericCode=Number.isInteger(error?.replyCode)?error.replyCode:handshakeCode??error?.code;
 const code=typeof numericCode==='number'&&Number.isInteger(numericCode)&&numericCode>=0&&numericCode<=65535?numericCode:codes.has(error?.code)?error.code:null;
 return {ingressStage:stages.has(stage)?stage:'actor.thread',errorType:types.has(error?.name)?error.name:'OtherError',errorCode:code,sqliteErrcode:Number.isInteger(error?.errcode)&&error.errcode>=0&&error.errcode<=65535?error.errcode:null,signals:[...signals,...(isClosedIngressChannel(error)?['CHANNEL_NOT_OPEN']:[])],stackFrames:frames.slice(0,6)};
}
const inboxOwners=new Map();

if(!isMainThread){
 const send=v=>parentPort.postMessage(v);let inbox,connection,channel,callback,closed=false,quiesced=false,pending=[],flushTimer,inflight=new Set(),pumpTimer,deliveredThrough=0,stagedThrough=0;
 const metrics={received:0,acknowledged:0,processed:0,checkpointed:0,receivedBytes:0,lastReceiveAt:null,lastAckAt:null,headersByType:{},durableCommitMs:0};
 const loop=monitorEventLoopDelay({resolution:20});loop.enable();let windowStart=Date.now();let intakePaused=false,consumerTag,consumerControl=Promise.resolve();
 const maximum=workerData.maxBytes??2*1024**3;const resumeBytes=Math.max(0,maximum-Math.min(8*1024**2,Math.floor(maximum/4)));
 const controlConsumer=()=>{consumerControl=consumerControl.then(async()=>{if(!channel||channelEnded||transportEnded)return;if(closed||quiesced||intakePaused){if(consumerTag){const tag=consumerTag;consumerTag=undefined;await channel.cancel(tag);}}else if(!consumerTag){consumerTag=(await channel.consume(workerData.pkg.queue,receive,{noAck:false,exclusive:true})).consumerTag;}}).catch(e=>fail(e,'amqp.consume'));return consumerControl;};
 const pauseIntake=()=>{if(!intakePaused){intakePaused=true;send({event:"capacity",paused:true,bytes:inbox.stats().bytes});void controlConsumer();}};
 const resumeIntake=()=>{if(intakePaused&&!pending.length&&inbox.stats().bytes<=resumeBytes&&!closed){intakePaused=false;send({event:"capacity",paused:false,bytes:inbox.stats().bytes});void controlConsumer();}};
 const report=()=>{const now=Date.now();send({event:'metrics',metrics:{...metrics,intakePaused,...inbox.stats(),...inbox.processingStats(stagedThrough),rssBytes:process.memoryUsage().rss,ingressMaxEventLoopDelayMs:Math.ceil(loop.max/1e6),metricWindowStartUTC:new Date(windowStart).toISOString(),metricWindowEndUTC:new Date(now).toISOString()}});loop.reset();windowStart=now;};
 let failureStage='inbox.open';const setStage=stage=>{failureStage=stage;send({event:'startup_stage',stage});};
 const fail=(e,stage=failureStage)=>{send({event:'failure',details:ingressFailureDetails(e,stage),code:typeof e?.code==='number'||['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN'].includes(e?.code)?e.code:null,reason:e?.message==='INBOX_CAPACITY_EXCEEDED'?'INBOX_CAPACITY_EXCEEDED':/CONNECTION_FORCED/i.test(e?.message||'')?'CONNECTION_FORCED':'INGRESS_FAILED'});};
 const pump=()=>{if(closed||quiesced||inflight.size||!callback)return;const rows=inbox.peek(4096,deliveredThrough);if(rows.length){deliveredThrough=rows.at(-1).id;inflight=new Set(rows.map(r=>r.id));send({event:'deliveries',rows});}};
 const flush=()=>{clearTimeout(flushTimer);flushTimer=undefined;if(!pending.length)return;const batch=pending;pending=[];
  try{
   persistIngressBatch(inbox,batch,m=>channel?.ack(m.original),{
    canAcknowledge:()=>!closed&&!quiesced&&(workerData.offline||!transportEnded&&!channelEnded),
    onCommitted:ms=>{metrics.durableCommitMs=ms;},
    onAcknowledged:()=>{metrics.acknowledged++;metrics.lastAckAt=new Date().toISOString();},
    onAckFailure:error=>{
     // The complete batch is already in SQLite. Never put it back in pending.
     if(isClosedIngressChannel(error)){
      channelEnded=true;send({event:'ack_deferred',details:ingressFailureDetails(error,'amqp.ack'),committedRows:batch.length});
      if(!closed&&!quiesced)send({event:'transport_closed'});
     }else{fail(error,'amqp.ack');void closeTransport();}
    },
   });
   pump();
  }catch(error){
   if(error?.message==='INBOX_CAPACITY_EXCEEDED'){pending=batch;pauseIntake();pump();}
   else{fail(error,'inbox.append');void closeTransport();}
  }
 };
 const receive=m=>{if(!m){fail(Error('CONSUMER_CANCELLED'));return;}if(closed)return;if(quiesced){try{channel?.nack(m,false,true);}catch{}return;}if(intakePaused){if(channel)channel.nack(m,false,true);else fail(Error('OFFLINE_CAPACITY_PAUSE_REQUIRES_REDELIVERY'));return;}metrics.received++;metrics.receivedBytes+=m.content.byteLength;metrics.lastReceiveAt=new Date().toISOString();const type=m.properties?.headers?.MessageType??m.properties?.headers?.messageType??'unknown';if(Object.keys(metrics.headersByType).length<128||metrics.headersByType[type])metrics.headersByType[type]=(metrics.headersByType[type]||0)+1;
  if(m.content.byteLength>16*1024**2){fail(Error('INBOX_MESSAGE_TOO_LARGE'));void connection?.close().catch(()=>{});return;}
  if(pending.reduce((n,r)=>n+r.content.byteLength,0)+m.content.byteLength>8*1024**2){flush();if(intakePaused){if(channel)channel.nack(m,false,true);else fail(Error('OFFLINE_CAPACITY_PAUSE_REQUIRES_REDELIVERY'));return;}}
  pending.push({...m,received:Date.now(),original:m});if(pending.length>=100)flush();else if(!flushTimer)flushTimer=setTimeout(flush,5);
 };
 let transportEnded=false,channelEnded=false,transportClosing;
 const closeTransport=()=>transportClosing??=Promise.resolve().then(()=>{
  if(!connection||transportEnded)return;
  return new Promise(resolve=>{let done=false;const finish=()=>{if(done)return;done=true;connection.removeListener('close',finish);resolve();};connection.once('close',finish);Promise.resolve().then(()=>connection.close()).then(finish,finish);});
 });
 let timer,loadTimer;
 try{
  setStage('inbox.open');inbox=openInbox(workerData.path,workerData.maxBytes);send({event:'opened',safeSeconds:inbox.safeSeconds()});
  parentPort.on('message',async m=>{try{
   if(m.action==='quiesce'){quiesced=true;callback=false;clearTimeout(pumpTimer);clearInterval(loadTimer);flush();void controlConsumer();await closeTransport();}
   if(m.action==='consume'){callback=true;pump();}
   if(m.action==='stage'){
    for(const id of m.ids){if(!inflight.has(id)||id<=stagedThrough)throw Error('INBOX_STAGE_IDENTITY');stagedThrough=id;metrics.processed++;inflight.delete(id);}
    if(!inflight.size){clearTimeout(pumpTimer);pumpTimer=setTimeout(pump,25);}
   }
   if(m.action==='complete'){
    for(const id of m.ids){if(!Number.isSafeInteger(id)||id>deliveredThrough||id>stagedThrough&&!inflight.has(id))throw Error('INBOX_COMPLETION_IDENTITY');if(inflight.has(id)){metrics.processed++;stagedThrough=Math.max(stagedThrough,id);inflight.delete(id);}}
    inbox.complete(m.ids);metrics.checkpointed+=m.ids.length;if(intakePaused){flush();resumeIntake();}report();
    if(!inflight.size){clearTimeout(pumpTimer);pumpTimer=setTimeout(pump,25);}
   }
   if(m.action==='safe'){flush();const seconds=inbox.safePoint(m.seconds,true);send({event:'safe',id:m.id,drained:true,seconds});}
   if(m.action==='offline_load'&&workerData.offline){
    const template=JSON.parse(Buffer.from(m.message.content).toString()),started=performance.now();let sent=0,burstDone=false;
    const produce=()=>{const elapsed=performance.now()-started;let target=Math.floor(Math.min(elapsed,m.durationMs)*m.rate/1000);if(elapsed>=m.burstAtMs)target+=m.burst;
      while(sent<target&&!intakePaused){const n=++sent,body=structuredClone(template);body.Header.MsgGuid='load-'+started+'-'+n;body.Header.ServerTimestamp=Date.now();if(body.Body?.Events)body.Body.Events[0].FixtureId=1+(n%100);
       receive({content:Buffer.from(JSON.stringify(body)),properties:{headers:{MessageType:body.Header.Type,FixtureId:body.Body?.Events?.[0]?.FixtureId}},fields:{redelivered:false}});}
      if(elapsed>=m.durationMs&&sent>=target){clearInterval(loadTimer);flush();report();send({event:'load_complete',sent,durationMs:elapsed});}
    };loadTimer=setInterval(produce,10);
   }
   if(m.action==='offline'&&workerData.offline){for(const row of m.messages)receive({...row,content:Buffer.from(row.content)});flush();report();}
   if(m.action==='close'){closed=true;clearInterval(timer);clearInterval(loadTimer);clearTimeout(pumpTimer);flush();await closeTransport();loop.disable();inbox.close();send({event:'closed'});parentPort.close();}
  }catch(e){fail(e,m.action==='complete'?'inbox.complete':m.action==='close'?'actor.shutdown':m.action==='quiesce'?'transport.close':failureStage);}});
  if(!workerData.offline){
   setStage('amqp.connect');const amqp=await import('amqplib');const p=workerData.pkg;
   connection=await amqp.connect({protocol:p.tls?'amqps':'amqp',hostname:p.hostname,port:p.port,username:p.mqUsername??p.username,password:p.mqPassword??p.password,vhost:p.vhost,heartbeat:30},{timeout:15000,...(p.tls?{servername:p.hostname}:{})});
   connection.on('error',fail);connection.on('close',()=>{transportEnded=true;if(!closed&&!quiesced)send({event:'transport_closed'});});
   setStage('amqp.channel');channel=await connection.createChannel();channel.on('error',fail);channel.on('close',()=>{channelEnded=true;if(!closed&&!quiesced)send({event:'transport_closed'});});setStage('amqp.prefetch');await channel.prefetch(100);
   setStage('amqp.consume');await controlConsumer();
  }
  setStage('actor.ready');send({event:'ready'});timer=setInterval(report,1000);
 }catch(e){fail(e);parentPort.close();}
}

// amqplib-compatible facade: ack here means business checkpoint committed, NOT broker ACK.
// Broker ACK happens solely in the transport thread after SQLite FULL commit.
export async function connectDurableMq(pkg,path,onMetrics=()=>{},options={}){
 const ownerPath=resolve(path),owner=Symbol(),actorId=randomUUID();const sessionId=typeof options.sessionId==='string'&&/^[0-9a-f-]{36}$/.test(options.sessionId)?options.sessionId:undefined;
 if(inboxOwners.has(ownerPath)){const e=Error('INBOX_ACTOR_ALREADY_OWNED');console.error(JSON.stringify({operation:'inbox.actor_failure',lane:pkg?.lane,sessionId,ingressActorId:actorId,...ingressFailureDetails(e,'actor.ownership')}));throw e;}inboxOwners.set(ownerPath,owner);
 let worker;try{worker=new Worker(new URL('./durable-ingress.mjs',import.meta.url),{workerData:{pkg,path,...options},resourceLimits:{maxOldGenerationSizeMb:192}});}catch(error){inboxOwners.delete(ownerPath);console.error(JSON.stringify({operation:'inbox.actor_failure',lane:pkg?.lane,sessionId,ingressActorId:actorId,...ingressFailureDetails(error,'actor.spawn')}));throw error;}
 let exited=false,resolveExit;const exitPromise=new Promise(r=>resolveExit=r);let closePromise;
 const connection=new EventEmitter(),channel=new EventEmitter();let callback,closed=false,resolveClose,readyResolve,readyReject;const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j;});
 let loadResolve;let intakePaused=false;let recoveryAnchor;const anchors=new Map();let anchorId=0;
 const waiting=[];let completing=[],staging=[];let completeScheduled=false;
 const flushOutgoing=()=>{completeScheduled=false;if(staging.length){worker.postMessage({action:'stage',ids:staging});staging=[];}if(completing.length){worker.postMessage({action:'complete',ids:completing});completing=[];}};
 const scheduleOutgoing=()=>{if(!completeScheduled){completeScheduled=true;setImmediate(flushOutgoing);}};
 console.info(JSON.stringify({operation:'inbox.actor_lifecycle',lane:pkg?.lane,sessionId,ingressActorId:actorId,status:'spawned'}));
 worker.on('message',m=>{
  if(m.event==='startup_stage')console.info(JSON.stringify({operation:'inbox.actor_lifecycle',lane:pkg?.lane,sessionId,ingressActorId:actorId,status:'initializing',ingressStage:m.stage}));
  if(m.event==='load_complete')loadResolve?.(m);
  if(m.event==='capacity'){intakePaused=m.paused;console.info(JSON.stringify({operation:'inbox.intake_capacity',lane:pkg?.lane,stage:m.paused?'paused':'resumed',bytes:m.bytes,atUTC:new Date().toISOString()}));}
  if(m.event==='opened')recoveryAnchor=m.safeSeconds;
  if(m.event==='safe'){recoveryAnchor=m.seconds;anchors.get(m.id)?.(m.drained);anchors.delete(m.id);}
  if(m.event==='ready')readyResolve();
  if(m.event==='metrics')onMetrics({...m.metrics,ingressActorId:actorId});
  if(m.event==='deliveries'){for(const row of m.rows){const msg={content:Buffer.from(row.content),properties:row.properties,fields:{...row.fields,inboxId:row.id,inboxReceived:row.received}};if(callback)callback(msg);else waiting.push(msg);}}
  if(m.event==='ack_deferred')console.warn(JSON.stringify({operation:'inbox.transport_ack',lane:pkg?.lane,sessionId,ingressActorId:actorId,status:'deferred',committedRows:m.committedRows,...m.details}));
  if(m.event==='failure'){console.error(JSON.stringify({operation:'inbox.actor_failure',lane:pkg?.lane,sessionId,ingressActorId:actorId,...m.details}));const e=Object.assign(new Error(m.reason),{code:m.code});readyReject(e);if(connection.listenerCount('error'))connection.emit('error',e);}
  if(m.event==='transport_closed'&&!closed)connection.emit('close');
  if(m.event==='closed')resolveClose?.();
 });
 worker.on('error',e=>{console.error(JSON.stringify({operation:'inbox.actor_failure',lane:pkg?.lane,sessionId,ingressActorId:actorId,...ingressFailureDetails(e,'actor.thread')}));readyReject(e);if(connection.listenerCount('error'))connection.emit('error',new Error('INGRESS_THREAD_FAILED'));});
 worker.on('exit',code=>{console.info(JSON.stringify({operation:'inbox.actor_lifecycle',lane:pkg?.lane,sessionId,ingressActorId:actorId,status:'exited',exitCode:code,closeRequested:closed}));exited=true;if(inboxOwners.get(ownerPath)===owner)inboxOwners.delete(ownerPath);resolveExit();const wasClosed=closed;closed=true;for(const resolve of anchors.values())resolve(false);anchors.clear();if(!wasClosed){readyReject(Error('INGRESS_THREAD_EXITED'));connection.emit('close');}resolveClose?.();});
 Object.assign(channel,{async prefetch(){},async consume(_queue,cb){callback=cb;worker.postMessage({action:'consume'});for(const row of waiting.splice(0))cb(row);return{consumerTag:'durable-inbox-exclusive'};},stage(msg){staging.push(msg.fields.inboxId);scheduleOutgoing();},ack(msg){completing.push(msg.fields.inboxId);scheduleOutgoing();},nack(){/* Retain durable row. Session failure must block/recover rather than delete it. */}});
 Object.assign(connection,{intakePaused:()=>intakePaused,async crashOfflineForTest(){if(!options.offline)throw Error('OFFLINE_ONLY');await worker.terminate();},offlineLoad(config){const p=new Promise(r=>loadResolve=r);worker.postMessage({action:'offline_load',...config});return p;},recoveryAnchor:()=>recoveryAnchor,async checkpointAnchor(seconds){if(closed)return false;const id=++anchorId;const p=new Promise(r=>anchors.set(id,r));worker.postMessage({action:'safe',seconds,id});const ok=await p;return ok;},async createChannel(){return channel;},quiesce(){if(!closed&&!exited)worker.postMessage({action:'quiesce'});},close(){return closePromise??=(async()=>{if(exited)return;console.info(JSON.stringify({operation:'inbox.actor_lifecycle',lane:pkg?.lane,sessionId,ingressActorId:actorId,status:'closing',ingressStage:'actor.shutdown'}));closed=true;for(const resolve of anchors.values())resolve(false);anchors.clear();const p=new Promise(r=>resolveClose=r);flushOutgoing();worker.postMessage({action:'close'});await p;await exitPromise;})();},offline(messages){worker.postMessage({action:'offline',messages});}});
 try{await ready;}catch(e){await connection.close();throw e;}return connection;
}
