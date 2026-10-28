import { platformRoutes } from "./platform-routes.js";
import { platformEnabled, type PlatformStore } from "@lsports/feed-store/platform";
import { ticketRoutes } from "./ticket-routes.js";
import type { TicketStore } from "@lsports/feed-store/tickets";
import { explainOpenEventExclusions } from "./open-event-diagnostics.js";
import express from "express";
import { demoSource } from "@lsports/demo";
import { dataMode, readConnectedFeed, IndexedFeedStore, indexedFeedPath, statePath, unavailable } from "@lsports/feed-store";
import type { EventSource } from "@lsports/contracts";
export function createApp(source?: EventSource, options: {ticketStore?: TicketStore; platformStore?: PlatformStore; platform?: boolean; publicOrigin?: string} = {}) {
  const mode = dataMode();
  let feed =
    source ||
    (mode === "connected"
      ? { getEvents: () => readConnectedFeed() }
      : demoSource);
  let indexed: IndexedFeedStore | undefined;
  if (!source && mode === "connected") {
    try { indexed = new IndexedFeedStore(indexedFeedPath(statePath()), true); } catch { /* Worker has not committed its first index yet. */ }
    feed = {
      getEvents: () => readConnectedFeed(),
      getEventsPage: async input => {
        try {
          if (!indexed) indexed = new IndexedFeedStore(indexedFeedPath(statePath()), true);
          const page = indexed.page({ ...input, filter: { lane: input.lane, sport: input.sport, competitionId: input.competitionId, eventId: input.eventId, marketId: input.marketId }, scope: input.scope, now: Date.now() });
          return page;
        } catch (error) {
          if (error instanceof Error && error.message === "INDEX_CURSOR_STALE") throw error;
          return { feed: unavailable("Índice de cuotas no disponible; selección bloqueada."), events: [], page: { revision: 0, limit: input.limit || 100, hasMore: false } };
        }
      },
      getEventsByIds: async input => {
        try {
          if (!indexed) indexed = new IndexedFeedStore(indexedFeedPath(statePath()), true);
          return indexed.eventsByIds(input.ids,input.scope,Date.now());
        } catch { return unavailable("Índice de cuotas no disponible; selección bloqueada."); }
      },
      getFeedSummary: async () => {
        try {
          if (!indexed) indexed = new IndexedFeedStore(indexedFeedPath(statePath()), true);
          const summary = indexed.summary();
          const age=Date.now()-Date.parse(summary.metadata.updatedAt||'');
          const metadata=!Number.isFinite(age)||age< -5000||age>20000?unavailable("Worker sin señal reciente. No se muestran cuotas almacenadas."):summary.metadata;
          return { metadata, counts: summary.counts, revision: summary.revision };
        } catch { return { metadata: unavailable("Índice de cuotas no disponible; selección bloqueada."), counts: [], revision: 0 }; }
      },
    };
  }
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  if (options.platform ?? platformEnabled()) {
    const control = platformRoutes(feed, options.platformStore, options.publicOrigin);
    app.use(control.router);
    app.locals.closeTickets = control.close;
    return app;
  }
  app.get("/api/health", async (_req, res) => {
    const summary = await feed.getFeedSummary?.();
    const data = summary ? { ...summary.metadata, events: [] } : await feed.getEvents();
    res.status(data.health === "unavailable" ? 503 : 200).json({
      status: data.health || "ok",
      mode: data.mode,
      connections: data.connections,
      apiEventCount: summary ? summary.counts.reduce((total, lane) => total + lane.events, 0) : data.events.length,
      coverage: data.coverage,
      outrightDiagnostics: data.outrightDiagnostics,
      horseRacing: data.horseRacing,
    });
  });
  app.get("/api/diagnostics/outright/:fixtureId", async (req, res) => {
    const fixtureId = Number(req.params.fixtureId);
    if (!/^\d+$/.test(req.params.fixtureId) || !Number.isSafeInteger(fixtureId) || fixtureId <= 0) {
      res.status(400).json({ error: "Fixture ID inválido" });
      return;
    }
    const data = await feed.getEvents();
    const matches = (data.outrightDiagnostics || []).filter((entry) => entry.fixtureId === fixtureId);
    res.json({ mode: data.mode, health: data.health, updatedAt: data.updatedAt,
      observation: matches.length ? "observed" : "not_observed_in_current_projection",
      matches, connections: data.connections,
    });
  });
  // Local projection only: this route never calls the supplier or changes subscriptions.
  app.get("/api/diagnostics/open-events", async (req, res) => {
    const sport = req.query.sport ?? "hipica";
    if (typeof sport !== "string" || !["hipica", "futbol", "tenis", "basquet", "otros", "all"].includes(sport)) {
      res.status(400).json({ error: "Deporte inválido" }); return;
    }
    const data = await feed.getEvents();
    const connected = data.mode === "connected";
    const events = connected ? data.events.filter(e => sport === "all" || e.sport === sport) : [];
    const candidates = events.flatMap(event => {
      if (event.available !== true || ![1, 2, 9].includes(event.status ?? 0)) return [];
      const markets = (event.markets || []).filter(m => m.status === 1).map(m => ({ ...m,
        selections: m.selections.filter(s => s.available === true && Number.isFinite(s.odds) && s.odds > 1),
      })).filter(m => m.selections.length > 0);
      return markets.length ? [{ eventId: event.id, fixtureId: Number(event.id.split(":").at(-1)),
        competitionId: event.competition?.id, source: event.source, sport: event.sport,
        title: [event.home, event.away].filter(Boolean).join(" · "), status: event.status,
        statusLabel: event.statusLabel, time: event.time, live: event.live, markets }] : [];
    });
    res.json({ mode: data.mode, health: data.health, updatedAt: data.updatedAt,
      observation: !connected ? "connected_feed_required" : candidates.length ? "candidates_available" : "no_selectable_events_in_current_projection",
      observedEvents: events.length, candidates, connections: data.connections,
      exclusions: explainOpenEventExclusions(events, new Set(candidates.map(candidate => candidate.eventId))),
    });
  });
  const tickets = ticketRoutes(feed, options.ticketStore);
  app.locals.closeTickets = tickets.close;
  app.locals.closeIndexedFeed = () => indexed?.close();
  app.use("/api", tickets.router);
  app.get("/api/events", async (req, res) => {
    if (!feed.getEventsPage) { res.json(await feed.getEvents()); return; }
    try {
      const page = await feed.getEventsPage({ limit: Number(req.query.limit) || 100, cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
        lane: req.query.lane === "prematch" || req.query.lane === "inplay" ? req.query.lane : undefined,
        sport: typeof req.query.sport === "string" ? req.query.sport as import('@lsports/contracts').Sport : undefined,
        eventId: typeof req.query.eventId === "string" ? req.query.eventId : undefined,
        marketId: typeof req.query.marketId === "string" ? req.query.marketId : undefined,
        scope: `public:lane=${String(req.query.lane||'')}:sport=${String(req.query.sport||'')}:event=${String(req.query.eventId||'')}:market=${String(req.query.marketId||'')}` });
      res.json({ ...page.feed, events: page.events, page: page.page });
    } catch (error) { res.status(error instanceof Error && error.message === "INDEX_CURSOR_STALE" ? 409 : error instanceof Error && error.message === "INDEX_EVENT_EXCEEDS_PAGE_LIMIT" ? 413 : 400).json({ error: "Página vencida, inválida o superior al tamaño seguro; afiná el filtro y volvé a consultar." }); }
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Ruta no encontrada" }),
  );
  return app;
}
