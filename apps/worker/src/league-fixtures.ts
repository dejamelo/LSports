import {OutrightLeagueFixtureUpdate,TransformerUtil} from 'trade360-nodejs-sdk';
import {normalizeSdkTimestamps,attachTimestampPrecision,hasInvalidProviderTimestamp} from './timestamp-contract.js';
import {OperationError} from './diagnostics.js';
import type {TradeEvent} from './state.js';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
const invalid=():never=>{throw new OperationError({operation:'feed.decode',protocol:'amqp',category:'invalid_message',reason:'invalid_event_body',decodeStage:'entity',message:'Tipo 38 requiere Competition.Competitions[].Events[].OutrightLeague; entrega conservada sin ACK.'});};
/** SDK EntityKey(38): metadata of a league/season fixture, not markets or settlement. */
export function leagueFixtureEvents(body:unknown):TradeEvent[]{
 if(!object(body)||!object(body.Competition))return invalid();
 const raw=body.Competition;
 if(!id(raw.Id)||Object.hasOwn(raw,'Events')||!Array.isArray(raw.Competitions))return invalid();
 for(const season of raw.Competitions){
  if(!object(season)||!id(season.Id)||!Array.isArray(season.Events))return invalid();
  for(const event of season.Events)if(!object(event)||!id(event.FixtureId)||!object(event.OutrightLeague)||
   (event.OutrightLeague.Status!==undefined&&(!Number.isInteger(event.OutrightLeague.Status)||Number(event.OutrightLeague.Status)<0)))return invalid();
 }
 if(hasInvalidProviderTimestamp(body))throw new OperationError({operation:'feed.decode',protocol:'amqp',category:'invalid_message',reason:'invalid_timestamp',decodeStage:'entity',message:'Fecha inválida en tipo 38; no se confirma la entrega.'});
 const sdk=TransformerUtil.transform(normalizeSdkTimestamps(body),OutrightLeagueFixtureUpdate);attachTimestampPrecision(body,sdk);
 const competition=sdk.competition;
 if(!competition||competition.id!==raw.Id||competition.competitions?.length!==raw.Competitions.length)return invalid();
 const result:TradeEvent[]=[];
 for(const [s,season] of competition.competitions.entries()){
  const original=raw.Competitions[s] as Record<string,unknown>,events=original.Events as Record<string,unknown>[];
  if(season.id!==original.Id||season.events?.length!==events.length)return invalid();
  for(const [i,event] of season.events.entries()){
   if(event.fixtureId!==events[i].FixtureId||!event.outrightLeague)return invalid();
   result.push({fixtureId:event.fixtureId,outright:{competitionId:competition.id!,competitionName:competition.name,competitionType:competition.type,leagueSeason:{id:season.id!,name:season.name,type:season.type},fixture:event.outrightLeague}});
  }
 }
 return result;
}
