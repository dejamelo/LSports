import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { minor, type EventFeed, type TestTicket } from "@lsports/contracts";
import {
  PlatformStore,
  PlatformError,
  digest,
  text,
  type Admin,
} from "./platform.js";
import { eventKey, itemKey, exposure } from "./risk-exposure.js";
export const riskKinds = [
  "largeStake",
  "unusualStake",
  "frequency",
  "fragmentation",
  "eventConcentration",
  "marketConcentration",
  "selectionConcentration",
  "operationExposure",
  "oddsJump",
  "feedHealth",
] as const;
export type RiskKind = (typeof riskKinds)[number];
export interface RiskRule {
  enabled: boolean;
  action: "alert" | "block";
  severity: "info" | "warning" | "high" | "critical";
  thresholdMinor: string;
  maxTickets: number;
  windowMs: number;
  minHistory: number;
  multiplierBps: number;
  changeBps: number;
}
export interface RiskConfig {
  rules: Record<RiskKind, RiskRule>;
  exclusiveMarketIds: string[];
}
export const defaultRiskConfig = (): RiskConfig => ({
  exclusiveMarketIds: [],
  rules: Object.fromEntries(
    riskKinds.map((kind) => [
      kind,
      {
        enabled: kind === "feedHealth",
        action: "alert",
        severity: kind === "feedHealth" ? "high" : "warning",
        thresholdMinor: "1000000",
        maxTickets: 5,
        windowMs: 60000,
        minHistory: 5,
        multiplierBps: 30000,
        changeBps: 2000,
      },
    ]),
  ) as RiskConfig["rules"],
});
export interface Finding {
  kind: RiskKind | "technical";
  severity: RiskRule["severity"];
  reason: string;
  action: "alert" | "block";
  playerId: string | null;
  eventId: string | null;
  marketId: string | null;
  selectionId: string | null;
  ticketIds: string[];
  metric: string;
  events: {
    eventId: string;
    startDisplay: string | null;
    live: boolean | null;
    updatedAt: string | null;
  }[];
}
export class RiskDenied extends PlatformError {
  constructor(public findings: Finding[]) {
    super(
      "RISK_PREVENTIVE_BLOCK",
      "Jugada bloqueada por una regla preventiva configurada. Contactá al operador.",
      409,
    );
  }
}
const validDate = (value: unknown): value is string =>
  typeof value === "string" &&
  /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
  Number.isFinite(Date.parse(value));
const eventInfo = (feed: EventFeed, id: string) => {
  let e: EventFeed["events"][number] | undefined;
  for (const event of feed.events) if (eventKey(event.id) === id) { e = event; break; }
  return {
    eventId: id,
    startDisplay: e?.time || null,
    live: e?.live ?? null,
    updatedAt: e?.updatedAt || feed.updatedAt || null,
  };
};
const mapEvents = (events: Iterable<EventFeed["events"][number]>, map: (event: EventFeed["events"][number]) => EventFeed["events"][number]): EventFeed["events"] => {
  if(Array.isArray(events))return events.map(map);
  return { [Symbol.iterator]: function* () { for (const event of events) yield map(event); }, } as EventFeed["events"];
};
export class OperationRisk {
  constructor(
    private db: DatabaseSync,
    private platform: PlatformStore,
    private operationId: string,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS risk_config(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS risk_suspensions(kind TEXT NOT NULL,event_id TEXT NOT NULL,market_id TEXT NOT NULL,selection_id TEXT NOT NULL,active INTEGER NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(kind,event_id,market_id,selection_id));
   CREATE TABLE IF NOT EXISTS risk_prices(selection_id TEXT NOT NULL,event_id TEXT NOT NULL,market_id TEXT NOT NULL,version_at TEXT NOT NULL,observed INTEGER NOT NULL,odds_micros INTEGER NOT NULL,PRIMARY KEY(selection_id,version_at));
   CREATE TABLE IF NOT EXISTS risk_alerts(id TEXT PRIMARY KEY,dedupe TEXT NOT NULL,fingerprint TEXT NOT NULL,created TEXT NOT NULL,last_seen TEXT NOT NULL,status TEXT NOT NULL,assignee TEXT,notes TEXT NOT NULL,occurrences INTEGER NOT NULL,body TEXT NOT NULL);
   CREATE UNIQUE INDEX IF NOT EXISTS active_risk_alert ON risk_alerts(dedupe) WHERE status IN ('new','review');
   CREATE TABLE IF NOT EXISTS risk_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,body TEXT NOT NULL);`);
  }
  private transaction<T>(fn: () => T) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private audit(
    db: DatabaseSync,
    actor: string,
    action: string,
    body: unknown,
  ) {
    db.prepare(
      "INSERT INTO risk_audit(at,actor,action,body) VALUES(?,?,?,?)",
    ).run(new Date().toISOString(), actor, action, JSON.stringify(body));
  }
  config(db = this.db): RiskConfig {
    const row = db.prepare("SELECT body FROM risk_config WHERE id=1").get() as
      | { body: string }
      | undefined;
    return row ? JSON.parse(row.body) : defaultRiskConfig();
  }
  configure(actor: Admin, input: unknown) {
    const op = this.platform.operation(this.operationId)!;
    this.platform.authorize(actor, op.clientId);
    const value = input as RiskConfig;
    if (
      !value ||
      !value.rules ||
      !Array.isArray(value.exclusiveMarketIds) ||
      value.exclusiveMarketIds.length > 30 ||
      value.exclusiveMarketIds.some(
        (id) => typeof id !== "string" || !/^\d{1,10}$/.test(id),
      )
    )
      throw new PlatformError(
        "INVALID_RISK_CONFIG",
        "Configuración de riesgo inválida.",
      );
    const config = defaultRiskConfig();
    config.exclusiveMarketIds = [...new Set(value.exclusiveMarketIds)];
    for (const kind of riskKinds) {
      const rule = value.rules[kind];
      if (
        !rule ||
        typeof rule.enabled !== "boolean" ||
        !["alert", "block"].includes(rule.action) ||
        !["info", "warning", "high", "critical"].includes(rule.severity)
      )
        throw new PlatformError(
          "INVALID_RISK_CONFIG",
          "Definí estado, acción y gravedad de cada regla.",
        );
      minor(rule.thresholdMinor);
      for (const field of [
        "maxTickets",
        "windowMs",
        "minHistory",
        "multiplierBps",
        "changeBps",
      ] as const)
        if (
          !Number.isSafeInteger(rule[field]) ||
          rule[field] < 1 ||
          rule[field] > 86400000
        )
          throw new PlatformError(
            "INVALID_RISK_CONFIG",
            "Parámetros de regla fuera de rango.",
          );
      if (rule.windowMs > 3600000 || rule.minHistory > 1000)
        throw new PlatformError(
          "INVALID_RISK_CONFIG",
          "La ventana admite hasta una hora y hasta 1000 muestras históricas.",
        );
      config.rules[kind] = {
        enabled: rule.enabled,
        action: rule.action,
        severity: rule.severity,
        thresholdMinor: minor(rule.thresholdMinor).toString(),
        maxTickets: rule.maxTickets,
        windowMs: rule.windowMs,
        minHistory: rule.minHistory,
        multiplierBps: rule.multiplierBps,
        changeBps: rule.changeBps,
      };
    }
    return this.transaction(() => {
      const previous = this.config();
      this.db
        .prepare(
          "INSERT INTO risk_config VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
        )
        .run(JSON.stringify(config));
      this.audit(this.db, actor.id, "risk.config.updated", {
        previous,
        next: config,
      });
      return config;
    });
  }
  private rows(db = this.db) {
    return db
      .prepare(
        "SELECT t.body,c.player_id,t.created FROM tickets t JOIN operation_context c ON c.ticket_id=t.id ORDER BY t.created DESC",
      )
      .all()
      .map((row) => ({
        ticket: JSON.parse(String(row.body)) as TestTicket,
        playerId: String(row.player_id),
        created: Number(row.created),
      }));
  }
  private findings(
    feed: EventFeed,
    db: DatabaseSync,
    candidate?: { ticket: TestTicket; playerId: string },
  ): Finding[] {
    const config = this.config(db),
      rows = this.rows(db),
      pending = rows.filter((row) => row.ticket.status === "PENDING"),
      now = Date.now(),
      result: Finding[] = [];
    const add = (
      kind: RiskKind,
      reason: string,
      metric: string,
      items: typeof rows,
      keys: {
        playerId?: string;
        eventId?: string;
        marketId?: string;
        selectionId?: string;
      } = {},
    ) => {
      const rule = config.rules[kind];
      if (!rule.enabled) return;
      const ids = [...new Set(items.map((row) => row.ticket.id))];
      const events = [
        ...new Set(
          items.flatMap((row) =>
            row.ticket.selections.map((leg) => eventKey(leg.eventId)),
          ),
        ),
      ];
      result.push({
        kind,
        severity: rule.severity,
        action: rule.action,
        reason,
        metric,
        playerId: keys.playerId || null,
        eventId: keys.eventId || null,
        marketId: keys.marketId || null,
        selectionId: keys.selectionId || null,
        ticketIds: ids.slice(0, 100),
        events: events.slice(0, 50).map((id) => eventInfo(feed, id)),
      });
    };
    if (candidate) {
      const own = rows.filter((row) => row.playerId === candidate.playerId),
        history = own
          .filter((row) => row.ticket.id !== candidate.ticket.id)
          .slice(0, 1000),
        amount = BigInt(candidate.ticket.stakeMinor),
        r = config.rules;
      if (amount > minor(r.largeStake.thresholdMinor))
        add(
          "largeStake",
          "Importe superior al umbral configurado.",
          amount.toString(),
          rows.filter((row) => row.ticket.id === candidate.ticket.id),
          { playerId: candidate.playerId },
        );
      if (history.length >= r.unusualStake.minHistory) {
        const sum = history.reduce(
          (a, row) => a + BigInt(row.ticket.stakeMinor),
          0n,
        );
        if (
          amount * BigInt(history.length) * 10000n >
          sum * BigInt(r.unusualStake.multiplierBps)
        )
          add(
            "unusualStake",
            "Importe superior al múltiplo de la media histórica del jugador.",
            amount.toString(),
            own,
            { playerId: candidate.playerId },
          );
      }
      const recent = own.filter(
        (row) => now - row.created <= r.frequency.windowMs,
      );
      if (recent.length >= r.frequency.maxTickets)
        add(
          "frequency",
          "Frecuencia de billetes superior al umbral configurado.",
          String(recent.length),
          recent,
          { playerId: candidate.playerId },
        );
      for (const id of new Set(
        candidate.ticket.selections.map((leg) => eventKey(leg.eventId)),
      )) {
        const split = own.filter(
          (row) =>
            now - row.created <= r.fragmentation.windowMs &&
            row.ticket.selections.some((leg) => eventKey(leg.eventId) === id),
        );
        const sum = split.reduce(
          (n, row) => n + BigInt(row.ticket.stakeMinor),
          0n,
        );
        if (
          split.length >= r.fragmentation.maxTickets &&
          sum >= minor(r.fragmentation.thresholdMinor)
        )
          add(
            "fragmentation",
            "Varios billetes del jugador concentran importe en el mismo evento.",
            sum.toString(),
            split,
            { playerId: candidate.playerId, eventId: id },
          );
      }
      for (const leg of candidate.ticket.selections) {
        const prices = db
          .prepare(
            "SELECT version_at,observed,odds_micros FROM risk_prices WHERE selection_id=? ORDER BY version_at DESC LIMIT 2",
          )
          .all(leg.selectionId) as {
          version_at: string;
          observed: number;
          odds_micros: number;
        }[];
        if (
          prices.length === 2 &&
          now - prices[0].observed <= r.oddsJump.windowMs &&
          now - Date.parse(prices[0].version_at) <= r.oddsJump.windowMs &&
          Date.parse(prices[0].version_at) <= now + 5000 &&
          Date.parse(prices[0].version_at) > Date.parse(prices[1].version_at)
        ) {
          const delta = BigInt(
            Math.abs(prices[0].odds_micros - prices[1].odds_micros),
          );
          if (
            delta * 10000n >=
            BigInt(prices[1].odds_micros) * BigInt(r.oddsJump.changeBps)
          )
            add(
              "oddsJump",
              "Jugada próxima a una variación de cuota con dos versiones confiables.",
              delta.toString(),
              rows.filter((row) => row.ticket.id === candidate.ticket.id),
              {
                playerId: candidate.playerId,
                eventId: eventKey(leg.eventId),
                marketId: itemKey(leg.marketId),
                selectionId: itemKey(leg.selectionId),
              },
            );
        }
      }
    }
    for (const kind of [
      "eventConcentration",
      "marketConcentration",
      "selectionConcentration",
    ] as const) {
      const groups = new Map<
        string,
        {
          keys: { eventId: string; marketId?: string; selectionId?: string };
          items: typeof rows;
        }
      >();
      for (const row of pending)
        for (const leg of row.ticket.selections) {
          const keys = {
              eventId: eventKey(leg.eventId),
              ...(kind !== "eventConcentration"
                ? { marketId: itemKey(leg.marketId) }
                : {}),
              ...(kind === "selectionConcentration"
                ? { selectionId: itemKey(leg.selectionId) }
                : {}),
            },
            key = JSON.stringify(keys);
          const group = groups.get(key) || { keys, items: [] };
          if (!group.items.some((other) => other.ticket.id === row.ticket.id))
            group.items.push(row);
          groups.set(key, group);
        }
      for (const group of groups.values()) {
        const sum = group.items.reduce(
          (n, row) => n + BigInt(row.ticket.stakeMinor),
          0n,
        );
        if (sum > minor(config.rules[kind].thresholdMinor))
          add(
            kind,
            "Concentración de importe pendiente superior al umbral configurado.",
            sum.toString(),
            group.items,
            group.keys,
          );
      }
    }
    const x = exposure(
      pending.map((row) => row.ticket),
      config.exclusiveMarketIds,
    );
    if (
      minor(x.potentialGrossMinor) >
      minor(config.rules.operationExposure.thresholdMinor)
    )
      add(
        "operationExposure",
        "Retorno bruto potencial conservador superior al límite de la operación; no es una pérdida exacta.",
        x.potentialGrossMinor,
        pending,
      );
    // Worker publications expose `events` as a restartable lazy iterable to
    // avoid materializing a second multi-gigabyte array. Keep this scan lazy.
    let ambiguous = 0;
    for (const event of feed.events)
      for (const market of event.markets || [])
        for (const selection of market.selections || [])
          if (selection.unavailableReasons?.some((reason) =>
            reason === "ambiguous_snapshot_timestamp" ||
            reason === "awaiting_timestamp_recovery",
          )) ambiguous++;
    const stale =
      feed.mode === "connected" &&
      (ambiguous > 0 ||
        !validDate(feed.updatedAt) ||
        Date.now() - Date.parse(feed.updatedAt) > 20000 ||
        Date.parse(feed.updatedAt) > Date.now() + 5000 ||
        feed.health === "unavailable" ||
        feed.health === "degraded" ||
        Object.values(feed.connections || {}).some(
          (c) => c.phase !== "connected",
        ));
    if (stale)
      add(
        "feedHealth",
        "Feed sin señal confiable o conexión completa. Se mantienen las protecciones técnicas de admisión.",
        JSON.stringify({
          health: feed.health,
          phases: Object.values(feed.connections || {}).map((c) => c.phase),
          ambiguousSelections: ambiguous,
          stale:
            !validDate(feed.updatedAt) ||
            Date.now() - Date.parse(feed.updatedAt) > 20000,
        }),
        pending,
      );
    return result;
  }
  private persist(
    db: DatabaseSync,
    finding: Finding,
    attempt?: { id: string; candidateId: string },
  ) {
    const body = {
      ...finding,
      ticketIds: finding.ticketIds.filter((id) => id !== attempt?.candidateId),
      ...(attempt ? { attemptId: attempt.id } : {}),
      scope: {
        clientId: this.platform.operation(this.operationId)!.clientId,
        operationId: this.operationId,
        currency: this.platform.operation(this.operationId)!.currency,
      },
    };
    const dedupe = digest(
      JSON.stringify([
        finding.kind,
        finding.playerId,
        finding.eventId,
        finding.marketId,
        finding.selectionId,
      ]),
    );
    const current = db
      .prepare(
        "SELECT * FROM risk_alerts WHERE dedupe=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(dedupe) as
      | {
          id: string;
          status: string;
          fingerprint: string;
          occurrences: number;
          body: string;
        }
      | undefined;
    if (current && current.status !== "closed") {
      const previous = JSON.parse(current.body);
      body.ticketIds = [
        ...new Set([...(previous.ticketIds || []), ...body.ticketIds]),
      ].slice(-100);
      const events = new Map<string, Finding["events"][number]>(
        (previous.events || []).map((event: Finding["events"][number]) => [
          event.eventId,
          event,
        ]),
      );
      for (const event of body.events) events.set(event.eventId, event);
      body.events = [...events.values()].slice(-50);
    }
    const fingerprint = digest(
      JSON.stringify([
        finding.metric,
        body.ticketIds.slice().sort(),
        attempt?.id,
      ]),
    );
    const at = new Date().toISOString();
    if (current?.status === "closed" && current.fingerprint === fingerprint)
      return;
    if (current && current.status !== "closed") {
      db.prepare(
        "UPDATE risk_alerts SET fingerprint=?,last_seen=?,occurrences=?,body=? WHERE id=?",
      ).run(
        fingerprint,
        at,
        current.occurrences + (current.fingerprint === fingerprint ? 0 : 1),
        JSON.stringify(body),
        current.id,
      );
    } else {
      const id = randomUUID();
      db.prepare(
        "INSERT INTO risk_alerts VALUES(?,?,?,?,?,'new',NULL,'[]',1,?)",
      ).run(id, dedupe, fingerprint, at, at, JSON.stringify(body));
      this.audit(db, "risk-engine", "risk.alert.created", {
        alertId: id,
        kind: finding.kind,
        action: finding.action,
      });
    }
  }
  assess(
    ticket: TestTicket,
    playerId: string,
    feed: EventFeed,
    transaction: DatabaseSync,
  ) {
    this.assertNotSuspended(ticket, transaction);
    const findings = this.findings(feed, transaction, { ticket, playerId });
    if (
      findings.some(
        (f) =>
          f.action === "block" &&
          (!f.eventId ||
            ticket.selections.some(
              (leg) =>
                eventKey(leg.eventId) === f.eventId &&
                (!f.marketId || itemKey(leg.marketId) === f.marketId) &&
                (!f.selectionId || itemKey(leg.selectionId) === f.selectionId),
            )),
      )
    )
      throw new RiskDenied(findings);
    for (const finding of findings) this.persist(transaction, finding);
  }
  rejected(
    error: unknown,
    attempt: string,
    candidateId: string | undefined,
    feed: EventFeed | undefined,
    input: Record<string, unknown>,
    playerId: string,
  ) {
    if (error instanceof RiskDenied) {
      this.transaction(() => {
        for (const finding of error.findings)
          this.persist(this.db, finding, {
            id: attempt,
            candidateId: candidateId || "",
          });
        this.audit(this.db, "risk-engine", "risk.preventive.block", {
          attemptId: attempt,
          rules: error.findings
            .filter((f) => f.action === "block")
            .map((f) => f.kind),
        });
      });
    } else if (
      [
        "STALE_FEED",
        "FEED_OR_EVENT_UNAVAILABLE",
        "SELECTION_UNAVAILABLE",
      ].includes((error as { code?: string }).code || "")
    ) {
      const events = Array.isArray(input.selections)
        ? [
            ...new Set(
              input.selections.map((s: any) => eventKey(String(s.eventId))),
            ),
          ]
        : [];
      const finding: Finding = {
        kind: "technical",
        severity: "critical",
        action: "block",
        reason:
          "Protección técnica: feed, estado o timestamp no habilitado. No se aceptó el billete.",
        metric: (error as { code: string }).code,
        playerId,
        eventId: events[0] || null,
        marketId: null,
        selectionId: null,
        ticketIds: [],
        events: events.map((id) =>
          feed
            ? eventInfo(feed, id)
            : { eventId: id, startDisplay: null, live: null, updatedAt: null },
        ),
      };
      this.transaction(() =>
        this.persist(this.db, finding, { id: attempt, candidateId: "" }),
      );
    }
  }
  observe(feed: EventFeed) {
    this.transaction(() => {
      for (const event of feed.events)
        for (const market of event.markets || [])
          for (const selection of market.selections) {
            const proof = selection as typeof selection & {
              priceVersionAt?: string;
              priceOrderingSafe?: boolean;
            };
            if (
              feed.mode !== "connected" ||
              event.source === undefined ||
              feed.connections?.[event.source]?.phase !== "connected" ||
              selection.available !== true ||
              proof.priceOrderingSafe !== true ||
              !validDate(proof.priceVersionAt) ||
              Date.parse(proof.priceVersionAt) > Date.now() + 5000 ||
              !validDate(feed.updatedAt) ||
              Date.now() - Date.parse(feed.updatedAt) > 20000 ||
              Date.parse(feed.updatedAt) > Date.now() + 5000
            )
              continue;
            const previous = this.db
              .prepare(
                "SELECT version_at FROM risk_prices WHERE selection_id=? ORDER BY version_at DESC LIMIT 1",
              )
              .get(selection.id) as { version_at: string } | undefined;
            if (
              previous &&
              Date.parse(previous.version_at) >=
                Date.parse(proof.priceVersionAt)
            )
              continue;
            const odds = Math.round(selection.odds * 1000000);
            if (!Number.isSafeInteger(odds) || odds <= 1000000) continue;
            this.db
              .prepare("INSERT OR IGNORE INTO risk_prices VALUES(?,?,?,?,?,?)")
              .run(
                selection.id,
                eventKey(event.id),
                itemKey(market.id),
                new Date(proof.priceVersionAt).toISOString(),
                Date.now(),
                odds,
              );
          }
      this.db
        .prepare("DELETE FROM risk_prices WHERE observed<?")
        .run(Date.now() - 86400000);
      for (const row of this.db
        .prepare(
          "SELECT id,body FROM risk_alerts WHERE status IN ('new','review')",
        )
        .all()) {
        const body = JSON.parse(String(row.body));
        body.events = (body.events || []).map(
          (event: Finding["events"][number]) => eventInfo(feed, event.eventId),
        );
        body.dataRefreshedAt = feed.updatedAt || null;
        this.db
          .prepare("UPDATE risk_alerts SET body=? WHERE id=?")
          .run(JSON.stringify(body), String(row.id));
      }
      for (const finding of this.findings(feed, this.db))
        this.persist(this.db, finding);
    });
  }
  private assertNotSuspended(ticket: TestTicket, db: DatabaseSync) {
    const targets = db
      .prepare("SELECT * FROM risk_suspensions WHERE active=1")
      .all();
    for (const target of targets) {
      if (
        target.kind === "operation" ||
        ticket.selections.some(
          (leg) =>
            eventKey(leg.eventId) === target.event_id &&
            (target.kind === "event" ||
              (itemKey(leg.marketId) === target.market_id &&
                (target.kind === "market" ||
                  itemKey(leg.selectionId) === target.selection_id))),
        )
      )
        throw new PlatformError(
          "RISK_TARGET_SUSPENDED",
          "Nuevas jugadas suspendidas para la operación, evento, mercado o selección.",
          409,
        );
    }
  }
  suspend(actor: Admin, input: Record<string, unknown>) {
    const op = this.platform.operation(this.operationId)!;
    this.platform.authorize(actor, op.clientId);
    const kind = String(input.kind);
    if (
      !["operation", "event", "market", "selection"].includes(kind) ||
      typeof input.active !== "boolean"
    )
      throw new PlatformError(
        "INVALID_TARGET",
        "Destino de suspensión inválido.",
      );
    const eventId =
        kind === "operation"
          ? ""
          : eventKey(text(input.eventId, "evento", 100)),
      marketId = ["market", "selection"].includes(kind)
        ? itemKey(text(input.marketId, "mercado", 100))
        : "",
      selectionId =
        kind === "selection"
          ? itemKey(text(input.selectionId, "selección", 100))
          : "";
    const reason = text(input.reason, "motivo", 1000);
    return this.transaction(() => {
      const previous = this.db
        .prepare(
          "SELECT * FROM risk_suspensions WHERE kind=? AND event_id=? AND market_id=? AND selection_id=?",
        )
        .get(kind, eventId, marketId, selectionId);
      const next = {
        kind,
        eventId,
        marketId,
        selectionId,
        active: input.active,
        reason,
      };
      this.db
        .prepare(
          "INSERT INTO risk_suspensions VALUES(?,?,?,?,?,?) ON CONFLICT(kind,event_id,market_id,selection_id) DO UPDATE SET active=excluded.active,reason=excluded.reason",
        )
        .run(
          kind,
          eventId,
          marketId,
          selectionId,
          input.active ? 1 : 0,
          reason,
        );
      this.audit(this.db, actor.id, "risk.suspension.updated", {
        previous: previous || null,
        next,
      });
      return next;
    });
  }
  updateAlert(actor: Admin, id: string, input: Record<string, unknown>) {
    const op = this.platform.operation(this.operationId)!;
    this.platform.authorize(actor, op.clientId);
    const status = String(input.status);
    if (!["new", "review", "closed"].includes(status))
      throw new PlatformError(
        "INVALID_ALERT_STATUS",
        "Estado de alerta inválido.",
      );
    const note = text(input.note, "observación", 2000),
      assignee = text(input.assignee, "responsable", 150);
    return this.transaction(() => {
      const current = this.db
        .prepare("SELECT status,assignee,notes FROM risk_alerts WHERE id=?")
        .get(id) as
        | { status: string; assignee: string | null; notes: string }
        | undefined;
      if (!current)
        throw new PlatformError("NOT_FOUND", "Alerta no encontrada.", 404);
      const notes = JSON.parse(current.notes);
      notes.push({ at: new Date().toISOString(), actor: actor.id, text: note });
      this.db
        .prepare(
          "UPDATE risk_alerts SET status=?,assignee=?,notes=? WHERE id=?",
        )
        .run(status, assignee, JSON.stringify(notes), id);
      this.audit(this.db, actor.id, "risk.alert.updated", {
        alertId: id,
        previous: { status: current.status, assignee: current.assignee },
        next: { status, assignee, note },
      });
    });
  }
  auditEntries() {
    return this.db
      .prepare("SELECT * FROM risk_audit ORDER BY id DESC LIMIT 100")
      .all()
      .map((row) => ({
        id: Number(row.id),
        at: String(row.at),
        actor: String(row.actor),
        action: String(row.action),
        body: JSON.parse(String(row.body)),
      }));
  }
  overlay(feed: EventFeed): EventFeed {
    const targets = this.db
      .prepare("SELECT * FROM risk_suspensions WHERE active=1")
      .all();
    if (!targets.length) return feed;
    return {
      ...feed,
      notice: `${feed.notice || ""} Algunas nuevas jugadas tienen suspensión administrativa.`,
      events: mapEvents(feed.events, (event) => {
        const eventBlocked = targets.some(
          (t) =>
            t.kind === "operation" ||
            (t.kind === "event" && t.event_id === eventKey(event.id)),
        );
        const markets = event.markets?.map((market) => ({
          ...market,
          selections: market.selections.map((selection) => {
            const blocked =
              eventBlocked ||
              targets.some(
                (t) =>
                  t.event_id === eventKey(event.id) &&
                  t.market_id === itemKey(market.id) &&
                  (t.kind === "market" ||
                    (t.kind === "selection" &&
                      t.selection_id === itemKey(selection.id))),
              );
            return blocked
              ? {
                  ...selection,
                  available: false,
                  unavailableReasons: [
                    ...(selection.unavailableReasons || []),
                    "operator_suspension",
                  ],
                }
              : selection;
          }),
        }));
        return {
          ...event,
          ...(eventBlocked ? { available: false } : {}),
          markets,
          selections:
            markets?.find((m) => m.name === event.market)?.selections ||
            event.selections,
        };
      }),
    };
  }
  dashboard(filters: Record<string, unknown> = {}) {
    const op = this.platform.operation(this.operationId)!;
    const rows = this.rows();
    const alerts = this.db
      .prepare("SELECT * FROM risk_alerts ORDER BY last_seen DESC LIMIT 500")
      .all()
      .map((row) => ({
        ...row,
        notes: JSON.parse(String(row.notes)),
        ...JSON.parse(String(row.body)),
      }))
      .filter(
        (row) =>
          (!filters.status || row.status === filters.status) &&
          (!filters.severity || row.severity === filters.severity) &&
          (!filters.playerId || row.playerId === filters.playerId) &&
          (!filters.eventId ||
            row.eventId === eventKey(String(filters.eventId)) ||
            row.events.some(
              (event: any) =>
                event.eventId === eventKey(String(filters.eventId)),
            )),
      );
    return {
      scope: {
        clientId: op.clientId,
        operationId: op.id,
        currency: op.currency,
      },
      financialMode: "simulation",
      updatedAt: new Date().toISOString(),
      config: this.config(),
      alerts,
      exposure: exposure(
        rows.map((row) => row.ticket),
        this.config().exclusiveMarketIds,
      ),
      suspensions: this.db.prepare("SELECT * FROM risk_suspensions").all(),
      audit: this.db
        .prepare("SELECT * FROM risk_audit ORDER BY id DESC LIMIT 100")
        .all()
        .map((row) => ({ ...row, body: JSON.parse(String(row.body)) })),
      priceHistory: {
        reliableSamples: Number(
          this.db.prepare("SELECT count(*) as n FROM risk_prices").get()!.n,
        ),
        requirement:
          "Dos versiones explícitas y ordenadas por selección; sin evidencia no se evalúa la variación.",
      },
    };
  }
}
