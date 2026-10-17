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
      horseRacing: data.horseRacing,
    });
  });
  app.get("/api/events", async (_req, res) => res.json(await feed.getEvents()));
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Ruta no encontrada" }),
  );
  return app;
}
