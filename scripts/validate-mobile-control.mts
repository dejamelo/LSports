// Browser-only responsive panel validation, isolated accounts/database, no worker/provider.
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { PlatformStore } from '@lsports/feed-store/platform';
import { createApp } from '../apps/api/src/app.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir = await mkdtemp(join(tmpdir(), 'adl-mobile-control-')), platform = new PlatformStore(dir);
const email = 'mobile@isolated.example', password = 'Isolated-responsive-panel-2026';
await platform.bootstrap(email, password);
const owner = await platform.login(email, password, 'isolated-browser');
await platform.createClient(owner.admin, { name: 'Cliente de prueba con nombre deliberadamente largo para validar el ancho disponible', adminEmail: 'responsive-client@isolated.example', adminPassword: 'Isolated-client-only-2026', domains: [] });
const host = express(), server = host.listen(0, '127.0.0.1');
await new Promise<void>(r => server.once('listening', r));
const address = server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const app = createApp({ getEvents: async () => ({ mode: 'connected', health: 'unavailable', updatedAt: new Date().toISOString(), events: [], connections: { prematch: { phase: 'error' }, inplay: { phase: 'error' } } } as any) }, { platform: true, platformStore: platform, publicOrigin: base });
host.use(app);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] }), results: any[] = [];
const artifacts = process.env.ADL_PANEL_ARTIFACTS;
if (artifacts)
    await mkdir(artifacts, { recursive: true });
async function noOverflow(page: any, step: string) { const sizes = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth })); assert.ok(sizes.scroll <= sizes.width + 1, `${step}: page overflow ${JSON.stringify(sizes)}`); }
try {
    for (const width of [360, 390, 430, 1440]) {
        const mobile = width < 650, context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: mobile, hasTouch: mobile }), page = await context.newPage(), errors: string[] = [];
        page.setDefaultTimeout(10000);
        page.on('pageerror', (e: Error) => errors.push(e.message));
        page.on('request', (r: any) => assert.equal(new URL(r.url()).origin, base));
        await page.goto(base + '/control');
        await noOverflow(page, `login ${width}`);
        if (artifacts)
            await page.screenshot({ path: join(artifacts, `control-login-${width}.png`), fullPage: true });
        await page.getByLabel('Email', { exact: true }).fill(email);
        await page.getByLabel('Contraseña', { exact: true }).fill(password);
        await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
        await page.getByRole('button', { name: 'Salir', exact: true }).waitFor();
        await noOverflow(page, `home ${width}`);
        const menu = page.getByRole('button', { name: /menú de navegación/ }), nav = page.locator('#control-navigation');
        const navigate = async (name: string) => { if (mobile) {
            await menu.click();
            assert.equal(await menu.getAttribute('aria-expanded'), 'true');
        } await nav.getByRole('button', { name, exact: true }).click(); if (mobile) {
            await nav.waitFor({ state: 'hidden' });
            assert.equal(await menu.getAttribute('aria-expanded'), 'false');
        } await noOverflow(page, `${name} ${width}`); };
        if (mobile) {
            assert.equal(await nav.isVisible(), false);
            await menu.click();
            await page.keyboard.press('Escape');
            assert.equal(await nav.isVisible(), false);
            await menu.click();
            await menu.click();
            assert.equal(await nav.isVisible(), false);
        }
        else {
            assert.equal(await menu.isVisible(), false);
            assert.equal(await nav.isVisible(), true);
            const desktop = await page.locator('.control-main').evaluate((node: HTMLElement) => ({ padding: getComputedStyle(node).padding, columns: getComputedStyle(node.parentElement!).gridTemplateColumns }));
            assert.equal(desktop.padding, '34px 38px');
            assert.ok(desktop.columns.startsWith('245px'));
        }
        await navigate('Auditoría');
        await page.locator('table').waitFor();
        const table = await page.locator('.control-table-wrap').evaluate((node: HTMLElement) => ({ client: node.clientWidth, scroll: node.scrollWidth }));
        if (mobile)
            assert.ok(table.scroll > table.client);
        await page.locator('.control-table-wrap').evaluate((node: HTMLElement) => { node.scrollLeft = node.scrollWidth; });
        await noOverflow(page, 'table scroll');
        await navigate('Configuración');
        await page.getByLabel('Nombre del cliente', { exact: true }).fill('Cliente aislado ' + width);
        const dialog = new Promise<void>(resolve => page.once('dialog', async (d: any) => { assert.equal(d.type(), 'confirm'); await d.dismiss(); resolve(); }));
        await page.getByRole('button', { name: 'Suspender cliente', exact: true }).click();
        await dialog;
        assert.equal(await page.getByRole('button', { name: 'Suspender cliente', exact: true }).count(), 1);
        await noOverflow(page, 'dismiss dialog');
        const suspend = new Promise<void>(resolve => page.once('dialog', async (d: any) => { await d.accept(); resolve(); }));
        await page.getByRole('button', { name: 'Suspender cliente', exact: true }).click();
        await suspend;
        await page.getByRole('button', { name: 'Reactivar cliente', exact: true }).waitFor();
        const reactivate = new Promise<void>(resolve => page.once('dialog', async (d: any) => { await d.accept(); resolve(); }));
        await page.getByRole('button', { name: 'Reactivar cliente', exact: true }).click();
        await reactivate;
        await page.getByRole('button', { name: 'Suspender cliente', exact: true }).waitFor();
        await navigate('Nuevo cliente');
        await page.getByLabel('Nombre del cliente', { exact: true }).fill('Formulario aislado sin guardar');
        await page.getByLabel('Email del administrador', { exact: true }).fill('not-created@isolated.example');
        await page.getByLabel('Contraseña inicial del administrador', { exact: true }).fill('Not-saved-synthetic-2026');
        if (mobile)
            await page.setViewportSize({ width, height: 380 });
        const submit = page.getByRole('button', { name: 'Crear cliente', exact: true });
        await submit.scrollIntoViewIfNeeded();
        const box = await submit.boundingBox();
        assert.ok(box && box.y >= 0 && box.y + box.height <= 380 + (mobile ? 1 : 1000));
        await noOverflow(page, 'form reduced height');
        if (mobile)
            await page.setViewportSize({ width, height: 900 });
        await page.getByRole('button', { name: 'Mi cuenta: cambiar mi contraseña', exact: true }).click();
        await page.getByLabel('Nueva contraseña', { exact: true }).fill('Not-submitted-isolated-2026');
        if (mobile)
            await page.setViewportSize({ width, height: 380 });
        await page.getByRole('button', { name: 'Cambiar mi contraseña', exact: true }).scrollIntoViewIfNeeded();
        await noOverflow(page, 'account reduced height');
        if (mobile)
            await page.setViewportSize({ width, height: 900 });
        if (artifacts)
            await page.screenshot({ path: join(artifacts, `control-account-${width}.png`), fullPage: true });
        await navigate('Resumen');
        await page.getByRole('button', { name: 'Salir', exact: true }).click();
        await page.getByRole('button', { name: 'Ingresar', exact: true }).waitFor();
        assert.deepEqual(errors, []);
        results.push({ width, menuReflowsContent: mobile, tableScrollConfined: true, formReducedViewport: true, nativeConfirmDismissed: true, nativeConfirmAccepted: true, desktopGridUnchanged: !mobile, consoleErrors: 0 });
        await context.close();
    }
    console.log(JSON.stringify({ test: 'mobile_control_panel', status: 'ok', results, physicalKeyboardValidated: false, supplierRequests: 0, awsChanged: false, artifacts }));
}
finally {
    await browser.close();
    await new Promise<void>(r => server.close(() => r()));
    app.locals.closeTickets();
    platform.close();
    await rm(dir, { recursive: true, force: true });
}
