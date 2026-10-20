// Read persisted diagnostics only. No vendor requests, process signals or payload output.
const codes=new Set(['inventory_not_array','inventory_limit','inventory_invalid_ids','inventory_envelope','inventory_sdk_mismatch','batch_invalid_fixture','batch_id_mismatch','inventory_changed','full_document_invalid']);
const count=v=>Number.isSafeInteger(v)&&v>=0&&v<=1000000;
const utc=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(v)?v:null;
function validation(v){if(!v||typeof v!=='object')return null;const o={};
 for(const [k,allowed] of Object.entries({phase:['inventory','batch','verify'],code:[...codes],attribution:['local_bound','provider_contract','sdk_or_adapter','inventory_changed','not_proven']}))if(allowed.includes(v[k]))o[k]=v[k];
 for(const k of ['requested','received','missing','unexpected','rawCount','sdkCount','invalidCount'])if(count(v[k]))o[k]=v[k];
 if(v.itemTypes){o.itemTypes={};for(const k of ['number','string','object','null','array','boolean','other'])if(count(v.itemTypes[k]))o.itemTypes[k]=v.itemTypes[k];}
 if(['invalid_json','token_size_limit','truncated_string','truncated_json','item_size_limit','root_not_object','invalid_root_key','duplicate_or_invalid_root_key','invalid_root_colon','body_not_array','invalid_body_separator','invalid_root_separator','trailing_comma','trailing_json','invalid_header_or_application_error','header_status_rejected','row_not_object','invalid_fixture','invalid_markets_shape','invalid_timestamp','sdk_row_mismatch','disk_headroom','duplicate_or_excess_fixture','invalid_endpoint','unsupported_content_encoding','nesting_limit'].includes(v.detail))o.detail=v.detail;
 return o;
}
function lane(l={}){const p=l.partitionRecovery??{},b=p.lastBatch??{};return{
 phase:['recovering','connected','error','stopped','connecting'].includes(l.phase)?l.phase:null,
 sessionAtUTC:utc(l.session?.startedAt),lastSnapshotAtUTC:utc(l.lastSnapshotAt),lastAttemptAtUTC:utc(l.lastSnapshotAttemptAt),lastErrorAtUTC:utc(l.lastSnapshotErrorAt),
 currentValidation:validation(l.diagnostic?.snapshotValidation),lastSnapshotValidation:validation(l.lastSnapshotDiagnostic?.snapshotValidation),
 partition:{stage:['inventory','batches','verify','complete','waiting','failed'].includes(p.stage)?p.stage:null,failure:validation(p.failure),
 ...Object.fromEntries(['inventory','completedFixtures','batches'].filter(k=>count(p[k])).map(k=>[k,p[k]])),
 lastBatch:{...Object.fromEntries(['requested','received','missing','unexpected'].filter(k=>count(b[k])).map(k=>[k,b[k]])),exampleMissingFixtures:Array.isArray(b.exampleMissingFixtures)?b.exampleMissingFixtures.filter(v=>Number.isSafeInteger(v)&&v>0).slice(0,5):[]}},
 };}
function diagnostic(d={}){return{
 operation:['snapshot.events','amqp.connection','amqp.connect','distribution.start','feed.decode','file.persist'].includes(d.operation)?d.operation:undefined,
 category:['response_limit','rate_limited','invalid_response','unexpected','network','authentication_rejected','supplier_error'].includes(d.category)?d.category:undefined,
 reason:['memory_budget_exceeded','response_size_limit','invalid_snapshot','connection_closed','distribution_still_off','timeout'].includes(d.reason)?d.reason:undefined,
 rateLimitSource:['local_in_flight','local_operation_cooldown','local_host_cooldown','supplier_http'].includes(d.rateLimitSource)?d.rateLimitSource:undefined,
 httpStatus:Number.isInteger(d.httpStatus)?d.httpStatus:undefined,amqpCode:Number.isInteger(d.amqpCode)?d.amqpCode:undefined,retryAt:utc(d.retryAt),snapshotValidation:validation(d.snapshotValidation)};}
function progress(p={}){return Object.fromEntries(Object.entries(p).filter(([k,v])=>['acknowledgedMessages','rows','bytes','validatedRows','appliedRows','ackedDuringRecovery'].includes(k)&&Number.isSafeInteger(v)&&v>=0||k==='active'&&typeof v==='boolean'||['startedAt','completedAt','registeredAt','lastAckAt','lastProgressAt'].includes(k)&&utc(v)||k==='method'&&v==='disk_spool_two_pass'||k==='stage'&&['waiting_http','download','validate','apply','complete'].includes(v)));}
function observation(l={},previous={},projection={},since){
 const session=utc(l.session?.startedAt),boundary=Date.parse(session),isCurrent=t=>Number.isFinite(boundary)&&Number.isFinite(Date.parse(t))&&Date.parse(t)>=boundary;
 const sameSession=!!session&&session===utc(previous.session?.startedAt);
 const ack=l.consumerProgress?.acknowledgedMessages,prior=previous.consumerProgress?.acknowledgedMessages;
 const closures=(l.sessionEnds||[]).filter(e=>e.diagnostic?.amqpCode===320).map(e=>({startedAtUTC:utc(e.startedAt),endedAtUTC:utc(e.endedAt),amqpCode:320,signals:(e.diagnostic.amqpCloseSignals||[]).filter(s=>s==='connection_forced'),
  scope:isCurrent(e.endedAt)?'current_session':Date.parse(e.endedAt)>=Date.parse(since)?'post_update_previous_session':'before_update'}));
 const d=l.lastSnapshotDiagnostic||{},when=d.coordinator?.at||d.retryAt;
 return {sessionStartedAtUTC:session,phase:lane(l).phase,consumer:progress(l.consumerProgress),
  ackComparison:{sameSession,previousAcknowledgedMessages:prior??null,currentAcknowledgedMessages:ack??null,delta:sameSession&&Number.isSafeInteger(ack)&&Number.isSafeInteger(prior)&&ack>=prior?ack-prior:null},
  lastSnapshotAtUTC:utc(l.lastSnapshotAt),snapshotBelongsToCurrentSession:isCurrent(l.lastSnapshotAt),fullSnapshot:progress(l.fullSnapshot),
  lastMarketDecodedAtUTC:utc(l.updates?.lastMarketDecodedAt),marketUpdateBelongsToCurrentSession:isCurrent(l.updates?.lastMarketDecodedAt),
  diagnostic:diagnostic(l.diagnostic),lastSnapshotDiagnostic:diagnostic(d),lastSnapshotDiagnosticScope:when?(isCurrent(when)?'current_session':'historical_before_session'):'timestamp_unknown',
  projection,amqp320:closures};
}
export function snapshotValidationReport(current,ledger={}){return{readOnlyRemote:true,providerRequests:0,workerRestarted:false,posnetChanged:false,
 capturedAtUTC:new Date().toISOString(),validationSinceUTC:utc(current.validationSinceUTC),
 current:{prematch:lane(current.lanes?.prematch),inplay:lane(current.lanes?.inplay)},
 feedObservations:Object.fromEntries(['prematch','inplay'].map(name=>[name,observation(current.lanes?.[name],ledger.lastValidation?.lanes?.[name],current.projectionByLane?.[name],current.validationSinceUTC)])),
 selectableSelections:current.selectableSelections??null,blockedReasons:current.blockedReasons,workers:current.workers,
 historical:{lastValidation:lane(ledger.lastValidation?.lanes?.prematch),preFix:lane(ledger.distributionPreFixEvidence?.current?.lanes?.prematch)},
 evidenceLimit:'One current persisted observation compared with the saved previous sample. ACK delta is unknown across session changes. Stored selections and timestamps alone do not prove feed recovery. No provider requests or worker restart.'};}
