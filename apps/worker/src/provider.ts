import {normalizeSdkTimestamps,attachTimestampPrecision} from './timestamp-contract.js';
import { inspectSettlements } from "./settlement-evidence.js";
import { SnapshotScheduler } from "./snapshot-scheduler.js";
import { sdkAxios as axios } from "./diagnostics.js";
import {
  operation,
  describeFailure,
  formatDiagnostic,
  OperationError,
  responseEvidence,
  snapshotResponsePayload,
  snapshotResponseInspection,
} from "./diagnostics.js";
import {
  CustomersApiFactory,
  SnapshotApiFactory,
  GetEventRequestDto,
  GetOutrightFixtureRequestDto,
  GetOutrightMarketRequestDto,
  IdSafeJsonParser,
  TransformerUtil,
  OutrightFixtureUpdate,
  OutrightFixtureMarketUpdate,
  GetInPlayEventRequestDto,
  StatusResponseBody,
  StartResponseBody,
  GetSubscriptionsRequestDto,
  GetFixtureScheduleRequestDto,
} from "trade360-nodejs-sdk";
import type { SnapshotAudit } from "@lsports/contracts";
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
axios.defaults.maxRedirects = 0;
export interface ProviderClients {
  snapshot(): Promise<TradeEvent[]>;
  outrightFixtures?: () => Promise<TradeEvent[]>;
  outrightTimestampRejections?: () => import("@lsports/contracts").TimestampInspection[];
  outrightMarkets?: (fixtureIds?: number[]) => Promise<TradeEvent[]>;
  outrightMarketRequest?: () => import("@lsports/contracts").SnapshotRequestInspection | undefined;
  catalog(): Promise<{ id?: number; name?: string }[]>;
  distributionStatus(): Promise<{
    isDistributionOn: boolean;
    consumers: string[];
    numberMessagesInQueue: number;
    messagesPerSecond: number;
  }>;
  startDistribution(): Promise<void>;
  snapshotAudit?: () => SnapshotAudit | undefined;
  outrightResponseInspections?: () => NonNullable<import("@lsports/contracts").ConnectionState["outrightRecovery"]>["responseInspections"];
  subscriptions?: () => Promise<{ fixtures: number }>;
  quota?: () => Promise<{
    creditLimit: number;
    creditRemaining: number;
    usedCredit: number;
  }>;
  schedule?: () => Promise<{ fixtures: number }>;
}
export function clients(
  config: PackageConfig,
  urls: { snapshotUrl: string; customersUrl: string },
  scheduling?: Pick<SnapshotScheduler, "run">,
): ProviderClients {
  const scheduler = scheduling || new SnapshotScheduler(urls.snapshotUrl, config.packageId);
  const snapshotRequest = <T>(name: import("./diagnostics.js").Operation, action: () => Promise<T>) => scheduler.run(name, () => operation(name, "http", action));
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
  const subscription = factory.createSubscriptionHttpClient({
    ...options,
    restApiBaseUrl: urls.customersUrl,
  });
  let rejectedTimestamps: import("@lsports/contracts").TimestampInspection[] = [];
  let audit: SnapshotAudit | undefined;
  let recoveredFixtureIds: number[] | undefined;
  let marketRequest: import("@lsports/contracts").SnapshotRequestInspection | undefined;
  const outrightInspections: NonNullable<ReturnType<NonNullable<ProviderClients["outrightResponseInspections"]>>> = {};
  return {
    snapshotAudit: () => audit,
    outrightTimestampRejections: () => structuredClone(rejectedTimestamps),
    outrightMarketRequest: () => marketRequest ? { ...marketRequest } : undefined,
    outrightResponseInspections: () => structuredClone(outrightInspections),
    ...(config.lane === "prematch" ? {
      async outrightFixtures() {
        return snapshotRequest("snapshot.outright.fixtures", async () => {
          const sdk = await (snapshot as ReturnType<SnapshotApiFactory["createSnapshotApiPrematchHttpClient"]>).getOutrightFixtures(new GetOutrightFixtureRequestDto({}));
          const result = decodeOutrightSnapshot(sdk, snapshotResponsePayload(), "fixtures");
          recoveredFixtureIds = [...new Set(result.map(event => event.fixtureId))];
          outrightInspections.fixtures = snapshotResponseInspection();
          return result;
        });
      },
      async outrightMarkets(fixtureIds = recoveredFixtureIds) {
        const ids = [...new Set(fixtureIds || [])];
        if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error("Invalid outright fixture filter");
        marketRequest = { method: "POST", route: "/Prematch/GetOutrightFixtureMarkets", filter: ids.length ? "fixtures" : "none", fixtureCount: ids.length, competitionIdSent: false, credentialField: "userName" };
        try {
          return await snapshotRequest("snapshot.outright.markets", async () => {
            const sdk = await (snapshot as ReturnType<SnapshotApiFactory["createSnapshotApiPrematchHttpClient"]>).getOutrightFixtureMarkets(new GetOutrightMarketRequestDto(ids.length ? { fixtures: ids } : {}));
            const result = decodeOutrightSnapshot(sdk, snapshotResponsePayload(), "markets");
            rejectedTimestamps = result.flatMap(e => (e.settlementInspection?.rejected || []).map(r => r.inspection));
            outrightInspections.markets = snapshotResponseInspection();
            return result;
          });
        } catch (error) {
          throw new OperationError({ ...describeFailure(error, "snapshot.outright.markets", "http"), requestInspection: { ...marketRequest } });
        }
      },
    } : {}),
    async subscriptions() {
      return operation("subscriptions.list", "http", async () => {
        const response = await subscription.getSubscriptions(
          new GetSubscriptionsRequestDto({}),
        );
        if (
          !response ||
          !Array.isArray(response.fixtures) ||
          responseEvidence().fixturesCount === undefined
        )
          throw new Error("Invalid subscriptions response");
        return { fixtures: response.fixtures.length };
      });
    },
    async quota() {
      return operation("subscriptions.quota", "http", async () => {
        const response = await subscription.getPackageQuota();
        if (
          !response ||
          ![
            response.creditLimit,
            response.creditRemaining,
            response.usedCredit,
          ].every(Number.isFinite)
        )
          throw new Error("Invalid quota response");
        return {
          creditLimit: response.creditLimit,
          creditRemaining: response.creditRemaining,
          usedCredit: response.usedCredit,
        };
      });
    },
    async schedule() {
      return operation("subscriptions.schedule", "http", async () => {
        const response = await subscription.getFixturesSchedule(
          new GetFixtureScheduleRequestDto({}),
        );
        if (
          !response ||
          !Array.isArray(response.fixtures) ||
          responseEvidence().fixturesCount === undefined
        )
          throw new Error("Invalid schedule response");
        return { fixtures: response.fixtures.length };
      });
    },
    async snapshot(): Promise<TradeEvent[]> {
      return snapshotRequest("snapshot.events", async () => {
        const response =
          config.lane === "inplay"
            ? await snapshot.getEvents(new GetInPlayEventRequestDto({}))
            : await snapshot.getEvents(new GetEventRequestDto({}));
        if (response === undefined || response === null)
          throw new Error("Invalid snapshot response");
        const rows = Array.isArray(response) ? response : [response];
        if (
          rows.some(
            (e) =>
              !Number.isSafeInteger(e.fixtureId) ||
              !e.fixture ||
              typeof e.fixture !== "object" ||
              Array.isArray(e.fixture),
          )
        )
          throw new Error("Invalid snapshot event");
        const evidence = responseEvidence();
        audit = {
          bodyShape: evidence.bodyShape,
          providerRows: evidence.providerRows,
          sdkRows: rows.length,
          acceptedRows: rows.length,
          filters: "none",
        };
        if (evidence.providerRows !== rows.length)
          throw new Error("Invalid snapshot response: row count mismatch");
        let raw = snapshotResponsePayload();
        if(typeof raw==='string')raw=IdSafeJsonParser.parse(raw);
        if(raw && typeof raw==='object' && 'Body' in raw){const body=(raw as any).Body;attachTimestampPrecision(Array.isArray(body)?body:[body],rows);}
        return rows;
      });
    },
    async catalog() {
      return operation("metadata.sports", "http", async () => {
        const sports = await metadata.getSports();
        if (!Array.isArray(sports)) throw new Error("Invalid metadata");
        return sports;
      });
    },
    async distributionStatus() {
      return operation("distribution.status", "http", async () => {
        const status =
          await distribution.getDistributionStatus(StatusResponseBody);
        if (!status || typeof status.isDistributionOn !== "boolean")
          throw new Error("Distribution status missing");
        return status;
      });
    },
    async startDistribution() {
      let status = await this.distributionStatus();
      if (!status.isDistributionOn) {
        await operation("distribution.start", "http", () =>
          distribution.startDistribution(StartResponseBody),
        );
        status = await this.distributionStatus();
        if (!status?.isDistributionOn)
          throw new OperationError({
            operation: "distribution.start",
            protocol: "http",
            category: "invalid_response",
            message:
              "La distribución sigue apagada después de solicitar inicio.",
          });
      }
    },
  };
}
export { decodeMessage } from "./messages.js";
export type { Decoded } from "./messages.js";
export function safeFailure(error: unknown): string {
  return formatDiagnostic(describeFailure(error, "worker.start", "local"));
}

// The snapshot DTOs omit Market.Status and rich participant fields. Use the official
// message entities on the same validated response body to retain supplier fields.
function decodeOutrightSnapshot(sdk: unknown, payload: unknown, kind: "fixtures" | "markets"): TradeEvent[] {
  const invalid: () => never = () => { throw new OperationError({
    operation: kind === "fixtures" ? "snapshot.outright.fixtures" : "snapshot.outright.markets",
    protocol: "http", category: "invalid_response", reason: "invalid_snapshot", stage: "validation",
    message: "Snapshot Outright con estructura o conteo inválido; no se reemplazan los datos persistidos.",
  }); };
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (typeof payload === "string") payload = IdSafeJsonParser.parse(payload);
  if (!object(payload) || payload.Body === undefined || sdk == null) invalid();
  const raw = Array.isArray(payload.Body) ? payload.Body : [payload.Body];
  const converted = Array.isArray(sdk) ? sdk : [sdk];
  if (raw.length !== converted.length) invalid();
  const events: TradeEvent[] = [];
  for (let i = 0; i < raw.length; i++) {
    const body = raw[i];
    const sdkBody = converted[i];
    if (!object(body) || !Number.isSafeInteger(body.Id) || Number(body.Id) <= 0 || !Array.isArray(body.Events) ||
        !object(sdkBody) || !Array.isArray(sdkBody.events) || sdkBody.events.length !== body.Events.length)
      invalid();
    for (const row of body.Events) {
      if (!object(row) || !Number.isSafeInteger(row.FixtureId) || Number(row.FixtureId) <= 0 ||
          (kind === "fixtures" ? !object(row.OutrightFixture) ||
            (row.OutrightFixture.Participants !== undefined && (!Array.isArray(row.OutrightFixture.Participants) || row.OutrightFixture.Participants.some((p: unknown) => !object(p))))
            : !Array.isArray(row.Markets) || row.Markets.some((m: unknown) => !object(m) || !Number.isSafeInteger(m.Id) || Number(m.Id) <= 0 || (m.Bets !== undefined && !Array.isArray(m.Bets)))))
        invalid();
    }
    if (kind === "fixtures") {
      const competition = TransformerUtil.transform(normalizeSdkTimestamps({ Competition: body }), OutrightFixtureUpdate).competition!;
      for (const row of competition.events || []) events.push({ fixtureId: row.fixtureId, outright: {
        competitionId: competition.id!, competitionName: competition.name, competitionType: competition.type, fixture: row.outrightFixture } });
    } else {
      const competition = TransformerUtil.transform(normalizeSdkTimestamps({ Competition: body }), OutrightFixtureMarketUpdate).competition!;
      attachTimestampPrecision({Competition:body},{competition});
      for (const [index, row] of (competition.events || []).entries()) {
        if (row.markets?.some(m => m.bets?.some(b => typeof b.id !== "string" || !b.id))) invalid();
        let inspection: ReturnType<typeof inspectSettlements>;
        try { inspection = inspectSettlements(body.Events[index].Markets, row.markets || [], "snapshot", {competitionId:competition.id!,fixtureId:row.fixtureId}); }
        catch (error) { if (error instanceof OperationError) throw error; return invalid(); }
        const blocked = new Set(inspection.rejected.map(r => `${r.marketId}:${r.selectionId}`));
        events.push({ fixtureId: row.fixtureId, outright: { competitionId: competition.id!, competitionName: competition.name, competitionType: competition.type },
          markets: (row.markets || []).map(m => ({...m,bets:(m.bets || []).filter(b => !blocked.has(`${m.id}:${b.id}`))})),
          marketRecovery: true, settlementInspection: inspection });
      }
    }
  }
  return events;
}
