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
import type { Fixture, Livescore, Market, OutrightFixtureEvent } from "trade360-nodejs-sdk";
export interface TradeEvent {
  fixtureId: number;
  outright?: { competitionId: number; competitionName?: string; competitionType?: number; fixture?: NonNullable<OutrightFixtureEvent["outrightFixture"]> };
  fixture?: Fixture;
  livescore?: Livescore;
  markets?: Market[];
  marketMessageType?: 41 | 42;
  marketRecovery?: boolean;
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
  markets: Map<string, Market>;
  marketAt: Map<string, number>;
  betAt: Map<string, number>;
  freshBets?: Set<string>;
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
          if (t >= (row.betAt.get(betKey) || 0)) {
            bets.set(bet.id, {
              ...bets.get(bet.id),
              ...defined(bet),
            } as typeof bet);
            if (row.restored && t > (row.betAt.get(betKey) || 0)) (row.freshBets ||= new Set()).add(betKey);
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
    const events: SportEvent[] = [];
    const observed = new Set<string>();
    const outrightDiagnostics: OutrightMarketDiagnostic[] = [];
    const diagnosticByKey = new Map<string, OutrightMarketDiagnostic>();
    for (const lane of ["prematch", "inplay"] as const) {
      for (const [key, row] of this.rows[lane]) {
        if (!row.outright) continue;
        const diagnostic: OutrightMarketDiagnostic = { lane, competitionId: row.outright.competitionId,
          fixtureId: Number(String(key).split(":").at(-1)), hasFixture: !!row.fixture,
          restored: row.restored || undefined, participantCount: row.fixture?.value.participants?.length || 0,
          messagesByType: {}, marketUpdates: 0, betUpdates: 0, providerMarketUpdates: 0, providerBetUpdates: 0, staleBetUpdates: 0,
          ...structuredClone(row.marketReceipt),
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
