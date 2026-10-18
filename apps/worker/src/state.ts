import { SettlementType, OutrightScoreStatus } from "trade360-nodejs-sdk";
import { marketStatusLabel, settlementLabel } from "@lsports/contracts";
import type {
  ConnectionState,
  OutrightMarketDiagnostic,
  CoverageStats,
  SnapshotAudit,
  EventFeed,
  EventMarket,
  Lane,
  Sport,
  SportEvent,
} from "@lsports/contracts";
import type { Fixture, Livescore, Market, OutrightFixtureEvent, OutrightScoreUpdate } from "trade360-nodejs-sdk";
type OutrightScore = NonNullable<NonNullable<NonNullable<OutrightScoreUpdate["competition"]>["events"]>[number]["outrightScore"]>;
export interface TradeEvent {
  fixtureId: number;
  outright?: { competitionId: number; competitionName?: string; competitionType?: number; fixture?: NonNullable<OutrightFixtureEvent["outrightFixture"]> };
  fixture?: Fixture;
  livescore?: Livescore;
  outrightScore?: OutrightScore;
  markets?: Market[];
  marketMessageType?: 41 | 42;
  marketRecovery?: boolean;
  settlementInspection?: ReturnType<typeof import("./settlement-evidence.js").inspectSettlements>;
}
interface Versioned<T> {
  value: T;
  at: number;
}
export interface Row {
  restored?: boolean;
  fixture?: Versioned<Fixture>;
  outright?: TradeEvent["outright"];
  marketReceipt?: { messagesByType: Record<string, number>; marketUpdates: number; betUpdates: number; providerMarketUpdates: number; providerBetUpdates: number; staleBetUpdates: number; lastMarketMessageAt?: string; snapshotMarketUpdates?: number; lastMarketSnapshotAt?: string };
  livescore?: Versioned<Livescore>;
  outrightScore?: Versioned<OutrightScore>;
  markets: Map<string, Market>;
  marketAt: Map<string, number>;
  betAt: Map<string, number>;
  freshBets?: Set<string>;
  settlementAudit?: Map<string, import("@lsports/contracts").SettlementTrace>;
  settlementMarkets?: Map<string, import("@lsports/contracts").SettlementMarketEvidence>;
  // Session evidence only: a checkpoint must never restore quote confirmation.
  snapshotBets?: Map<string, import("@lsports/contracts").SnapshotQuoteObservation>;
}
const statusLabels: Record<number, string> = {
  0: "Sin estado",
  1: "Prepartido",
  2: "En vivo",
  3: "Finalizado",
  4: "Cancelado",
  5: "Postergado",
  6: "Interrumpido",
  7: "Abandonado",
  8: "Sin cobertura",
  9: "Por comenzar",
};
export function classifySport(name = ""): Sport {
  const n = name.toLowerCase();
  if (/horse racing|horse-racing|carreras de caballos|hípica/.test(n))
    return "hipica";
  if (/soccer|football|fútbol/.test(n) && !/american|australian/.test(n))
    return "futbol";
  if (/tennis|tenis/.test(n) && !/table/.test(n)) return "tenis";
  if (/basketball|básquet/.test(n)) return "basquet";
  return "otros";
}
const timestamp = (value: unknown, fallback: number) => {
  const n = value ? new Date(value as string).getTime() : NaN;
  return Number.isFinite(n) ? n : fallback;
};
const defined = <T extends object>(value: T) =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
export class TradeState {
  rows: Record<Lane, Map<number | string, Row>> = {
    prematch: new Map(),
    inplay: new Map(),
  };
  metrics: Record<
    Lane,
    {
      snapshot?: SnapshotAudit;
      messages: number;
      messagesByType: Record<string, number>;
      eventUpdatesReceived: number;
      duplicateMessages: number;
      keepAliveActiveEvents?: number;
      marketsWithoutId: number;
      staleUpdatesIgnored: number;
    }
  > = {
    prematch: {
      messages: 0,
      messagesByType: {},
      eventUpdatesReceived: 0,
      duplicateMessages: 0,
      marketsWithoutId: 0,
      staleUpdatesIgnored: 0,
    },
    inplay: {
      messages: 0,
      messagesByType: {},
      eventUpdatesReceived: 0,
      duplicateMessages: 0,
      marketsWithoutId: 0,
      staleUpdatesIgnored: 0,
    },
  };
  recordMessage(
    lane: Lane,
    type: number,
    events: number,
    duplicate: boolean,
    keepAliveActiveEvents?: number,
  ) {
    const m = this.metrics[lane];
    m.messages++;
    m.messagesByType[String(type)] = (m.messagesByType[String(type)] || 0) + 1;
    m.eventUpdatesReceived += events;
    if (duplicate) m.duplicateMessages++;
    if (keepAliveActiveEvents !== undefined)
      m.keepAliveActiveEvents = keepAliveActiveEvents;
  }
  connections: Record<Lane, ConnectionState> = {
    prematch: { phase: "starting", message: "Esperando conexión PreMatch" },
    inplay: { phase: "starting", message: "Esperando conexión InPlay" },
  };
  outrightFixtureIds(lane: Lane) {
    return [...new Set([...this.rows[lane]].filter(([, row]) => !!row.outright).map(([key]) => Number(String(key).split(":").at(-1))))];
  }
  set(lane: Lane, patch: Partial<ConnectionState>) {
    Object.assign(this.connections[lane], patch);
  }
  apply(lane: Lane, events: TradeEvent[], at: number) {
    for (const event of events) {
      if (!Number.isSafeInteger(event.fixtureId) || event.fixtureId <= 0)
        throw new Error("Invalid provider fixture ID");
      const key = event.outright ? `outright:${event.outright.competitionId}:${event.fixtureId}` : event.fixtureId;
      let row = this.rows[lane].get(key);
      if (!row) {
        row = { markets: new Map(), marketAt: new Map(), betAt: new Map() };
        this.rows[lane].set(key, row);
      }
      if (event.outright) {
        const incoming = event.outright;
        row.outright = { ...row.outright, ...defined(incoming), competitionId: incoming.competitionId };
        if (incoming.fixture) {
          const t = timestamp(incoming.fixture.lastUpdate, at);
          if (!row.fixture || t >= row.fixture.at)
            row.fixture = { value: { ...row.fixture?.value, ...defined(incoming.fixture) } as Fixture, at: t };
          else this.metrics[lane].staleUpdatesIgnored++;
        }
        if (event.marketMessageType || event.marketRecovery) {
          const receipt = row.marketReceipt ||= { messagesByType: {}, marketUpdates: 0, betUpdates: 0, providerMarketUpdates: 0, providerBetUpdates: 0, staleBetUpdates: 0 };
          if (event.marketRecovery) {
            receipt.snapshotMarketUpdates = (receipt.snapshotMarketUpdates || 0) + (event.markets?.length || 0);
            receipt.lastMarketSnapshotAt = new Date(at).toISOString();
          }
          if (event.marketMessageType) {
          const type = String(event.marketMessageType);
          receipt.messagesByType[type] = (receipt.messagesByType[type] || 0) + 1;
          receipt.marketUpdates += event.markets?.length || 0;
          receipt.betUpdates += (event.markets || []).reduce((n, m) => n + (m.bets?.length || 0), 0);
          receipt.providerMarketUpdates += (event.markets || []).reduce((n, m) => n + (m.providerMarkets?.length || 0), 0);
          receipt.providerBetUpdates += (event.markets || []).reduce((n, m) => n + (m.providerMarkets || []).reduce((count, provider) => count + (provider.Bets?.length || 0), 0), 0);
          receipt.lastMarketMessageAt = new Date(Math.max(at, Date.parse(receipt.lastMarketMessageAt || '') || 0)).toISOString();
          }
        }
      }
      if (event.outrightScore) {
        if (!row.outrightScore || at >= row.outrightScore.at) {
          row.outrightScore = {value: {...row.outrightScore?.value, ...defined(event.outrightScore)}, at};
        } else this.metrics[lane].staleUpdatesIgnored++;
      }
      if (event.fixture) {
        const t = timestamp(event.fixture.lastUpdate, at);
        if (!row.fixture || t >= row.fixture.at)
          row.fixture = {
            value: { ...row.fixture?.value, ...defined(event.fixture) },
            at: t,
          };
        else this.metrics[lane].staleUpdatesIgnored++;
      }
      if (event.livescore && (!row.livescore || at >= row.livescore.at))
        row.livescore = {
          value: { ...row.livescore?.value, ...defined(event.livescore) },
          at,
        };
      else if (event.livescore) this.metrics[lane].staleUpdatesIgnored++;
      const settlementSource = event.marketRecovery ? "snapshot.outright.markets" : event.marketMessageType ? `amqp.${event.marketMessageType}` as const : undefined;
      if (settlementSource) for (const counts of event.settlementInspection?.counts || []) {
        const evidence = (row.settlementMarkets ||= new Map()).get(String(counts.marketId)) || {};
        evidence[settlementSource] = {...counts, receivedAt: new Date(at).toISOString()};
        row.settlementMarkets.set(String(counts.marketId), evidence);
      }
      const settlementFields = new Map((event.settlementInspection?.fields || []).map(f => [`${f.marketId}:${f.selectionId}`, f]));
      for (const market of event.markets || []) {
        if (market.id === undefined) {
          this.metrics[lane].marketsWithoutId++;
          continue;
        }
        const key = String(market.id);
        const old = row.markets.get(key);
        const marketTime = row.marketAt.get(key) || 0;
        const merged: Market =
          at >= marketTime ? { ...old, ...defined(market) } : { ...old };
        const bets = new Map((old?.bets || []).map((b) => [b.id, b]));
        for (const bet of market.bets || []) {
          const betKey = `${key}:${bet.id}`;
          const t = timestamp(bet.lastUpdate, at);
          const previousAt = row.betAt.get(betKey) || 0;
          const field = settlementFields.get(betKey);
          if (settlementSource && field) {
            const observation: import("@lsports/contracts").SettlementObservation = {
              source: settlementSource, receivedAt: new Date(at).toISOString(), versionAt: new Date(t).toISOString(),
              field: field.field, code: field.code, timestamp: field.timestamp,
              decision: field.field === "missing" ? "ignored_missing" : field.field === "null" ? "ignored_null" : t < previousAt ? "ignored_older" : "stored",
            };
            const trace = (row.settlementAudit ||= new Map()).get(betKey) || {};
            trace[settlementSource === "amqp.42" ? "last42" : settlementSource === "amqp.41" ? "last41" : "lastSnapshot"] = observation;
            if (field.field === "integer") trace.lastNumeric = observation;
            row.settlementAudit.set(betKey, trace);
          }
          const hasPrice = bet.price !== undefined && Number.isFinite(Number(bet.price)) && Number(bet.price) > 1;
          if (event.marketRecovery) {
            (row.snapshotBets ||= new Map()).set(betKey, {
              receivedAt: new Date(at).toISOString(), versionAt: new Date(t).toISOString(),
              receivedPrice: bet.price !== undefined && Number.isFinite(Number(bet.price)) ? Number(bet.price) : null,
              decision: t < previousAt ? "older_than_stored" : !hasPrice ? "missing_or_invalid_price" : "confirmed",
            });
          }
          if (t >= previousAt) {
            bets.set(bet.id, {
              ...bets.get(bet.id),
              ...defined(bet),
              // null/missing is absence of settlement, never an explicit correction.
              // A supplier correction to unsettled must carry numeric code 0.
              settlement: Number.isInteger(bet.settlement) ? bet.settlement : bets.get(bet.id)?.settlement,
            } as typeof bet);
            // A current snapshot explicitly reconfirms an unchanged quote. Its LastUpdate
            // describes the last price change, not when the snapshot was requested.
            // A status-only delta must never validate a price read from disk.
            if (row.restored && hasPrice && (event.marketRecovery || t > previousAt))
              (row.freshBets ||= new Set()).add(betKey);
            row.betAt.set(betKey, t);
          } else {
            this.metrics[lane].staleUpdatesIgnored++;
            if (row.marketReceipt) row.marketReceipt.staleBetUpdates++;
          }
        }
        merged.bets = [...bets.values()];
        row.markets.set(key, merged);
        row.marketAt.set(key, Math.max(at, marketTime));
      }
    }
  }
  replace(lane: Lane, events: TradeEvent[], at: number, audit?: SnapshotAudit) {
    this.metrics[lane].snapshot = audit;
    this.rows[lane] = new Map([...this.rows[lane]].filter(([, row]) => !!row.outright));
    this.apply(lane, events, at);
    this.set(lane, {
      lastSnapshotAt: new Date().toISOString(),
      snapshotEvents: events.length,
    });
  }
  feed(now = Date.now()): EventFeed {
    const ticketOutcomes: NonNullable<EventFeed["ticketOutcomes"]> = [];
    for (const lane of ["prematch", "inplay"] as const) {
      for (const [key, row] of this.rows[lane]) for (const market of row.markets.values()) {
        for (const bet of market.bets || []) {
          const at = row.betAt.get(`${market.id}:${bet.id}`);
          if (!Number.isInteger(bet.settlement) || at === undefined) continue;
          ticketOutcomes.push({eventId: `${lane}:${key}`, marketId: `${lane}:${key}:${market.id}`,
            selectionId: `${lane}:${key}:${market.id}:${bet.id}`, settlement: bet.settlement!, updatedAt: new Date(at).toISOString()});
        }
      }
    }
    const events: SportEvent[] = [];
    const observed = new Set<string>();
    const outrightDiagnostics: OutrightMarketDiagnostic[] = [];
    const diagnosticByKey = new Map<string, OutrightMarketDiagnostic>();
    for (const lane of ["prematch", "inplay"] as const) {
      for (const [key, row] of this.rows[lane]) {
        if (!row.outright) continue;
        const diagnostic: OutrightMarketDiagnostic = { lane, competitionId: row.outright.competitionId,
          fixtureId: Number(String(key).split(":").at(-1)), hasFixture: !!row.fixture,
          outrightScore: row.outrightScore ? {
            updatedAt: new Date(row.outrightScore.at).toISOString(), status: row.outrightScore.value.status ?? null,
            statusName: OutrightScoreStatus[row.outrightScore.value.status ?? -1] ?? "Unrecognized",
            participantResults: structuredClone(row.outrightScore.value.participantResults || []),
          } : undefined,
          restored: row.restored || undefined, participantCount: row.fixture?.value.participants?.length || 0,
          messagesByType: {}, marketUpdates: 0, betUpdates: 0, providerMarketUpdates: 0, providerBetUpdates: 0, staleBetUpdates: 0,
          ...structuredClone(row.marketReceipt),
          markets: [...row.markets.values()].map(m => ({
            settlementEvidence: row.settlementMarkets?.get(String(m.id)),
            id: m.id ?? null, name: m.name ?? null, status: m.status ?? null, statusLabel: marketStatusLabel(m.status),
            selections: (m.bets || []).map(b => {
              const participantName = b.participantId === undefined ? undefined : row.fixture?.value.participants?.find(p => p.id === b.participantId)?.name;
              const known = typeof b.settlement === "number" && Object.hasOwn(SettlementType, b.settlement);
              return { id: b.id, name: b.name ?? participantName ?? null,
                participantId: b.participantId ?? null, participantName: participantName ?? null,
                nameSource: b.name !== undefined ? "selection" as const : participantName !== undefined ? "participant" as const : "not_reported" as const,
                status: b.betStatusId ?? b.status ?? null, providerStatus: b.status ?? null, betStatusId: b.betStatusId ?? null,
                settlement: b.settlement ?? null, resultKnown: known,
                settlementTrace: row.settlementAudit?.get(`${m.id}:${b.id}`),
                quoteRecovery: {
                  awaitingFreshQuote: !!row.restored && !row.freshBets?.has(`${m.id}:${b.id}`),
                  snapshotSeen: !!row.snapshotBets?.has(`${m.id}:${b.id}`),
                  snapshot: row.snapshotBets?.get(`${m.id}:${b.id}`),
                },
                resultDescription: b.settlement == null ? "Liquidación no informada" : known ? settlementLabel(b.settlement) : "Código de liquidación desconocido" };
            }),
          })),
          storedMarkets: row.markets.size,
          storedSelections: [...row.markets.values()].reduce((n, m) => n + (m.bets?.length || 0), 0), selectableSelections: 0 };
        const winner = row.markets.get("160");
        if (winner) diagnostic.market160 = { status: winner.status,
          selections: winner.bets?.length || 0,
          pricedSelections: (winner.bets || []).filter((b) => Number.isFinite(Number(b.price)) && Number(b.price) > 1).length,
          selectableSelections: 0 };
        outrightDiagnostics.push(diagnostic);
        diagnosticByKey.set(`${lane}:${key}`, diagnostic);
      }
    }
    for (const lane of ["prematch", "inplay"] as const) {
      for (const [id, row] of this.rows[lane]) {
        const fixture = row.fixture?.value;
        if (!fixture) continue;
        const sport = classifySport(fixture.sport?.name);
        if (sport === "hipica") observed.add(lane);
        const score = row.livescore?.value.scoreboard;
        const status =
          (row.livescore && row.livescore.at >= (row.fixture?.at || 0)
            ? score?.status
            : undefined) ?? fixture.status;
        const available =
          this.connections[lane].phase === "connected" &&
          [1, 2, 9].includes(status ?? 0);
        const prefix = `${lane}:${id}`;
        const markets: EventMarket[] = [...row.markets.values()].map((m) => ({
          id: `${prefix}:${m.id}`,
          name: m.name || `Mercado ${m.id}`,
          status: m.status,
          selections: (m.bets || []).map((b) => {
            const unavailableReasons = [
              ...(this.connections[lane].phase !== "connected" ? ["feed_disconnected"] : []),
              ...(![1, 2, 9].includes(status ?? 0) ? ["event_inactive"] : []),
              ...(m.status !== 1 ? [m.status === 3 ? "market_settled" : "market_not_open"] : []),
              ...((b.betStatusId ?? b.status) !== 1 ? ["selection_not_open"] : []),
              ...(b.settlement !== undefined && b.settlement !== 0 ? ["selection_settled"] : []),
              ...(!(Number(b.price) > 1 && Number.isFinite(Number(b.price))) ? ["invalid_price"] : []),
              ...(row.restored && !row.freshBets?.has(`${m.id}:${b.id}`) ? ["awaiting_update"] : []),
            ];
            return ({
            id: `${prefix}:${m.id}:${b.id}`,
            label: `${b.name || (row.outright && b.participantId !== undefined ? fixture.participants?.find((p) => p.id === b.participantId)?.name : undefined) || "Selección"}${b.line ? ` (${b.line})` : ""}`,
            line: b.line,
            participantId: b.participantId,
            settlement: b.settlement,
            settlementLabel: b.settlement === undefined ? undefined : settlementLabel(b.settlement),
            unavailableReasons,
            odds: Number(b.price) || 0,
            status: b.betStatusId ?? b.status,
            available: unavailableReasons.length === 0,
          }); }),
        }));
        const marketDiagnostic = diagnosticByKey.get(prefix);
        if (marketDiagnostic) {
          for (const diagnosticMarket of marketDiagnostic.markets || []) {
            const published = markets.find(m => m.id === `${prefix}:${diagnosticMarket.id}`);
            for (const diagnosticSelection of diagnosticMarket.selections) {
              const selection = published?.selections.find(s => s.id === `${prefix}:${diagnosticMarket.id}:${diagnosticSelection.id}`);
              if (selection) Object.assign(diagnosticSelection, {odds: selection.odds, available: selection.available,
                unavailableReasons: selection.unavailableReasons});
            }
          }
          marketDiagnostic.fixtureStatus = status;
          marketDiagnostic.fixtureStatusLabel = statusLabels[status ?? 0] || "Estado desconocido";
          marketDiagnostic.selectableSelections = markets.reduce((n, m) => n + m.selections.filter((s) => s.available).length, 0);
          const winner = markets.find((m) => m.id === `${prefix}:160`);
          if (winner) marketDiagnostic.market160 = { status: winner.status, statusLabel: marketStatusLabel(winner.status),
            selectionStatusCounts: winner.selections.reduce<Record<string, number>>((counts, s) => { const key = s.status === undefined ? "unknown" : String(s.status); counts[key] = (counts[key] || 0) + 1; return counts; }, {}),
            settlementCounts: winner.selections.reduce<Record<string, number>>((counts, s) => { const key = s.settlement === undefined ? "unknown" : String(s.settlement); counts[key] = (counts[key] || 0) + 1; return counts; }, {}),
            blockedReasonCounts: winner.selections.reduce<Record<string, number>>((counts, s) => { for (const reason of s.unavailableReasons || []) counts[reason] = (counts[reason] || 0) + 1; return counts; }, {}),
            selections: winner.selections.length,
            pricedSelections: winner.selections.filter((s) => s.odds > 1 && Number.isFinite(s.odds)).length,
            selectableSelections: winner.selections.filter((s) => s.available).length };
        }
        const primary =
          markets.find((m) => m.selections.some((s) => s.available)) ||
          markets[0];
        const participants = [...(fixture.participants || [])].sort(
          (a, b) => Number(a.position || 0) - Number(b.position || 0),
        );
        const start = fixture.startDate ? new Date(fixture.startDate) : null;
        events.push({
          id: prefix,
          sport,
          source: lane,
          marketDiagnostic,
          outrightScore: marketDiagnostic?.outrightScore,
          restored: row.restored || undefined,
          kind: row.outright ? "outright" : "fixture",
          competition: row.outright ? { id: row.outright.competitionId, name: row.outright.competitionName, type: row.outright.competitionType } : undefined,
          participants: structuredClone(participants),
          status,
          statusLabel: statusLabels[status ?? 0] || "Estado desconocido",
          available,
          league:
            [fixture.location?.name, fixture.league?.name || row.outright?.competitionName]
              .filter(Boolean)
              .join(" · ") || "Competición sin nombre",
          home: row.outright ? fixture.fixtureName || `Evento ${id}` : participants[0]?.name || fixture.fixtureName || `Evento ${id}`,
          away:
            (row.outright ? `${participants.length} participantes` : participants[1]?.name) ||
            (sport === "hipica" ? `${participants.length} participantes` : ""),
          time:
            start && Number.isFinite(+start)
              ? new Intl.DateTimeFormat("es-AR", {
                  timeZone: "America/Argentina/Buenos_Aires",
                  day: "2-digit",
                  month: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                }).format(start) + " ART"
              : "Horario no informado",
          live: status === 2,
          score: score?.results?.map((r) => r.value).join(" : "),
          market: primary?.name || "Sin mercados disponibles",
          selections: primary?.selections || [],
          markets,
          updatedAt: new Date(
            Math.max(
              row.fixture?.at || 0,
              row.livescore?.at || 0,
              ...row.marketAt.values(),
            ),
          ).toISOString(),
        });
      }
    }
    // Prefer InPlay when a fixture exists in both packages; never merge their prices.
    const inplayIds = new Set(
      events
        .filter((e) => e.source === "inplay" && e.live)
        .map((e) => e.id.substring(e.id.indexOf(":") + 1)),
    );
    const visible = events.filter(
      (e) => !(e.source === "prematch" && inplayIds.has(e.id.substring(e.id.indexOf(":") + 1))),
    );
    const coverage = {} as Record<Lane, CoverageStats>;
    for (const lane of ["prematch", "inplay"] as const) {
      const published = visible.filter((e) => e.source === lane);
      coverage[lane] = {
        ...structuredClone(this.metrics[lane]),
        outrightMarketRowsWithoutFixture: [...this.rows[lane].values()].filter((r) => r.outright && r.marketReceipt && !r.fixture).length,
        rowsStored: this.rows[lane].size,
        rowsWithoutFixture: [...this.rows[lane].values()].filter(
          (r) => !r.fixture,
        ).length,
        rowsPublished: published.length,
        rowsHiddenAsDuplicate:
          events.filter((e) => e.source === lane).length - published.length,
        eventsWithMarkets: published.filter((e) => e.markets?.length).length,
        eventsWithSelections: published.filter((e) =>
          e.markets?.some((m) => m.selections.length),
        ).length,
        eventsWithSelectableOdds: published.filter((e) =>
          e.markets?.some((m) => m.selections.some((s) => s.available)),
        ).length,
      };
    }
    const phases = Object.values(this.connections).map((c) => c.phase);
    const health = phases.every((p) => p === "connected") && !Object.values(this.connections).some(c => ["partial", "rate_limited"].includes(c.outrightRecovery?.status || "") || c.diagnostic?.category === "rate_limited")
      ? "ok"
      : phases.some((p) => p === "connected")
        ? "degraded"
        : "unavailable";
    const checked = Object.values(this.connections).every(
      (c) => !!c.lastSnapshotAt,
    );
    return {
      mode: "connected",
      health,
      notice:
        health === "ok"
          ? "LSports TRADE · Test · Billete de simulación, sin dinero real."
          : "Integración con fallas o en recuperación. Las cuotas afectadas están bloqueadas.",
      updatedAt: new Date(now).toISOString(),
      connections: structuredClone(this.connections),
      events: visible,
      ticketOutcomes,
      coverage,
      outrightDiagnostics,
      horseRacing: {
        status: observed.size
          ? "observed"
          : checked
            ? "not_observed"
            : "unknown",
        message: observed.size
          ? "Se observaron eventos de Hípica en el paquete."
          : checked
            ? "Sin eventos de Hípica en los snapshots consultados. Esto no confirma ni descarta la habilitación del paquete."
            : "Hípica: disponibilidad pendiente de consulta autenticada.",
      },
    };
  }
}
