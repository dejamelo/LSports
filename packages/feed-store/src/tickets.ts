import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { root, statePath } from './index.js';
import { settlementLabel, type EventFeed, type TestTicket, type TicketLeg, type TicketRequest, type TicketStatus } from '@lsports/contracts';

export class TicketError extends Error {
  constructor(public code: string, message: string, public httpStatus = 409) { super(message); }
}
function fail(code: string, message: string, status = 409): never { throw new TicketError(code, message, status); }
const canonical = (id: string) => id.replace(/^(prematch|inplay):/, "");
const terminalCodes = new Set([-1, 1, 2, 3, 4, 5]);
const validKey = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9:_-]{8,128}$/.test(s);
export const ticketDatabasePath = () => resolve(root, process.env.TEST_TICKETS_DB || `${dirname(statePath())}/test-tickets.sqlite`);

export class TicketStore {
  private db: DatabaseSync;
  constructor(path = ticketDatabasePath(), private now = () => Date.now()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL, created INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outcomes(mode TEXT NOT NULL, event_id TEXT NOT NULL, market_id TEXT NOT NULL, selection_id TEXT NOT NULL, version INTEGER NOT NULL, code INTEGER NOT NULL,
        PRIMARY KEY(mode,event_id,market_id,selection_id));
      CREATE TABLE IF NOT EXISTS print_jobs(id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, terminal_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ticket_order ON tickets(created DESC);`);
  }
  close() { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  private outcome(mode: string, leg: Pick<TicketLeg, 'eventId' | 'marketId' | 'selectionId'>) {
    return this.db.prepare('SELECT code,version FROM outcomes WHERE mode=? AND event_id=? AND market_id=? AND selection_id=?')
      .get(mode, canonical(leg.eventId), canonical(leg.marketId), canonical(leg.selectionId)) as { code: number; version: number } | undefined;
  }
  create(input: TicketRequest, idempotencyKey: string, getFeed: () => EventFeed, policy?: (selections: TicketLeg[]) => void, accepted?: (ticket: TestTicket, transaction: DatabaseSync) => void): TestTicket {
    if (!validKey(idempotencyKey)) fail('INVALID_IDEMPOTENCY_KEY', 'Falta una clave de idempotencia válida.', 400);
    if (!input || !Number.isSafeInteger(input.stakeMinor) || input.stakeMinor <= 0 || input.stakeMinor > 100000000 ||
        !Array.isArray(input.selections) || input.selections.length < 1 || input.selections.length > 12)
      fail('INVALID_TICKET', 'Importe o cantidad de selecciones inválidos.', 400);
    if (input.channel !== undefined && !['web', 'mobile', 'pos', 'posnet_test'].includes(input.channel)) fail('INVALID_CHANNEL', 'Canal inválido.', 400);
    if ((input.channel === 'posnet_test' || input.channel === 'pos') && !validKey(input.terminalId)) fail('INVALID_TERMINAL', 'Terminal de prueba inválida.', 400);
    for (const leg of input.selections) {
      if (!leg || ![leg.eventId, leg.marketId, leg.selectionId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 300) ||
          !Number.isFinite(leg.expectedOdds)) fail('INVALID_SELECTION', 'Selección inválida.', 400);
    }
    if (new Set(input.selections.map(s => s.eventId)).size !== input.selections.length)
      fail('DUPLICATE_EVENT', 'Una sola selección por evento en esta etapa de prueba.', 400);
    const hash = createHash('sha256').update(JSON.stringify({ stakeMinor: input.stakeMinor,
      selections: input.selections.map(s => ({ eventId: s.eventId, marketId: s.marketId, selectionId: s.selectionId, expectedOdds: s.expectedOdds })),
      channel: input.channel || 'web', terminalId: input.terminalId || null })).digest('hex');
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT body,request_hash FROM tickets WHERE idem=?').get(idempotencyKey) as {body: string; request_hash: string} | undefined;
      if (previous) {
        if (previous.request_hash !== hash) fail('IDEMPOTENCY_CONFLICT', 'La clave ya fue usada para otro billete.');
        return JSON.parse(previous.body) as TestTicket;
      }
      const feed = getFeed();
      const at = this.now();
      if (feed.mode === 'connected' && (!Number.isFinite(Date.parse(feed.updatedAt || '')) || at - Date.parse(feed.updatedAt!) > 20000 || at < Date.parse(feed.updatedAt!)))
        fail('STALE_FEED', 'El feed no tiene datos recientes.', 503);
      const selections: TicketLeg[] = input.selections.map(request => {
        const event = feed.events.find(e => e.id === request.eventId);
        if (!event || event.available === false) fail('EVENT_UNAVAILABLE', 'El evento no está habilitado.');
        if (feed.mode === 'connected' && (event.available !== true || ![1, 2, 9].includes(event.status ?? 0) || !event.source || feed.connections?.[event.source]?.phase !== 'connected'))
          fail('FEED_OR_EVENT_UNAVAILABLE', 'Conexión o estado del evento no habilitado.');
        const market = event.markets?.find(m => m.id === request.marketId) ||
          (feed.mode === 'demo' && request.marketId === 'demo' ? { id: 'demo', name: event.market, status: 1, selections: event.selections } : undefined);
        if (!market || (feed.mode === 'connected' && market.status !== 1) || (market.status !== undefined && market.status !== 1))
          fail('MARKET_NOT_OPEN', 'El mercado está suspendido, cerrado o liquidado.');
        const selection = market.selections.find(s => s.id === request.selectionId);
        if (!selection || selection.available === false || (feed.mode === 'connected' && (selection.available !== true || selection.status !== 1)) ||
            (selection.settlement !== undefined && selection.settlement !== 0)) fail('SELECTION_UNAVAILABLE', 'Selección no habilitada o ya liquidada.');
        if (!Number.isFinite(selection.odds) || selection.odds <= 1 || selection.odds > 10000) fail('INVALID_PRICE', 'Cuota inválida.');
        if (selection.odds !== request.expectedOdds) fail('PRICE_CHANGED', 'La cuota cambió. Actualizá y aceptá el precio vigente.');
        const oddsMicros = Math.round(selection.odds * 1000000);
        if (Math.abs(oddsMicros / 1000000 - selection.odds) > 1e-9) fail('PRICE_PRECISION', 'Precisión de cuota no soportada.');
        const leg: TicketLeg = { eventId: event.id, marketId: market.id, selectionId: selection.id,
          eventName: [event.home, event.away].filter(Boolean).join(' · '), marketName: market.name, selectionName: selection.label,
          acceptedOdds: selection.odds, oddsMicros, settlement: null, resultDescription: 'Pendiente' };
        if (terminalCodes.has(this.outcome(feed.mode, leg)?.code ?? 0)) fail('RESULT_ALREADY_RECEIVED', 'Ya se recibió un resultado; no se acepta un billete retroactivo.');
        return leg;
      });
      // Bound the largest possible return before accepting, using integer arithmetic.
      let max = BigInt(input.stakeMinor), denominator = 1n;
      for (const s of selections) { max *= BigInt(s.oddsMicros); denominator *= 1000000n; }
      if ((max + denominator - 1n) / denominator > BigInt(Number.MAX_SAFE_INTEGER)) fail('RETURN_LIMIT', 'Retorno fuera del límite de prueba.', 400);
      policy?.(selections);
      const ticket: TestTicket = { id: randomUUID(), mode: feed.mode, testOnly: true, currency: 'TEST_POINTS',
        createdAt: new Date(at).toISOString(), stakeMinor: input.stakeMinor, status: 'PENDING', payoutMinor: null, revision: 0,
        channel: input.channel || 'web', ...(input.terminalId ? {terminalId: input.terminalId} : {}), selections,
        history: [{ revision: 0, at: new Date(at).toISOString(), status: 'PENDING', payoutMinor: null, reason: 'Billete de prueba aceptado por el servidor.' }] };
      this.db.prepare('INSERT INTO tickets VALUES(?,?,?,?,?)').run(ticket.id, idempotencyKey, hash, at, JSON.stringify(ticket));
      accepted?.(ticket, this.db); // Same BEGIN IMMEDIATE transaction as admission.
      if (ticket.channel === 'posnet_test') this.db.prepare('INSERT INTO print_jobs(id,ticket_id,terminal_id,created) VALUES(?,?,?,?)').run(randomUUID(), ticket.id, ticket.terminalId!, at);
      return ticket;
    });
  }
  reconcile(feed: EventFeed) {
    this.transaction(() => {
      // Repair only an explicitly quarantined *unsettled* version index. Ticket bodies,
      // accepted odds and terminal outcomes are immutable here. Exact old-version match
      // makes this crash/replay safe after the offline checkpoint preparation.
      for(const recovery of feed.ticketVersionRecoveries || []) {
        const previous=Date.parse(recovery.previousVersion),baseline=Date.parse(recovery.baselineVersion);
        if(feed.mode!=="connected"||!recovery.auditId||!Number.isFinite(previous)||!Number.isFinite(baseline)||baseline>=previous)continue;
        this.db.prepare('UPDATE outcomes SET version=? WHERE mode=? AND event_id=? AND market_id=? AND selection_id=? AND code=0 AND version=?')
          .run(baseline,feed.mode,canonical(recovery.eventId),canonical(recovery.marketId),canonical(recovery.selectionId),previous);
      }
      let changed = false;
      for (const result of feed.ticketOutcomes || []) {
        const version = Date.parse(result.updatedAt);
        if (!Number.isFinite(version) || !Number.isInteger(result.settlement)) continue;
        const prior = this.outcome(feed.mode, result);
        if (prior && (prior.version > version || (prior.version === version && prior.code === result.settlement))) continue;
        this.db.prepare(`INSERT INTO outcomes VALUES(?,?,?,?,?,?) ON CONFLICT(mode,event_id,market_id,selection_id)
          DO UPDATE SET version=excluded.version,code=excluded.code`).run(feed.mode, canonical(result.eventId), canonical(result.marketId), canonical(result.selectionId), version, result.settlement);
        if (!prior || prior.code !== result.settlement) changed = true;
      }
      if (!changed) return;
      const rows = this.db.prepare('SELECT id,body FROM tickets').all() as {id: string; body: string}[];
      for (const row of rows) {
        const ticket = JSON.parse(row.body) as TestTicket;
        if (ticket.mode !== feed.mode) continue;
        const next = ticket.selections.map(leg => {
          const result = this.outcome(ticket.mode, leg);
          if (!result) return leg;
          return { ...leg, settlement: result.code, resultDescription: terminalCodes.has(result.code) || result.code === 0 ? settlementLabel(result.code) : 'Código desconocido: revisión pendiente' };
        });
        if (next.every((s, i) => s.settlement === ticket.selections[i].settlement)) continue;
        ticket.selections = next;
        let payout: number | null = null; let status: TicketStatus = 'PENDING';
        if (next.every(s => s.settlement !== null && terminalCodes.has(s.settlement))) {
          let numerator = BigInt(ticket.stakeMinor), denominator = 1n;
          for (const leg of next) {
            const code = leg.settlement!;
            const factor = code === 1 ? 0 : code === 2 ? leg.oddsMicros : code === 4 ? 500000 : code === 5 ? (leg.oddsMicros + 1000000) : 1000000;
            numerator *= BigInt(factor); denominator *= code === 5 ? 2000000n : 1000000n;
          }
          payout = Number((numerator + denominator / 2n) / denominator);
          status = next.every(s => s.settlement === -1 || s.settlement === 3) ? 'REFUNDED' : payout === 0 ? 'LOST' : payout < ticket.stakeMinor ? 'PARTIAL_RETURN' : 'WON';
        }
        ticket.status = status; ticket.payoutMinor = payout; ticket.revision++;
        ticket.history.push({ revision: ticket.revision, at: new Date(this.now()).toISOString(), status, payoutMinor: payout,
          reason: ticket.revision === 1 ? 'Resultado recibido del feed.' : 'Corrección/actualización del proveedor; reemplaza el cálculo anterior.' });
        this.db.prepare('UPDATE tickets SET body=? WHERE id=?').run(JSON.stringify(ticket), ticket.id);
      }
    });
  }
  get(id: string) {
    const row = this.db.prepare('SELECT body FROM tickets WHERE id=?').get(id) as {body: string} | undefined;
    return row ? JSON.parse(row.body) as TestTicket : undefined;
  }
  list(offset = 0, limit = 50) {
    const total = (this.db.prepare('SELECT count(*) AS n FROM tickets').get() as {n: number}).n;
    const tickets = (this.db.prepare('SELECT body FROM tickets ORDER BY created DESC,id LIMIT ? OFFSET ?').all(limit, offset) as {body: string}[]).map(row => JSON.parse(row.body) as TestTicket);
    return { tickets, total, offset, nextOffset: offset + tickets.length < total ? offset + tickets.length : null };
  }
  printJobs(terminalId: string) {
    if (!validKey(terminalId)) fail('INVALID_TERMINAL', 'Terminal inválida.', 400);
    return this.db.prepare("SELECT id,ticket_id AS ticketId,status,created FROM print_jobs WHERE terminal_id=? AND status='pending' ORDER BY created").all(terminalId);
  }
  acknowledgePrint(id: string, terminalId: string) {
    if (!validKey(terminalId)) fail('INVALID_TERMINAL', 'Terminal inválida.', 400);
    const job = this.db.prepare('SELECT id,status FROM print_jobs WHERE id=? AND terminal_id=?').get(id, terminalId);
    if (!job) fail('JOB_NOT_FOUND', 'Trabajo no encontrado.', 404);
    this.db.prepare("UPDATE print_jobs SET status='printed' WHERE id=? AND terminal_id=?").run(id, terminalId);
    return { id, status: 'printed', testOnly: true };
  }
}
