import type {
  ConnectionState,
  EventFeed,
  EventMarket,
  Lane,
  Sport,
  SportEvent,
} from "@lsports/contracts";
import type { Fixture, Livescore, Market } from "trade360-nodejs-sdk";
export interface TradeEvent {
  fixtureId: number;
  fixture?: Fixture;
  livescore?: Livescore;
  markets?: Market[];
}
interface Versioned<T> {
  value: T;
  at: number;
}
interface Row {
  fixture?: Versioned<Fixture>;
  livescore?: Versioned<Livescore>;
  markets: Map<string, Market>;
  marketAt: Map<string, number>;
  betAt: Map<string, number>;
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
  rows: Record<Lane, Map<number, Row>> = {
    prematch: new Map(),
    inplay: new Map(),
  };
  connections: Record<Lane, ConnectionState> = {
    prematch: { phase: "starting", message: "Esperando conexión PreMatch" },
    inplay: { phase: "starting", message: "Esperando conexión InPlay" },
  };
  set(lane: Lane, patch: Partial<ConnectionState>) {
    Object.assign(this.connections[lane], patch);
  }
  apply(lane: Lane, events: TradeEvent[], at: number) {
    for (const event of events) {
      if (!Number.isSafeInteger(event.fixtureId) || event.fixtureId <= 0)
        throw new Error("Invalid provider fixture ID");
      let row = this.rows[lane].get(event.fixtureId);
      if (!row) {
        row = { markets: new Map(), marketAt: new Map(), betAt: new Map() };
        this.rows[lane].set(event.fixtureId, row);
      }
      if (event.fixture) {
        const t = timestamp(event.fixture.lastUpdate, at);
        if (!row.fixture || t >= row.fixture.at)
          row.fixture = {
            value: { ...row.fixture?.value, ...defined(event.fixture) },
            at: t,
          };
      }
      if (event.livescore && (!row.livescore || at >= row.livescore.at))
        row.livescore = {
          value: { ...row.livescore?.value, ...defined(event.livescore) },
          at,
        };
      for (const market of event.markets || []) {
        if (market.id === undefined) continue;
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
            row.betAt.set(betKey, t);
          }
        }
        merged.bets = [...bets.values()];
        row.markets.set(key, merged);
        row.marketAt.set(key, Math.max(at, marketTime));
      }
    }
  }
  replace(lane: Lane, events: TradeEvent[], at: number) {
    this.rows[lane] = new Map();
    this.apply(lane, events, at);
    this.set(lane, {
      lastSnapshotAt: new Date().toISOString(),
      snapshotEvents: events.length,
    });
  }
  feed(now = Date.now()): EventFeed {
    const events: SportEvent[] = [];
    const observed = new Set<string>();
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
          selections: (m.bets || []).map((b) => ({
            id: `${prefix}:${m.id}:${b.id}`,
            label: `${b.name || "Selección"}${b.line ? ` (${b.line})` : ""}`,
            line: b.line,
            odds: Number(b.price) || 0,
            status: b.betStatusId ?? b.status,
            available:
              available &&
              m.status === 1 &&
              (b.settlement === undefined || b.settlement === 0) &&
              (b.betStatusId ?? b.status) === 1 &&
              Number(b.price) > 1 &&
              Number.isFinite(Number(b.price)),
          })),
        }));
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
          status,
          statusLabel: statusLabels[status ?? 0] || "Estado desconocido",
          available,
          league:
            [fixture.location?.name, fixture.league?.name]
              .filter(Boolean)
              .join(" · ") || "Competición sin nombre",
          home: participants[0]?.name || fixture.fixtureName || `Evento ${id}`,
          away:
            participants[1]?.name ||
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
        .map((e) => e.id.split(":")[1]),
    );
    const phases = Object.values(this.connections).map((c) => c.phase);
    const health = phases.every((p) => p === "connected")
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
      events: events.filter(
        (e) => !(e.source === "prematch" && inplayIds.has(e.id.split(":")[1])),
      ),
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
