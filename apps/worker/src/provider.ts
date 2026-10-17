import { sdkAxios as axios } from "./diagnostics.js";
import {
  operation,
  describeFailure,
  formatDiagnostic,
  OperationError,
} from "./diagnostics.js";
import {
  CustomersApiFactory,
  SnapshotApiFactory,
  GetEventRequestDto,
  GetInPlayEventRequestDto,
  StatusResponseBody,
  StartResponseBody,
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
axios.defaults.maxRedirects = 0;
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
      return operation("snapshot.events", "http", async () => {
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
