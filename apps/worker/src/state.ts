import {getHeapStatistics} from 'node:v8';
import {jsonItems,maskEventAvailability,type AvailabilityBlocks} from '@lsports/feed-store';
import { timestampOrder } from './timestamp-contract.js';
import { SettlementType, OutrightScoreStatus } from "trade360-nodejs-sdk";
import { marketStatusLabel, settlementLabel } from "@lsports/contracts";
import type {
  ConnectionState,
  OutrightMarketDiagnostic,
  CoverageStats,
  SnapshotAudit,
  EventFeed,
  EventMarket,
  Lane,
  Sport,
  SportEvent,
} from "@lsports/contracts";
import type { Fixture, Livescore, Market, OutrightFixtureEvent, OutrightScoreUpdate } from "trade360-nodejs-sdk";
type OutrightScore = NonNullable<NonNullable<NonNullable<OutrightScoreUpdate["competition"]>["events"]>[number]["outrightScore"]>;
export interface TradeEvent {
  fixtureId: number;
  outright?: { competitionId: number; competitionName?: string; competitionType?: number; leagueSeason?: {id:number;name?:string;type?:number}; fixtureName?:string; fixture?: NonNullable<OutrightFixtureEvent["outrightFixture"]> };
  fixture?: Fixture;
  livescore?: Livescore;
  outrightScore?: OutrightScore;
  markets?: Market[];
  marketMessageType?: 40 | 41 | 42;
  marketRecovery?: boolean;
  localReplay?: boolean;
  settlementInspection?: ReturnType<typeof import("./settlement-evidence.js").inspectSettlements>;
}
interface Versioned<T> {
  value: T;
  at: number;
}
export interface Row {
  observation?:import("@lsports/contracts").FeedObservation;
  restored?: boolean;
  fixture?: Versioned<Fixture>;
  outright?: TradeEvent["outright"];
  marketReceipt?: { messagesByType: Record<string, number>; marketUpdates: number; betUpdates: number; providerMarketUpdates: number; providerBetUpdates: number; staleBetUpdates: number; lastMarketMessageAt?: string; snapshotMarketUpdates?: number; lastMarketSnapshotAt?: string };
  livescore?: Versioned<Livescore>;
  outrightScore?: Versioned<OutrightScore>;
  markets: Map<string, Market>;
  marketAt: Map<string, number>;
  betAt: Map<string, number>;
  betOrder?: Map<string,string>;
  freshBets?: Set<string>;
  quoteInvalidations?: Set<string>; // Sparse session-only revocations; never restored as confirmation.
  deferredTimestampBets?: Map<string, {marketId:number;selectionId:string;bet:NonNullable<Market["bets"]>[number];inspection:import("@lsports/contracts").TimestampInspection;receivedAt:string}>;
  timestampRecovery?: Map<string, import("@lsports/contracts").TimestampRecovery>;
  settlementAudit?: Map<string, import("@lsports/contracts").SettlementTrace>;
  settlementMarkets?: Map<string, import("@lsports/contracts").SettlementMarketEvidence>;
  // Session evidence only: a checkpoint must never restore quote confirmation.
  snapshotBets?: Map<string, import("@lsports/contracts").SnapshotQuoteObservation>;
}
const preciseOrder=Symbol('preciseBetOrder');
type OrderedBet=NonNullable<Market['bets']>[number]&{[preciseOrder]?:string};
export const preciseBetOrder=(row:Row,key:string,bet?:object)=>((bet as OrderedBet|undefined)?.[preciseOrder]??row.betOrder?.get(key));
function setOrder(row:Row,key:string,bet:object,order:string,t:number){
  const value=bet as OrderedBet;
  if(BigInt(order)===BigInt(t)*1000000n){delete value[preciseOrder];row.betOrder?.delete(key);return;}
  Object.defineProperty(value,preciseOrder,{value:order,writable:true,configurable:true});row.betOrder?.delete(key);
}
export function* persistedBetOrders(row:Row):Generator<[string,string]>{
  if(row.betOrder)yield* row.betOrder;
  for(const [marketId,market] of row.markets)for(const bet of market.bets||[]){
    const order=(bet as OrderedBet)[preciseOrder];if(order!==undefined)yield [`${marketId}:${bet.id}`,order];
  }
}
export function restorePreciseBetOrders(row:Row){
  if(!row.betOrder?.size){row.betOrder=undefined;return;}
  const indexes=new Map<string,Map<string,NonNullable<Market['bets']>[number]>>();
  for(const [key,order] of row.betOrder){const split=key.indexOf(':');if(split<1)continue;const marketId=key.slice(0,split),selectionId=key.slice(split+1);let index=indexes.get(marketId);if(!index){const market=row.markets.get(marketId);if(!market?.bets)continue;index=new Map(market.bets.map(bet=>[String(bet.id),bet]));indexes.set(marketId,index);}const bet=index.get(selectionId);if(!bet)continue;Object.defineProperty(bet,preciseOrder,{value:order,writable:true,configurable:true});row.betOrder.delete(key);}
  if(!row.betOrder.size)row.betOrder=undefined;
}
function transferPreciseBetOrders(source:Row,target:Row){for(const [marketId,market] of source.markets){const destination=target.markets.get(marketId);if(!destination?.bets)continue;for(let i=0;i<(market.bets?.length||0);i++){const order=(market.bets![i] as OrderedBet)[preciseOrder];if(order===undefined)continue;const bet=destination.bets.find(candidate=>candidate.id===market.bets![i].id);if(bet)Object.defineProperty(bet,preciseOrder,{value:order,writable:true,configurable:true});}}}
const snapshotEpochByRow=new WeakMap<Row,object>();
const snapshotEpochByBet=new WeakMap<object,object>();
export function quoteConfirmed(row:Row,key:string,bet?:object){const epoch=snapshotEpochByRow.get(row);return !row.quoteInvalidations?.has(key)&&(row.freshBets?.has(key)===true||!!bet&&!!epoch&&snapshotEpochByBet.get(bet)===epoch||!row.timestampRecovery?.has(key)&&row.snapshotBets?.get(key)?.decision==='confirmed');}
function selectionReasons(row:Row,m:Market,b:NonNullable<Market['bets']>[number],status:number|undefined,connection:ConnectionState,deferred=false){return [
              ...(!deferred&&connection.phase !== "connected" ? ["feed_disconnected"] : []),
              ...(!deferred&&connection.ingressProgress && (connection.ingressProgress!.processingBacklog??connection.ingressProgress!.backlog) > 0 && (connection.ingressProgress!.oldestProcessingAgeMs??connection.ingressProgress!.oldestAgeMs) > 5000 ? ["processing_backlog"] : []),
              ...(![1, 2, 9].includes(status ?? 0) ? ["event_inactive"] : []),
              ...(m.status !== 1 ? [m.status === 3 ? "market_settled" : "market_not_open"] : []),
              ...((b.betStatusId ?? b.status) !== 1 ? ["selection_not_open"] : []),
              ...(b.settlement !== undefined && b.settlement !== 0 ? ["selection_settled"] : []),
              ...(!(Number(b.price) > 1 && Number.isFinite(Number(b.price))) ? ["invalid_price"] : []),
              ...(row.deferredTimestampBets?.has(`${m.id}:${b.id}`) ? ["ambiguous_snapshot_timestamp"] : []),
              ...(row.timestampRecovery?.get(`${m.id}:${b.id}`)?.status === "awaiting_fresh_amqp" ? ["awaiting_timestamp_recovery"] : []),
              ...(row.restored && !quoteConfirmed(row,`${m.id}:${b.id}`,b) ? ["awaiting_update"] : []),
            ];}
function hasSelectableSelection(row:Row,m:Market,b:NonNullable<Market['bets']>[number],status:number|undefined,connection:ConnectionState){
 if(connection.phase!=="connected")return false;
 const ingress=connection.ingressProgress;
 if(ingress&&(ingress.processingBacklog??ingress.backlog)>0&&(ingress.oldestProcessingAgeMs??ingress.oldestAgeMs)>5000)return false;
 if(![1,2,9].includes(status??0)||m.status!==1||(b.betStatusId??b.status)!==1)return false;
 if(b.settlement!==undefined&&b.settlement!==0)return false;
 const price=Number(b.price);if(!(price>1&&Number.isFinite(price)))return false;
 const key=`${m.id}:${b.id}`;
 return !row.deferredTimestampBets?.has(key)&&row.timestampRecovery?.get(key)?.status!=="awaiting_fresh_amqp"&&(!row.restored||quoteConfirmed(row,key,b));
}
const startTimeFormatter=new Intl.DateTimeFormat('es-AR',{
 timeZone:'America/Argentina/Buenos_Aires',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'
});
const statusLabels: Record<number, string> = {
  0: "Sin estado",
  1: "Prepartido",
  2: "En vivo",
  3: "Finalizado",
  4: "Cancelado",
  5: "Postergado",
  6: "Interrumpido",
  7: "Abandonado",
  8: "Sin cobertura",
  9: "Por comenzar",
};
export function classifySport(name = ""): Sport {
  const n = name.toLowerCase();
  if (/horse racing|horse-racing|carreras de caballos|hípica/.test(n))
    return "hipica";
  if (/soccer|football|fútbol/.test(n) && !/american|australian/.test(n))
    return "futbol";
  if (/tennis|tenis/.test(n) && !/table/.test(n)) return "tenis";
  if (/basketball|básquet/.test(n)) return "basquet";
  return "otros";
}
const timestamp = (value: unknown, fallback: number) => {
  const n = value ? new Date(value as string).getTime() : NaN;
  return Number.isFinite(n) ? n : fallback;
};
/** Millisecond quote versions are already present on stored bets. Keep only
 * fallback timestamps that cannot be reconstructed from LastUpdate. */
export function betVersionAt(row:Row,marketId:string|number,bet:{id:string|number;lastUpdate?:unknown}):number|undefined{
  const key=`${marketId}:${bet.id}`,saved=row.betAt.get(key);
  if(saved!==undefined)return saved;
  const fromBet=timestamp(bet.lastUpdate,NaN);
  return Number.isFinite(fromBet)?fromBet:undefined;
}
export function compactBetAt(markets:Map<string,Market>,entries:Iterable<[string,number]>):Map<string,number>{
  const lastUpdates=new Map<string,number>();
  for(const [marketId,market] of markets)for(const bet of market.bets||[]){
    const at=timestamp(bet.lastUpdate,NaN);
    if(Number.isFinite(at))lastUpdates.set(`${marketId}:${bet.id}`,at);
  }
  const sparse=new Map<string,number>();
  for(const [key,at] of entries)if(lastUpdates.get(key)!==at)sparse.set(key,at);
  return sparse;
}
const defined = <T extends object>(value: T) =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
export class TradeState {
  private mutationGenerationValue = 0;
  get mutationGeneration() { return this.mutationGenerationValue; }
  private noteMutation() { this.mutationGenerationValue++; }
  // Opt-in worker publication cache: immutable event projections; never raw SDK rows.
  private mutationTail:Promise<void>=Promise.resolve();
  exclusive<T>(operation:()=>T|Promise<T>):Promise<T>{
    const result=this.mutationTail.then(operation);this.mutationTail=result.then(()=>{},()=>{});return result;
  }
  private projectionCaptured=new WeakSet<Row>();
  private publicationCaptured=new WeakSet<Row>();
  private publicationDone?:Promise<void>;
  publicationIdle(){return this.publicationDone??Promise.resolve();}
  private publicationPhase='idle';
  private publicationStarted=0;
  setPublicationPhase(phase:string){this.publicationPhase=phase;}
  publicationStatus(){return {publicationStage:this.publicationPhase,publicationElapsedMs:this.publicationStarted?Date.now()-this.publicationStarted:0};}
  async publicationMutation<T>(operation:()=>T,waiting?:(active:boolean)=>void):Promise<T>{
    for(;;){
      // Inspect under the gate, but wait outside it. Recheck after every wait:
      // another publication may have captured before this mutation gets its turn.
      const turn=await this.exclusive(async()=>{
        if(this.publicationDone){const v=getHeapStatistics();if(v.heap_size_limit-v.used_heap_size<512*1024**2){
          console.info(JSON.stringify({operation:'state.publication_wait',stage:'heap_reserve',heapHeadroomBytes:v.heap_size_limit-v.used_heap_size,...this.publicationStatus(),atUTC:new Date().toISOString()}));
          return {wait:this.publicationDone};
        }}
        return {value:await operation()};
      });
      if(!('wait' in turn))return turn.value as T;
      waiting?.(true);try{await turn.wait;}finally{waiting?.(false);}
    }
  }
  capturePublication(){
    if(this.publicationDone)throw Error('PUBLICATION_CAPTURE_OVERLAP');
    this.publicationStarted=Date.now();this.publicationPhase='capture';
    const captured=Object.create(this) as TradeState;
    captured.mutationGenerationValue=this.mutationGenerationValue;
    captured.rows={prematch:new Map(this.rows.prematch),inplay:new Map(this.rows.inplay)};
    captured.connections=structuredClone(this.connections);captured.metrics=structuredClone(this.metrics);
    for(const lane of ['prematch','inplay'] as const)for(const row of captured.rows[lane].values())this.publicationCaptured.add(row);
    let done!:()=>void;this.publicationDone=new Promise<void>(resolve=>done=resolve);let released=false;
    return {state:captured,release:()=>{if(released)return;released=true;for(const lane of ['prematch','inplay'] as const)for(const row of captured.rows[lane].values())this.publicationCaptured.delete(row);this.publicationDone=undefined;this.publicationStarted=0;this.publicationPhase='idle';done();}};
  }
  private projectionCache=new WeakMap<Row,{context:string;event:SportEvent}>();
  restoration?:import("@lsports/contracts").EventFeed["restoration"];
  rows: Record<Lane, Map<number | string, Row>> = {
    prematch: new Map(),
    inplay: new Map(),
  };
  metrics: Record<
    Lane,
    {
      snapshot?: SnapshotAudit;
      activity?:import("@lsports/contracts").FeedActivity;
      messages: number;
      messagesByType: Record<string, number>;
      eventUpdatesReceived: number;
      duplicateMessages: number;
      keepAliveActiveEvents?: number;
      marketsWithoutId: number;
      staleUpdatesIgnored: number;
    }
  > = {
    prematch: {
      messages: 0,
      messagesByType: {},
      eventUpdatesReceived: 0,
      duplicateMessages: 0,
      marketsWithoutId: 0,
      staleUpdatesIgnored: 0,
    },
    inplay: {
      messages: 0,
      messagesByType: {},
      eventUpdatesReceived: 0,
      duplicateMessages: 0,
      marketsWithoutId: 0,
      staleUpdatesIgnored: 0,
    },
  };
  recordMessage(
    lane: Lane,
    type: number,
    events: number,
    duplicate: boolean,
    keepAliveActiveEvents?: number,
    decodedAt = Date.now(),
    receivedAt = decodedAt,
  ) {
    this.noteMutation();
    const m = this.metrics[lane];
    m.messages++;
    const now=new Date(decodedAt).toISOString(),activity=(m.activity ||= {});
    activity.lastDecodedAt=now;
    if(type===31||type===32)activity.lastControlDecodedAt=now;
    else if(duplicate)activity.lastDuplicateDecodedAt=now;
    else if(events>0){
      activity.lastDataDecodedAt=now;activity.lastDataReceivedAt=new Date(receivedAt).toISOString();
      if([1,2,37,38,39].includes(type))activity.lastEventDecodedAt=now;
      if([3,40,41].includes(type)){activity.lastMarketDecodedAt=now;activity.lastMarketReceivedAt=new Date(receivedAt).toISOString();}
      if([35,42].includes(type)){activity.lastSettlementDecodedAt=now;activity.lastSettlementReceivedAt=new Date(receivedAt).toISOString();}
    }
    m.messagesByType[String(type)] = (m.messagesByType[String(type)] || 0) + 1;
    m.eventUpdatesReceived += events;
    if (duplicate) m.duplicateMessages++;
    if (keepAliveActiveEvents !== undefined)
      m.keepAliveActiveEvents = keepAliveActiveEvents;
  }
  connections: Record<Lane, ConnectionState> = {
    prematch: { phase: "starting", message: "Esperando conexión PreMatch" },
    inplay: { phase: "starting", message: "Esperando conexión InPlay" },
  };
  outrightFixtureIds(lane: Lane) {
    return [...new Set([...this.rows[lane]].filter(([, row]) => !!row.outright).map(([key]) => Number(String(key).split(":").at(-1))))];
  }
  set(lane: Lane, patch: Partial<ConnectionState>) {
    Object.assign(this.connections[lane], patch);
    if (Object.keys(patch).some(key => key !== "persistenceProgress")) this.noteMutation();
  }
  apply(lane: Lane, events: TradeEvent[], at: number, observation?:{source:"amqp"|"snapshot";receivedAt:number}) {
    if(events.length)this.noteMutation();
    for (const event of events) {
      if (!Number.isSafeInteger(event.fixtureId) || event.fixtureId <= 0)
        throw new Error("Invalid provider fixture ID");
      // Bound timestamp interning to one fixture update: identical primitive ISO
      // values need not be separately allocated for every selection observation.
      const snapshotObservations=new Map<string,import("@lsports/contracts").SnapshotQuoteObservation>();
      const isoTimes=new Map<number,string>();const isoTime=(n:number)=>{let value=isoTimes.get(n);if(value===undefined){value=new Date(n).toISOString();if(isoTimes.size<1024)isoTimes.set(n,value);}return value;};
      const key = event.outright ? `outright:${event.outright.competitionId}:${event.fixtureId}` : event.fixtureId;
      let row = this.rows[lane].get(key);
      if (!row) {
        row = { markets: new Map(), marketAt: new Map(), betAt: new Map() };
        this.rows[lane].set(key, row);
      }
      if((this.projectionCaptured.has(row)||this.publicationCaptured.has(row))){const prior=row;row=structuredClone(row);transferPreciseBetOrders(prior,row);this.rows[lane].set(key,row);const epoch=snapshotEpochByRow.get(prior);if(epoch)snapshotEpochByRow.set(row,epoch);}
      this.projectionCache.delete(row);
      if(observation){
        const at=new Date(observation.receivedAt).toISOString();
        const proof=(row.observation ||= {});
        if(observation.source==='snapshot')proof.snapshotReceivedAt=at;
        else {
          proof.amqpEventReceivedAt=at;
          if(event.markets?.length)proof.amqpMarketReceivedAt=at;
        }
      }
      if (event.outright) {
        const incoming = event.outright;
        row.outright = { ...row.outright, ...defined(incoming), competitionId: incoming.competitionId };
        if (incoming.fixture) {
          const t = timestamp(incoming.fixture.lastUpdate, at);
          if (!row.fixture || t >= row.fixture.at)
            row.fixture = { value: { ...row.fixture?.value, ...defined(incoming.fixture) } as Fixture, at: t };
          else this.metrics[lane].staleUpdatesIgnored++;
        }
        if (event.marketMessageType || event.marketRecovery) {
          const receipt = row.marketReceipt ||= { messagesByType: {}, marketUpdates: 0, betUpdates: 0, providerMarketUpdates: 0, providerBetUpdates: 0, staleBetUpdates: 0 };
          if (event.marketRecovery) {
            receipt.snapshotMarketUpdates = (receipt.snapshotMarketUpdates || 0) + (event.markets?.length || 0);
            receipt.lastMarketSnapshotAt = isoTime(at);
          }
          if (event.marketMessageType && !event.localReplay) {
          const type = String(event.marketMessageType);
          receipt.messagesByType[type] = (receipt.messagesByType[type] || 0) + 1;
          receipt.marketUpdates += event.markets?.length || 0;
          receipt.betUpdates += (event.markets || []).reduce((n, m) => n + (m.bets?.length || 0), 0);
          receipt.providerMarketUpdates += (event.markets || []).reduce((n, m) => n + (m.providerMarkets?.length || 0), 0);
          receipt.providerBetUpdates += (event.markets || []).reduce((n, m) => n + (m.providerMarkets || []).reduce((count, provider) => count + (provider.Bets?.length || 0), 0), 0);
          receipt.lastMarketMessageAt = new Date(Math.max(at, Date.parse(receipt.lastMarketMessageAt || '') || 0)).toISOString();
          }
        }
      }
      if (event.outrightScore) {
        if (!row.outrightScore || at >= row.outrightScore.at) {
          row.outrightScore = {value: {...row.outrightScore?.value, ...defined(event.outrightScore)}, at};
        } else this.metrics[lane].staleUpdatesIgnored++;
      }
      if (event.fixture) {
        const t = timestamp(event.fixture.lastUpdate, at);
        if (!row.fixture || t >= row.fixture.at)
          row.fixture = {
            value: { ...row.fixture?.value, ...defined(event.fixture) },
            at: t,
          };
        else this.metrics[lane].staleUpdatesIgnored++;
      }
      if (event.livescore && (!row.livescore || at >= row.livescore.at))
        row.livescore = {
          value: { ...row.livescore?.value, ...defined(event.livescore) },
          at,
        };
      else if (event.livescore) this.metrics[lane].staleUpdatesIgnored++;
      const settlementSource = event.marketRecovery ? "snapshot.outright.markets" : event.marketMessageType ? `amqp.${event.marketMessageType}` as const : undefined;
      if (settlementSource) for (const counts of event.settlementInspection?.counts || []) {
        const evidence = (row.settlementMarkets ||= new Map()).get(String(counts.marketId)) || {};
        evidence[settlementSource] = {...counts, receivedAt: isoTime(at)};
        row.settlementMarkets.set(String(counts.marketId), evidence);
      }
      for(const rejection of event.settlementInspection?.rejected || []) {
        (row.deferredTimestampBets ||= new Map()).set(`${rejection.marketId}:${rejection.selectionId}`, {...rejection,receivedAt:isoTime(at)});
        row.freshBets?.delete(`${rejection.marketId}:${rejection.selectionId}`);
        (row.quoteInvalidations ||= new Set()).add(`${rejection.marketId}:${rejection.selectionId}`);
      }
      const settlementFields = new Map((event.settlementInspection?.fields || []).map(f => [`${f.marketId}:${f.selectionId}`, f]));
      for (const market of event.markets || []) {
        if (market.id === undefined) {
          this.metrics[lane].marketsWithoutId++;
          continue;
        }
        const key = String(market.id);
        const old = row.markets.get(key);
        const marketTime = row.marketAt.get(key) || 0;
        const merged: Market =
          at >= marketTime ? { ...old, ...defined(market) } : { ...old };
        const bets = new Map((old?.bets || []).map((b) => [b.id, b]));
        for (const bet of market.bets || []) {
          const betKey = `${key}:${bet.id}`;
          if(event.settlementInspection?.rejected.some(r=>`${r.marketId}:${r.selectionId}`===betKey))continue;
          const t = timestamp(bet.lastUpdate, at);
          const previousBetForOrder=bets.get(bet.id);
          const previousAt = row.betAt.get(betKey) ?? (previousBetForOrder?betVersionAt(row,key,previousBetForOrder):0) ?? 0;
          const field = settlementFields.get(betKey);
          const order = field?.timestamp?.orderingKey || timestampOrder(bet.lastUpdate,t);
          const savedOrder = preciseBetOrder(row,betKey,previousBetForOrder);
          const previousOrder = savedOrder && BigInt(savedOrder)/1000000n===BigInt(previousAt) ? savedOrder : (BigInt(previousAt)*1000000n).toString();
          const older = BigInt(order)<BigInt(previousOrder);
          const recovery = row.timestampRecovery?.get(betKey);
          const recovering = recovery?.status === "awaiting_fresh_amqp";
          const replaying = recovery?.status === "awaiting_settlement_replay";
          const validatesReplay = replaying && event.marketMessageType === 42 && (field?.timestamp?.timezone === "explicit" || field?.timestamp?.contract === "lsports-217525-utc") &&
            field.timestamp.orderingSafe && field.code === recovery.replayCode && t===previousAt && at===Date.parse(recovery.replayReceivedAt || '');
          if(replaying && !validatesReplay)continue;
          // Only a new live quote with verified UTC ordering can validate a quarantined version.
          const validatesRecovery = recovering && event.marketMessageType === 41 && (field?.timestamp?.timezone === "explicit" || field?.timestamp?.contract === "lsports-217525-utc") &&
            field.timestamp.orderingSafe && Number.isFinite(Number(bet.price)) && Number(bet.price)>1 &&
            BigInt(order)>BigInt(previousOrder) && t<=at+300000 && at>=Date.parse(recovery.preparedAt);
          if(recovering && !validatesRecovery) continue;
          if (settlementSource && field) {
            const observation: import("@lsports/contracts").SettlementObservation = {
              source: settlementSource, receivedAt: isoTime(at), versionAt: isoTime(t),
              field: field.field, code: field.code, timestamp: field.timestamp,
              decision: field.field === "missing" ? "ignored_missing" : field.field === "null" ? "ignored_null" : older ? "ignored_older" : "stored",
            };
            const trace = (row.settlementAudit ||= new Map()).get(betKey) || {};
            trace[settlementSource === "amqp.42" ? "last42" : settlementSource === "amqp.41" ? "last41" : settlementSource === "amqp.40" ? "last40" : "lastSnapshot"] = observation;
            if (field.field === "integer") trace.lastNumeric = observation;
            row.settlementAudit.set(betKey, trace);
          }
          const hasPrice = bet.price !== undefined && Number.isFinite(Number(bet.price)) && Number(bet.price) > 1;
            const previousBet=bets.get(bet.id),wasConfirmed=quoteConfirmed(row,betKey,previousBet);
            const previousPrice=previousBet?.price,previousLastUpdate=(previousBet as any)?.lastUpdate;
          let snapshotDecision:string|undefined;
          if (event.marketRecovery) {
            const receivedPrice=bet.price !== undefined && Number.isFinite(Number(bet.price)) ? Number(bet.price) : null;
            const decision=older ? "older_than_stored" : !hasPrice ? "missing_or_invalid_price" : "confirmed";
            snapshotDecision=decision;
            if(row.outright||!row.restored){
              const observationKey=JSON.stringify([t,receivedPrice,decision]);
              let snapshot=snapshotObservations.get(observationKey);
              if(!snapshot){snapshot=Object.freeze({receivedAt:isoTime(at),versionAt:isoTime(t),receivedPrice,decision});if(snapshotObservations.size<1024)snapshotObservations.set(observationKey,snapshot);}
              (row.snapshotBets ||= new Map()).set(betKey,snapshot);
            }
            // Confirmation is already represented by the immutable snapshot observation.
            // Keep the separate Set only for live/previous confirmation not represented there.
            if(decision==='confirmed'&&!row.timestampRecovery?.has(betKey))row.freshBets?.delete(betKey);
            else if(wasConfirmed)(row.freshBets ||= new Set()).add(betKey);
          }
          if (!older) {
            row.deferredTimestampBets?.delete(betKey);
            if(validatesReplay) {recovery.status="settlement_replayed";recovery.validatedAt=isoTime(at);}
            if(validatesRecovery) {recovery.status="validated_amqp";recovery.validatedAt=isoTime(at);}
            const incoming=defined(bet);
            const settlement=Number.isInteger(bet.settlement)?bet.settlement:previousBet?.settlement;
            // Full snapshots commonly repeat the exact persisted quote. Reuse
            // that immutable-by-convention record instead of retaining a second
            // object for every selection during checkpoint recovery.
            let storedBet:typeof bet;
            if(previousBet){
              // The current row is detached from any captured publication before
              // mutation. Updating this private record in place avoids a second
              // multi-million-object bet graph during full snapshot recovery.
              Object.assign(previousBet,incoming);
              // null/missing is absence of settlement, never an explicit correction.
              // A supplier correction to unsettled must carry numeric code 0.
              previousBet.settlement=settlement;
              storedBet=previousBet;
            }else storedBet={...incoming,settlement} as typeof bet;
            bets.set(bet.id,storedBet);const snapshotEpoch=snapshotEpochByRow.get(row);
            if(event.marketRecovery&&snapshotDecision==='confirmed'&&!row.timestampRecovery?.has(betKey)&&snapshotEpoch)snapshotEpochByBet.set(storedBet,snapshotEpoch);
            else if(!event.marketRecovery&&row.restored&&wasConfirmed&&snapshotEpoch&&previousBet){
              const nextDate=(storedBet as any).lastUpdate;
              const sameVersion=previousLastUpdate instanceof Date&&nextDate instanceof Date?previousLastUpdate.getTime()===nextDate.getTime():Object.is(previousLastUpdate,nextDate);
              if(Object.is(previousPrice,storedBet.price)&&sameVersion)snapshotEpochByBet.set(storedBet,snapshotEpoch);
            }
            // A current snapshot explicitly reconfirms an unchanged quote. Its LastUpdate
            // describes the last price change, not when the snapshot was requested.
            // A status-only delta must never validate a price read from disk.
            if (row.restored && hasPrice && (event.marketRecovery || BigInt(order)>BigInt(previousOrder))){
              row.quoteInvalidations?.delete(betKey);
              if(!event.marketRecovery||row.timestampRecovery?.has(betKey))(row.freshBets ||= new Set()).add(betKey);
            }
            // Persist only receive-time fallbacks. Normal quote versions are
            // reconstructed from LastUpdate, avoiding millions of duplicate Map entries.
            if(timestamp(storedBet.lastUpdate,NaN)===t)row.betAt.delete(betKey);
            else row.betAt.set(betKey,t);
            setOrder(row,betKey,storedBet,order,t);
          } else {
            this.metrics[lane].staleUpdatesIgnored++;
            if (row.marketReceipt) row.marketReceipt.staleBetUpdates++;
          }
        }
        merged.bets = [...bets.values()];
        row.markets.set(key, merged);
        row.marketAt.set(key, Math.max(at, marketTime));
      }
    }
  }
  beginPartitionedSnapshot(lane:Lane){
    // Keep prior outcomes/versions, but never release prices absent from this baseline.
    const snapshotEpoch={};for(const [key,original] of this.rows[lane])if(!original.outright){const row=(this.projectionCaptured.has(original)||this.publicationCaptured.has(original))?structuredClone(original):original;if(row!==original)transferPreciseBetOrders(original,row);this.rows[lane].set(key,row);snapshotEpochByRow.set(row,snapshotEpoch);this.projectionCache.delete(row);row.restored=true;row.freshBets=new Set();row.snapshotBets=new Map();}
  }
  finishPartitionedSnapshot(lane:Lane,ids:Set<number>,audit?:SnapshotAudit,liveSince?:number){
    this.rows[lane]=new Map([...this.rows[lane]].filter(([id,row])=>!!row.outright||typeof id==='number'&&(ids.has(id)||liveSince!==undefined&&Date.parse(row.observation?.amqpEventReceivedAt||'')>=liveSince)));
    this.metrics[lane].snapshot=audit;
    this.set(lane,{lastSnapshotAt:new Date().toISOString(),snapshotEvents:ids.size});
  }
  replace(lane: Lane, events: TradeEvent[], at: number, audit?: SnapshotAudit) {
    this.metrics[lane].snapshot = audit;
    this.rows[lane] = new Map([...this.rows[lane]].filter(([, row]) => !!row.outright));
    this.apply(lane, events, at,{source:"snapshot",receivedAt:Date.now()});
    this.set(lane, {
      lastSnapshotAt: new Date().toISOString(),
      snapshotEvents: events.length,
    });
  }
  availabilityBlocks():AvailabilityBlocks{
    const result:AvailabilityBlocks={};
    for(const lane of ['prematch','inplay'] as const){
      const m=this.connections[lane].ingressProgress,reasons:NonNullable<AvailabilityBlocks['prematch']>=[];
      if(this.connections[lane].phase!=='connected')reasons.push('feed_disconnected');
      if(m&&(m.processingBacklog??m.backlog)>0&&(m.oldestProcessingAgeMs??m.oldestAgeMs)>5000)reasons.push('processing_backlog');
      result[lane]=reasons;
    }return result;
  }
  // Freeze row references, not their full projected graph. Only one fixture is projected at a time, with the existing validation/quote rules.
  // Internal publication payload: lazy arrays are consumed by writeJsonObject, not JSON.stringify.
  projection(now = Date.now(),capture=true): EventFeed {
    const captured = Object.create(this) as TradeState;
    captured.rows={prematch:new Map(this.rows.prematch),inplay:new Map(this.rows.inplay)};
    if(capture)for(const lane of ['prematch','inplay'] as const)for(const row of captured.rows[lane].values())this.projectionCaptured.add(row);
    captured.connections=structuredClone(this.connections);
    captured.metrics=structuredClone(this.metrics);
    const empty=Object.create(captured) as TradeState;
    empty.rows={prematch:new Map(),inplay:new Map()};
    const base=empty.feed(now);
    const live=new Set<string>();
    for(const [id,row] of captured.rows.inplay){
      const status=(row.livescore&&row.livescore.at>=(row.fixture?.at||0)?row.livescore.value.scoreboard?.status:undefined)??row.fixture?.value.status;
      if(row.fixture&&status===2)live.add(String(id));
    }
    function* parts(onlyOutright=false){
      for(const lane of ['prematch','inplay'] as const)for(const [id,row] of captured.rows[lane]){
        if(onlyOutright&&!row.outright)continue;
        const view=Object.create(captured) as TradeState;
        view.rows={prematch:new Map(),inplay:new Map()};view.rows[lane].set(id,row);
        const part=view.feed(now,false,false,true);
        if(lane==='prematch'&&live.has(String(id)))part.events=[];
        yield {lane,part};
      }
    }
    // Coverage is a bounded pass; arrays below are generated only as written.
    let horse=false;
    for(const lane of ['prematch','inplay'] as const)Object.assign(base.coverage![lane],{
      rowsStored:0,rowsWithoutFixture:0,rowsPublished:0,rowsHiddenAsDuplicate:0,
      outrightMarketRowsWithoutFixture:0,eventsWithMarkets:0,eventsWithSelections:0,eventsWithSelectableOdds:0});
    const availabilityBlocks=captured.availabilityBlocks();
    for(const lane of ['prematch','inplay'] as const)for(const [id,row] of captured.rows[lane]){
      const target=base.coverage![lane];target.rowsStored++;
      if(!row.fixture){target.rowsWithoutFixture++;if(row.outright&&row.marketReceipt)target.outrightMarketRowsWithoutFixture=(target.outrightMarketRowsWithoutFixture??0)+1;continue;}
      horse ||= classifySport(row.fixture.value.sport?.name)==='hipica';
      if(lane==='prematch'&&live.has(String(id))){target.rowsHiddenAsDuplicate++;continue;}
      target.rowsPublished++;if(row.markets.size)target.eventsWithMarkets++;
      if([...row.markets.values()].some(m=>m.bets?.length))target.eventsWithSelections++;
      const status=(row.livescore&&row.livescore.at>=(row.fixture?.at||0)?row.livescore.value.scoreboard?.status:undefined)??row.fixture.value.status;
      let selectable=false;
      if(!availabilityBlocks[lane]?.length)for(const market of row.markets.values()){
        for(const bet of market.bets||[])if(hasSelectableSelection(row,market,bet,status,captured.connections[lane])){selectable=true;break;}
        if(selectable)break;
      }
      if(selectable)target.eventsWithSelectableOdds++;
    }
    if(horse)base.horseRacing={status:'observed',message:'Se observaron eventos de Hípica en el paquete.'};
    (base as any).events=jsonItems(function*(){for(const {part} of parts())yield* part.events;});
    (base as any).outrightDiagnostics=jsonItems(function*(){for(const {part} of parts(true))yield* part.outrightDiagnostics||[];});
    (base as any).ticketVersionRecoveries=jsonItems(function*(){
      for(const lane of ['prematch','inplay'] as const)for(const [key,row] of captured.rows[lane])
        for(const [betKey,r] of row.timestampRecovery||[]){const marketId=betKey.slice(0,betKey.indexOf(':'));
          yield {auditId:r.auditId,eventId:`${lane}:${key}`,marketId:`${lane}:${key}:${marketId}`,selectionId:`${lane}:${key}:${betKey}`,previousVersion:r.previousVersion,baselineVersion:r.baselineVersion};}
    });
    (base as any).ticketOutcomes=jsonItems(function*(){
      for(const lane of ['prematch','inplay'] as const)for(const [key,row] of captured.rows[lane])
        for(const market of row.markets.values())for(const bet of market.bets||[]){
          const at=betVersionAt(row,String(market.id),bet);if(!Number.isInteger(bet.settlement)||at===undefined)continue;
          yield {eventId:`${lane}:${key}`,marketId:`${lane}:${key}:${market.id}`,selectionId:`${lane}:${key}:${market.id}:${bet.id}`,settlement:bet.settlement!,updatedAt:new Date(at).toISOString()};}
    });
    return base;
  }
  feed(now = Date.now(),useCache=false,deferAvailability=false,projectionPart=false): EventFeed {
    const blocks=this.availabilityBlocks();
    const ticketVersionRecoveries: NonNullable<EventFeed["ticketVersionRecoveries"]> = [];
    const ticketOutcomes: NonNullable<EventFeed["ticketOutcomes"]> = [];
    if(!projectionPart)for (const lane of ["prematch", "inplay"] as const) {
      for (const [key,row] of this.rows[lane]) for(const [betKey,recovery] of row.timestampRecovery || []) {
        const marketId=betKey.slice(0,betKey.indexOf(':'));
        ticketVersionRecoveries.push({auditId:recovery.auditId,eventId:`${lane}:${key}`,marketId:`${lane}:${key}:${marketId}`,selectionId:`${lane}:${key}:${betKey}`,previousVersion:recovery.previousVersion,baselineVersion:recovery.baselineVersion});
      }
      for (const [key, row] of this.rows[lane]) for (const market of row.markets.values()) {
        for (const bet of market.bets || []) {
          const at = betVersionAt(row,String(market.id),bet);
          if (!Number.isInteger(bet.settlement) || at === undefined) continue;
          ticketOutcomes.push({eventId: `${lane}:${key}`, marketId: `${lane}:${key}:${market.id}`,
            selectionId: `${lane}:${key}:${market.id}:${bet.id}`, settlement: bet.settlement!, updatedAt: new Date(at).toISOString()});
        }
      }
    }
    const events: SportEvent[] = [];
    const observed = new Set<string>();
    const outrightDiagnostics: OutrightMarketDiagnostic[] = [];
    const diagnosticByKey = new Map<string, OutrightMarketDiagnostic>();
    for (const lane of ["prematch", "inplay"] as const) {
      for (const [key, row] of this.rows[lane]) {
        if (!row.outright) continue;
        const diagnostic: OutrightMarketDiagnostic = { lane, competitionId: row.outright.competitionId,
          fixtureId: Number(String(key).split(":").at(-1)), hasFixture: !!row.fixture,
          outrightScore: row.outrightScore ? {
            updatedAt: new Date(row.outrightScore.at).toISOString(), status: row.outrightScore.value.status ?? null,
            statusName: OutrightScoreStatus[row.outrightScore.value.status ?? -1] ?? "Unrecognized",
            participantResults: structuredClone(row.outrightScore.value.participantResults || []),
          } : undefined,
          restored: row.restored || undefined, participantCount: row.fixture?.value.participants?.length || 0,
          messagesByType: {}, marketUpdates: 0, betUpdates: 0, providerMarketUpdates: 0, providerBetUpdates: 0, staleBetUpdates: 0,
          ...structuredClone(row.marketReceipt),
          markets: [...row.markets.values()].map(m => ({
            timestampRejections: [...(row.deferredTimestampBets?.values() || [])].filter(r=>r.marketId===m.id).map(r=>r.inspection),
            settlementEvidence: row.settlementMarkets?.get(String(m.id)),
            id: m.id ?? null, name: m.name ?? null, status: m.status ?? null, statusLabel: marketStatusLabel(m.status),
            selections: (m.bets || []).map(b => {
              const participantName = b.participantId === undefined ? undefined : row.fixture?.value.participants?.find(p => p.id === b.participantId)?.name;
              const known = typeof b.settlement === "number" && Object.hasOwn(SettlementType, b.settlement);
              return { id: b.id, name: b.name ?? participantName ?? null,
                participantId: b.participantId ?? null, participantName: participantName ?? null,
                nameSource: b.name !== undefined ? "selection" as const : participantName !== undefined ? "participant" as const : "not_reported" as const,
                status: b.betStatusId ?? b.status ?? null, providerStatus: b.status ?? null, betStatusId: b.betStatusId ?? null,
                settlement: b.settlement ?? null, resultKnown: known,
                settlementTrace: row.settlementAudit?.get(`${m.id}:${b.id}`),
                timestampRecovery: row.timestampRecovery?.get(`${m.id}:${b.id}`),
                quoteRecovery: {
                  awaitingFreshQuote: !!row.restored && !quoteConfirmed(row,`${m.id}:${b.id}`,b),
                  snapshotSeen: !!row.snapshotBets?.has(`${m.id}:${b.id}`),
                  snapshot: row.snapshotBets?.get(`${m.id}:${b.id}`),
                },
                resultDescription: b.settlement == null ? "Liquidación no informada" : known ? settlementLabel(b.settlement) : "Código de liquidación desconocido" };
            }),
          })),
          storedMarkets: row.markets.size,
          storedSelections: [...row.markets.values()].reduce((n, m) => n + (m.bets?.length || 0), 0), selectableSelections: 0 };
        const winner = row.markets.get("160");
        if (winner) diagnostic.market160 = { status: winner.status,
          selections: winner.bets?.length || 0,
          pricedSelections: (winner.bets || []).filter((b) => Number.isFinite(Number(b.price)) && Number(b.price) > 1).length,
          selectableSelections: 0 };
        outrightDiagnostics.push(diagnostic);
        diagnosticByKey.set(`${lane}:${key}`, diagnostic);
      }
    }
    for (const lane of ["prematch", "inplay"] as const) {
      for (const [id, row] of this.rows[lane]) {
        const fixture = row.fixture?.value;
        if (!fixture) continue;
        const sport = classifySport(fixture.sport?.name);
        if (sport === "hipica") observed.add(lane);
        const context=`${lane}:${id}`;const deferred=useCache&&!row.outright;
        const cached=useCache&&!row.outright?this.projectionCache.get(row):undefined;
        if(cached?.context===context){events.push(deferAvailability?cached.event:maskEventAvailability(cached.event,blocks[lane]));continue;}
        const score = row.livescore?.value.scoreboard;
        const status =
          (row.livescore && row.livescore.at >= (row.fixture?.at || 0)
            ? score?.status
            : undefined) ?? fixture.status;
        const available =
          (deferred||this.connections[lane].phase === "connected") &&
          (deferred||!(this.connections[lane].ingressProgress && (this.connections[lane].ingressProgress!.processingBacklog??this.connections[lane].ingressProgress!.backlog) > 0 && (this.connections[lane].ingressProgress!.oldestProcessingAgeMs??this.connections[lane].ingressProgress!.oldestAgeMs) > 5000)) &&
          [1, 2, 9].includes(status ?? 0);
        const prefix = `${lane}:${id}`;
        const markets: EventMarket[] = [...row.markets.values()].map((m) => ({
          id: `${prefix}:${m.id}`,
          name: m.name || `Mercado ${m.id}`,
          status: m.status,
          selections: (m.bets || []).map((b) => {
            const unavailableReasons=selectionReasons(row,m,b,status,this.connections[lane],deferred);
            return ({
            id: `${prefix}:${m.id}:${b.id}`,
            ...(() => {
              const trace=row.settlementAudit?.get(`${m.id}:${b.id}`);
              const version=betVersionAt(row,String(m.id),b);
              const proof=[trace?.last40,trace?.last41,trace?.lastSnapshot].find(p=>p?.timestamp?.orderingSafe===true&&(p.timestamp.timezone==='explicit'||p.timestamp.contract==='lsports-217525-utc')&&Date.parse(p.versionAt)===version);
              return proof&&unavailableReasons.length===0?{priceVersionAt:proof.versionAt,priceOrderingSafe:true}:{};
            })(),
            label: `${b.name || (row.outright && b.participantId !== undefined ? fixture.participants?.find((p) => p.id === b.participantId)?.name : undefined) || "Selección"}${b.line ? ` (${b.line})` : ""}`,
            line: b.line,
            participantId: b.participantId,
            settlement: b.settlement,
            settlementLabel: b.settlement === undefined ? undefined : settlementLabel(b.settlement),
            unavailableReasons,
            odds: Number(b.price) || 0,
            status: b.betStatusId ?? b.status,
            available: unavailableReasons.length === 0,
          }); }),
        }));
        const marketDiagnostic = diagnosticByKey.get(prefix);
        if (marketDiagnostic) {
          for (const diagnosticMarket of marketDiagnostic.markets || []) {
            const published = markets.find(m => m.id === `${prefix}:${diagnosticMarket.id}`);
            for (const diagnosticSelection of diagnosticMarket.selections) {
              const selection = published?.selections.find(s => s.id === `${prefix}:${diagnosticMarket.id}:${diagnosticSelection.id}`);
              if (selection) Object.assign(diagnosticSelection, {odds: selection.odds, available: selection.available,
                unavailableReasons: selection.unavailableReasons});
            }
          }
          marketDiagnostic.fixtureStatus = status;
          marketDiagnostic.fixtureStatusLabel = statusLabels[status ?? 0] || "Estado desconocido";
          marketDiagnostic.selectableSelections = markets.reduce((n, m) => n + m.selections.filter((s) => s.available).length, 0);
          const winner = markets.find((m) => m.id === `${prefix}:160`);
          if (winner) marketDiagnostic.market160 = { status: winner.status, statusLabel: marketStatusLabel(winner.status),
            selectionStatusCounts: winner.selections.reduce<Record<string, number>>((counts, s) => { const key = s.status === undefined ? "unknown" : String(s.status); counts[key] = (counts[key] || 0) + 1; return counts; }, {}),
            settlementCounts: winner.selections.reduce<Record<string, number>>((counts, s) => { const key = s.settlement === undefined ? "unknown" : String(s.settlement); counts[key] = (counts[key] || 0) + 1; return counts; }, {}),
            blockedReasonCounts: winner.selections.reduce<Record<string, number>>((counts, s) => { for (const reason of s.unavailableReasons || []) counts[reason] = (counts[reason] || 0) + 1; return counts; }, {}),
            selections: winner.selections.length,
            pricedSelections: winner.selections.filter((s) => s.odds > 1 && Number.isFinite(s.odds)).length,
            selectableSelections: winner.selections.filter((s) => s.available).length };
        }
        const primary =
          markets.find((m) => m.selections.some((s) => s.available)) ||
          markets[0];
        const participants = [...(fixture.participants || [])].sort(
          (a, b) => Number(a.position || 0) - Number(b.position || 0),
        );
        const start = fixture.startDate ? new Date(fixture.startDate) : null;
        events.push({
          id: prefix,
          sport,
          source: lane,
          marketDiagnostic,
          outrightScore: marketDiagnostic?.outrightScore,
          restored: row.restored || undefined,
          observation:row.observation ? {...row.observation} : undefined,
          startsAt:start && Number.isFinite(+start)?start.toISOString():undefined,
          kind: row.outright ? "outright" : "fixture",
          competition: row.outright ? { id: row.outright.competitionId, name: row.outright.competitionName, type: row.outright.competitionType } : undefined,
          participants: structuredClone(participants),
          status,
          statusLabel: statusLabels[status ?? 0] || "Estado desconocido",
          available,
          league:
            [fixture.location?.name, fixture.league?.name || row.outright?.competitionName]
              .filter(Boolean)
              .join(" · ") || "Competición sin nombre",
          home: row.outright ? fixture.fixtureName || `Evento ${id}` : participants[0]?.name || fixture.fixtureName || `Evento ${id}`,
          away:
            (row.outright ? `${participants.length} participantes` : participants[1]?.name) ||
            (sport === "hipica" ? `${participants.length} participantes` : ""),
          time:
            start && Number.isFinite(+start)
              ? startTimeFormatter.format(start) + " ART"
              : "Horario no informado",
          live: status === 2,
          score: score?.results?.map((r) => r.value).join(" : "),
          market: primary?.name || "Sin mercados disponibles",
          selections: primary?.selections || [],
          markets,
          updatedAt: new Date(
            Math.max(
              row.fixture?.at || 0,
              row.livescore?.at || 0,
              ...row.marketAt.values(),
            ),
          ).toISOString(),
        });
        if(useCache&&!row.outright){const base=events[events.length-1];this.projectionCache.set(row,{context,event:base});if(!deferAvailability)events[events.length-1]=maskEventAvailability(base,blocks[lane]);}
      }
    }
    if(projectionPart)return {mode:"connected",events,outrightDiagnostics} as EventFeed;
    // Prefer InPlay when a fixture exists in both packages; never merge their prices.
    const inplayIds = new Set(
      events
        .filter((e) => e.source === "inplay" && e.live)
        .map((e) => e.id.substring(e.id.indexOf(":") + 1)),
    );
    const visible = events.filter(
      (e) => !(e.source === "prematch" && inplayIds.has(e.id.substring(e.id.indexOf(":") + 1))),
    );
    const coverage = {} as Record<Lane, CoverageStats>;
    for (const lane of ["prematch", "inplay"] as const) {
      const published = visible.filter((e) => e.source === lane);
      coverage[lane] = {
        ...structuredClone(this.metrics[lane]),
        outrightMarketRowsWithoutFixture: [...this.rows[lane].values()].filter((r) => r.outright && r.marketReceipt && !r.fixture).length,
        rowsStored: this.rows[lane].size,
        rowsWithoutFixture: [...this.rows[lane].values()].filter(
          (r) => !r.fixture,
        ).length,
        rowsPublished: published.length,
        rowsHiddenAsDuplicate:
          events.filter((e) => e.source === lane).length - published.length,
        eventsWithMarkets: published.filter((e) => e.markets?.length).length,
        eventsWithSelections: published.filter((e) =>
          e.markets?.some((m) => m.selections.length),
        ).length,
        eventsWithSelectableOdds: blocks[lane]?.length?0:published.filter((e) =>
          e.markets?.some((m) => m.selections.some((s) => s.available)),
        ).length,
      };
    }
    const phases = Object.values(this.connections).map((c) => c.phase);
    const health = phases.every((p) => p === "connected") && !Object.values(this.connections).some(c => ["partial", "rate_limited"].includes(c.outrightRecovery?.status || "") || c.diagnostic?.category === "rate_limited")
      ? "ok"
      : phases.some((p) => p === "connected")
        ? "degraded"
        : "unavailable";
    const checked = Object.values(this.connections).every(
      (c) => !!c.lastSnapshotAt,
    );
    return {
      mode: "connected",
      restoration:this.restoration,
      health,
      notice:
        health === "ok"
          ? "LSports TRADE · Test · Billete de simulación, sin dinero real."
          : "Integración con fallas o en recuperación. Las cuotas afectadas están bloqueadas.",
      updatedAt: new Date(now).toISOString(),
      connections: structuredClone(this.connections),
      events: visible,
      ticketOutcomes,
      ticketVersionRecoveries,
      coverage,
      outrightDiagnostics,
      horseRacing: {
        status: observed.size
          ? "observed"
          : checked
            ? "not_observed"
            : "unknown",
        message: observed.size
          ? "Se observaron eventos de Hípica en el paquete."
          : checked
            ? "Sin eventos de Hípica en los snapshots consultados. Esto no confirma ni descarta la habilitación del paquete."
            : "Hípica: disponibilidad pendiente de consulta autenticada.",
      },
    };
  }
}
