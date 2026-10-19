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
export function snapshotValidationReport(current,ledger={}){return{readOnlyRemote:true,providerRequests:0,workerRestarted:false,posnetChanged:false,
 capturedAtUTC:new Date().toISOString(),validationSinceUTC:utc(current.validationSinceUTC),
 current:{prematch:lane(current.lanes?.prematch),inplay:lane(current.lanes?.inplay)},
 historical:{lastValidation:lane(ledger.lastValidation?.lanes?.prematch),preFix:lane(ledger.distributionPreFixEvidence?.current?.lanes?.prematch)},
 evidenceLimit:'Counts and validation codes only; rejected raw HTTP bodies are not retained. No new provider call or worker instrumentation installed.'};}
