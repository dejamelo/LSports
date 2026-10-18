import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = await import(`${root}/node_modules/vite/dist/node/index.js`);
const { decodeMessage } = await import(`${root}/apps/worker/src/messages.ts`);
const { TradeState } = await import(`${root}/apps/worker/src/state.ts`);
const { checkpoint, restore } = await import(`${root}/apps/worker/src/persistence.ts`);
const { createPublisher, readConnectedFeed } = await import(`${root}/packages/feed-store/src/index.ts`);
const { createApp } = await import(`${root}/apps/api/src/app.ts`);
const dir = await mkdtemp(join(tmpdir(), 'adl-isolated-ui-'));
const path = join(dir, 'test-feed.json');
const {TicketStore} = await import(`${root}/packages/feed-store/src/tickets.ts`);
const tickets = new TicketStore(join(dir,'test-tickets.sqlite'));
const state = new TradeState();
let messageSequence=0;
const at = Date.now();
function receive(type: number, body: object) {
  const decoded = decodeMessage(gzipSync(Buffer.from(JSON.stringify({ Header: { Type: type, MsgGuid: `isolated-test-${type}-${++messageSequence}`, ServerTimestamp: at }, Body: body }))), {}, { contentType: 'application/json', contentEncoding: 'gzip' });
  state.apply('prematch', decoded.events, decoded.at);
  state.recordMessage('prematch', type, decoded.events.length, false);
}
// Clearly isolated synthetic messages. Never written to .runtime or mixed with supplier data.
receive(37, { Competition: { Id: 900001, Name: 'PRUEBA AISLADA — NO ES FEED REAL', Events: [{ FixtureId: 900002,
  OutrightFixture: { FixtureName: 'Carrera de prueba aislada', Sport: { Name: 'Horse Racing' }, Status: 1,
    Participants: Array.from({ length: 9 }, (_, i) => ({ Id: i + 1, Name: `Caballo de prueba ${i + 1}`, Position: String(i + 1) })) } }] } });
receive(41, { Competition: { Id: 900001, Events: [{ FixtureId: 900002, Markets: [{ Id: 160, Name: 'Race Winner — PRUEBA', Status: 1,
  Bets: [{ Id: '900003', ParticipantId: 1, Name: 'Caballo de prueba 1', Price: '3.25', Status: 1 }] }] }] } });
receive(1, { Events: [{ FixtureId: 900004, Fixture: { Sport: { Name: 'Football' }, Status: 1,
  League: { Name: 'PRUEBA AISLADA fútbol' }, Participants: [{ Name: 'Equipo de prueba A' }, { Name: 'Equipo de prueba B' }] } }] });
receive(3, { Events: [{ FixtureId: 900004, Markets: [{ Id: 1, Name: 'Ganador — PRUEBA', Status: 1,
  Bets: [{ Id: '900005', Name: '1', Price: '2.10', Status: 1 }] }] }] });
state.set('prematch', { phase: 'connected' }); state.set('inplay', { phase: 'connected' });
const publish = createPublisher(path);
const save = () => {tickets.reconcile(state.feed());return publish({ ...state.feed(), notice: 'PRUEBA AISLADA — mensajes sintéticos, sin proveedor ni dinero real.' }, checkpoint(state));};
await save();
const api = createApp({ getEvents: () => readConnectedFeed(path) }, {ticketStore:tickets}).listen(0, '127.0.0.1');
await new Promise<void>(r => api.once('listening', r));
const address = api.address(); assert(address && typeof address !== 'string');
const vite = await createServer({ root: `${root}/apps/web`, configFile: `${root}/apps/web/vite.config.ts`, server: { host: '127.0.0.1', port: 0,
  proxy: { '/api': `http://127.0.0.1:${address.port}` } } });
let browser;
const heartbeat = setInterval(() => void save(), 3000);
try {
  await vite.listen();
  const webAddress = vite.httpServer.address(); assert(webAddress && typeof webAddress !== 'string');
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const forbidden: string[] = [];
  page.on('request', req => { if (!['GET', 'HEAD'].includes(req.method()) && !(req.method()==='POST' && new URL(req.url()).pathname==='/api/tickets')) forbidden.push(req.method()); });
  await page.goto(`http://127.0.0.1:${webAddress.port}/sportsbook`);
  await page.getByText('Equipo de prueba A', { exact: true }).waitFor();
  await page.locator('.odds-row button').first().click();
  assert.equal(await page.locator('.pick').count(), 1);
  await page.getByRole('button', { name: 'Simular billete', exact: true }).click();
  await page.getByText(/Billete de prueba registrado:/).waitFor();
  await page.getByRole('button', { name: 'Vaciar', exact: true }).click();
  await page.getByRole('tab', { name: 'Hípica' }).click();
  await page.getByText('Carrera de prueba aislada', { exact: true }).waitFor();
  await page.getByText('Ver participantes (9)', { exact: true }).click();
  await page.getByText('9. Caballo de prueba 9', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Caballo de prueba 1 3.25', exact: true }).click();
  assert.equal(await page.locator('.pick').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Simular billete', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Simular billete', exact: true }).click();
  await page.getByText(/Billete de prueba registrado:/).waitFor();
  // Provider settlement must disable the existing pick, without opening the market.
  receive(42, { Competition: { Id: 900001, Events: [{ FixtureId: 900002, Markets: [{ Id: 160, Status: 3,
    Bets: [{ Id: '900003', Status: 3, Settlement: 2 }] }] }] } });
  await save();
  await page.getByText('Mercado liquidado', { exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await page.getByRole('button', { name: 'Simular billete', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('.odds-row button').first().isDisabled(), true);
  assert.equal(await page.locator('.odds-row button').first().getAttribute('title'), 'Mercado liquidado');
  await page.getByText(/^Ganado ·/).waitFor({timeout:10000});
  assert.equal(tickets.list().total,2);
  const accepted = tickets.list().tickets.find(t=>t.selections[0].eventId.includes('outright'))!;
  assert.equal(accepted.payoutMinor,325000);assert.equal(accepted.revision,1);
  const receiptResponse=await fetch(`http://127.0.0.1:${address.port}/api/tickets/${accepted.id}/receipt`);
  const receiptHtml=await receiptResponse.text();assert.match(receiptHtml,/SIN VALOR MONETARIO/);assert.match(receiptHtml,/3250.00 pts/);
  receive(42, { Competition: { Id: 900001, Events: [{ FixtureId: 900002, Markets: [{ Id: 160, Status: 3,
    Bets: [{ Id: '900003', Status: 3, Settlement: 1 }] }] }] } });
  await save();
  await page.getByText(/^Perdido ·/).waitFor({timeout:10000});
  assert.equal(tickets.get(accepted.id)?.revision,2);assert.equal(tickets.get(accepted.id)?.payoutMinor,0);
  const restored = new TradeState(); await restore(restored, path);
  assert.equal(restored.feed().events.find(e => e.kind === 'outright')?.participants?.length, 9);
  assert.equal(restored.feed().events.find(e => e.kind === 'outright')?.selections[0].odds, 3.25);
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  console.log('PASS ISOLATED SYNTHETIC: gzip AMQP 37/41 + 1/3 -> SDK parser -> atomic checkpoint -> real API -> real React sportsbook -> participants -> persistent football and race tickets -> settlement and correction -> history and printable receipt -> restart preservation -> mobile width, settled-market label and blocked existing pick. No supplier calls, subscriptions, queue consumption or payment requests.');
} finally {
  clearInterval(heartbeat); await browser?.close(); await vite.close();
  await new Promise<void>(r => api.close(() => r())); tickets.close(); await rm(dir, { recursive: true, force: true });
}
