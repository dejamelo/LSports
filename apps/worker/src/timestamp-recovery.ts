import {decodeMessage} from "./messages.js";
import {readFile,writeFile,copyFile,mkdir,rename,access,open,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {Lane,TimestampRecovery} from '@lsports/contracts';
import {TradeState} from './state.js';
import {restore,checkpoint} from './persistence.js';
export interface RecoveryCandidate {lane:Lane;rowKey:string;marketId:number;selectionId:string;previousVersion:string;baselineVersion:string;snapshotReceivedAt:string;settlement?:{code:number;receivedAt:string;rawLastUpdate:string|number|null}}
// A future snapshot version is quarantined, not converted to an assumed timezone.
// Requires individual evidence of a recent, explicitly zoned AMQP quote rejected as older.
export async function planTimestampRecovery(path:string,fixtureId:number,marketId:number,now=Date.now(),mode:"quotes"|"settlements"="quotes") {
 const state=new TradeState();await restore(state,path);const candidates:RecoveryCandidate[]=[];const excluded:{selectionId:string;reason:string}[]=[];
 for(const lane of ['prematch','inplay'] as const)for(const [key,row]of state.rows[lane]){
  if(!row.outright||Number(String(key).split(':').at(-1))!==fixtureId)continue;
  for(const bet of row.markets.get(String(marketId))?.bets||[]){
   const betKey=`${marketId}:${bet.id}`,trace=row.settlementAudit?.get(betKey),snapshot=trace?.lastSnapshot,amqp=mode==="settlements"?trace?.last42:trace?.last41;
   const old=row.betAt.get(betKey),snapAt=Date.parse(snapshot?.versionAt||''),received=Date.parse(snapshot?.receivedAt||''),baseline=Date.parse(amqp?.versionAt||''),observed=Date.parse(amqp?.receivedAt||'');
   let reason='';
   if(row.timestampRecovery?.has(betKey))reason='already_prepared';
   else if(Number.isInteger(bet.settlement)&&bet.settlement!==0)reason='explicit_settlement_preserved';
   else if(!snapshot||snapshot.timestamp?.orderingSafe===true||old!==snapAt||!(snapAt>received+300000))reason='no_matching_unverified_future_snapshot';
   else if(!amqp||amqp.timestamp?.timezone!=='explicit'||amqp.timestamp.orderingSafe!==true||!Number.isFinite(baseline)||!(baseline<snapAt)||Date.parse(amqp.timestamp.normalizedUtc||'')!==baseline||(mode==="quotes"&&observed<received)||baseline>observed+300000||observed>now+5000||(mode==="quotes"&&now-observed>900000))reason='no_recent_explicit_amqp_evidence';
   if(!reason&&mode==="settlements"&&(!amqp||amqp.field!=="integer"||![-1,1,2,3,4,5].includes(amqp.code!)||amqp.decision!=="ignored_older"))reason='no_rejected_explicit_settlement';
   const newer=trace?.lastNumeric;
   if(!reason&&mode==="settlements"&&newer?.timestamp?.orderingSafe===true&&newer.timestamp.timezone==="explicit"&&Date.parse(newer.versionAt)>baseline)reason='newer_explicit_result_evidence';
   if(reason)excluded.push({selectionId:bet.id,reason});
   else candidates.push({lane,rowKey:String(key),marketId,selectionId:bet.id,previousVersion:new Date(old!).toISOString(),baselineVersion:new Date(baseline).toISOString(),snapshotReceivedAt:new Date(received).toISOString(),...(mode==="settlements"?{settlement:{code:amqp!.code!,receivedAt:amqp!.receivedAt,rawLastUpdate:amqp!.timestamp!.rawLastUpdate}}:{})});
  }
 }
 return {fixtureId,marketId,mode,candidates,excluded};
}
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const fingerprint=(db:DatabaseSync)=>hash(JSON.stringify(db.prepare('SELECT id,body FROM tickets ORDER BY id').all()));
export async function applyTimestampRecovery(path:string,database:string,fixtureId:number,marketId:number,now=Date.now(),mode:"quotes"|"settlements"="quotes"){
 // Caller must stop API/worker. Never remove an existing owner's lock.
 try{await access(`${path}.lock`);throw new Error('Stop the worker before recovery; lock preserved');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const lock=await open(`${path}.lock`,'wx',0o600);await lock.writeFile(String(process.pid));
 try {
 const original=await readFile(path);const plan=await planTimestampRecovery(path,fixtureId,marketId,now,mode);
 if(!plan.candidates.length)throw new Error('No eligible selections; no files changed');
 const auditId=randomUUID(),backup=join(dirname(path),`timestamp-recovery-${auditId}`);await mkdir(backup,{mode:0o700});
 await copyFile(path,join(backup,'feed.before.json'),constants.COPYFILE_EXCL);
 const db=new DatabaseSync(database,{readOnly:true});let ticketFingerprint:string;
 try{
  ticketFingerprint=fingerprint(db);
  const target=join(backup,'tickets.before.sqlite').replaceAll("'","''");db.exec(`VACUUM INTO '${target}'`);
  const saved=new DatabaseSync(join(backup,'tickets.before.sqlite'),{readOnly:true});try{if(fingerprint(saved)!==ticketFingerprint)throw new Error('Ticket backup verification failed');}finally{saved.close();}
 }finally{db.close();}
 const state=new TradeState();await restore(state,path);
 for(const c of plan.candidates){const row=state.rows[c.lane].get(c.rowKey)!;const key=`${marketId}:${c.selectionId}`;
  const recovery:TimestampRecovery={auditId,status:c.settlement?'awaiting_settlement_replay':'awaiting_fresh_amqp',...(c.settlement?{replayCode:c.settlement.code,replayReceivedAt:c.settlement.receivedAt}:{}),previousVersion:c.previousVersion,baselineVersion:c.baselineVersion,preparedAt:new Date(now).toISOString()};
  (row.timestampRecovery||=new Map()).set(key,recovery);row.betAt.set(key,Date.parse(c.baselineVersion));row.freshBets?.delete(key);
  if(c.settlement){
    // Reconstruct only fields proven by the persisted provider observation; no quote,
    // fixture status or inferred market result is introduced by this local replay.
    const decoded=decodeMessage(Buffer.from(JSON.stringify({Header:{Type:42,MsgGuid:`recovery:${auditId}:${c.selectionId}`,ServerTimestamp:Date.parse(c.settlement.receivedAt)},Body:{Competition:{Id:row.outright!.competitionId,Events:[{FixtureId:fixtureId,Markets:[{Id:marketId,Bets:[{Id:c.selectionId,Settlement:c.settlement.code,LastUpdate:c.settlement.rawLastUpdate}]}]}]}}})));
    state.apply(c.lane,decoded.events.map(e=>({...e,localReplay:true})),decoded.at);
    if(row.timestampRecovery!.get(key)?.status!=='settlement_replayed')throw new Error('Settlement replay not applied; original checkpoint preserved');
  }
 }
 for(const lane of ['prematch','inplay']as const)state.set(lane,{phase:'stopped',message:mode==='settlements'?'Resultados explícitos reprocessados; pendiente reconciliación normal de billetes.':'Recuperación de versiones preparada; se requieren cuotas AMQP nuevas.'});
 // Keep unknown top-level fields; only rebuild the public projection and optional checkpoint fields.
 const raw=JSON.parse(original.toString());const next=JSON.stringify({...raw,...state.feed(now),workerCheckpoint:checkpoint(state)});
 const manifest={auditId,preparedAt:new Date(now).toISOString(),policy:mode==='settlements'?'replay-explicit-rejected-settlements-v1':'quarantine-future-snapshot-require-explicit-live-quote-v1',mode,fixtureId,marketId,candidates:plan.candidates,beforeSha256:hash(original),afterSha256:hash(next),ticketFingerprint,backup};
 await writeFile(join(backup,'audit.json'),JSON.stringify(manifest,null,2),{mode:0o600,flag:'wx'});
 // Fail safely if another process changed state/tickets during backup.
 if(hash(await readFile(path))!==hash(original))throw new Error('Checkpoint changed during recovery; backup retained, no overwrite');
 const verify=new DatabaseSync(database,{readOnly:true});try{if(fingerprint(verify)!==ticketFingerprint!)throw new Error('Tickets changed; stop API before recovery');}finally{verify.close();}
 const temp=`${path}.${auditId}.recovery.tmp`;await writeFile(temp,next,{mode:0o600,flag:'wx'});await rename(temp,path);
 return {...manifest,status:mode==='settlements'?'settlement_replayed_awaiting_normal_reconciliation':'awaiting_fresh_amqp',ticketsModified:false};
 }finally{await lock.close();await rm(`${path}.lock`,{force:true});}
}
