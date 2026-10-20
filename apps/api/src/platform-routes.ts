import { feedEvidence } from "./feed-evidence.js";
import { walletReadiness, assertSimulation } from "./wallet-port.js";
import express from "express";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "@lsports/feed-store";
import {
  PlatformStore,
  PlatformError,
  digest,
  text,
  assertBinding,
  integrationChannel,
} from "@lsports/feed-store/platform";
import { TenantTickets } from "@lsports/feed-store/tenant-tickets";
import { TicketError } from "@lsports/feed-store/tickets";
import { MoneyError, type EventSource } from "@lsports/contracts";
import { receipt } from "./ticket-routes.js";
export function platformRoutes(
  source: EventSource,
  supplied?: PlatformStore,
  configuredOrigin = process.env.PLATFORM_PUBLIC_ORIGIN ||
    "http://localhost:3001",
) {
  const platform = supplied || new PlatformStore();
  const tickets = new TenantTickets(platform);
  const router = express.Router();
  const publicOrigin = new URL(configuredOrigin).origin;
  if (publicOrigin !== configuredOrigin)
    throw new Error("PLATFORM_PUBLIC_ORIGIN must be an exact origin");
  const secure = new URL(publicOrigin).protocol === "https:";
  if (
    !secure &&
    !["localhost", "127.0.0.1", "[::1]"].includes(
      new URL(publicOrigin).hostname,
    )
  )
    throw new Error("PLATFORM_PUBLIC_ORIGIN requires HTTPS");
  router.use(express.json({ limit: "32kb" }));
  const sameOrigin = (req: express.Request) => {
    if (req.get("Origin") !== publicOrigin)
      throw new PlatformError("ORIGIN_REJECTED", "Origen no autorizado.", 403);
  };
  const cookie = (req: express.Request) => {
    const entry = (req.get("Cookie") || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("adl_admin="));
    const value = entry?.slice("adl_admin=".length) || "";
    return /^[a-zA-Z0-9_-]{43}$/.test(value) ? value : "";
  };
  const admin = (req: express.Request, write = false) => {
    const value = cookie(req);
    const session = platform.session(value);
    if (!session)
      throw new PlatformError(
        "AUTH_REQUIRED",
        "Iniciá sesión para continuar.",
        401,
      );
    if (write) {
      sameOrigin(req);
      if (digest(req.get("X-CSRF-Token") || "") !== session.csrfHash)
        throw new PlatformError(
          "CSRF_REJECTED",
          "Actualizá la sesión y reintentá.",
          403,
        );
    }
    return session.admin;
  };
  const body = (req: express.Request): Record<string, unknown> => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
      throw new PlatformError("INVALID_JSON", "Ingresá un objeto JSON.");
    return req.body;
  };
  const auth = (req: express.Request) => {
    const bearer = req.get("Authorization") || "";
    const parsed = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(bearer);
    if (!parsed || bearer.length > 250)
      throw new PlatformError(
        "AUTH_REQUIRED",
        "Credencial o sesión requerida.",
        401,
      );
    const value = parsed[1];
    if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value))
      throw new PlatformError(
        "CREDENTIAL_ID_NOT_SECRET",
        "El ID no es el secreto. Usá el contenido completo del archivo .key vigente desde tu backend.",
        401,
      );
    const access = platform.integration(value);
    if (!access)
      throw new PlatformError(
        "AUTH_REQUIRED",
        "Credencial revocada, sesión inválida o vencida.",
        401,
      );
    const client = platform.client(access.clientId);
    if (!client)
      throw new PlatformError("AUTH_REQUIRED", "Cliente no disponible.", 401);
    const operation = platform.operation(access.operationId);
    if (
      !operation ||
      operation.clientId !== client.id ||
      operation.currency !== access.currency
    )
      throw new PlatformError("AUTH_REQUIRED", "Ámbito inválido.", 401);
    assertBinding(access, {
      ...req.query,
      ...(req.body && typeof req.body === "object" ? req.body : {}),
    });
    return { ...access, client, operation };
  };
  const player = (req: express.Request, access: ReturnType<typeof auth>) => {
    const input = req.method === "POST" ? body(req) : req.query;
    if (access.kind === "iframe") {
      if (input.playerId !== undefined && input.playerId !== access.playerId)
        throw new PlatformError(
          "PLAYER_MISMATCH",
          "El jugador no coincide con la sesión.",
          403,
        );
      return access.playerId!;
    }
    return text(input.playerId, "playerId", 120);
  };
  const assertAccepting = (access: ReturnType<typeof auth>) => {
    if (
      access.client.status !== "active" ||
      !access.client.settings.acceptingTickets ||
      access.operation.status !== "active" ||
      !access.operation.acceptingTickets
    )
      throw new PlatformError(
        "ACCEPTANCE_PAUSED",
        "Nuevos billetes suspendidos. Los resultados pendientes siguen procesándose.",
        409,
      );
  };
  // Read-only platform views are available before a casino/operation is configured.
  // Explicit platform permission; no credentials, writes, snapshots or provider calls.
  router.get("/api/control/feed-overview", async (req,res)=>{
    if(admin(req).role!=="platform_admin")throw new PlatformError("FORBIDDEN","Vista global reservada a la plataforma.",403);
    const feed=await source.getEvents(),report=feedEvidence(feed);
    res.json({readOnly:true,events:feed.events.length,selectableSelections:report.events.filter(e=>e.available===true).reduce((n,e)=>n+e.selectableSelections,0),lanes:report.lanes});
  });
  router.get("/api/control/feed-preview", async (req,res)=>{
    if(admin(req).role!=="platform_admin")throw new PlatformError("FORBIDDEN","Vista global reservada a la plataforma.",403);
    const feed=await source.getEvents();
    res.json({...feed,readOnly:true,notice:"Vista administrativa de solo lectura. Sin admisión de billetes. "+(feed.notice||"")});
  });
  router.get("/api/control/status", (_req, res) =>
    res.json({
      enabled: true,
      initialized: platform.hasPlatformAdmin(),
      financialMode: "simulation",
    }),
  );
  router.post("/api/control/login", async (req, res) => {
    sameOrigin(req);
    const input = body(req);
    const session = await platform.login(
      input.email,
      input.password,
      req.socket.remoteAddress || "unknown",
    );
    res.cookie("adl_admin", session.value, {
      httpOnly: true,
      secure,
      sameSite: "strict",
      path: "/api/control",
      maxAge: 8 * 3600000,
    });
    res.json({ admin: session.admin, csrf: session.csrf,expiresAt:session.expiresAt,syncId:session.syncId,serverNow:session.serverNow });
  });
  router.get("/api/control/session", (req, res) => {
    const current = admin(req);
    const info=platform.session(cookie(req))!;
    res.json({ admin: current, csrf: digest(`csrf:${cookie(req)}`),expiresAt:info.expiresAt,syncId:info.syncId,serverNow:info.serverNow });
  });
  router.post("/api/control/activity", (req,res)=>{
    admin(req,true); // explicit interaction endpoint, same origin + CSRF; GET/polls never touch.
    const info=platform.recordSessionActivity(cookie(req));
    res.json({expiresAt:info.expiresAt,syncId:info.syncId,serverNow:info.serverNow});
  });
  router.post("/api/control/logout", (req, res) => {
    const current = admin(req, true);
    platform.logout(cookie(req), current);
    res.clearCookie("adl_admin", {
      path: "/api/control",
      httpOnly: true,
      secure,
      sameSite: "strict",
    });
    res.json({ ok: true });
  });
  router.get("/api/control/clients", (req, res) =>
    res.json({ clients: platform.clients(admin(req)) }),
  );
  router.post("/api/control/clients", async (req, res) =>
    res
      .status(201)
      .json(await platform.createClient(admin(req, true), body(req))),
  );
  router.patch("/api/control/clients/:id", (req, res) =>
    res.json(platform.updateClient(admin(req, true), req.params.id, body(req))),
  );
  router.get("/api/control/clients/:id/operations", (req, res) =>
    res.json({
      operations: platform.operations(admin(req), req.params.id).map((op) => ({
        ...op,
        effectiveLimits: platform.effectiveOperationLimits(op.id),
      })),
    }),
  );
  router.post("/api/control/clients/:id/operations", (req, res) =>
    res
      .status(201)
      .json(
        platform.createOperation(admin(req, true), req.params.id, body(req)),
      ),
  );
  router.patch("/api/control/clients/:id/operations/:operationId", (req, res) =>
    res.json(
      platform.updateOperation(
        admin(req, true),
        req.params.id,
        req.params.operationId,
        body(req),
      ),
    ),
  );
  router.get("/api/control/clients/:id/limit-policies", (req, res) =>
    res.json({ policies: platform.limitPolicies(admin(req), req.params.id) }),
  );
  router.patch(
    "/api/control/clients/:id/limit-policies/:currency",
    (req, res) =>
      res.json(
        platform.updateLimitPolicy(
          admin(req, true),
          req.params.id,
          req.params.currency,
          body(req),
        ),
      ),
  );

  router.post("/api/control/password", async (req, res) => {
    const actor = admin(req, true),
      input = body(req);
    if(typeof input.confirmPassword!=="string" || input.confirmPassword!==input.newPassword)throw new PlatformError("PASSWORD_CONFIRMATION","La nueva contraseña y su confirmación no coinciden.",400);
    await platform.changePassword(
      actor,
      input.currentPassword,
      input.newPassword,
    );
    res.clearCookie("adl_admin", {
      path: "/api/control",
      httpOnly: true,
      secure,
      sameSite: "strict",
    });
    res.json({ ok: true });
  });
  router.post("/api/control/clients/:id/access", async (req, res) => {
    await platform.resetClientAccess(
      admin(req, true),
      req.params.id,
      body(req).newPassword,
    );
    res.json({ ok: true });
  });
  const opPath = "/api/control/clients/:id/operations/:operationId";
  router.get(`${opPath}/terminals`, (req, res) =>
    res.json({
      terminals: platform.terminals(
        admin(req),
        req.params.id,
        req.params.operationId,
      ),
    }),
  );
  router.post(`${opPath}/terminals`, (req, res) =>
    res
      .status(201)
      .json(
        platform.saveTerminal(
          admin(req, true),
          req.params.id,
          req.params.operationId,
          body(req),
        ),
      ),
  );
  router.post(`${opPath}/preview`, (req, res) => {
    const actor = admin(req, true);
    assertSimulation(body(req));
    const session = platform.preview(
      actor,
      req.params.id,
      req.params.operationId,
      publicOrigin,
      body(req),
    );
    res
      .status(201)
      .json({
        iframeUrl: `${publicOrigin}/embed/${session.clientId}/${session.operationId}/sportsbook#code=${session.code}`,
        expiresIn: session.expiresIn,
        financialMode: "simulation",
      });
  });
  router.get(`${opPath}/tickets`, (req, res) => {
    const op = platform.authorizeOperation(
      admin(req),
      req.params.id,
      req.params.operationId,
    );
    const offset = Number(req.query.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
      throw new PlatformError("INVALID_OFFSET", "Página inválida.");
    if (
      req.query.q !== undefined &&
      (typeof req.query.q !== "string" || req.query.q.length > 120)
    )
      throw new PlatformError("INVALID_SEARCH", "Búsqueda inválida.");
    res.json(
      tickets
        .store(op.id)
        .list(undefined, offset, 30, String(req.query.q || "")),
    );
  });
  router.get(`${opPath}/tickets/:ticketId`, (req, res) => {
    const op = platform.authorizeOperation(
        admin(req),
        req.params.id,
        req.params.operationId,
      ),
      ticket = tickets.store(op.id).get(req.params.ticketId);
    if (!ticket)
      throw new PlatformError("NOT_FOUND", "Billete no encontrado.", 404);
    res.json(ticket);
  });

  router.get(`${opPath}/credentials`, (req, res) =>
    res.json({
      credentials: platform.credentials(
        admin(req),
        req.params.id,
        req.params.operationId,
      ),
    }),
  );
  router.post(`${opPath}/credentials`, (req, res) =>
    res
      .status(201)
      .json(
        platform.issueCredential(
          admin(req, true),
          req.params.id,
          req.params.operationId,
          body(req).name,
        ),
      ),
  );
  router.post(`${opPath}/credentials/:key/rotate`, (req, res) =>
    res
      .status(201)
      .json(
        platform.issueCredential(
          admin(req, true),
          req.params.id,
          req.params.operationId,
          body(req).name,
          req.params.key,
        ),
      ),
  );
  router.post(`${opPath}/credentials/:key/revoke`, (req, res) => {
    platform.revokeCredential(
      admin(req, true),
      req.params.id,
      req.params.operationId,
      req.params.key,
    );
    res.json({ ok: true });
  });
  router.get("/api/control/audit", (req, res) => {
    const actor = admin(req),
      clientId =
        typeof req.query.clientId === "string" ? req.query.clientId : undefined;
    const entries = platform.auditEntries(actor, clientId);
    const risk = platform
      .allOperationIds()
      .map((id) => platform.operation(id)!)
      .filter((op) => !clientId || op.clientId === clientId)
      .flatMap((op) =>
        tickets
          .store(op.id)
          .risk.auditEntries()
          .map((row) => ({
            id: `risk:${op.id}:${row.id}`,
            at: String(row.at),
            actor: String(row.actor),
            client_id: op.clientId,
            action: String(row.action),
            details: { operationId: op.id, currency: op.currency, ...row.body },
          })),
      );
    res.json({
      entries: [...entries, ...risk]
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))
        .slice(0, 100),
    });
  });
  router.get(`${opPath}/risk`, async (req, res) => {
    const op = platform.authorizeOperation(
        admin(req),
        req.params.id,
        req.params.operationId,
      ),
      store = tickets.store(op.id);
    store.reconcile(await source.getEvents());
    res.json(store.risk.dashboard(req.query));
  });
  router.put(`${opPath}/risk/config`, (req, res) => {
    const actor = admin(req, true),
      op = platform.authorizeOperation(
        actor,
        req.params.id,
        req.params.operationId,
      );
    res.json(tickets.store(op.id).risk.configure(actor, body(req)));
  });
  router.post(`${opPath}/risk/suspensions`, (req, res) => {
    const actor = admin(req, true),
      op = platform.authorizeOperation(
        actor,
        req.params.id,
        req.params.operationId,
      );
    res.json(tickets.store(op.id).risk.suspend(actor, body(req)));
  });
  router.patch(`${opPath}/risk/alerts/:alertId`, (req, res) => {
    const actor = admin(req, true),
      op = platform.authorizeOperation(
        actor,
        req.params.id,
        req.params.operationId,
      );
    tickets.store(op.id).risk.updateAlert(actor, req.params.alertId, body(req));
    res.json({ ok: true });
  });
  router.get("/api/control/risk", async (req, res) => {
    const actor = admin(req);
    platform.authorize(actor);
    const feed = await source.getEvents();
    const operations = platform
      .allOperationIds()
      .filter((id) => !req.query.operationId || req.query.operationId === id)
      .map((id) => {
        const store = tickets.store(id);
        store.reconcile(feed);
        return store.risk.dashboard(req.query);
      });
    res.json({
      operations,
      aggregation: "separate_operation_currency_no_financial_sum",
    });
  });
  router.get(`${opPath}/report`, (req, res) => {
    const op = platform.authorizeOperation(
      admin(req),
      req.params.id,
      req.params.operationId,
    );
    res.json(tickets.store(op.id).report());
  });
  router.get(`${opPath}/feed-evidence`, async (req, res) => {
    platform.authorizeOperation(
      admin(req),
      req.params.id,
      req.params.operationId,
    );
    res.json(feedEvidence(await source.getEvents()));
  });
  router.get(`${opPath}/diagnostics`, async (req, res) => {
    const op = platform.authorizeOperation(
      admin(req),
      req.params.id,
      req.params.operationId,
    );
    const feed = await source.getEvents();
    const store = tickets.store(op.id);
    store.reconcile(feed);
    const history = store.list();
    res.json({
      operation: op,
      financialMode: "simulation",
      provider: "LSports TRADE",
      environment: "Test",
      mode: feed.mode,
      health: feed.health || "ok",
      updatedAt: feed.updatedAt,
      connections: feed.connections,
      coverage: feed.coverage,
      events: feed.events.length,
      markets: feed.events.reduce((n, e) => n + (e.markets?.length || 0), 0),
      selections: feed.events.reduce(
        (n, e) =>
          n + (e.markets || []).reduce((a, m) => a + m.selections.length, 0),
        0,
      ),
      resultSelections: feed.ticketOutcomes?.length || 0,
      tickets: {
        total: history.total,
        recent: history.tickets.map((t) => ({
          id: t.id,
          status: t.status,
          revision: t.revision,
          payoutMinor: t.payoutMinor,
          currency: t.currency,
        })),
      },
      report: store.report(),
    });
  });
  router.post("/api/integration/v1/embed-sessions", (req, res) => {
    const access = auth(req);
    const input = body(req);
    const session = platform.createEmbed(access, input);
    res.status(201).json({
      testOnly: true,
      financialMode: "simulation",
      expiresIn: session.expiresIn,
      iframeUrl: `${publicOrigin}/embed/${session.clientId}/${session.operationId}/sportsbook#code=${session.code}`,
    });
  });
  router.post("/api/integration/v1/embed-exchange", (req, res) => {
    sameOrigin(req);
    const input = body(req);
    const session = platform.exchangeEmbed(input);
    res.json({ testOnly: true, ...session });
  });
  router.get("/api/integration/v1/context", (req, res) => {
    const access = auth(req);
    res.json({
      client: access.client,
      financialMode: "simulation",
      testOnly: true,
      wallet: {
        ...walletReadiness,
        scope: {
          clientId: access.clientId,
          operationId: access.operationId,
          currency: access.currency,
        },
        balanceMinor: null,
      },
      operation: access.operation,
      scope: {
        clientId: access.clientId,
        operationId: access.operationId,
        currency: access.currency,
      },
      channel: access.channel || "web",
      terminalId: access.terminalId,
      playerId: access.kind === "iframe" ? access.playerId : undefined,
    });
  });
  router.all("/api/integration/v1/wallet/{*operation}", (req, res) => {
    auth(req);
    res.status(501).json({
      code: "WALLET_CONTRACT_PENDING",
      error:
        "Contrato de cartera pendiente. No se ejecutó ninguna operación financiera.",
      wallet: walletReadiness,
    });
  });
  router.get("/api/integration/v1/events", async (req, res) => {
    const access = auth(req);
    const feed = tickets
      .store(access.operationId)
      .risk.overlay(await source.getEvents());
    const paused =
      access.client.status !== "active" ||
      !access.client.settings.acceptingTickets ||
      access.operation.status !== "active" ||
      !access.operation.acceptingTickets;
    res.json({
      ...feed,
      notice: `${paused ? "Nuevos billetes suspendidos. " : ""}${feed.notice || ""}`,
      client: {
        id: access.client.id,
        displayName: access.client.settings.displayName,
        acceptingTickets: !paused,
      },
      operation: access.operation,
      effectiveLimits: platform.effectiveOperationLimits(access.operationId)
        .limits,
      financialMode: "simulation",
    });
  });
  router.post("/api/integration/v1/tickets", async (req, res) => {
    const access = auth(req),
      playerId = player(req, access),
      input = body(req);
    assertSimulation(input);
    assertBinding(access, input, true);
    let device = integrationChannel(input.channel, input.terminalId);
    if (access.kind === "iframe") {
      if (
        (input.channel !== undefined && input.channel !== access.channel) ||
        (input.terminalId !== undefined &&
          input.terminalId !== access.terminalId)
      )
        throw new PlatformError(
          "CHANNEL_MISMATCH",
          "El canal o terminal no coincide con la sesión.",
          403,
        );
      device = {
        channel: access.channel!,
        ...(access.terminalId ? { terminalId: access.terminalId } : {}),
      };
    }
    const feed = await source.getEvents(),
      store = tickets.store(access.operationId);
    store.reconcile(feed);
    const ticket = store.create(
      { ...input, ...device },
      playerId,
      req.get("Idempotency-Key") || "",
      () => {
        assertAccepting(auth(req));
        return feed;
      },
    );
    res.status(201).json(ticket);
  });
  router.get("/api/integration/v1/tickets", async (req, res) => {
    const access = auth(req),
      playerId = player(req, access),
      store = tickets.store(access.operationId);
    store.reconcile(await source.getEvents());
    const offset = Number(req.query.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new PlatformError("INVALID_OFFSET", "Página inválida.");
    res.json({ testOnly: true, ...store.list(playerId, offset, 30) });
  });
  router.get("/api/integration/v1/tickets/:id{/:view}", async (req, res) => {
    const access = auth(req),
      playerId = player(req, access),
      store = tickets.store(access.operationId);
    store.reconcile(await source.getEvents());
    const ticket = store.get(req.params.id, playerId);
    if (!ticket)
      throw new PlatformError("NOT_FOUND", "Billete no encontrado.", 404);
    if (req.params.view === "receipt") {
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'",
      );
      res.type("html").send(receipt(ticket));
    } else if (req.params.view)
      throw new PlatformError("NOT_FOUND", "Ruta no encontrada.", 404);
    else res.json(ticket);
  });
  const webDist = resolve(root, "apps/web/dist");
  router.use(
    "/assets",
    express.static(resolve(webDist, "assets"), {
      immutable: true,
      maxAge: "1y",
      fallthrough: true,
    }),
  );
  router.get("/adl.svg", (_req,res)=>res.type("image/svg+xml").sendFile(resolve(webDist,"adl.svg")));
  router.get("/embed/:id/:operationId/sportsbook", async (req, res) => {
    const client = platform.client(req.params.id),
      op = platform.operation(req.params.operationId);
    if (!client || !op || op.clientId !== client.id)
      throw new PlatformError("NOT_FOUND", "Cliente no encontrado.", 404);
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors ${client.domains.length ? client.domains.join(" ") : "'none'"}; base-uri 'none'; object-src 'none'; form-action 'self'`,
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      res
        .type("html")
        .send(await readFile(resolve(webDist, "index.html"), "utf8"));
    } catch {
      res.status(503).json({
        code: "WEB_BUILD_REQUIRED",
        error: "Ejecutá npm run build para servir el iframe.",
      });
    }
  });
  router.get(["/control","/control/sportsbook-preview"], async (req, res) => {
    const preview=req.path==="/control/sportsbook-preview";
    res.setHeader("Cache-Control", "no-store");
    // Static shell only, like /control; admin cookie intentionally stays scoped
    // to /api/control. Protected data requests authenticate the iframe.
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors ${preview?"'self'":"'none'"}; base-uri 'none'; object-src 'none'; form-action 'self'`,
    );
    res.setHeader("X-Frame-Options", preview?"SAMEORIGIN":"DENY");
    try {
      res
        .type("html")
        .send(await readFile(resolve(webDist, "index.html"), "utf8"));
    } catch {
      res.status(503).json({
        code: "WEB_BUILD_REQUIRED",
        error: "Ejecutá npm run build para abrir el panel.",
      });
    }
  });
  // Fail closed: platform mode never falls through to anonymous legacy tickets,
  // local diagnostics, or the old terminal test bridge.
  router.use("/api", (req, res, next) => {
    if (
      req.path.startsWith("/control") ||
      req.path.startsWith("/integration")
    ) {
      res.status(404).json({ error: "Ruta no encontrada." });
      return;
    }
    res.status(401).json({
      code: "PLATFORM_AUTH_REQUIRED",
      error: "Usá el acceso administrativo o la integración autenticada.",
    });
  });
  router.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof MoneyError)
        res.status(400).json({ code: error.code, error: error.message });
      else if (error instanceof PlatformError)
        res
          .status(error.status)
          .json({ code: error.code, error: error.message });
      else if (error instanceof TicketError)
        res
          .status(error.httpStatus)
          .json({ code: error.code, error: error.message, testOnly: true });
      else if ((error as { type?: string })?.type === "entity.parse.failed")
        res.status(400).json({ code: "INVALID_JSON", error: "JSON inválido." });
      else if ((error as { type?: string })?.type === "entity.too.large")
        res.status(413).json({
          code: "BODY_TOO_LARGE",
          error: "Solicitud demasiado grande.",
        });
      else
        res.status(500).json({
          code: "PLATFORM_OPERATION_FAILED",
          error:
            "No se pudo completar la operación. No se publican datos internos.",
        });
    },
  );
  return {
    router,
    close() {
      tickets.close();
      if (!supplied) platform.close();
    },
  };
}
