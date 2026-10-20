// Isolated fresh platform, no seeded casino/operation and no provider requests.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import express from 'express';
import {PlatformStore} from '@lsports/feed-store/platform';import {createApp} from '../apps/api/src/app.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const dir=await mkdtemp(join(tmpdir(),'adl-empty-platform-')),platform=new PlatformStore(dir);
await platform.bootstrap('empty@isolated.example','Isolated-empty-platform-2026');
const host=express(),server=host.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const address=server.address();assert(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
const feed:any={mode:'connected',health:'unavailable',updatedAt:new Date().toISOString(),events:[],connections:Object.fromEntries(['prematch','inplay'].map(l=>[l,{phase:'error',diagnostic:{operation:'amqp.connect',protocol:'amqp',category:'authentication',amqpCode:403}}]))};
const app=createApp({getEvents:async()=>feed},{platform:true,platformStore:platform,publicOrigin:base});host.use(app);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[],badRequests:string[]=[],httpErrors:string[]=[];let posts=0;
 page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{const p=new URL(r.url()).pathname;if(r.status()>=400&&!(p==='/api/control/session'&&r.status()===401))httpErrors.push(`${r.status()} ${p}`);});page.on('requestfailed',r=>badRequests.push(new URL(r.url()).pathname));page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/tickets'))posts++;});
 await page.goto(base+'/control');await page.getByLabel('Email',{exact:true}).fill('empty@isolated.example');await page.getByLabel('Contraseña',{exact:true}).fill('Isolated-empty-platform-2026');await page.getByRole('button',{name:'Ingresar',exact:true}).click();
 await page.getByRole('heading',{name:'Estado de la plataforma',exact:true}).waitFor();
 for(const tab of ['Operaciones','Configuración','Credenciales','Riesgo','Billetes','Terminales']){
  await page.getByRole('button',{name:tab,exact:true}).click();await page.getByRole('heading',{name:`${tab} · Todavía no hay clientes`,exact:true}).waitFor();await page.getByText(new RegExp(`${tab} requiere un cliente seleccionado`)).waitFor();
 }
 await page.getByRole('button',{name:'Acceso',exact:true}).click();await page.getByRole('heading',{name:'Acceso administrativo',exact:true}).waitFor();
 await page.getByRole('button',{name:'Auditoría',exact:true}).click();await page.getByRole('heading',{name:'Actividad administrativa',exact:true}).waitFor();await page.getByText('platform.admin.created',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Sportsbook',exact:true}).click();await page.getByText('Feed no disponible para nuevas apuestas. No hay cuotas habilitadas.',{exact:true}).waitFor();await page.getByRole('button',{name:'Abrir sportsbook de solo lectura',exact:true}).click();
 const frame=page.frameLocator('iframe[title="Sportsbook de plataforma · solo lectura"]');await frame.getByText(/Sin conexión confirmada/).waitFor();await frame.getByText(/Vista administrativa de solo lectura/).waitFor();assert.equal(await frame.getByRole('button',{name:'Simular billete',exact:true}).count(),0);assert.equal(await frame.getByLabel('Billete de simulación',{exact:true}).count(),0);
 await page.getByRole('button',{name:'Cerrar sportsbook de solo lectura',exact:true}).click();await page.getByRole('button',{name:'Actualizar estado local',exact:true}).click();
 await page.getByRole('button',{name:'Nuevo cliente',exact:true}).click();await page.getByRole('heading',{name:'Datos del operador',exact:true}).waitFor();
 await page.getByLabel('Nombre del cliente',{exact:true}).fill('Cliente aislado vacío');await page.getByLabel('Email del administrador',{exact:true}).fill('client@isolated.example');await page.getByLabel('Contraseña inicial del administrador',{exact:true}).fill('Isolated-client-only-2026');await page.getByRole('button',{name:'Crear cliente',exact:true}).click();await page.getByText('Cliente y administrador creados.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Sportsbook',exact:true}).click();await page.getByRole('heading',{name:'Sportsbook · Seleccioná o creá una operación',exact:true}).waitFor();await page.getByRole('button',{name:'Nueva operación',exact:true}).click();await page.getByRole('heading',{name:'Nueva operación',exact:true}).waitFor();
 await page.getByRole('button',{name:'Resumen',exact:true}).click();await page.getByRole('button',{name:'Actualizar',exact:true}).click();
 await page.getByRole('button',{name:'Salir',exact:true}).click();await page.getByRole('button',{name:'Ingresar',exact:true}).waitFor();
 assert.equal(posts,0);assert.deepEqual(errors,[]);assert.deepEqual(badRequests,[]);assert.deepEqual(httpErrors,[]);
 console.log(JSON.stringify({test:'empty_platform_navigation',status:'ok',validated:['all_navigation_handlers','no_client_guidance','no_operation_guidance','global_audit_before_client','account_access','read_only_sportsbook_amqp403','no_admission_or_fake_scope','create_client','new_operation_form','refresh','logout','no_console_or_network_failures'],vendorRequests:0,realAwsValidated:false}));
}finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));app.locals.closeTickets();platform.close();await rm(dir,{recursive:true,force:true});}
