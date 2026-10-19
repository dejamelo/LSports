import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startSyntheticDemo, syntheticLogin } from "./synthetic-demo.js";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const directory = await mkdtemp(join(tmpdir(), "adl-synthetic-browser-"));
const demo = await startSyntheticDemo({
  directory: join(directory, "isolated"),
  apiPort: 0,
  parentPort: 0,
});
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  args: ["--no-sandbox"],
});
try {
  const admin = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await admin.goto(demo.apiOrigin + "/control");
  await admin.getByLabel("Email", { exact: true }).fill(syntheticLogin.email);
  await admin
    .getByLabel("Contraseña", { exact: true })
    .fill(syntheticLogin.password);
  assert.equal(
    await admin.getByLabel("Contraseña", { exact: true }).getAttribute("type"),
    "password",
  );
  await admin
    .getByRole("button", { name: "Mostrar contraseña", exact: true })
    .click();
  assert.equal(
    await admin.getByLabel("Contraseña", { exact: true }).getAttribute("type"),
    "text",
  );
  await admin
    .getByRole("button", { name: "Ocultar contraseña", exact: true })
    .click();
  assert.equal(
    await admin.getByLabel("Contraseña", { exact: true }).getAttribute("type"),
    "password",
  );
  assert(
    (await admin.getByLabel("Contraseña", { exact: true }).inputValue()) ===
      syntheticLogin.password,
  );
  await admin.getByRole("button", { name: "Ingresar", exact: true }).click();
  await admin.getByRole("button", { name: "Terminales", exact: true }).click();
  await admin
    .getByLabel("ID de terminal", { exact: true })
    .fill("SYNTHETIC-POS-01");
  await admin
    .getByLabel("Nombre del terminal", { exact: true })
    .fill("POS SINTÉTICO AISLADO");
  await admin
    .getByRole("button", { name: "Guardar terminal", exact: true })
    .click();
  await admin.getByText("Terminal guardado.", { exact: true }).waitFor();
  for (const channel of ["web", "mobile", "pos"]) {
    await admin
      .getByRole("button", { name: "Sportsbook", exact: true })
      .click();
    await admin.getByLabel("Canal de la vista previa").selectOption(channel);
    if (channel === "pos")
      await admin
        .getByLabel("ID de terminal", { exact: true })
        .fill("SYNTHETIC-POS-01");
    const creation = admin
      .waitForResponse(
        (response) =>
          response.url().endsWith("/preview") &&
          response.request().method() === "POST",
      )
      .catch((error) => error);
    const exchange = admin
      .waitForResponse(
        (response) =>
          response.url().endsWith("/api/integration/v1/embed-exchange") &&
          response.request().method() === "POST",
      )
      .catch((error) => error);
    await admin
      .getByRole("button", {
        name: "Abrir sportsbook de simulación",
        exact: true,
      })
      .click();
    const created = await creation;
    if (created instanceof Error) throw created;
    assert.equal(created.status(), 201);
    assert.equal(
      new URL((await created.request().allHeaders()).origin).origin,
      demo.apiOrigin,
    );
    const exchanged = await exchange;
    if (exchanged instanceof Error) throw exchanged;
    assert.equal(exchanged.status(), 200);
    const session = await exchanged.json();
    assert.equal(session.channel, channel);
    assert.equal(session.scope.operationId, demo.manifest.operationId);
    assert.equal(session.scope.currency, "ARS");
    if (channel === "pos") assert.equal(session.terminalId, "SYNTHETIC-POS-01");
    await admin
      .frameLocator('iframe[title="Sportsbook de simulación"]')
      .getByRole("heading", {
        name: "Historial de billetes de prueba",
        exact: true,
      })
      .waitFor();
    await admin
      .getByRole("button", {
        name: "Cerrar iframe y volver al resumen",
        exact: true,
      })
      .click();
  }
  await admin.getByRole("button", { name: "Operaciones", exact: true }).click();
  const operation = admin.locator("form").filter({
    has: admin.getByRole("heading", {
      name: "Configuración de la operación",
      exact: true,
    }),
  });
  await operation
    .getByLabel("Nombre", { exact: true })
    .fill("Operación SINTÉTICA editada");
  const opUrl = `**/api/control/clients/${demo.manifest.clientId}/operations/${demo.manifest.operationId}`;
  let release: () => void = () => {},
    arrived: () => void = () => {};
  let intercepted = new Promise<void>((resolve) => (arrived = resolve));
  await admin.route(opUrl, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    await new Promise<void>((resolve) => {
      release = resolve;
      arrived();
    });
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        code: "ISOLATED_TEST_ERROR",
        error: "Error de prueba controlado; conservá los valores.",
      }),
    });
  });
  await operation
    .getByRole("button", { name: "Guardar operación", exact: true })
    .click();
  await operation
    .getByRole("button", { name: "Guardando operación…", exact: true })
    .waitFor();
  await intercepted;
  release();
  await operation.getByRole("alert").waitFor();
  assert.equal(
    await operation.getByLabel("Nombre", { exact: true }).inputValue(),
    "Operación SINTÉTICA editada",
  );
  await admin.unroute(opUrl);
  await operation
    .getByRole("button", { name: "Guardar operación", exact: true })
    .click();
  await operation.getByText("Operación guardada.", { exact: true }).waitFor();
  const policy = admin.locator("form").filter({
    has: admin.getByRole("heading", {
      name: "Política autorizada · Cliente / ARS",
      exact: true,
    }),
  });
  const count = policy.getByLabel(
    "Máximo de billetes por jugador/evento (vacío = sin límite)",
    { exact: true },
  );
  await count.fill("4");
  const policyUrl = `**/api/control/clients/${demo.manifest.clientId}/limit-policies/ARS`;
  intercepted = new Promise<void>((resolve) => (arrived = resolve));
  await admin.route(policyUrl, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    await new Promise<void>((resolve) => {
      release = resolve;
      arrived();
    });
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Error de política de prueba; valores conservados.",
      }),
    });
  });
  await policy
    .getByRole("button", { name: "Guardar política autorizada", exact: true })
    .click();
  await policy
    .getByRole("button", { name: "Guardando política…", exact: true })
    .waitFor();
  await intercepted;
  release();
  await policy.getByRole("alert").waitFor();
  assert.equal(await count.inputValue(), "4");
  await admin.unroute(policyUrl);
  await policy
    .getByRole("button", { name: "Guardar política autorizada", exact: true })
    .click();
  await policy
    .getByText("Política autorizada guardada.", { exact: true })
    .waitFor();
  const casino = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
  });
  await casino.goto(demo.parentOrigin + "/demo/synthetic");
  const frame = casino.frameLocator("#sportsbook");
  await frame.getByText("TEST Equipo A", { exact: true }).waitFor();
  await frame.locator(".odds-row button").first().click();
  const limitText = await frame
    .getByRole("region", { name: "Límites de la operación", exact: true })
    .innerText();
  assert.match(limitText, /1,00 ARS a 100,00 ARS/);
  assert.match(limitText, /200,00 ARS/);
  assert.match(limitText, /3 billetes/);
  assert.match(limitText, /150,00 ARS/);
  const stakeInput = frame.getByLabel("Importe simulado (ARS)", {
    exact: true,
  });
  await stakeInput.fill("0.50");
  await frame
    .getByText("El mínimo por billete es 1,00 ARS.", { exact: true })
    .waitFor();
  assert(
    await frame
      .getByRole("button", { name: "Simular billete", exact: true })
      .isDisabled(),
  );
  await stakeInput.fill("101");
  await frame
    .getByText("El máximo por billete es 100,00 ARS.", { exact: true })
    .waitFor();
  await stakeInput.fill("100");
  await frame
    .getByText("El retorno potencial supera el máximo de 200,00 ARS.", {
      exact: true,
    })
    .waitFor();
  assert(
    await frame
      .getByRole("button", { name: "Simular billete", exact: true })
      .isDisabled(),
  );
  assert.deepEqual(
    await frame.locator(".quick-stakes button").allTextContents(),
    ["1,00 ARS", "10,00 ARS", "50,00 ARS"],
  );
  await frame
    .locator(".quick-stakes")
    .getByRole("button", { name: "50,00 ARS", exact: true })
    .click();
  assert.equal(await stakeInput.inputValue(), "50.00");
  await stakeInput.fill("10");
  const requestPromise = casino.waitForRequest(
    (r) =>
      r.url().endsWith("/api/integration/v1/tickets") && r.method() === "POST",
  );
  const acceptedPromise = casino.waitForResponse(
    (r) =>
      r.url().endsWith("/api/integration/v1/tickets") &&
      r.request().method() === "POST",
  );
  await frame
    .getByRole("button", { name: "Simular billete", exact: true })
    .click();
  const originalRequest = await requestPromise,
    accepted = await acceptedPromise;
  assert.equal(accepted.status(), 201);
  const ticket = await accepted.json();
  await frame.getByText(/Billete de prueba registrado:/).waitFor();
  assert.equal(await frame.locator('.success[role="status"]').count(), 1);
  assert.equal(await frame.locator(".success .lucide-check").count(), 1);
  const iframe = casino
    .frames()
    .find((f) => f.url().startsWith(demo.apiOrigin + "/embed/"))!;
  const headers = await originalRequest.allHeaders();
  const replay = await iframe.evaluate(
    async ({ body, authorization, key }) => {
      const r = await fetch("/api/integration/v1/tickets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authorization,
          "Idempotency-Key": key,
        },
        body,
      });
      return { status: r.status, data: await r.json() };
    },
    {
      body: originalRequest.postData()!,
      authorization: headers.authorization,
      key: headers["idempotency-key"],
    },
  );
  assert.equal(replay.status, 201);
  assert.equal(replay.data.id, ticket.id);
  assert.equal(await frame.locator(".ticket-history details").count(), 1);
  await frame.locator(".ticket-history details summary").click();
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
  const actor = (
    await demo.platform.login(
      syntheticLogin.email,
      syntheticLogin.password,
      "isolated-ux-check",
    )
  ).admin;
  const originalLimits = demo.platform.operation(
    demo.manifest.operationId,
  )!.limits;
  demo.platform.updateOperation(
    actor,
    demo.manifest.clientId,
    demo.manifest.operationId,
    { limits: { ...originalLimits, maxTicketsPerPlayerEvent: 1 } },
  );
  await frame
    .getByRole("button", { name: "Armar otro billete de prueba", exact: true })
    .click();
  await frame.locator(".odds-row button").first().click();
  await stakeInput.fill("10");
  const refusal = casino.waitForResponse(
    (r) =>
      r.url().endsWith("/api/integration/v1/tickets") &&
      r.request().method() === "POST",
  );
  await frame
    .getByRole("button", { name: "Simular billete", exact: true })
    .click();
  assert.equal((await refusal).status(), 409);
  await frame
    .locator('.ticket-error[role="alert"]')
    .getByText("Alcanzaste el máximo de 1 billete por jugador/evento.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await frame.locator(".success").count(), 0);
  assert.equal(await frame.locator(".ticket-error .lucide-check").count(), 0);
  assert.equal(await frame.locator(".ticket-history details").count(), 1);
  demo.platform.updateOperation(
    actor,
    demo.manifest.clientId,
    demo.manifest.operationId,
    { limits: originalLimits },
  );

  await admin.getByRole("button", { name: "Riesgo", exact: true }).click();
  const alert = admin
    .locator(".control-risk-alert")
    .filter({ hasText: "Importe alto" })
    .first();
  await alert.locator("summary").click();
  assert.match(await alert.innerText(), /Métrica evaluada:.*10,00/);
  assert((await alert.innerText()).includes(ticket.id));
  await alert
    .getByLabel("Responsable", { exact: true })
    .fill("Operador de pruebas");
  await alert
    .getByLabel("Observación", { exact: true })
    .fill("Datos sintéticos; no retener pagos.");
  await alert.getByLabel("Situación", { exact: true }).selectOption("review");
  await alert
    .getByRole("button", { name: "Guardar tratamiento", exact: true })
    .click();
  await admin
    .getByText("Tratamiento de alerta registrado con auditoría.", {
      exact: true,
    })
    .waitFor();
  const action = async (name: string) => {
    const response = casino.waitForResponse((r) =>
      r.url().endsWith("/synthetic/action"),
    );
    await casino.getByRole("button", { name, exact: true }).click();
    assert.equal((await response).status(), 200);
  };
  await action("Suspender nuevos billetes");
  const paused = await iframe.evaluate(
    async ({ body, authorization }) => {
      const r = await fetch("/api/integration/v1/tickets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authorization,
          "Idempotency-Key": "synthetic-after-suspension",
        },
        body,
      });
      return { status: r.status, data: await r.json() };
    },
    { body: originalRequest.postData()!, authorization: headers.authorization },
  );
  assert.equal(paused.data.code, "ACCEPTANCE_PAUSED");
  await action("Liquidar: gana A");
  await frame
    .locator(".ticket-history summary")
    .filter({ hasText: "Ganado" })
    .waitFor({ timeout: 15000 });
  await frame.getByText(/Revisión 1/).waitFor();
  await action("Repetir liquidación");
  await frame.getByText(/Revisión 1/).waitFor();
  await action("Corregir: gana B");
  await frame
    .locator(".ticket-history summary")
    .filter({ hasText: "Perdido" })
    .waitFor({ timeout: 15000 });
  await frame.getByText(/Revisión 2/).waitFor();
  await action("Repetir liquidación");
  await frame.getByText(/Revisión 2/).waitFor();
  const finalTicket = await iframe.evaluate(
    async ({ id, authorization }) => {
      const response = await fetch("/api/integration/v1/tickets/" + id, {
        headers: { Authorization: authorization },
      });
      return response.json();
    },
    { id: ticket.id, authorization: headers.authorization },
  );
  assert.equal(finalTicket.revision, 2);
  assert.equal(finalTicket.status, "LOST");
  assert.equal(finalTicket.payoutMinor, "0");
  assert.deepEqual(
    finalTicket.selections.map((s: any) => s.acceptedOdds),
    ticket.selections.map((s: any) => s.acceptedOdds),
  );
  assert.equal(await frame.locator(".ticket-history details").count(), 1);
  await admin.getByRole("button", { name: "Auditoría", exact: true }).click();
  await admin
    .getByText("risk.alert.updated", { exact: true })
    .first()
    .waitFor();
  const secret = await readFile(
    join(
      demo.platform.directory,
      "credentials",
      demo.manifest.credentialId + ".key",
    ),
    "utf8",
  );
  assert(!(await casino.content()).includes(secret));
  assert(!(await admin.content()).includes(secret));
  await casino.setViewportSize({ width: 390, height: 844 });
  assert(
    await casino.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  console.log(
    JSON.stringify({
      test: "synthetic_browser",
      status: "ok",
      validated: [
        "isolated_storage",
        "panel_preview_web_mobile_pos_exact_origins",
        "iframe_selection",
        "simulated_admission",
        "idempotent_request",
        "history",
        "receipt",
        "settlement_revision_1",
        "correction_revision_2",
        "idempotent_settlement",
        "suspension_does_not_stop_results",
        "risk_alert_review_audit",
        "save_loading_error_success_preserves_inputs",
        "mobile",
        "password_visibility_toggle",
        "operation_limits_and_adaptive_shortcuts",
        "real_server_refusal_red_without_success_check",
      ],
      supplierRequests: 0,
      realData: false,
    }),
  );
} finally {
  await browser.close();
  await demo.close();
  await rm(directory, { recursive: true, force: true });
}
