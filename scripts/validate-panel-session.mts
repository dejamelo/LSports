// Isolated panel/browser validation. No real provider, account or production data.
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { PlatformStore } from '@lsports/feed-store/platform';
import { createApp } from '../apps/api/src/app.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir = await mkdtemp(join(tmpdir(), 'adl-session-ui-'));
let now = Date.now();
const platform = new PlatformStore(dir, false, () => now);
const email = 'panel@isolated.example', password = 'Isolated-panel-password-2026', nextPassword = 'Changed-isolated-panel-2026';
await platform.bootstrap(email, password);
const host = express(), server = host.listen(0, '127.0.0.1');
await new Promise<void>(r => server.once('listening', r));
const address = server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const feed: any = { mode: 'connected', health: 'unavailable', updatedAt: new Date(now).toISOString(), events: [], connections: { prematch: { phase: 'error' }, inplay: { phase: 'error' } } };
const app = createApp({ getEvents: async () => feed }, { platform: true, platformStore: platform, publicOrigin: base });
host.use(app);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
const errors: string[] = [], requests: any[] = [];
const results: any = { formats: [], idle: [], password: [], supplierRequests: 0, realAwsValidated: false };
const artifacts = process.env.ADL_PANEL_ARTIFACTS;
if (artifacts)
    await mkdir(artifacts, { recursive: true });
async function pageIn(context: any) { const page = await context.newPage(); page.on('pageerror', (e: Error) => errors.push(e.message)); page.on('request', (r: any) => { const url = new URL(r.url()); assert.equal(url.origin, base, 'No external request allowed'); requests.push({ path: url.pathname, method: r.method() }); }); await page.clock.install({ time: new Date(now) }); return page; }
async function login(page: any, mail: string, secret: string) { await page.goto(base + '/control'); await page.getByLabel('Email', { exact: true }).fill(mail); await page.getByLabel('Contraseña', { exact: true }).fill(secret); await page.getByRole('button', { name: 'Ingresar', exact: true }).click(); await page.getByRole('button', { name: 'Salir', exact: true }).waitFor(); }
const info = (page: any) => page.evaluate(async () => { const r = await fetch('/api/control/session'); return { status: r.status, ...await r.json() }; });
async function idle(context: any, first: any, role: string) {
    const second = await pageIn(context);
    await second.goto(base + '/control');
    await second.getByRole('button', { name: 'Salir', exact: true }).waitFor();
    const initial = await info(first);
    const advance = async (ms: number) => { now += ms; await first.clock.fastForward(ms); await second.clock.fastForward(ms); };
    await advance(120000);
    for (let i = 0; i < 3; i++)
        await info(first);
    assert.equal((await info(first)).expiresAt, initial.expiresAt, 'polling renewed server deadline');
    const before = requests.filter(r => r.path === '/api/control/activity').length;
    await first.evaluate(() => document.dispatchEvent(new Event('click', { bubbles: true })));
    assert.equal(requests.filter(r => r.path === '/api/control/activity').length, before, 'synthetic event counted as human');
    await Promise.all([first.waitForResponse((r: any) => r.url().endsWith('/api/control/activity') && r.status() === 200), first.getByRole('button', { name: 'Acceso', exact: true }).click()]);
    const renewed = await info(first);
    assert.equal(renewed.expiresAt, now + 300000);
    await advance(299999);
    assert.equal((await info(second)).status, 200);
    await advance(1);
    await first.getByRole('button', { name: 'Ingresar', exact: true }).waitFor();
    await second.getByRole('button', { name: 'Ingresar', exact: true }).waitFor();
    assert.equal((await info(first)).status, 401);
    await first.reload();
    await first.getByRole('button', { name: 'Ingresar', exact: true }).waitFor();
    results.idle.push({ role, pollingDoesNotRenew: true, humanActivityRenews: true, crossTabExpiry: true, serverRefusesExpired: true, reloadDoesNotRevive: true });
    return second;
}
async function passwordFlow(context: any, page: any, second: any, mail: string, old: string, next: string, role: string) {
    await login(page, mail, old);
    await second.goto(base + '/control');
    await second.getByRole('button', { name: 'Salir', exact: true }).waitFor();
    const oldCookies = await context.cookies(base + '/api/control/session');
    await page.getByRole('button', { name: 'Mi cuenta: cambiar mi contraseña', exact: true }).click();
    await page.getByLabel('Contraseña actual', { exact: true }).fill(old);
    await page.getByLabel('Nueva contraseña', { exact: true }).fill(next);
    await page.getByLabel('Confirmar nueva contraseña', { exact: true }).fill('Isolated-mismatch-password');
    await page.getByRole('button', { name: 'Mostrar contraseñas', exact: true }).click();
    assert.equal(await page.getByLabel('Nueva contraseña', { exact: true }).getAttribute('type'), 'text');
    await page.getByRole('button', { name: 'Ocultar contraseñas', exact: true }).click();
    assert.equal(await page.getByLabel('Nueva contraseña', { exact: true }).getAttribute('type'), 'password');
    await page.getByRole('button', { name: 'Cambiar mi contraseña', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'confirmación' }).waitFor();
    assert.equal((await info(page)).status, 200);
    await page.getByLabel('Confirmar nueva contraseña', { exact: true }).fill(next);
    await page.getByRole('button', { name: 'Cambiar mi contraseña', exact: true }).click();
    await page.getByRole('button', { name: 'Ingresar', exact: true }).waitFor();
    await second.getByRole('button', { name: 'Ingresar', exact: true }).waitFor();
    const oldSession = await fetch(base + '/api/control/session', { headers: { Cookie: oldCookies.map((c: any) => `${c.name}=${c.value}`).join('; ') } });
    assert.equal(oldSession.status, 401);
    const rejectedOld = await context.request.post(base + '/api/control/login', { headers: { Origin: base }, data: { email: mail, password: old } });
    assert.equal(rejectedOld.status(), 401);
    await login(page, mail, next);
    results.password.push({ role, confirmationEnforced: true, showHide: true, previousSessionRejected: true, crossTabLogout: true, oldPasswordRejected: true, newPasswordLogin: true });
}
try {
    const context = await browser.newContext({ viewport: { width: 1680, height: 1100 } }), page = await pageIn(context);
    await login(page, email, password);
    assert.equal(platform.allClientIds().length, 0);
    for (const width of [360,390,430]) {
        const touchContext = await browser.newContext({viewport:{width,height:844},hasTouch:true,isMobile:true});
        const touch = await pageIn(touchContext);
        await login(touch,email,password);
        for (const format of ['web','mobile','pos']) {
            await touch.getByRole('button',{name:/menú de navegación/}).click();
            await touch.getByRole('button',{name:'Sportsbook',exact:true}).click();
            await touch.getByLabel('Canal de la vista previa').selectOption(format);
            await touch.getByRole('button',{name:'Abrir sportsbook de solo lectura',exact:true}).click();
            const f=touch.frameLocator('iframe');
            await f.locator(`[data-presentation="${format}"]`).waitFor();
            await f.getByText('No hay eventos actuales disponibles', {exact:false}).waitFor();
            assert.equal(await touch.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
            assert.equal(await f.locator('body').evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
            await f.getByRole('tab',{name:'En vivo',exact:true}).click();
            await touch.getByRole('button',{name:'Cerrar sportsbook de solo lectura',exact:true}).click();
        }
        for(const format of ['web','mobile','pos']) {
            await touch.goto(base+'/control/sportsbook-preview?format='+format);
            await touch.locator(`[data-presentation="${format}"]`).waitFor();
            await touch.getByRole('link',{name:'Volver al panel'}).click();
            await touch.getByRole('button',{name:'Salir',exact:true}).waitFor();
        }
        await touchContext.close();
        results.formats.push({viewportWidth:width,initialChannelOpen:['web','mobile','pos'],directLinks:true,touchNavigation:true,noClients:true});
    }
    await page.getByRole('button', { name: 'Sportsbook', exact: true }).click();
    await page.getByRole('button', { name: 'Abrir sportsbook de solo lectura', exact: true }).click();
    const frame = page.frameLocator('iframe[title="Sportsbook de plataforma · solo lectura"]');
    await frame.locator('.sportsbook').waitFor();
    for (const [format, width] of [['web', null], ['mobile', 390], ['pos', 480]] as const) {
        await page.getByLabel('Formato de la vista previa', { exact: true }).selectOption(format);
        await frame.locator(`[data-presentation="${format}"]`).waitFor();
        const metrics = await frame.locator('.sportsbook').evaluate((node: HTMLElement) => ({ width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, sidebarVisible: getComputedStyle(node.querySelector('.sidebar')!).display !== 'none', heroVisible: getComputedStyle(node.querySelector('.hero')!).display !== 'none' }));
        if (width)
            assert.equal(metrics.width, width);
        else
            assert.ok(metrics.width > 900);
        assert.equal(metrics.overflow, false);
        assert.equal(metrics.sidebarVisible, format === 'web');
        if (format === 'pos')
            assert.equal(metrics.heroVisible, false);
        assert.equal(await frame.getByRole('button', { name: 'Simular billete', exact: true }).count(), 0);
        results.formats.push({ format, ...metrics });
        if (artifacts)
            await page.screenshot({ path: join(artifacts, `panel-${format}.png`), fullPage: true });
    }
    now += 120000;
    await page.clock.fastForward(120000);
    await Promise.all([page.waitForResponse((r: any) => r.url().endsWith('/api/control/activity') && r.status() === 200), frame.locator('.sports-rail button').first().click()]);
    assert.equal((await info(page)).expiresAt, now + 300000);
    results.iframeHumanActivityRenews = true;
    await page.getByRole('button', { name: 'Cerrar sportsbook de solo lectura', exact: true }).click();
    const second = await idle(context, page, 'platform_admin');
    await passwordFlow(context, page, second, email, password, nextPassword, 'platform_admin');
    await context.close();
    const owner = await platform.login(email, nextPassword, 'isolated-browser');
    await platform.createClient(owner.admin, { name: 'Cliente aislado', adminEmail: 'client@isolated.example', adminPassword: 'Isolated-client-password-2026', domains: [base] });
    const clientContext = await browser.newContext({ viewport: { width: 1024, height: 900 } }), client = await pageIn(clientContext);
    await login(client, 'client@isolated.example', 'Isolated-client-password-2026');
    const clientSecond = await idle(clientContext, client, 'client_admin');
    await passwordFlow(clientContext, client, clientSecond, 'client@isolated.example', 'Isolated-client-password-2026', 'Changed-isolated-client-2026', 'client_admin');
    await clientContext.close();
    assert.deepEqual(errors, []);
    assert.equal(requests.filter(r => r.method === 'POST' && r.path.includes('tickets')).length, 0);
    assert.equal(requests.filter(r => r.method === 'POST' && r.path.endsWith('/preview')).length, 0);
    console.log(JSON.stringify({ test: 'panel_idle_account_formats', status: 'ok', ...results, consoleErrors: errors.length, artifacts }));
}
finally {
    await browser.close();
    await new Promise<void>(r => server.close(() => r()));
    app.locals.closeTickets();
    platform.close();
    await rm(dir, { recursive: true, force: true });
}
