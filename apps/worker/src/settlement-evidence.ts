import { inspectTimestamp, requireTimestamp } from "./timestamp-evidence.js";
import type {Market} from 'trade360-nodejs-sdk';
import type {SettlementFieldEvidence, SettlementMarketCounts, SettlementObservation, SettlementTrace} from '@lsports/contracts';
const object=(v:unknown):v is Record<string,unknown> => !!v&&typeof v==='object'&&!Array.isArray(v);
// Compare the actual supplier JSON with the official entity conversion. Never log payloads.
export function inspectSettlements(raw:unknown, converted:Market[], source: "amqp" | "snapshot" = "amqp"):{fields:SettlementFieldEvidence[];counts:SettlementMarketCounts[]} {
 if(!Array.isArray(raw)||raw.length!==converted.length)throw new Error('Settlement conversion mismatch');
 const fields:SettlementFieldEvidence[]=[], counts:SettlementMarketCounts[]=[];
 for(let i=0;i<raw.length;i++){
  const market=raw[i], sdk=converted[i];
  if(!object(market)||market.Id!==sdk.id)throw new Error('Settlement market identity mismatch');
  const bets=market.Bets===undefined?[]:market.Bets;
  if(!Array.isArray(bets)||bets.length!==(sdk.bets||[]).length)throw new Error('Settlement bet count mismatch');
  const summary:SettlementMarketCounts={marketId:sdk.id!,rootBets:bets.length,rootNumeric:0,rootNull:0,rootMissing:0,providerBets:0,providerNumeric:0};
  for(let j=0;j<bets.length;j++){
   const bet=bets[j], parsed=sdk.bets![j];
   if(!object(bet)||String(bet.Id)!==parsed.id)throw new Error('Settlement selection identity mismatch');
   const timestamp=inspectTimestamp(bet.LastUpdate,parsed.lastUpdate);
   requireTimestamp(timestamp,source);
   const field=!Object.hasOwn(bet,'Settlement')?'missing':bet.Settlement===null?'null':'integer';
   if(field==='integer'&&(!Number.isInteger(bet.Settlement)||parsed.settlement!==bet.Settlement))throw new Error('Settlement numeric value invalid or lost');
   if(field==='missing'&&parsed.settlement!==undefined)throw new Error('Settlement invented during conversion');
   if(field==='null'&&parsed.settlement!=null)throw new Error('Settlement null conversion mismatch');
   summary[field==='integer'?'rootNumeric':field==='null'?'rootNull':'rootMissing']++;
   fields.push({marketId:sdk.id!,selectionId:parsed.id,timestamp,field,code:field==='integer'?Number(bet.Settlement):null});
  }
  // Provider-specific results are counted, never promoted into the recommended selection.
  for(const provider of Array.isArray(market.ProviderMarkets)?market.ProviderMarkets:[]){
   if(!object(provider)||!Array.isArray(provider.Bets))continue;
   summary.providerBets+=provider.Bets.length;
   summary.providerNumeric+=provider.Bets.filter(b=>object(b)&&Number.isInteger(b.Settlement)).length;
  }
  counts.push(summary);
 }
 return {fields,counts};
}
const sources=new Set(['amqp.41','amqp.42','snapshot.outright.markets']);
export function validObservation(v:unknown):v is SettlementObservation {
 return object(v)&&sources.has(String(v.source))&&Number.isFinite(Date.parse(String(v.receivedAt)))&&Number.isFinite(Date.parse(String(v.versionAt)))&&
  ['missing','null','integer'].includes(String(v.field))&&(v.field==='integer'?Number.isInteger(v.code):v.code===null)&&
  ['stored','ignored_missing','ignored_null','ignored_older'].includes(String(v.decision));
}
export function validTrace(v:unknown):v is SettlementTrace {
 return object(v)&&Object.keys(v).every(k=>['last41','last42','lastSnapshot','lastNumeric'].includes(k)&&validObservation(v[k]));
}
export function validMarketEvidence(v:unknown):boolean {
 return object(v)&&Object.keys(v).every(k=>sources.has(k)&&object(v[k])&&
  Number.isFinite(Date.parse(String(v[k].receivedAt)))&&
  ['marketId','rootBets','rootNumeric','rootNull','rootMissing','providerBets','providerNumeric'].every(f=>Number.isSafeInteger((v[k] as Record<string,unknown>)[f])&&Number((v[k] as Record<string,unknown>)[f])>=0));
}
