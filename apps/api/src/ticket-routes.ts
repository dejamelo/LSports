import {formatMinor,returnMinor} from '@lsports/contracts';
import express from 'express';
import type { EventSource, TestTicket, OperationTicket } from '@lsports/contracts';
import { TicketStore, TicketError } from '@lsports/feed-store/tickets';
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function receipt(ticket: TestTicket | OperationTicket) {
  const points = (n: number | string | null) => n === null ? 'Pendiente' : ticket.currency==='TEST_POINTS' ? `${(Number(n)/100).toFixed(2)} pts` : formatMinor(String(n),ticket.currency);
  return `<!doctype html><html lang="es-AR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Comprobante de prueba · Apuesta DEPORTIVA LAT</title>
<style>body{font:12px monospace;overflow-wrap:anywhere;max-width:74mm;margin:24px auto;padding:12px}li{margin:16px 0;overflow-wrap:anywhere}h1{font-size:20px}small{overflow-wrap:anywhere}@media print{@page{size:80mm auto;margin:3mm}body{margin:0;width:74mm;max-width:100%}button{display:none}}</style>
<h1>ADL · Apuesta DEPORTIVA LAT</h1><h2>SIMULACIÓN · PRUEBA · SIN VALOR MONETARIO NI FISCAL</h2><small>ID: ${escape(ticket.id)}</small><p>${escape(ticket.createdAt)} (UTC) · ${escape(ticket.mode)}</p>
${'operationId' in ticket ? `<p>Cliente: ${escape(ticket.clientId)}<br>Operación: ${escape(ticket.operationId)}<br>Moneda simulada: ${escape(ticket.currency)}<br>Canal: ${escape(ticket.channel)}${ticket.terminalId?` · Terminal ${escape(ticket.terminalId)}`:''}</p>`:''}
<p>Importe ficticio: ${points(ticket.stakeMinor)}<br>Retorno potencial al aceptar: ${points(returnMinor(String(ticket.stakeMinor),ticket.selections.map(s=>s.oddsMicros)))}<br>Estado: ${escape(ticket.status)} · Revisión ${ticket.revision}<br>Retorno simulado: ${points(ticket.payoutMinor)}</p>
<ol>${ticket.selections.map(s => `<li>${escape(s.eventName)}<br>${escape(s.marketName)} · ${escape(s.selectionName)}<br>Cuota aceptada: ${s.acceptedOdds}<br>${escape(s.resultDescription)} (settlement ${escape(s.settlement ?? 'pendiente')})</li>`).join('')}</ol>
<details><summary>Historial de revisiones</summary>${ticket.history.map(h => `<p>${h.revision} · ${escape(h.at)} · ${escape(h.status)} · ${points(h.payoutMinor)}<br>${escape(h.reason)}</p>`).join('')}</details>
<p>Sin depósitos, retiros ni cobros. Consultá el historial para comprobar correcciones posteriores.</p><button onclick="window.print()">Imprimir comprobante de prueba</button></html>`;
}
export function ticketRoutes(source: EventSource, supplied?: TicketStore) {
  const router = express.Router();
  let instance = supplied;
  const store = () => instance ||= new TicketStore();
  const refresh = async () => { const feed = await source.getEvents(); store().reconcile(feed); return feed; };
  router.use(express.json({limit:'32kb'}));
  router.post('/tickets', async (req, res) => {
    const feed = source.getEventsByIds && Array.isArray(req.body?.selections)
      ? await source.getEventsByIds({ids:req.body.selections.map((leg: {eventId?:string})=>String(leg?.eventId||'')),scope:'public-ticket'})
      : await refresh();
    store().reconcile(feed);
    const ticket = store().create(req.body, req.get('Idempotency-Key') || '', () => feed);
    res.status(201).json(ticket);
  });
  router.get('/tickets', async (req, res) => {
    const offset = Number(req.query.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TicketError('INVALID_OFFSET','Página inválida.',400);
    await refresh(); res.json({...store().list(offset), testOnly:true});
  });
  router.get('/tickets/:id', async (req, res) => {
    await refresh(); const ticket = store().get(req.params.id);
    if (!ticket) throw new TicketError('NOT_FOUND','Billete no encontrado.',404);
    res.json(ticket);
  });
  router.get('/tickets/:id/receipt', async (req, res) => {
    await refresh(); const ticket = store().get(req.params.id);
    if (!ticket) throw new TicketError('NOT_FOUND','Billete no encontrado.',404);
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'");
    res.type('html').send(receipt(ticket));
  });
  router.get('/posnet/test/capabilities', (_req,res) => res.json({testOnly:true, protocol:'adl-rest-test-v1', hardwareValidated:false,
    createTicket:'POST /api/tickets (channel=posnet_test, terminalId, Idempotency-Key)',
    jobs:'GET /api/posnet/test/print-jobs?terminalId=...', receipt:'GET /api/tickets/:id/receipt', acknowledgement:'POST /api/posnet/test/print-jobs/:id/ack'}));
  router.get('/posnet/test/print-jobs', (req,res) => res.json({testOnly:true,jobs:store().printJobs(String(req.query.terminalId || ''))}));
  router.post('/posnet/test/print-jobs/:id/ack', (req,res) => res.json(store().acknowledgePrint(req.params.id, req.body?.terminalId)));
  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof TicketError) res.status(error.httpStatus).json({code:error.code,error:error.message,testOnly:true});
    else if ((error as {type?:string})?.type === 'entity.parse.failed') res.status(400).json({code:'INVALID_JSON',error:'JSON inválido.',testOnly:true});
    else if ((error as {type?:string})?.type === 'entity.too.large') res.status(413).json({code:'BODY_TOO_LARGE',error:'Solicitud demasiado grande.',testOnly:true});
    else res.status(500).json({code:'TICKET_STORAGE_ERROR',error:'No se pudo completar la operación. Reintentá con la misma clave.',testOnly:true});
  });
  return {router,close:()=>{if (!supplied) instance?.close();}};
}
