import axios from "axios";
import {
  CustomersApiFactory,
  SnapshotApiFactory,
  GetEventRequestDto,
  GetInPlayEventRequestDto,
  StatusResponseBody,
  StartResponseBody,
  FixtureMetadataUpdate,
  LivescoreUpdate,
  MarketUpdate,
  SettlementUpdate,
  HeartbeatUpdate,
  KeepAliveUpdate,
  TransformerUtil,
  IdSafeJsonParser,
  WrappedMessage,
  TransportMessageHeaders,
} from "trade360-nodejs-sdk";
import type { ILogger } from "trade360-nodejs-sdk";
import type { PackageConfig } from "./config.js";
import type { TradeEvent } from "./state.js";
// SDK errors may contain request bodies. Never forward SDK log arguments or exception objects.
export const silentLogger: ILogger = {
  log() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};
axios.defaults.timeout = 20000;
axios.defaults.maxContentLength = 50 * 1024 * 1024;
export function clients(
  config: PackageConfig,
  urls: { snapshotUrl: string; customersUrl: string },
) {
  const credentials = {
    packageId: config.packageId,
    username: config.username,
    password: config.password,
  };
  const options = { packageCredentials: credentials, logger: silentLogger };
  const snapshots = new SnapshotApiFactory();
  const snapshot =
    config.lane === "inplay"
      ? snapshots.createSnapshotApiInPlayHttpClient({
          ...options,
          restApiBaseUrl: urls.snapshotUrl,
        })
      : snapshots.createSnapshotApiPrematchHttpClient({
          ...options,
          restApiBaseUrl: urls.snapshotUrl,
        });
  const factory = new CustomersApiFactory();
  const metadata = factory.createMetadataHttpClient({
    ...options,
    restApiBaseUrl: urls.customersUrl,
  });
  const distribution = factory.createPackageDistributionHttpClient({
    ...options,
    restApiBaseUrl: urls.customersUrl,
  });
  return {
    async snapshot(): Promise<TradeEvent[]> {
      const response =
        config.lane === "inplay"
          ? await snapshot.getEvents(new GetInPlayEventRequestDto({}))
          : await snapshot.getEvents(new GetEventRequestDto({}));
      if (response === undefined || response === null)
        throw new Error("Invalid snapshot response");
      const rows = Array.isArray(response) ? response : [response];
      if (rows.some((e) => !Number.isSafeInteger(e.fixtureId) || !e.fixture))
        throw new Error("Invalid snapshot event");
      return rows;
    },
    async catalog() {
      const sports = await metadata.getSports();
      if (!Array.isArray(sports)) throw new Error("Invalid metadata");
      return sports;
    },
    async startDistribution() {
      let status = await distribution.getDistributionStatus(StatusResponseBody);
      if (!status) throw new Error("Distribution status missing");
      if (!status.isDistributionOn) {
        await distribution.startDistribution(StartResponseBody);
        status = await distribution.getDistributionStatus(StatusResponseBody);
        if (!status?.isDistributionOn)
          throw new Error("Distribution did not start");
      }
    },
  };
}
export interface Decoded {
  guid: string;
  at: number;
  events: TradeEvent[];
  interrupted: boolean;
  type: number;
}
export function decodeMessage(
  content: Buffer,
  headers: Record<string, unknown>,
): Decoded {
  const transport = TransportMessageHeaders.createFromProperties(headers);
  const wrapped = TransformerUtil.transform(
    IdSafeJsonParser.parse(content.toString("utf8")) as WrappedMessage,
    WrappedMessage,
  );
  if (!wrapped.header || !wrapped.body)
    throw new Error("Missing message envelope");
  const { type, msgGuid } = wrapped.header;
  const at = Number(transport.timestampInMs);
  if (!Number.isFinite(at) || at <= 0 || !msgGuid)
    throw new Error("Invalid message timestamp/guid");
  let events: TradeEvent[] = [];
  let interrupted = false;
  if (type === 1)
    events =
      TransformerUtil.transform(wrapped.body, FixtureMetadataUpdate).events ||
      [];
  if (type === 2)
    events = (TransformerUtil.transform(wrapped.body, LivescoreUpdate).events ||
      []) as TradeEvent[];
  if (type === 3)
    events = TransformerUtil.transform(wrapped.body, MarketUpdate).events || [];
  if (type === 35)
    events =
      TransformerUtil.transform(wrapped.body, SettlementUpdate).events || [];
  if (type === 32)
    interrupted = !!TransformerUtil.transform(wrapped.body, HeartbeatUpdate)
      .feedInterrupted?.length;
  if (type === 31) TransformerUtil.transform(wrapped.body, KeepAliveUpdate);
  return { guid: msgGuid, at, events, interrupted, type };
}
export function safeFailure(error: unknown): string {
  // Classification only. Never return supplier text, URLs, usernames, body or stack.
  const text = error instanceof Error ? `${error.name} ${error.message}` : "";
  if (/401|403|ACCESS_REFUSED|authentication/i.test(text))
    return "Autenticación o permisos rechazados. Revisá las credenciales y el acceso al paquete.";
  if (/certificate|TLS|SSL/i.test(text))
    return "Falló la verificación TLS. Revisá puerto y certificado del proveedor.";
  if (/ECONN|ETIMEDOUT|ENOTFOUND|timeout/i.test(text))
    return "Proveedor no accesible. Revisá red, host y puerto.";
  return "Falló la conexión, el snapshot o el procesamiento del proveedor. Reintentando sin datos demo.";
}
