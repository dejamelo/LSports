import {providerTimestamp} from './timestamp-contract.js';
import type {TimestampInspection} from '@lsports/contracts';
import {OperationError} from './diagnostics.js';
const iso=/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?$/i;
const processTimezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
export function inspectTimestamp(raw:unknown, sdk:unknown):TimestampInspection {
 const match=typeof raw==='string'?raw.match(iso):null;
 const milliseconds=sdk instanceof Date?sdk.getTime():NaN;
 const tz=processTimezone;
 const timezone=raw==null?'missing':typeof raw==='number'&&Number.isFinite(raw)?'epoch_milliseconds':match?match[1]?'explicit':'absent':'invalid';
 const contract=providerTimestamp(raw);
 const expected=contract?.milliseconds ?? NaN;
 // The wall-clock comparison is diagnostic ONLY, never used as a timezone assumption.
 const wall=timezone==='absent'?Date.parse(String(raw).replace(' ','T')+'Z'):NaN;
 return {
  contract: contract ? 'lsports-217525-utc' : undefined,
  orderingKey: contract?.order,
  rawLastUpdate:match?String(raw):typeof raw==='number'&&Number.isFinite(raw)?raw:null,
  rawType:raw===undefined?'missing':raw===null?'null':typeof raw==='string'?'string':typeof raw==='number'?'number':'other',
  timezone, sdkUtc:Number.isFinite(milliseconds)?new Date(milliseconds).toISOString():null,
  normalizedUtc:Number.isFinite(expected)&&Math.abs(expected)<=8640000000000000?new Date(expected).toISOString():null,
  hostTimezone:/^[A-Za-z0-9_+\-/]{1,80}$/.test(tz)?tz:'unrecognized',
  hostOffsetMinutes:Number.isFinite(milliseconds)?new Date(milliseconds).getTimezoneOffset():new Date().getTimezoneOffset(),
  wallClockToSdkDeltaMinutes:Number.isFinite(wall)&&Number.isFinite(milliseconds)?(milliseconds-wall)/60000:null,
  orderingSafe:timezone==='missing'||(Number.isFinite(expected)&&expected===milliseconds),
  orderingSource:timezone==='missing'?'envelope_or_snapshot_start':'last_update',
 };
}
export function requireTimestamp(inspection:TimestampInspection, source:'amqp'|'snapshot'):void {
 if(inspection.orderingSafe)return;
 throw new OperationError({operation:source==='amqp'?'feed.decode':'snapshot.outright.markets',protocol:source==='amqp'?'amqp':'http',
  category:source==='amqp'?'invalid_message':'invalid_response',reason:'invalid_timestamp',
  message:'LastUpdate inválido o conversión del SDK divergente; no se modifica el estado anterior.',
  timestampInspection:inspection,
 });
}
