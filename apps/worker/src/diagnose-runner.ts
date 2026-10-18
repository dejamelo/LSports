import amqp from "amqplib";
import type { PackageConfig } from "./config.js";
import { clients } from "./provider.js";
import { connectMq } from "./mq.js";
import { operation, describeFailure } from "./diagnostics.js";
import type { Operation, Protocol } from "./diagnostics.js";
export type Report = Record<string, unknown>;
export async function diagnosePackage(
  pkg: PackageConfig,
  urls: { snapshotUrl: string; customersUrl: string },
  emit: (report: Report) => void,
  deps = { connect: amqp.connect, clientFactory: clients },
) {
  let healthy = true;
  const write = (report: Report) =>
    emit({ lane: pkg.lane, packageId: pkg.packageId, ...report });
  const secrets = [
    pkg.username,
    pkg.password,
    pkg.mqUsername,
    pkg.mqPassword,
  ].filter((s): s is string => !!s);
  const identifier = (text: string) =>
    secrets.some((s) => text.includes(s)) || /[:@\r\n]/.test(text)
      ? "[omitido]"
      : text.slice(0, 255);
  const defaultQueue = pkg.defaultQueue || `_${pkg.packageId}_`;
  const queueDetails = {
    queue: identifier(pkg.queue),
    sdkDefaultQueue: defaultQueue,
    queueSource: pkg.queueSource || "unspecified",
    queueVariable: `LSPORTS_${pkg.lane.toUpperCase()}_QUEUE`,
    vhost: identifier(pkg.vhost),
  };
  const warnings: string[] = [];
  if ((pkg.tls && pkg.port === 5672) || (!pkg.tls && pkg.port === 5671))
    warnings.push(
      "Puerto/TLS no coincide con el listener estándar; confirmá si el proveedor asignó un listener personalizado.",
    );
  if (pkg.queue === String(pkg.packageId))
    warnings.push(
      `El override de cola es el ID sin underscores. El default oficial es ${defaultQueue}; revisá LSPORTS_${pkg.lane.toUpperCase()}_QUEUE y los exports del shell. No se cambia automáticamente una cola personalizada.`,
    );
  write({
    operation: "config",
    status: "ok",
    credentials: {
      http: "present",
      amqp: pkg.mqUsername ? "explicit_pair_present" : "same_package_pair",
    },
    amqp: {
      host: identifier(pkg.hostname),
      port: pkg.port,
      tls: pkg.tls,
      ...queueDetails,
    },
    snapshotHost: identifier(new URL(urls.snapshotUrl).hostname),
    customersHost: identifier(new URL(urls.customersUrl).hostname),
    warnings,
  });
  const api = deps.clientFactory(pkg, urls);
  async function check<T>(
    name: Operation,
    protocol: Protocol,
    action: () => Promise<T>,
    summary: (result: T) => Report = () => ({}),
  ) {
    try {
      const result = await operation(name, protocol, action);
      write({
        operation: name,
        protocol,
        status: "ok",
        ...(name === "amqp.queue" ? queueDetails : {}),
        ...summary(result),
      });
      return result;
    } catch (error) {
      healthy = false;
      const diagnostic = describeFailure(error, name, protocol);
      write({
        status: diagnostic.category === "rate_limited" ? "deferred" : "error",
        ...(name === "amqp.queue" ? queueDetails : {}),
        ...diagnostic,
      });
      return undefined;
    }
  }
  // Independent, read-only HTTP probes. Do not start distribution or change subscriptions.
  await check(
    "distribution.status",
    "http",
    () => api.distributionStatus(),
    (result) => ({ distributionOn: result.isDistributionOn }),
  );
  await check(
    "snapshot.events",
    "http",
    () => api.snapshot(),
    (result) => ({
      events: result.length,
      snapshotAudit: api.snapshotAudit?.(),
    }),
  );
  if (api.outrightFixtures) await check("snapshot.outright.fixtures", "http", () => api.outrightFixtures!(), result => ({ events: result.length }));
  if (api.outrightMarkets) await check("snapshot.outright.markets", "http", () => api.outrightMarkets!(), result => ({ events: result.length, timestampRejected:api.outrightTimestampRejections?.().length || 0, complete:!api.outrightTimestampRejections?.().length }));
  if (pkg.lane === "inplay" && !api.outrightFixtures)
    write({ operation: "snapshot.outright.fixtures", status: "unsupported", message: "SDK oficial InPlay sin snapshot outright por fixture; no se inventa ruta." });
  await check(
    "metadata.sports",
    "http",
    () => api.catalog(),
    (result) => ({ sports: result.length }),
  );
  if (api.subscriptions)
    await check(
      "subscriptions.list",
      "http",
      () => api.subscriptions!(),
      (result) => ({ subscribedFixtures: result.fixtures }),
    );
  if (api.quota)
    await check(
      "subscriptions.quota",
      "http",
      () => api.quota!(),
      (result) => ({ ...result }),
    );
  if (pkg.lane === "inplay" && api.schedule)
    await check(
      "subscriptions.schedule",
      "http",
      () => api.schedule!(),
      (result) => ({
        scheduledFixtures: result.fixtures,
        scope: "InPlaySchedule",
      }),
    );
  const connection = await check("amqp.connect", "amqp", () =>
    connectMq(pkg, deps.connect),
  );
  if (!connection) {
    write({
      operation: "amqp.queue",
      status: "skipped",
      message: "No se pudo abrir la conexión AMQP.",
    });
    return false;
  }
  let interrupted = false;
  connection.on("error", (error) => {
    interrupted = true;
    healthy = false;
    write({
      status: "error",
      ...describeFailure(error, "amqp.connection", "amqp"),
    });
  });
  try {
    const channel = await check("amqp.channel", "amqp", () =>
      connection.createChannel(),
    );
    if (channel) {
      channel.on("error", () => {}); // checkQueue rejection carries the precise operation and replyCode.
      await check(
        "amqp.queue",
        "amqp",
        () => channel.checkQueue(pkg.queue),
        (result) => ({
          messages: result.messageCount,
          consumers: result.consumerCount,
          passive: true,
        }),
      );
      await channel.close().catch(() => {});
    }
  } finally {
    await connection.close().catch(() => {});
  }
  return healthy && !interrupted;
}
