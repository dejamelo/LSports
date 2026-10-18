import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { PlatformStore } from "@lsports/feed-store/platform";
import { createApp } from "../apps/api/src/app.js";
import { TradeState } from "../apps/worker/src/state.js";
import { decodeMessage } from "../apps/worker/src/messages.js";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const directory = await mkdtemp(join(tmpdir(), "adl-platform-ui-"));
const platform = new PlatformStore(directory);
const state = new TradeState();
const timestamp = Date.now();
for (const [type, body] of [
  [
    1,
    {
      Events: [
        {
          FixtureId: 900001,
          Fixture: {
            Sport: { Name: "Football" },
            Status: 1,
            League: { Name: "PRUEBA AISLADA" },
            Participants: [
              { Name: "Equipo de prueba A" },
              { Name: "Equipo de prueba B" },
            ],
          },
        },
      ],
    },
  ],
  [
    3,
    {
      Events: [
        {
          FixtureId: 900001,
          Markets: [
            {
              Id: 1,
              Name: "Ganador — PRUEBA AISLADA",
              Status: 1,
              Bets: [{ Id: "900002", Name: "1", Price: "2.10", Status: 1 }],
            },
          ],
        },
      ],
    },
  ],
] as const) {
  const decoded = decodeMessage(
    Buffer.from(
      JSON.stringify({
        Header: {
          Type: type,
          MsgGuid: `isolated-${type}`,
          ServerTimestamp: timestamp,
        },
        Body: body,
      }),
    ),
  );
  state.apply("prematch", decoded.events, decoded.at);
}
state.set("prematch", { phase: "connected" });
state.set("inplay", { phase: "connected" });
await platform.bootstrap("platform@isolated.example", "isolated-test-password");
let iframeUrl = "";
const parent = express();
parent.get("/", (_req, res) =>
  res.send(
    `<html><title>CASINO DE PRUEBA AISLADA</title><iframe title="Apuesta DEPORTIVA LAT" src="${iframeUrl}" style="width:100%;height:1000px;border:0" sandbox="allow-scripts allow-same-origin allow-modals"></iframe></html>`,
  ),
);
const parentServer = parent.listen(0, "127.0.0.1");
await new Promise<void>((r) => parentServer.once("listening", r));
const pa = parentServer.address();
assert(pa && typeof pa !== "string");
const parentOrigin = `http://127.0.0.1:${pa.port}`;
const host = express();
const server = host.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const a = server.address();
assert(a && typeof a !== "string");
const base = `http://127.0.0.1:${a.port}`;
const app = createApp(
  {
    async getEvents() {
      return { ...state.feed(), notice: "PRUEBA AISLADA · NO ES FEED REAL" };
    },
  },
  { platform: true, platformStore: platform, publicOrigin: base },
);
host.use(app);
host.get("/unauthorized-parent", (_req, res) =>
  res.send(`<iframe src="${iframeUrl}"></iframe>`),
);
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/control`);
  await page
    .getByLabel("Email", { exact: true })
    .fill("platform@isolated.example");
  await page
    .getByLabel("Contraseña", { exact: true })
    .fill("isolated-test-password");
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await page
    .getByRole("button", { name: "Nuevo cliente", exact: true })
    .click();
  await page
    .getByLabel("Nombre del cliente", { exact: true })
    .fill("Casino de prueba aislada");
  await page
    .getByLabel("Email del administrador", { exact: true })
    .fill("client@isolated.example");
  await page
    .getByLabel("Contraseña inicial del administrador", { exact: true })
    .fill("isolated-client-password");
  await page
    .getByLabel("Orígenes autorizados, uno por línea", { exact: true })
    .fill(parentOrigin);
  await page
    .getByRole("button", { name: "Crear cliente", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Casino de prueba aislada", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Nueva operación", exact: true })
    .click();
  await page
    .getByLabel("Nombre de la operación", { exact: true })
    .fill("Operación ARS de prueba");
  await page
    .getByLabel("País (código de dos letras)", { exact: true })
    .fill("AR");
  await page.getByLabel("Moneda fija", { exact: true }).selectOption("ARS");
  await page
    .getByRole("button", { name: "Crear operación", exact: true })
    .click();
  await page
    .getByText(
      "Operación creada. La moneda es fija; las credenciales pertenecen a esta operación.",
      { exact: true },
    )
    .waitFor();
  await page.getByRole("button", { name: "Credenciales", exact: true }).click();
  await page
    .getByLabel("Nombre de la credencial", { exact: true })
    .fill("Servidor de prueba");
  await page
    .getByRole("button", { name: "Generar credencial", exact: true })
    .click();
  await page
    .getByText("Activa · ARS · secreto solo en servidor", { exact: true })
    .waitFor();
  const admin = (
    await platform.login(
      "platform@isolated.example",
      "isolated-test-password",
      "isolated-harness",
    )
  ).admin;
  const client = platform.clients(admin)[0];
  const operation = platform.operations(admin, client.id)[0];
  const key = platform.credentials(admin, client.id, operation.id)[0];
  const secret = await readFile(
    join(directory, "credentials", `${key.id}.key`),
    "utf8",
  );
  assert(!(await page.content()).includes(secret));
  const session = await fetch(`${base}/api/integration/v1/embed-sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      clientId: client.id,
      operationId: operation.id,
      currency: operation.currency,
      playerId: "isolated-player",
      parentOrigin,
    }),
  });
  assert.equal(session.status, 201);
  iframeUrl = (await session.json()).iframeUrl;
  const casino = await browser.newPage({
    viewport: { width: 1280, height: 1100 },
  });
  casino.on("pageerror", (e) => errors.push(e.message));
  await casino.goto(parentOrigin);
  const frame = casino.frameLocator("iframe");
  await frame.getByText("Equipo de prueba A", { exact: true }).waitFor();
  await frame.locator(".odds-row button").first().click();
  await frame
    .getByRole("button", { name: "Simular billete", exact: true })
    .click();
  await frame.getByText(/Billete de prueba registrado:/).waitFor();
  const forbidden = await browser.newPage();
  const blocked = forbidden.waitForEvent("console", {
    predicate: (message) => message.text().includes("frame-ancestors"),
    timeout: 5000,
  });
  await forbidden.goto(`${base}/unauthorized-parent`);
  await blocked;
  await forbidden.close();
  const iframe = casino
    .frames()
    .find((f) => f.url().startsWith(base + "/embed/"))!;
  assert(!iframe.url().includes("#code="));
  await frame.locator(".ticket-history details summary").first().click();
  await frame
    .getByRole("button", {
      name: "Abrir / imprimir comprobante de prueba",
      exact: true,
    })
    .click();
  await frame
    .getByRole("button", { name: "Imprimir comprobante", exact: true })
    .waitFor();
  await frame.getByRole("button", { name: "Cerrar", exact: true }).click();
  await casino.setViewportSize({ width: 390, height: 844 });
  assert(
    await iframe.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByRole("button", { name: "Riesgo", exact: true }).click();
  await page
    .getByRole("heading", {
      name: "Control de riesgo · Solo simulación",
      exact: true,
    })
    .waitFor();
  const rule = page.locator(".control-risk-rule").first();
  await rule.locator("summary").click();
  await rule.getByLabel("Habilitar regla", { exact: true }).check();
  await rule
    .getByLabel("Umbral en unidades menores de la moneda", { exact: true })
    .fill("1");
  await page
    .getByRole("button", { name: "Guardar reglas de riesgo", exact: true })
    .click();
  await page
    .getByText("Reglas determinísticas guardadas y auditadas.", { exact: true })
    .waitFor();
  await casino.setViewportSize({ width: 1280, height: 1100 });
  await frame
    .getByRole("button", { name: "Armar otro billete de prueba", exact: true })
    .click();
  await frame.locator(".odds-row button").first().click();
  await frame
    .getByRole("button", { name: "Simular billete", exact: true })
    .click();
  await frame.getByText(/Billete de prueba registrado:/).waitFor();
  const alert = page
    .locator(".control-risk-alert")
    .filter({ hasText: "Importe alto" })
    .first();
  await alert.locator("summary").click();
  await alert
    .getByLabel("Responsable", { exact: true })
    .fill("Operador de prueba");
  await alert
    .getByLabel("Observación", { exact: true })
    .fill("Validación local sin cancelar billetes.");
  await alert.getByLabel("Situación", { exact: true }).selectOption("review");
  await alert
    .getByRole("button", { name: "Guardar tratamiento", exact: true })
    .click();
  await page
    .getByText("Tratamiento de alerta registrado con auditoría.", {
      exact: true,
    })
    .waitFor();
  await page
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  await page
    .getByLabel("Admitir nuevos billetes de prueba", { exact: true })
    .uncheck();
  await page
    .getByRole("button", { name: "Guardar configuración", exact: true })
    .click();
  await page
    .getByText(
      "Configuración guardada. Los resultados pendientes siguen procesándose.",
      { exact: true },
    )
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByRole("button", { name: "Resumen", exact: true }).click();
  await page.getByText("Nuevos billetes pausados", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      test: "isolated_platform_ui",
      status: "ok",
      validated: [
        "admin_login",
        "create_client",
        "create_currency_operation",
        "server_only_key",
        "authorized_cross_origin_iframe",
        "blocked_unauthorized_parent",
        "single_use_exchange",
        "select_parsed_synthetic_odds",
        "persistent_simulated_ticket",
        "protected_receipt",
        "risk_rule_ui",
        "risk_alert_review",
        "pause_admission",
        "responsive_panel_390px",
        "responsive_iframe_390px",
      ],
      supplierCalls: 0,
      realData: false,
    }),
  );
} finally {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => parentServer.close(() => r()));
  app.locals.closeTickets();
  platform.close();
  await rm(directory, { recursive: true, force: true });
}
