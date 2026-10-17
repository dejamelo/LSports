import type { Lane } from "@lsports/contracts";
export interface PackageConfig {
  lane: Lane;
  packageId: number;
  username: string;
  password: string;
  hostname: string;
  vhost: string;
  port: number;
  tls: boolean;
  queue: string;
}
function integer(name: string, fallback: number, min = 1) {
  const n = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`Invalid ${name}`);
  return n;
}
export function loadConfig() {
  if ((process.env.LSPORTS_ENVIRONMENT || "Test") !== "Test")
    throw new Error("Only the requested Test environment is configured");
  const tls = process.env.LSPORTS_MQ_TLS === "true";
  if (
    process.env.LSPORTS_MQ_TLS &&
    !["true", "false"].includes(process.env.LSPORTS_MQ_TLS)
  )
    throw new Error("Invalid LSPORTS_MQ_TLS");
  const packages = (["prematch", "inplay"] as const).map((lane) => {
    const prefix = `LSPORTS_${lane.toUpperCase()}`;
    const username = process.env[`${prefix}_USERNAME`];
    const password = process.env[`${prefix}_PASSWORD`];
    if (!username || !password)
      throw new Error(
        `Missing ${prefix}_USERNAME / ${prefix}_PASSWORD; fill server .env`,
      );
    const packageId = integer(
      `${prefix}_PACKAGE_ID`,
      lane === "prematch" ? 4511 : 4510,
    );
    return {
      lane,
      packageId,
      username,
      password,
      hostname: process.env[`${prefix}_HOST`] || `stm-${lane}.lsports.eu`,
      vhost: lane === "prematch" ? "StmPreMatch" : "StmInPlay",
      port: integer("LSPORTS_MQ_PORT", tls ? 5671 : 5672),
      tls,
      queue: process.env[`${prefix}_QUEUE`] || `_${packageId}_`,
    };
  });
  const httpsUrl = (name: string, fallback: string) => {
    const url = new URL(process.env[name] || fallback);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        `Invalid ${name}: HTTPS URL without credentials required`,
      );
    return url.toString();
  };
  return {
    packages,
    snapshotUrl: httpsUrl(
      "LSPORTS_SNAPSHOT_URL",
      "https://stm-snapshot.lsports.eu",
    ),
    customersUrl: httpsUrl(
      "LSPORTS_CUSTOMERS_URL",
      "https://stm-api.lsports.eu",
    ),
    recoveryMs: integer("LSPORTS_SNAPSHOT_INTERVAL_MS", 300000, 10000),
    staleMs: integer("LSPORTS_FEED_STALE_MS", 90000, 10000),
  };
}
