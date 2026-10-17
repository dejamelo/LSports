import amqp from "amqplib";
import type { PackageConfig } from "./config.js";
import { operation } from "./diagnostics.js";
export function connectMq(pkg: PackageConfig, connect = amqp.connect) {
  return operation("amqp.connect", "amqp", () =>
    connect(
      {
        protocol: pkg.tls ? "amqps" : "amqp",
        hostname: pkg.hostname,
        port: pkg.port,
        username: pkg.mqUsername ?? pkg.username,
        password: pkg.mqPassword ?? pkg.password,
        vhost: pkg.vhost,
        heartbeat: 30,
      },
      { timeout: 15000, ...(pkg.tls ? { servername: pkg.hostname } : {}) },
    ),
  );
}
