import { resolveConsumeQueueName } from "trade360-nodejs-sdk";
import type { Lane } from "@lsports/contracts";
import { configError } from "./diagnostics.js";
export interface PackageConfig {
  lane: Lane;
  packageId: number;
  username: string;
  password: string;
  mqUsername?: string;
  mqPassword?: string;
  hostname: string;
  vhost: string;
  port: number;
  tls: boolean;
  queue: string;
  queueSource?: "sdk_default" | "environment_override";
  defaultQueue?: string;
}
function integer(
  name: string,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
) {
  const n = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw configError("configuration", [name], "Valor numérico inválido.");
  return n;
}
const present = (s: string | undefined) => !!s?.trim();
export function loadPackageConfig(lane: Lane): PackageConfig {
  const prefix = `LSPORTS_${lane.toUpperCase()}`;
  const fields = [`${prefix}_USERNAME`, `${prefix}_PASSWORD`].filter(
    (n) => !present(process.env[n]),
  );
  if (fields.length)
    throw configError(
      "missing_credentials",
      fields,
      `Faltan variables del servidor: ${fields.join(", ")}. No se intentó autenticar.`,
    );
  const packageId = integer(
    `${prefix}_PACKAGE_ID`,
    lane === "prematch" ? 4511 : 4510,
  );
  const tlsValue = process.env.LSPORTS_MQ_TLS || "false";
  if (!["true", "false"].includes(tlsValue))
    throw configError("configuration", ["LSPORTS_MQ_TLS"], "Usá true o false.");
  const tls = tlsValue === "true";
  const port = integer("LSPORTS_MQ_PORT", tls ? 5671 : 5672, 1, 65535);
  const hostname = process.env[`${prefix}_HOST`] || `stm-${lane}.lsports.eu`;
  if (!/^[a-zA-Z0-9.-]+$/.test(hostname))
    throw configError(
      "configuration",
      [`${prefix}_HOST`],
      "Usá solo un hostname, sin protocolo, puerto ni credenciales.",
    );
  const overrides = [`${prefix}_MQ_USERNAME`, `${prefix}_MQ_PASSWORD`];
  const hasOverrides = overrides.some((n) => present(process.env[n]));
  const missingOverrides = hasOverrides
    ? overrides.filter((n) => !present(process.env[n]))
    : [];
  if (missingOverrides.length)
    throw configError(
      "missing_credentials",
      missingOverrides,
      "El par RabbitMQ específico está incompleto. No se intentó autenticar.",
    );
  return {
    lane,
    packageId,
    username: process.env[`${prefix}_USERNAME`]!,
    password: process.env[`${prefix}_PASSWORD`]!,
    ...(hasOverrides
      ? {
          mqUsername: process.env[overrides[0]]!,
          mqPassword: process.env[overrides[1]]!,
        }
      : {}),
    hostname,
    vhost:
      process.env[`${prefix}_VHOST`] ||
      (lane === "prematch" ? "StmPreMatch" : "StmInPlay"),
    port,
    tls,
    queue: resolveConsumeQueueName({
      packageId,
      customQueueName: process.env[`${prefix}_QUEUE`],
    }),
    defaultQueue: resolveConsumeQueueName({ packageId }),
    queueSource: process.env[`${prefix}_QUEUE`]?.trim()
      ? "environment_override"
      : "sdk_default",
  };
}
export function loadRuntimeConfig() {
  if ((process.env.LSPORTS_ENVIRONMENT || "Test") !== "Test")
    throw configError(
      "configuration",
      ["LSPORTS_ENVIRONMENT"],
      "Solo está configurado el entorno Test solicitado.",
    );
  const httpsUrl = (name: string, fallback: string) => {
    try {
      const url = new URL(process.env[name] || fallback);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw Error();
      return url.toString();
    } catch {
      throw configError(
        "configuration",
        [name],
        "Usá una URL HTTPS sin credenciales, query ni fragmento.",
      );
    }
  };
  return {
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
export function loadConfig() {
  return {
    ...loadRuntimeConfig(),
    packages: (["prematch", "inplay"] as const).map(loadPackageConfig),
  };
}
