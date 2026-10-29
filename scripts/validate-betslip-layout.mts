import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { PlatformStore } from "@lsports/feed-store/platform";
import { createApp } from "../apps/api/src/app.js";
import { TradeState } from "../apps/worker/src/state.js";
import { decodeMessage } from "../apps/worker/src/messages.js";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const directory = await mkdtemp(join(tmpdir(), "adl-betslip-layout-"));
const platform = new PlatformStore(directory);
const state = new TradeState();
const timestamp = Date.now();
for (const [type, body] of [
  [
    1,
    {
      Events: [
        {
          FixtureId: 910001,
          Fixture: {
            Sport: { Name: "Football" },
            Status: 1,
            League: { Name: "LAYOUT AISLADO" },
            Participants: [{ Name: "Equipo de prueba A" }, { Name: "Equipo de prueba B" }],
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
          FixtureId: 910001,
          Markets: [
            {
              Id: 1,
              Name: "Ganador · LAYOUT AISLADO",
              Status: 1,
              Bets: [{ Id: "910002", Name: "1", Price: "2.10", Status: 1 }],
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
        Header: { Type: type, MsgGuid: `layout-${type}`, ServerTimestamp: timestamp },
        Body: body,
      }),
    ),
  );
  state.apply("prematch", decoded.events, decoded.at);
}
state.set("prematch", { phase: "connected" });
state.set("inplay", { phase: "connected" });

let browser: any;
let server: any;
try {
  await platform.bootstrap("layout-admin@isolated.example", "layout-isolated-password");
  const admin = (await platform.login(
    "layout-admin@isolated.example",
    "layout-isolated-password",
    "layout-test",
  )).admin;
  const client = await platform.createClient(admin, {
    name: "Sportsbook layout isolated",
    adminEmail: "layout-client@isolated.example",
    adminPassword: "isolated-client-password",
    domains: ["http://127.0.0.1"],
  });
  const operation = platform.createOperation(admin, client.id, {
    name: "Layout ARS",
    country: "AR",
    currency: "ARS",
  });
  await platform.issueCredential(admin, client.id, operation.id, "Layout test");
  const key = platform.credentials(admin, client.id, operation.id)[0] as { id: string };
  const secret = await readFile(join(directory, "credentials", `${key.id}.key`), "utf8");
  const auth = platform.integration(secret)!;

  const host = express();
  server = host.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  platform.updateClient(admin, client.id, { domains: [base] });
  const session = platform.createEmbed(auth, {
    clientId: client.id,
    operationId: operation.id,
    currency: "ARS",
    playerId: "isolated-layout-player",
    parentOrigin: base,
    channel: "web",
  });
  const iframeUrl = `${base}/embed/${client.id}/${operation.id}/sportsbook#code=${session.code}`;
  host.get("/layout-parent", (_req, res) =>
    res.send(
      `<html><iframe title="Sportsbook de simulación" src="${iframeUrl}" style="width:100%;height:calc(100vh - 100px);border:0" sandbox="allow-scripts allow-same-origin allow-modals"></iframe></html>`,
    ),
  );
  host.use(
    createApp(
      { async getEvents() { return { ...state.feed(), notice: "SOLO PRUEBA LOCAL AISLADA" }; } },
      { platform: true, platformStore: platform, publicOrigin: base },
    ),
  );

  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 480 }, hasTouch: true });
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(`${base}/layout-parent`);
  const frame = page.frameLocator('iframe[title="Sportsbook de simulación"]');
  await frame.getByText("Equipo de prueba A", { exact: true }).waitFor();
  await frame.locator(".odds-row button").first().click();
  await frame.getByLabel("Importe simulado (ARS)", { exact: true }).fill("10");
  let scroll = await frame.locator(".slip-content").evaluate((el) => ({
    height: el.clientHeight,
    content: el.scrollHeight,
    overflow: getComputedStyle(el).overflowY,
  }));
  assert.equal(scroll.overflow, "auto");
  assert(scroll.content > scroll.height, "Web baixa precisa rolar o corpo do bilhete");
  const confirm = frame.getByRole("button", { name: "Simular billete", exact: true });
  assert.equal(await confirm.isVisible(), true);
  const fits = async (locator: any) =>
    locator.evaluate((el: HTMLElement) => el.getBoundingClientRect().bottom <= innerHeight);
  assert(await fits(confirm), "Confirmação Web deve ficar no viewport do iframe");

  await frame.locator(".slip-content").evaluate((el) => { el.scrollTop = 0; });
  await frame.locator(".slip-content").hover();
  await page.mouse.wheel(0, 260);
  await page.waitForTimeout(80);
  assert(await frame.locator(".slip-content").evaluate((el) => el.scrollTop > 0), "Roda/trackpad devem rolar o bilhete");
  assert(await fits(confirm), "O botão permanece visível durante a rolagem Web");
  await confirm.click();
  await frame.getByText(/Billete de prueba registrado:/).waitFor();

  await frame.getByRole("button", { name: "Armar otro billete de prueba", exact: true }).click();
  await page.evaluate(() => document.querySelector("iframe")!.contentWindow!.postMessage(
    { type: "adl.preview.presentation", format: "mobile" }, location.origin));
  await frame.locator('.sportsbook[data-presentation="mobile"]').waitFor();
  await page.setViewportSize({ width: 390, height: 420 });
  const noHorizontalScroll = async () => frame.locator("html").evaluate(
    () => document.documentElement.scrollWidth <= innerWidth,
  );
  assert(await noHorizontalScroll(), "Mobile vazio sem rolagem horizontal");
  await frame.locator(".mobile-slip-button").click();
  await frame.getByText("Tu jugada empieza acá", { exact: true }).waitFor();
  await frame.locator(".close-slip").click();
  await frame.locator(".odds-row button").first().click();
  await frame.locator(".mobile-slip-button").click();
  await frame.getByLabel("Importe simulado (ARS)", { exact: true }).fill("10");
  assert.equal(await frame.locator(".pick").count(), 1);
  assert(await fits(frame.locator(".slip-confirm .simulate")), "Botão Mobile dentro do viewport");
  scroll = await frame.locator(".slip-content").evaluate((el) => ({
    height: el.clientHeight, content: el.scrollHeight, overflow: getComputedStyle(el).overflowY,
    touchAction: getComputedStyle(el).touchAction,
  }));
  assert.equal(scroll.overflow, "auto");
  assert(scroll.content > scroll.height, "Bilhete Mobile preenchido deve rolar");
  assert.equal(scroll.touchAction, "pan-y");
  await frame.locator(".slip-content").evaluate((el) => { el.scrollTop = 0; });
  const touchBox = await frame.locator(".slip-content").boundingBox();
  assert(touchBox);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, configuration: "mobile" });
  const x = touchBox.x + touchBox.width / 2, y = touchBox.y + touchBox.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - 100, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(80);
  assert(await frame.locator(".slip-content").evaluate((el) => el.scrollTop > 0), "Gesto de toque deve rolar o bilhete");
  await cdp.detach();

  await page.evaluate(() => document.querySelector("iframe")!.contentWindow!.postMessage(
    { type: "adl.preview.presentation", format: "pos" }, location.origin));
  await frame.locator('.sportsbook[data-presentation="pos"]').waitFor();
  assert.equal(await frame.locator(".pick").count(), 1, "Trocar formato preserva seleção");
  await page.setViewportSize({ width: 500, height: 650 });
  assert(await noHorizontalScroll(), "POS preenchido sem rolagem horizontal");
  assert.equal(await frame.locator(".slip-confirm .simulate").isVisible(), true);
  assert(await fits(frame.locator(".slip-confirm .simulate")), "Botão POS dentro do viewport");
  await frame.locator(".slip-type").getByRole("button", { name: "Vaciar", exact: true }).click();
  assert.equal(await frame.locator(".pick").count(), 0);
  assert(await noHorizontalScroll(), "POS vazio sem rolagem horizontal");
  await frame.locator(".close-slip").click();
  await frame.locator(".odds-row button").first().click();
  await frame.getByLabel("Importe simulado (ARS)", { exact: true }).fill("10");
  assert.equal(await frame.locator(".pick").count(), 1);
  assert.equal(await frame.locator(".slip-confirm .simulate").isVisible(), true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    test: "isolated_betslip_layout",
    status: "ok",
    web: { mouseWheel: true, confirmVisibleAtLowHeight: true, simulatedTicketConfirmed: true },
    mobile: { empty: true, filled: true, touchScroll: true, horizontalOverflow: false },
    pos: { empty: true, filled: true, selectionPreservedOnFormatChange: true, horizontalOverflow: false },
    scrollMetrics: scroll,
    supplierCalls: 0,
  }));
} finally {
  await browser?.close();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  platform.close();
  await rm(directory, { recursive: true, force: true });
}
