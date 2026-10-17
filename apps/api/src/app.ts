import { explainOpenEventExclusions } from "./open-event-diagnostics.js";
import express from "express";
import { demoSource } from "@lsports/demo";
import { dataMode, readConnectedFeed } from "@lsports/feed-store";
import type { EventSource } from "@lsports/contracts";
export function createApp(source?: EventSource) {
  const mode = dataMode();
  const feed =
    source ||
    (mode === "connected"
      ? { getEvents: () => readConnectedFeed() }
      : demoSource);
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.get("/api/health", async (_req, res) => {
    const data = await feed.getEvents();
    res.status(data.health === "unavailable" ? 503 : 200).json({
      status: data.health || "ok",
      mode: data.mode,
      connections: data.connections,
      apiEventCount: data.events.length,
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
  app.get("/api/events", async (_req, res) => res.json(await feed.getEvents()));
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Ruta no encontrada" }),
  );
  return app;
}
