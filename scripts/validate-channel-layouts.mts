// Isolated browser test. Resizing never exchanges another session or submits a bet.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startSyntheticDemo, syntheticLogin } from "./synthetic-demo.js";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const directory = await mkdtemp(join(tmpdir(), "adl-channel-layouts-"));
const demo = await startSyntheticDemo({
  directory: join(directory, "isolated"),
  apiPort: 0,
  parentPort: 0,
});
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  args: ["--no-sandbox"],
});
const captures = process.env.CHANNEL_CAPTURES
  ? resolve(process.env.CHANNEL_CAPTURES)
  : undefined;
if (captures) await mkdir(captures, { recursive: true });
try {
  const page = await browser.newPage({
      viewport: { width: 2100, height: 1200 },
    }),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(demo.apiOrigin + "/control");
  await page.getByLabel("Email", { exact: true }).fill(syntheticLogin.email);
  await page
    .getByLabel("Contraseña", { exact: true })
    .fill(syntheticLogin.password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await page.getByRole("button", { name: "Terminales", exact: true }).click();
  await page
    .getByLabel("ID de terminal", { exact: true })
    .fill("LAYOUT-POS-01");
  await page
    .getByLabel("Nombre del terminal", { exact: true })
    .fill("POS PRUEBA AISLADA");
  await page
    .getByRole("button", { name: "Guardar terminal", exact: true })
    .click();
  await page.getByText("Terminal guardado.", { exact: true }).waitFor();
  const expected = { web: [1440, 900], mobile: [390, 844], pos: [480, 800] },
    observed: Record<string, number[]> = {};
  const unobscured = async (locator: any) => {
    assert(
      await locator.evaluate((element: HTMLElement) => {
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.x + r.width / 2,
          r.y + r.height / 2,
        );
        return (
          r.top >= 0 &&
          r.bottom <= innerHeight &&
          r.left >= 0 &&
          r.right <= innerWidth &&
          !!hit &&
          (hit === element || element.contains(hit))
        );
      }),
      "Control must be fully visible and unobscured inside iframe",
    );
    const box = await locator.boundingBox(),
      viewport = page.viewportSize()!;
    assert(
      box &&
        box.y >= 0 &&
        box.y + box.height <= viewport.height &&
        box.x >= 0 &&
        box.x + box.width <= viewport.width,
      "Control must also fit the outer visible page",
    );
  };
  let exchanges = 0;
  page.on("response", (response) => {
    if (
      response.url().endsWith("/api/integration/v1/embed-exchange") &&
      response.request().method() === "POST"
    )
      exchanges++;
  });
  for (const channel of ["web", "mobile", "pos"] as const) {
    await page.setViewportSize({ width: 2100, height: 1200 });
    await page.getByRole("button", { name: "Sportsbook", exact: true }).click();
    await page.getByLabel("Canal de la vista previa").selectOption(channel);
    if (channel === "pos")
      await page
        .getByLabel("ID de terminal", { exact: true })
        .fill("LAYOUT-POS-01");
    await page
      .getByRole("button", {
        name: "Abrir sportsbook de simulación",
        exact: true,
      })
      .click();
    const host = page.locator('iframe[title="Sportsbook de simulación"]'),
      frame = page.frameLocator('iframe[title="Sportsbook de simulación"]');
    const root = frame.locator(".sportsbook");
    await root.waitFor();
    await page.waitForFunction(
      ({ channel }) => {
        const f = document.querySelector(
          'iframe[title="Sportsbook de simulación"]',
        ) as HTMLIFrameElement;
        return (
          f?.contentDocument
            ?.querySelector(".sportsbook")
            ?.getAttribute("data-presentation") === channel
        );
      },
      { channel },
    );
    observed[channel] = await root.evaluate(() => [innerWidth, innerHeight]);
    if (channel === "web") {
      assert(observed.web[0] > 900 && observed.web[0] <= 1440);
      assert.equal(observed.web[1], 900);
    } else assert.deepEqual(observed[channel], expected[channel]);
    assert.equal(await root.getAttribute("data-session-channel"), channel);
    assert(
      await root.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    if (channel === "web") {
      await frame.locator(".sidebar").waitFor({ state: "visible" });
      await frame.locator(".betslip").waitFor({ state: "visible" });
    } else {
      await frame
        .getByRole("navigation", { name: "Deportes disponibles" })
        .waitFor();
      await frame.locator(".sidebar").waitFor({ state: "hidden" });
    }
    if (channel === "pos")
      await frame.locator(".hero").waitFor({ state: "hidden" });
    const quote=frame.locator(".odds-row button:not(:disabled)").first();
    if(channel!=="web"){const target=await quote.boundingBox();assert(target&&target.width>=44&&target.height>=44);}
    await quote.click();
    assert.equal(await frame.locator(".pick").count(), 1);
    if (channel !== "web" && await frame.locator(".mobile-slip-button").getAttribute("aria-expanded")!=="true") await frame.locator(".mobile-slip-button").click();
    const stake = frame.getByLabel("Importe simulado (ARS)", { exact: true });
    await stake.fill("5");
    if (channel !== "web")
      await frame
        .getByRole("button", { name: "Cerrar billete", exact: true })
        .click();
    const sessionTime = await root.evaluate(() => performance.timeOrigin),
      source = await host.getAttribute("src"),
      exchangeCount = exchanges;
    // Presentation changes keep exactly the same iframe/document, accepted session and picks.
    for (const format of ["mobile", "pos", "web"]) {
      await page.getByLabel("Formato de la vista previa").selectOption(format);
      await page.waitForTimeout(80);
      assert.equal(await frame.locator(".pick").count(), 1);
      assert.equal(
        await root.evaluate(() => performance.timeOrigin),
        sessionTime,
      );
      assert.equal(await root.getAttribute("data-session-channel"), channel);
      assert.equal(await host.getAttribute("src"), source);
      assert.equal(await stake.inputValue(), "5");
    }
    assert.equal(exchanges, exchangeCount);
    await page.getByLabel("Formato de la vista previa").selectOption(channel);
    await page.waitForTimeout(80);
    if (channel !== "web" && await frame.locator(".mobile-slip-button").getAttribute("aria-expanded")!=="true") await frame.locator(".mobile-slip-button").click();
    if (channel === "web") {
      await frame.locator(".betslip").waitFor();
    } else {
      await page
        .getByLabel("Simular teclado abierto (altura reducida)")
        .check();
      await stake.focus();
      await stake.scrollIntoViewIfNeeded();
      await page.waitForTimeout(100);
      await unobscured(stake);
      await unobscured(
        frame.getByRole("button", { name: /^(Revisar billete|Simular billete)$/, exact: true }),
      );
      assert.equal(await stake.inputValue(), "5");
      await page
        .getByLabel("Simular teclado abierto (altura reducida)")
        .uncheck();
    }
    if (channel === "pos" && captures) {
      await host.scrollIntoViewIfNeeded();
      await host.screenshot({
        path: join(captures, "sportsbook-pos-ticket-isolated.png"),
      });
    }
    if (channel !== "web")
      await frame
        .getByRole("button", { name: "Cerrar billete", exact: true })
        .click();
    await root.evaluate(() => window.scrollTo(0, 0));
    await host.scrollIntoViewIfNeeded();
    if (captures)
      await host.screenshot({
        path: join(captures, `sportsbook-${channel}-isolated.png`),
      });
    // Narrow parent shrinks the real iframe, including Web and POS; no zoom or x overflow.
    await page.setViewportSize({ width: 320, height: 640 });
    await page.waitForTimeout(100);
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    assert(
      await root.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    const open = frame.locator(".mobile-slip-button");
    if ((await open.getAttribute("aria-expanded")) !== "true")
      await open.click();
    await page.getByLabel("Simular teclado abierto (altura reducida)").check();
    await stake.focus();
    await stake.scrollIntoViewIfNeeded();
    await unobscured(stake);
    await unobscured(
      frame.getByRole("button", { name: /^(Revisar billete|Simular billete)$/, exact: true }),
    );
    assert.equal(await stake.inputValue(), "5");
    if(channel==='pos'){
      await frame.getByRole('button',{name:'Revisar billete',exact:true}).click();
      await frame.getByRole('region',{name:'Revisión del billete'}).waitFor();
      let acceptedId='', firstKey='', requests=0;
      await page.route('**/api/integration/v1/tickets', async route=>{
        if(route.request().method()!=='POST'){await route.continue();return;}
        requests++;
        const key=route.request().headers()['idempotency-key'];
        if(!firstKey)firstKey=key;else assert.equal(key,firstKey);
        const response=await route.fetch();
        assert.equal(response.status(),201);
        const body=await response.json();
        if(!acceptedId)acceptedId=body.id;else assert.equal(body.id,acceptedId);
        if(requests===1)await route.abort('connectionfailed');else await route.fulfill({response});
      });
      await frame.getByRole('button',{name:'Confirmar simulación',exact:true}).dblclick();
      await frame.getByText(/Respuesta no confirmada/).waitFor();
      await frame.getByRole('button',{name:'Confirmar simulación',exact:true}).dblclick();
      await frame.getByText(/Billete de prueba registrado:/).waitFor();
      assert.equal(requests,2);
      await frame.getByRole('button',{name:'Ver billete registrado',exact:true}).click();
      const ticket=frame.locator(`[id="ticket-${acceptedId}"]`);
      await ticket.getByRole('button',{name:'Abrir / imprimir comprobante de prueba',exact:true}).click();
      const receipt=frame.frameLocator('iframe[title="Comprobante · Apuesta DEPORTIVA LAT"]');
      await receipt.getByText(/SIMULACIÓN · PRUEBA/).waitFor();
      await receipt.getByText(/Retorno potencial al aceptar:/).waitFor();
      await frame.getByRole('button',{name:'Cerrar',exact:true}).click();
      await ticket.getByRole('button',{name:'Abrir / imprimir comprobante de prueba',exact:true}).click();
      await receipt.getByText(`ID: ${acceptedId}`,{exact:true}).waitFor();
      assert.equal(requests,2);
      await frame.getByRole('button',{name:'Cerrar',exact:true}).click();
      await page.unroute('**/api/integration/v1/tickets');
    }
    await page
      .getByRole("button", {
        name: "Cerrar iframe y volver al resumen",
        exact: true,
      })
      .click();
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      test: "isolated_channel_layouts",
      status: "ok",
      requestedFormats: expected,
      observedFormats: observed,
      validated: [
        "real_iframe_dimensions",
        "three_authenticated_channels",
        "same_session_picks_and_amount_on_format_change",
        "single_column_and_sports_navigation",
      "pos_quote_amount_confirmation_simulated_ticket",
        "pos_review_before_confirmation",
        "lost_accepted_response_retry_same_id_and_key",
        "double_click_no_duplicate_admission",
        "consult_and_reopen_same_thermal_receipt",
        "pos_without_large_hero",
        "320px_parent_no_horizontal_overflow",
        "reduced_height_focused_input_and_confirmation_unobscured",
      ],
      realHardwareValidated: false,
      supplierRequests: 0,
    }),
  );
} finally {
  await browser.close();
  await demo.close();
  await rm(directory, { recursive: true, force: true });
}
