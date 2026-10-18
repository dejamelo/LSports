import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  currencyPrecision,
  majorToMinor,
  formatMinor,
  minor,
  returnMinor,
} from "@lsports/contracts";
import { PlatformStore } from "./platform.js";
import { TenantTickets } from "./tenant-tickets.js";
import { defaultLimits } from "./operation-limits.js";
test("ISO precision, exact decimal conversion, large integers and fixed-price financial arithmetic never use floating money", () => {
  for (const [code, digits] of Object.entries(currencyPrecision))
    assert.equal(
      new Intl.NumberFormat("en", {
        style: "currency",
        currency: code,
      }).resolvedOptions().maximumFractionDigits,
      digits,
    );
  assert.equal(majorToMinor("123,45", "ARS"), "12345");
  assert.equal(majorToMinor("123", "PYG"), "123");
  assert.throws(() => majorToMinor("1.25", "CLP"), {
    code: "INVALID_PRECISION",
  });
  assert.throws(() => minor(100), { code: "INVALID_MINOR_AMOUNT" });
  assert.throws(() => minor("1.0"), { code: "INVALID_MINOR_AMOUNT" });
  assert.equal(
    formatMinor("900719925474099312345", "USD"),
    "9.007.199.254.740.993.123,45 USD",
  );
  assert.equal(returnMinor("101", [2623300]), "265");
});
test(
  "separate Node workers atomically enforce player/event accumulated limits across web and mobile; retry reserves once",
  { timeout: 15000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "adl-concurrent-limits-"));
    const platform = new PlatformStore(dir);
    let registry: TenantTickets | undefined;
    const children: ReturnType<typeof spawn>[] = [];
    try {
      await platform.bootstrap(
        "admin@test.example",
        "isolated-password-platform",
      );
      const admin = (
        await platform.login(
          "admin@test.example",
          "isolated-password-platform",
          "test",
        )
      ).admin;
      const client = await platform.createClient(admin, {
        name: "Isolated",
        adminEmail: "client@test.example",
        adminPassword: "isolated-client-password",
      });
      const op = platform.createOperation(admin, client.id, {
        name: "ARS",
        country: "AR",
        currency: "ARS",
        limits: {
          ...defaultLimits,
          maxTicketsPerPlayerEvent: 2,
          maxStakePerPlayerEventMinor: "1000",
        },
      });
      registry = new TenantTickets(platform);
      registry.store(op.id); // Prepare schema before concurrent consumers.
      const jobs = ["web", "mobile"].map((channel, index) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "packages/feed-store/src/test-fixtures/operation-bet.ts",
            dir,
            op.id,
            `concurrent-${index}`,
            channel,
          ],
          { stdio: ["ignore", "pipe", "pipe", "ipc"] },
        );
        children.push(child);
        const ready = once(child, "message");
        const exit = once(child, "exit");
        return { child, ready, exit };
      });
      await Promise.all(jobs.map((j) => j.ready));
      const results = jobs.map((j) => once(j.child, "message"));
      for (const job of jobs) job.child.send("go");
      const messages = (await Promise.all(results)).map(
        ([m]) => m as { status: string; code?: string },
      );
      await Promise.all(jobs.map((j) => j.exit));
      assert.equal(messages.filter((m) => m.status === "accepted").length, 1);
      assert.equal(
        messages.find((m) => m.status === "rejected")?.code,
        "PLAYER_EVENT_AMOUNT_LIMIT",
      );
      const report = registry.store(op.id).report();
      assert.equal(report.acceptedTickets, 1);
      assert.equal(report.acceptedStakeMinor, "600");
    } finally {
      for (const child of children)
        if (child.exitCode === null) child.kill("SIGKILL");
      registry?.close();
      platform.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test(
  "concurrent preventive exposure decisions serialize admissions and include their own tentative ticket before commit",
  { timeout: 15000 },
  async () => {
    const { defaultRiskConfig } = await import("./operation-risk.js");
    const dir = await mkdtemp(join(tmpdir(), "adl-concurrent-risk-"));
    const platform = new PlatformStore(dir);
    let registry: TenantTickets | undefined;
    const children: ReturnType<typeof spawn>[] = [];
    try {
      await platform.bootstrap(
        "admin@test.example",
        "isolated-password-platform",
      );
      const admin = (
        await platform.login(
          "admin@test.example",
          "isolated-password-platform",
          "test",
        )
      ).admin;
      const client = await platform.createClient(admin, {
          name: "Isolated",
          adminEmail: "client@test.example",
          adminPassword: "isolated-client-password",
        }),
        op = platform.createOperation(admin, client.id, {
          name: "ARS",
          country: "AR",
          currency: "ARS",
        });
      registry = new TenantTickets(platform);
      const store = registry.store(op.id);
      const config = defaultRiskConfig();
      config.rules.operationExposure = {
        ...config.rules.operationExposure,
        enabled: true,
        action: "block",
        thresholdMinor: "1800",
      };
      store.risk.configure(admin, config);
      const jobs = ["web", "mobile"].map((channel, index) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "packages/feed-store/src/test-fixtures/operation-bet.ts",
            dir,
            op.id,
            `exposure-${index}`,
            channel,
          ],
          { stdio: ["ignore", "pipe", "pipe", "ipc"] },
        );
        children.push(child);
        return {
          child,
          ready: once(child, "message"),
          exit: once(child, "exit"),
        };
      });
      await Promise.all(jobs.map((j) => j.ready));
      const results = jobs.map((j) => once(j.child, "message"));
      for (const job of jobs) job.child.send("go");
      const messages = (await Promise.all(results)).map(
        ([m]) => m as { status: string; code?: string },
      );
      await Promise.all(jobs.map((j) => j.exit));
      assert.equal(messages.filter((m) => m.status === "accepted").length, 1);
      assert.equal(
        messages.find((m) => m.status === "rejected")?.code,
        "RISK_PREVENTIVE_BLOCK",
      );
      assert.equal(store.report().acceptedTickets, 1);
      assert.equal(store.risk.dashboard().exposure.potentialGrossMinor, "1200");
      assert.match(
        JSON.stringify(store.risk.dashboard().audit),
        /risk.preventive.block/,
      );
    } finally {
      for (const child of children)
        if (child.exitCode === null) child.kill("SIGKILL");
      registry?.close();
      platform.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
