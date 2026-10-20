export type Sport = "futbol" | "tenis" | "basquet" | "hipica" | "otros";
export interface Selection {
  priceVersionAt?: string;
  priceOrderingSafe?: boolean;
  id: string;
  label: string;
  odds: number;
  status?: number;
  available?: boolean;
  line?: string;
  participantId?: number;
  settlement?: number;
  settlementLabel?: string;
  unavailableReasons?: string[];
}
export const marketStatusLabel = (status?: number) => ({ 0: "Sin estado", 1: "Abierto", 2: "Suspendido", 3: "Liquidado", 4: "Cerrado" } as Record<number, string>)[status ?? -1] || "Estado desconocido";
export const settlementLabel = (status?: number) => ({ [-1]: "Cancelada", 0: "Sin liquidar", 1: "Perdedora", 2: "Ganadora", 3: "Reembolso", 4: "Media pérdida", 5: "Media ganancia" } as Record<number, string>)[status ?? -2] || "Liquidación no informada";
export interface EventMarket {
  id: string;
  name: string;
  status?: number;
  selections: Selection[];
}
export interface EventParticipant {
  id?: number;
  name?: string;
  position?: string;
  rotationId?: number;
  isActive?: number;
  form?: string;
  formation?: string;
  gender?: number;
  ageCategory?: number;
  type?: number;
  extraData?: { name?: string; value?: string }[];
}
export interface SnapshotQuoteObservation {
  receivedAt: string;
  versionAt: string;
  receivedPrice: number | null;
  decision: "confirmed" | "older_than_stored" | "missing_or_invalid_price";
}
export interface TimestampContext {competitionId: number; fixtureId: number; marketId: number; selectionId: string}
export interface TimestampRecovery {
  auditId: string; status: "awaiting_fresh_amqp" | "validated_amqp" | "awaiting_settlement_replay" | "settlement_replayed";
  replayCode?: number; replayReceivedAt?: string;
  previousVersion: string; baselineVersion: string; preparedAt: string; validatedAt?: string;
}
export interface TimestampInspection {
  contract?: "lsports-217525-utc";
  orderingKey?: string;
  context?: TimestampContext;
  rawLastUpdate: string | number | null;
  rawType: "missing" | "null" | "string" | "number" | "other";
  timezone: "missing" | "epoch_milliseconds" | "explicit" | "absent" | "invalid";
  sdkUtc: string | null; normalizedUtc: string | null;
  hostTimezone: string; hostOffsetMinutes: number;
  wallClockToSdkDeltaMinutes: number | null;
  orderingSafe: boolean; orderingSource: "envelope_or_snapshot_start" | "last_update";
}
export interface SettlementFieldEvidence {
  timestamp?: TimestampInspection;
  marketId: number; selectionId: string; field: "missing" | "null" | "integer"; code: number | null;
}
export interface SettlementObservation {
  timestamp?: TimestampInspection;
  source: "amqp.40" | "amqp.41" | "amqp.42" | "snapshot.outright.markets";
  receivedAt: string; versionAt: string;
  field: "missing" | "null" | "integer"; code: number | null;
  decision: "stored" | "ignored_missing" | "ignored_null" | "ignored_older";
}
export interface SettlementTrace {last40?: SettlementObservation;last41?: SettlementObservation; last42?: SettlementObservation; lastSnapshot?: SettlementObservation; lastNumeric?: SettlementObservation}
export interface SettlementMarketCounts {marketId: number; rootBets: number; rootNumeric: number; rootNull: number; rootMissing: number; providerBets: number; providerNumeric: number}
export type SettlementMarketEvidence = Partial<Record<SettlementObservation["source"], SettlementMarketCounts & {receivedAt: string}>>;
export interface OutrightMarketResult {
  timestampRejections?: TimestampInspection[];
  settlementEvidence?: SettlementMarketEvidence;
  id: number | null;
  name: string | null;
  status: number | null;
  statusLabel: string;
  selections: {
    id: string;
    name: string | null;
    participantId: number | null;
    participantName: string | null;
    nameSource: "selection" | "participant" | "not_reported";
    status: number | null;
    providerStatus: number | null;
    betStatusId: number | null;
    settlement: number | null;
    resultKnown: boolean;
    resultDescription: string;
    settlementTrace?: SettlementTrace;
    timestampRecovery?: TimestampRecovery;
    odds?: number;
    available?: boolean;
    unavailableReasons?: string[];
    quoteRecovery?: {
      awaitingFreshQuote: boolean;
      snapshotSeen: boolean; // observed in a snapshot during this process session; see receivedAt
      snapshot?: SnapshotQuoteObservation;
    };
  }[];
}
export interface OutrightScoreProjection {
  updatedAt: string;
  status: number | null;
  statusName: string;
  participantResults: {participantId?: number; name?: string; result?: number}[];
}
export interface OutrightMarketDiagnostic {
  outrightScore?: OutrightScoreProjection;
  markets?: OutrightMarketResult[];
  lane: Lane;
  competitionId: number;
  fixtureId: number;
  hasFixture: boolean;
  fixtureStatus?: number;
  fixtureStatusLabel?: string;
  restored?: boolean;
  participantCount?: number;
  messagesByType: Record<string, number>;
  marketUpdates: number;
  betUpdates: number;
  providerMarketUpdates: number;
  providerBetUpdates: number;
  staleBetUpdates: number;
  lastMarketMessageAt?: string;
  snapshotMarketUpdates?: number;
  lastMarketSnapshotAt?: string;
  storedMarkets: number;
  storedSelections: number;
  selectableSelections: number;
  market160?: { status?: number; statusLabel?: string; selections: number; pricedSelections: number; selectableSelections: number; selectionStatusCounts?: Record<string, number>; settlementCounts?: Record<string, number>; blockedReasonCounts?: Record<string, number> };
}
export interface FeedObservation {
  snapshotReceivedAt?: string;
  amqpEventReceivedAt?: string;
  amqpMarketReceivedAt?: string;
}
export interface FeedActivity {
  lastDecodedAt?:string;lastControlDecodedAt?:string;lastDataDecodedAt?:string;
  lastEventDecodedAt?:string;lastMarketDecodedAt?:string;lastSettlementDecodedAt?:string;
  lastDuplicateDecodedAt?:string;
}
export interface SportEvent {
  startsAt?:string;
  observation?:FeedObservation;
  outrightScore?: OutrightScoreProjection;
  kind?: "fixture" | "outright";
  restored?: boolean;
  marketDiagnostic?: OutrightMarketDiagnostic;
  competition?: { id: number; name?: string; type?: number };
  participants?: EventParticipant[];
  id: string;
  sport: Sport;
  league: string;
  home: string;
  away: string;
  time: string;
  live: boolean;
  score?: string;
  market: string;
  selections: Selection[];
  markets?: EventMarket[];
  status?: number;
  statusLabel?: string;
  available?: boolean;
  updatedAt?: string;
  source?: "prematch" | "inplay";
}
export type Lane = "prematch" | "inplay";
export interface HttpResponseInspection {
  contentType: "json" | "html" | "text" | "other" | "unspecified";
  root: "missing" | "null" | "array" | "object" | "string" | "number" | "boolean" | "other";
  header: HttpResponseInspection["root"];
  body: HttpResponseInspection["root"];
  headerStatusType?: HttpResponseInspection["root"];
  headerFields?: Record<string, HttpResponseInspection["root"]>;
  headerOtherFieldCount?: number;
  headerCodes?: Record<string, number>;
  headerFlags?: Record<string, boolean>;
  headerMessageSignals?: string[];
  knownRootFields: string[];
  knownBodyFields: string[];
  otherRootFields: number;
  applicationErrorFields: number;
  applicationErrorItems: number;
  competitionRows: number;
  eventRows: number;
  marketRows: number;
  selectionRows: number;
  bodyEmptyArray: boolean;
  bodyEmptyObject: boolean;
}
export interface SnapshotRequestInspection {
  method: "POST";
  route: "/Prematch/GetOutrightFixtureMarkets";
  filter: "fixtures" | "none";
  fixtureCount: number;
  competitionIdSent: false;
  credentialField: "userName";
}
export interface SnapshotValidationInspection {
  phase: 'inventory'|'batch'|'verify';
  code: 'inventory_not_array'|'inventory_limit'|'inventory_invalid_ids'|'inventory_envelope'|'inventory_sdk_mismatch'|'batch_invalid_fixture'|'batch_id_mismatch'|'inventory_changed'|'full_document_invalid';
  detail?:string;
  fieldPath?:string;actualType?:'undefined'|'null'|'array'|'object'|'string'|'number'|'boolean';fixtureId?:number;
  attribution: 'local_bound'|'provider_contract'|'sdk_or_adapter'|'inventory_changed'|'not_proven';
  rawCount?:number;sdkCount?:number;invalidCount?:number;requested?:number;received?:number;missing?:number;unexpected?:number;
  itemTypes?:Partial<Record<'number'|'string'|'object'|'null'|'array'|'boolean'|'other',number>>;
}
export interface DistributionObservation {
  stage:'before_start'|'start_response'|'after_propagation';observedAtUTC:string;
  bodyIsDistributionOn?:boolean;sdkIsDistributionOn?:boolean;queueDepth?:number;consumerCount?:number;messagesPerSecond?:number;
  startReturnedAtUTC?:string;elapsedSinceStartMs?:number;propagationDelayMs?:number;
  startMessage?:'activated'|'already_active'|'missing'|'unrecognized';
}
export interface IntegrationDiagnostic {
  snapshotValidation?:SnapshotValidationInspection;
  requestInspection?: SnapshotRequestInspection;
  amqpCloseSignals?: ("connection_forced"|"heartbeat_timeout"|"ack_timeout"|"administrative_close"|"server_shutdown")[];
  distributionInspection?: {before:boolean;startRequested:boolean;after?:boolean;startMessage?:'activated'|'already_active'|'missing'|'unrecognized';propagationDelayMs?:number};
  operation:
    | "config"
    | "distribution.status"
    | "distribution.start" | "distribution.stop"
    | "snapshot.events"
    | "snapshot.outright.fixtures"
    | "snapshot.outright.markets"
    | "metadata.sports"
    | "subscriptions.list"
    | "subscriptions.quota"
    | "subscriptions.schedule"
    | "amqp.connect"
    | "amqp.channel"
    | "amqp.prefetch"
    | "amqp.queue"
    | "amqp.consume"
    | "amqp.connection"
    | "feed.decode"
    | "feed.apply"
    | "amqp.ack"
    | "feed.stale"
    | "file.persist"
    | "worker.start";
  protocol: "http" | "amqp" | "local";
  category:
    | "missing_credentials"
    | "configuration"
    | "authentication_rejected"
    | "authentication_or_permission"
    | "permission_denied"
    | "not_found"
    | "rate_limited"
    | "invalid_request"
    | "network"
    | "tls"
    | "supplier_error"
    | "invalid_response"
    | "response_limit"
    | "redirect"
    | "sdk_error"
    | "invalid_message"
    | "unsupported_message"
    | "unexpected";
  message: string;
  reason?:
    | "timeout"
    | "response_size_limit"
    | "memory_budget_exceeded"
    | "request_size_limit"
    | "redirect_limit"
    | "connection_reset"
    | "dns"
    | "tls_failure"
    | "non_json_response"
    | "missing_response_header"
    | "missing_response_body"
    | "null_response_body"
    | "empty_http_body"
    | "application_error"
    | "sdk_conversion"
    | "sdk_validation"
    | "invalid_snapshot"
    | "ambiguous_timestamp"
    | "invalid_timestamp"
    | "connection_closed"
    | "channel_closed"
    | "consumer_cancelled"
    | "consumer_conflict"
    | "worker_stopped"
    | "distribution_still_off"
    | "unknown_exception"
    | "unsupported_content_type"
    | "unsupported_content_encoding"
    | "decompression_failed"
    | "message_too_large"
    | "invalid_utf8"
    | "invalid_json"
    | "invalid_envelope"
    | "invalid_message_headers"
    | "missing_timestamp"
    | "invalid_event_body"
    | "entity_conversion"
    | "unsupported_message_type"
    | "provider_interrupted";
  stage?: "request" | "response" | "sdk" | "validation";
  errorType?:
    | "axios"
    | "sdk_http"
    | "sdk_conversion"
    | "sdk_validation"
    | "syntax"
    | "type"
    | "range"
    | "unknown";
  clientCode?: string;
  elapsedMs?: number;
  responseInspection?: HttpResponseInspection;
  retryAfterMs?: number;
  retryAt?: string;
  attempts?: number;
  deferred?: boolean;
  rateLimitSource?: "supplier_http" | "local_in_flight" | "local_host_cooldown" | "local_operation_cooldown";
  requesterPid?: number;
  coordinator?: { recoveryId?:string;partitionPart?:number;packageId: number; operation: string; pid: number; at: string; completedAt?: string; outcome: "reserved" | "success" | "rate_limited" | "failed"; failure?: Pick<IntegrationDiagnostic, "category" | "reason" | "httpStatus" | "errorType" | "clientCode" | "networkCode" | "stage" | "responseLimitBytes" | "timeoutMs" | "memoryBudgetBytes" | "memoryHeadroomBytes" | "snapshotMemory" | "snapshotValidation"> };
  timeoutMs?: number;
  responseLimitBytes?: number;
  memoryBudgetBytes?: number;
  memoryHeadroomBytes?: number;
  snapshotMemory?: {heapLimitBytes:number|null;heapUsedBytes:number|null;heapHeadroomBytes:number;availableMemoryBytes:number|null;limitingFactor:"heap"|"available_memory"|"both"|"heap_only"};
  httpStatus?: number;
  providerStatus?: number;
  amqpCode?: number;
  networkCode?: string;
  fields?: string[];
  decodeStage?:
    | "properties"
    | "decompress"
    | "text"
    | "json"
    | "envelope"
    | "transport_headers"
    | "entity";
  messageMetadata?: FeedMessageMetadata;
  timestampInspection?: TimestampInspection;
  retryPolicy?: "restart_required";
  deliveryDisposition?: "requeue_requested" | "unacknowledged_until_close";
}
export interface FeedMessageMetadata {
  entityShape?: {leagueFixtureRows?:number;leagueFixtureMissingRows?:number;competition:"object"|"missing_or_invalid";seasons:number|null;flatEventsPresent:boolean;seasonEvents:(number|null)[]};
  wireBytes: number;
  decodedBytes?: number;
  contentType: string;
  contentEncoding: string;
  compression?: "none" | "gzip" | "deflate" | "br";
  signature: "empty" | "gzip" | "zlib" | "json_object" | "json_array" | "other";
  amqpHeadersPresent: string[];
  messageType?: number;
  messageTypeName?: string;
  timestampSource?:
    | "timestamp_in_ms"
    | "amqp_timestamp"
    | "server_timestamp"
    | "creation_date"
    | "received_control";
  guidSource?: "envelope" | "transport" | "control_fingerprint";
  rootShape?: "object" | "array" | "string" | "number" | "boolean" | "null";
  eventCount?: number;
  marketCount?: number;
  betCount?: number;
  participantResultCount?: number;
  redelivered?: boolean;
  warnings?: string[];
}
export interface ConnectionState {
  consumerProgress?:{acknowledgedMessages:number;lastAckAt?:string;registeredAt?:string;active?:boolean};
  persistenceProgress?:{writes:number;lastDurationMs:number;lastCompletedAt:string};
  fullSnapshot?:{stage?:'waiting_http'|'download'|'validate'|'apply'|'complete';validatedRows?:number;appliedRows?:number;lastProgressAt?:string;method:'disk_spool_two_pass';startedAt:string;completedAt?:string;rows?:number;bytes?:number;ackedDuringRecovery?:number};
  distributionObservations?:DistributionObservation[];
  session?: {id:string;startedAt:string};
  sessionEnds?: {id:string;startedAt:string;endedAt:string;diagnostic:IntegrationDiagnostic}[];
  lastSnapshotDiagnostic?: IntegrationDiagnostic;
  partitionRecovery?:{recoveryId:string;stage:"inventory"|"batches"|"verify"|"complete"|"waiting"|"failed";waitingFor?:"inventory"|"batches"|"verify";failure?:SnapshotValidationInspection;inventory:number;completedFixtures:number;batches:number;maxResponseBytes:number;retryAt?:string;inventoryDigest?:string;lastBatch?:{requested:number;received:number;missing:number;unexpected:number;exampleMissingFixtures:number[]}};
  recoveryProgress?:{stage:"snapshot"|"handoff"|"waiting_retry"|"idle";startedAt:string;completedAt?:string;queuedAtHandoff?:number;processedAtHandoff?:number;lastProgressAt?:string;regularSnapshotReady:boolean;nextRegularAttemptAt?:string};
  diagnostic?: IntegrationDiagnostic;
  phase: "starting" | "recovering" | "connected" | "error" | "stopped";
  message: string;
  lastMessageAt?: string;
  lastSnapshotAt?: string;
  lastSnapshotAttemptAt?:string;
  lastSnapshotErrorAt?:string;
  snapshotEvents?: number;
  catalogHorseRacing?: boolean;
  outrightRecovery?: { operations?:Partial<Record<"fixtures"|"marketEvents",{lastAttemptAt?:string;lastSuccessAt?:string;lastErrorAt?:string}>>; fixtures?: number; marketEvents?: number; status: "ok" | "partial" | "rate_limited" | "unsupported"; diagnostics?: IntegrationDiagnostic[]; timestampRejections?: TimestampInspection[]; checkedAt: string; responseInspections?: { fixtures?: HttpResponseInspection; markets?: HttpResponseInspection }; marketRequest?: SnapshotRequestInspection };
}
export interface SnapshotAudit {
  transport?: {responseLimitBytes?:number;receivedBytes?:number;timeoutMs?:number};
  content?: {rawStructureRecognized:boolean;providerFixtureStatusCounts:Record<string,number>|null;sdkFixtureStatusCounts:Record<string,number>;providerMarketStatusCounts:Record<string,number>|null;sdkMarketStatusCounts:Record<string,number>;providerMarkets:number|null;sdkMarkets:number;providerPricedSelections:number|null;sdkPricedSelections:number;examples:{fixtureId:number;status:number|null}[]};
  bodyShape: "array" | "single_event" | "events_wrapper" | "other" | "missing";
  providerRows?: number;
  sdkRows: number;
  acceptedRows: number;
  filters: "none" | "fixtures";
  partition?: {inventory:number;completedFixtures:number;batches:number;maxResponseBytes:number;complete:boolean};
}
export interface CoverageStats {
  activity?:FeedActivity;
  snapshot?: SnapshotAudit;
  messages: number;
  messagesByType: Record<string, number>;
  eventUpdatesReceived: number;
  duplicateMessages: number;
  keepAliveActiveEvents?: number;
  outrightMarketRowsWithoutFixture?: number;
  rowsStored: number;
  rowsWithoutFixture: number;
  rowsPublished: number;
  rowsHiddenAsDuplicate: number;
  eventsWithMarkets: number;
  eventsWithSelections: number;
  eventsWithSelectableOdds: number;
  marketsWithoutId: number;
  staleUpdatesIgnored: number;
}
export interface EventFeed {
  restoration?:{at:string;source:string;rows:number};
  ticketVersionRecoveries?: {auditId:string;eventId:string;marketId:string;selectionId:string;previousVersion:string;baselineVersion:string}[];
  ticketOutcomes?: import("./tickets.js").TicketOutcome[];
  mode: "demo" | "connected";
  notice: string;
  events: SportEvent[];
  updatedAt?: string;
  health?: "ok" | "degraded" | "unavailable";
  connections?: Record<Lane, ConnectionState>;
  coverage?: Record<Lane, CoverageStats>;
  outrightDiagnostics?: OutrightMarketDiagnostic[];
  horseRacing?: {
    status: "observed" | "not_observed" | "unknown";
    message: string;
  };
}
export interface EventSource {
  getEvents(): Promise<EventFeed>;
}

export type { TicketRequest, TicketLeg, TestTicket, TicketStatus, TicketOutcome } from './tickets.js';
export {currencyPrecision,currency,minor,majorToMinor,formatMinor,returnMinor,MoneyError} from './money.js';
export type {Currency,IntegrationChannel,OperationScope,WalletScope,WalletTransactionScope} from './money.js';
export type {OperationTicket} from './tickets.js';
