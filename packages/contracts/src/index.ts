export type Sport = "futbol" | "tenis" | "basquet" | "hipica" | "otros";
export interface Selection {
  id: string;
  label: string;
  odds: number;
  status?: number;
  available?: boolean;
  line?: string;
}
export interface EventMarket {
  id: string;
  name: string;
  status?: number;
  selections: Selection[];
}
export interface SportEvent {
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
export interface IntegrationDiagnostic {
  operation:
    | "config"
    | "distribution.status"
    | "distribution.start"
    | "snapshot.events"
    | "metadata.sports"
    | "amqp.connect"
    | "amqp.channel"
    | "amqp.prefetch"
    | "amqp.queue"
    | "amqp.consume"
    | "amqp.connection"
    | "feed.decode"
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
    | "unexpected";
  message: string;
  httpStatus?: number;
  providerStatus?: number;
  amqpCode?: number;
  networkCode?: string;
  fields?: string[];
}
export interface ConnectionState {
  diagnostic?: IntegrationDiagnostic;
  phase: "starting" | "recovering" | "connected" | "error" | "stopped";
  message: string;
  lastMessageAt?: string;
  lastSnapshotAt?: string;
  snapshotEvents?: number;
  catalogHorseRacing?: boolean;
}
export interface EventFeed {
  mode: "demo" | "connected";
  notice: string;
  events: SportEvent[];
  updatedAt?: string;
  health?: "ok" | "degraded" | "unavailable";
  connections?: Record<Lane, ConnectionState>;
  horseRacing?: {
    status: "observed" | "not_observed" | "unknown";
    message: string;
  };
}
export interface EventSource {
  getEvents(): Promise<EventFeed>;
}
