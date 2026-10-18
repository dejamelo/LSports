import { OperationRisk } from "./operation-risk.js";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { TicketStore } from "./tickets.js";
import {
  PlatformStore,
  PlatformError,
  assertBinding,
  integrationChannel,
  digest,
  text,
} from "./platform.js";
import {
  minor,
  returnMinor,
  currencyPrecision,
  type EventFeed,
  type OperationTicket,
  type TestTicket,
  type TicketRequest,
  type IntegrationChannel,
  type Currency,
} from "@lsports/contracts";
interface Context {
  client_id: string;
  operation_id: string;
  currency: Currency;
  ticket_id: string;
  player_id: string;
  channel: IntegrationChannel;
  terminal_id: string | null;
  limits: string;
  policy_revision: number;
}
const fixture = (id: string) => id.replace(/^(prematch|inplay):/, "");
export class OperationTickets {
  private core: TicketStore;
  private db: DatabaseSync;
  readonly risk: OperationRisk;
  constructor(
    private platform: PlatformStore,
    private operationId: string,
  ) {
    const op = platform.operation(operationId);
    if (!op)
      throw new PlatformError("NOT_FOUND", "Operación no encontrada.", 404);
    const path = join(
      platform.directory,
      "clients",
      op.clientId,
      "operations",
      op.id,
      "tickets.sqlite",
    );
    this.core = new TicketStore(path);
    try {
      this.db = new DatabaseSync(path);
      this.db.exec(`PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS operation_context(ticket_id TEXT PRIMARY KEY REFERENCES tickets(id),client_id TEXT NOT NULL,operation_id TEXT NOT NULL,currency TEXT NOT NULL,player_id TEXT NOT NULL,channel TEXT NOT NULL,terminal_id TEXT,limits TEXT NOT NULL,policy_revision INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS limit_reservations(ticket_id TEXT NOT NULL REFERENCES tickets(id),player_id TEXT NOT NULL,event_id TEXT NOT NULL,stake_minor TEXT NOT NULL,PRIMARY KEY(ticket_id,event_id));
   CREATE INDEX IF NOT EXISTS player_event_limits ON limit_reservations(player_id,event_id);`);
      this.risk = new OperationRisk(this.db, this.platform, this.operationId);
    } catch (error) {
      this.core.close();
      throw error;
    }
  }
  close() {
    try {
      this.core.close();
    } finally {
      this.db.close();
    }
  }
  private view(ticket: TestTicket, context: Context): OperationTicket {
    const op = this.platform.operation(this.operationId)!;
    if (
      context.client_id !== op.clientId ||
      context.operation_id !== op.id ||
      context.currency !== op.currency
    )
      throw new PlatformError(
        "STORED_SCOPE_MISMATCH",
        "El billete tiene un ámbito inconsistente. No se reinterpreta su moneda.",
        500,
      );
    return {
      ...ticket,
      clientId: context.client_id,
      operationId: context.operation_id,
      currency: context.currency,
      fractionDigits: currencyPrecision[op.currency],
      financialMode: "simulation",
      stakeMinor: BigInt(ticket.stakeMinor).toString(),
      payoutMinor:
        ticket.payoutMinor === null
          ? null
          : BigInt(ticket.payoutMinor).toString(),
      channel: context.channel,
      ...(context.terminal_id ? { terminalId: context.terminal_id } : {}),
      history: ticket.history.map((row) => ({
        ...row,
        payoutMinor:
          row.payoutMinor === null ? null : BigInt(row.payoutMinor).toString(),
      })),
    };
  }
  create(
    input: Record<string, unknown>,
    playerId: string,
    key: string,
    getFeed: () => EventFeed,
  ): OperationTicket {
    const op = this.platform.operation(this.operationId)!;
    assertBinding(op, input, true);
    text(playerId, "playerId", 120);
    if (!/^[a-zA-Z0-9:_-]{8,128}$/.test(key))
      throw new PlatformError(
        "INVALID_IDEMPOTENCY_KEY",
        "Clave de idempotencia inválida.",
      );
    const amount = minor(input.stakeMinor);
    if (amount < 1n || amount > 100000000n)
      throw new PlatformError(
        "STAKE_RANGE",
        "Importe fuera del rango de simulación.",
      );
    const channel = integrationChannel(input.channel, input.terminalId);
    const scopedKey = digest(
      JSON.stringify([op.clientId, op.id, op.currency, playerId, key]),
    );
    let acceptedLimits: ReturnType<PlatformStore["effectiveOperationLimits"]>;
    let attemptedTicketId: string | undefined;
    let currentFeed: EventFeed | undefined;
    try {
      const ticket = this.core.create(
        {
          stakeMinor: Number(amount),
          selections: input.selections as TicketRequest["selections"],
          ...channel,
        },
        scopedKey,
        () => {
          currentFeed = getFeed();
          return currentFeed;
        },
        (selections) => {
          const current = this.platform.operation(op.id)!,
            client = this.platform.client(op.clientId)!;
          if (
            current.status !== "active" ||
            !current.acceptingTickets ||
            client.status !== "active" ||
            !client.settings.acceptingTickets
          )
            throw new PlatformError(
              "ACCEPTANCE_PAUSED",
              "Nuevos billetes suspendidos. Las liquidaciones siguen activas.",
              409,
            );
          acceptedLimits = this.platform.effectiveOperationLimits(op.id);
          const limits = acceptedLimits.limits;
          if (minor(limits.minStakeMinor) > minor(limits.maxStakeMinor))
            throw new PlatformError(
              "LIMIT_POLICY_CONFLICT",
              "La política autorizada y los límites de la operación son incompatibles. Contactá al administrador.",
              409,
            );
          if (amount < minor(limits.minStakeMinor))
            throw new PlatformError(
              "STAKE_BELOW_MINIMUM",
              "El importe es menor al mínimo de la operación.",
              409,
            );
          if (amount > minor(limits.maxStakeMinor))
            throw new PlatformError(
              "STAKE_ABOVE_MAXIMUM",
              "El importe supera el máximo por billete.",
              409,
            );
          if (
            minor(
              returnMinor(
                amount.toString(),
                selections.map((s) => s.oddsMicros),
              ),
            ) > minor(limits.maxReturnMinor)
          )
            throw new PlatformError(
              "RETURN_LIMIT",
              "El retorno potencial supera el límite de la operación.",
              409,
            );
          if (
            new Set(selections.map((s) => fixture(s.eventId))).size !==
            selections.length
          )
            throw new PlatformError(
              "CORRELATED_SELECTIONS_UNSUPPORTED",
              "No se admiten múltiples con selecciones del mismo evento.",
              409,
            );
        },
        (ticket, db) => {
          attemptedTicketId = ticket.id;
          const { limits, policyRevision } = acceptedLimits!;
          for (const eventId of new Set(
            ticket.selections.map((s) => fixture(s.eventId)),
          )) {
            const rows = db
              .prepare(
                "SELECT stake_minor FROM limit_reservations WHERE player_id=? AND event_id=?",
              )
              .all(playerId, eventId);
            if (!limits.allowRepeatedTickets && rows.length)
              throw new PlatformError(
                "REPEATED_EVENT_BLOCKED",
                "Ya registraste un billete para este evento. No se permiten nuevas jugadas del mismo jugador.",
                409,
              );
            if (
              limits.maxTicketsPerPlayerEvent !== null &&
              rows.length >= limits.maxTicketsPerPlayerEvent
            )
              throw new PlatformError(
                "PLAYER_EVENT_TICKET_LIMIT",
                "Alcanzaste la cantidad máxima de billetes para este evento.",
                409,
              );
            const accumulated = rows.reduce(
              (sum, row) => sum + BigInt(String(row.stake_minor)),
              0n,
            );
            if (
              limits.maxStakePerPlayerEventMinor !== null &&
              accumulated + amount > minor(limits.maxStakePerPlayerEventMinor)
            )
              throw new PlatformError(
                "PLAYER_EVENT_AMOUNT_LIMIT",
                "El importe acumulado del jugador supera el límite de este evento.",
                409,
              );
          }
          db.prepare(
            "INSERT INTO operation_context VALUES(?,?,?,?,?,?,?,?,?)",
          ).run(
            ticket.id,
            op.clientId,
            op.id,
            op.currency,
            playerId,
            channel.channel,
            channel.terminalId || null,
            JSON.stringify(limits),
            policyRevision,
          );
          for (const eventId of new Set(
            ticket.selections.map((s) => fixture(s.eventId)),
          ))
            db.prepare("INSERT INTO limit_reservations VALUES(?,?,?,?)").run(
              ticket.id,
              playerId,
              eventId,
              amount.toString(),
            );
          this.risk.assess(ticket, playerId, currentFeed!, db);
        },
      );
      return this.get(ticket.id, playerId)!;
    } catch (error) {
      this.risk.rejected(
        error,
        scopedKey,
        attemptedTicketId,
        currentFeed,
        input,
        playerId,
      );
      throw error;
    }
  }
  reconcile(feed: EventFeed) {
    this.core.reconcile(feed);
    this.risk.observe(feed);
  }
  get(id: string, playerId?: string): OperationTicket | undefined {
    const context = this.db
      .prepare("SELECT * FROM operation_context WHERE ticket_id=?")
      .get(id) as unknown as Context | undefined;
    if (!context || (playerId !== undefined && context.player_id !== playerId))
      return undefined;
    const ticket = this.core.get(id);
    return ticket ? this.view(ticket, context) : undefined;
  }
  list(playerId?: string, offset = 0, limit = 50) {
    const ids = (
      playerId === undefined
        ? this.db
            .prepare(
              "SELECT ticket_id FROM operation_context ORDER BY rowid DESC",
            )
            .all()
        : this.db
            .prepare(
              "SELECT ticket_id FROM operation_context WHERE player_id=? ORDER BY rowid DESC",
            )
            .all(playerId)
    ).map((row) => String(row.ticket_id));
    return {
      tickets: ids
        .slice(offset, offset + limit)
        .map((id) => this.get(id, playerId)!),
      total: ids.length,
      offset,
      nextOffset: offset + limit < ids.length ? offset + limit : null,
    };
  }
  report(playerId?: string) {
    const op = this.platform.operation(this.operationId)!;
    let stakes = 0n,
      returns = 0n,
      pending = 0,
      total = 0;
    for (let offset = 0; ; offset += 100) {
      const page = this.list(playerId, offset, 100);
      for (const ticket of page.tickets) {
        total++;
        stakes += minor(ticket.stakeMinor);
        if (ticket.payoutMinor === null) pending++;
        else returns += minor(ticket.payoutMinor);
      }
      if (page.nextOffset === null) break;
    }
    return {
      clientId: op.clientId,
      operationId: op.id,
      currency: op.currency,
      fractionDigits: currencyPrecision[op.currency],
      financialMode: "simulation",
      acceptedTickets: total,
      pendingTickets: pending,
      acceptedStakeMinor: stakes.toString(),
      settledReturnMinor: returns.toString(),
      wallet: {
        clientId: op.clientId,
        operationId: op.id,
        currency: op.currency,
        playerId: playerId || null,
        balanceMinor: null,
        status: "contract_pending" as const,
      },
    };
  }
}
