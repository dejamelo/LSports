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
      vhost: identifier(pkg.vhost),
      queue: identifier(pkg.queue),
    },
    snapshotHost: identifier(new URL(urls.snapshotUrl).hostname),
    customersHost: identifier(new URL(urls.customersUrl).hostname),
    warnings:
      (pkg.tls && pkg.port === 5672) || (!pkg.tls && pkg.port === 5671)
        ? [
            "Puerto/TLS no coincide con el listener estándar; confirmá si el proveedor asignó un listener personalizado.",
          ]
        : [],
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
      write({ operation: name, protocol, status: "ok", ...summary(result) });
      return result;
    } catch (error) {
      healthy = false;
      write({ status: "error", ...describeFailure(error, name, protocol) });
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
    (result) => ({ events: result.length }),
  );
  await check(
    "metadata.sports",
    "http",
    () => api.catalog(),
    (result) => ({ sports: result.length }),
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
