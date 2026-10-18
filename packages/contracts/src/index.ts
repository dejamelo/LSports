export type Sport = "futbol" | "tenis" | "basquet" | "hipica" | "otros";
export interface Selection {
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
export interface OutrightMarketResult {
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
export interface SportEvent {
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
export interface IntegrationDiagnostic {
  requestInspection?: SnapshotRequestInspection;
  operation:
    | "config"
    | "distribution.status"
    | "distribution.start"
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
  timeoutMs?: number;
  responseLimitBytes?: number;
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
  retryPolicy?: "restart_required";
  deliveryDisposition?: "requeue_requested" | "unacknowledged_until_close";
}
export interface FeedMessageMetadata {
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
  diagnostic?: IntegrationDiagnostic;
  phase: "starting" | "recovering" | "connected" | "error" | "stopped";
  message: string;
  lastMessageAt?: string;
  lastSnapshotAt?: string;
  snapshotEvents?: number;
  catalogHorseRacing?: boolean;
  outrightRecovery?: { fixtures?: number; marketEvents?: number; status: "ok" | "partial" | "rate_limited" | "unsupported"; diagnostics?: IntegrationDiagnostic[]; checkedAt: string; responseInspections?: { fixtures?: HttpResponseInspection; markets?: HttpResponseInspection }; marketRequest?: SnapshotRequestInspection };
}
export interface SnapshotAudit {
  bodyShape: "array" | "single_event" | "events_wrapper" | "other" | "missing";
  providerRows?: number;
  sdkRows: number;
  acceptedRows: number;
  filters: "none";
}
export interface CoverageStats {
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
