// Explicit development-only runner. No .env loading, worker, supplier API or real feed.
import express from "express";
import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { root } from "@lsports/feed-store";
import { PlatformStore } from "@lsports/feed-store/platform";
import { TenantTickets } from "@lsports/feed-store/tenant-tickets";
import { defaultRiskConfig } from "../packages/feed-store/src/operation-risk.js";
import { createApp } from "../apps/api/src/app.js";
import { TradeState } from "../apps/worker/src/state.js";
import { decodeMessage } from "../apps/worker/src/messages.js";
import { localDemoServer } from "./local-embed-demo.js";
export const syntheticLimits = {
  minStakeMinor: "100",
  maxStakeMinor: "10000",
  maxReturnMinor: "20000",
  allowRepeatedTickets: true,
  maxTicketsPerPlayerEvent: 3,
  maxStakePerPlayerEventMinor: "15000",
  sameEventMultiples: "blocked" as const,
};
export const syntheticLogin = {
  email: "admin@synthetic.local",
  password: "Solo-pruebas-aisladas-2026",
};
export async function startSyntheticDemo(
  options: { directory?: string; apiPort?: number; parentPort?: number } = {},
) {
  if (process.env.NODE_ENV === "production")
    throw new Error("SYNTHETIC_DEVELOPMENT_ONLY");
  const directory = options.directory || join(root, ".local-synthetic-demo");
  const apiServer = createServer(),
    parentServer = createServer();
  const listen = async (server: Server, port: number) => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    return `http://localhost:${(server.address() as { port: number }).port}`;
  };
  let platform: PlatformStore | undefined,
    tickets: TenantTickets | undefined,
    app: ReturnType<typeof createApp> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = async () => {
    if (timer) clearInterval(timer);
    for (const server of [parentServer, apiServer])
      server.closeAllConnections();
    await Promise.all(
      [parentServer, apiServer].map(
        (server) => new Promise<void>((r) => server.close(() => r())),
      ),
    );
    app?.locals.closeTickets();
    tickets?.close();
    platform?.close();
  };
  try {
    // Acquire both exclusive listening sockets before touching the isolated data directory.
    apiServer.on("request", (_req, res) => {
      if (!app) {
        res.statusCode = 503;
        res.end("Initializing synthetic demo");
      }
    });
    const apiOrigin = await listen(apiServer, options.apiPort ?? 3101),
      parentOrigin = await listen(parentServer, options.parentPort ?? 5174);
    const marker = join(directory, "SYNTHETIC_ONLY");
    if (existsSync(directory) && !existsSync(marker))
      throw new Error("SYNTHETIC_DIRECTORY_NOT_MARKED");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!existsSync(marker))
      writeFileSync(marker, "ADL isolated synthetic platform v1\n", {
        flag: "wx",
        mode: 0o600,
      });
    platform = new PlatformStore(join(directory, "platform"));
    const manifestPath = join(directory, "manifest.json");
    let manifest: {
      clientId: string;
      operationId: string;
      credentialId: string;
      fixtureId: number;
      stage: "open" | "win" | "loss";
      version: number;
      parentOrigin: string;
      history?: {
        fixtureId: number;
        stage: "open" | "win" | "loss";
        version: number;
      }[];
    };
    const persist = () => {
      writeFileSync(manifestPath + ".tmp", JSON.stringify(manifest), {
        mode: 0o600,
      });
      renameSync(manifestPath + ".tmp", manifestPath);
    };
    if (existsSync(manifestPath)) {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (
        manifest.parentOrigin !== parentOrigin ||
        !Number.isSafeInteger(manifest.fixtureId) ||
        !["open", "win", "loss"].includes(manifest.stage) ||
        !Number.isSafeInteger(manifest.version)
      )
        throw new Error("SYNTHETIC_MANIFEST_INVALID");
    } else {
      await platform.bootstrap(syntheticLogin.email, syntheticLogin.password);
      const actor = (
        await platform.login(
          syntheticLogin.email,
          syntheticLogin.password,
          "synthetic-setup",
        )
      ).admin;
      const client = await platform.createClient(actor, {
        name: "PRUEBA SINTÉTICA · NO LSPORTS",
        adminEmail: "cliente@synthetic.local",
        adminPassword: "Cliente-solo-pruebas-2026",
        domains: [parentOrigin, apiOrigin],
      });
      platform.updateLimitPolicy(actor, client.id, "ARS", {
        ...syntheticLimits,
        clientMayEdit: true,
      });
      const operation = platform.createOperation(actor, client.id, {
        name: "Operación SINTÉTICA ARS",
        country: "AR",
        currency: "ARS",
        clientMayEditLimits: true,
        limits: syntheticLimits,
      });
      const key = platform.issueCredential(
        actor,
        client.id,
        operation.id,
        "Backend sintético local",
      );
      manifest = {
        clientId: client.id,
        operationId: operation.id,
        credentialId: key.id,
        fixtureId: 99000001,
        stage: "open",
        version: Date.now(),
        parentOrigin,
      };
      persist();
      const setupTickets = new TenantTickets(platform);
      const config = defaultRiskConfig();
      config.rules.largeStake = {
        ...config.rules.largeStake,
        enabled: true,
        action: "alert",
        severity: "high",
        thresholdMinor: "500",
      };
      setupTickets.store(operation.id).risk.configure(actor, config);
      setupTickets.close();
    }
    const actor = (
      await platform.login(
        syntheticLogin.email,
        syntheticLogin.password,
        "synthetic-runner",
      )
    ).admin;
    // Only this marked development fixture: both exact local parent origins are
    // necessary (casino demo and control-panel iframe). Repair old manifests
    // without recreating credentials, operations, events, tickets or audit data.
    const syntheticClient = platform.client(manifest.clientId);
    if (
      !syntheticClient ||
      platform.operation(manifest.operationId)?.clientId !== manifest.clientId
    )
      throw new Error("SYNTHETIC_MANIFEST_INVALID");
    const localOrigins = [parentOrigin, apiOrigin];
    if (
      syntheticClient.domains.length !== localOrigins.length ||
      localOrigins.some((origin) => !syntheticClient.domains.includes(origin))
    )
      platform.updateClient(actor, manifest.clientId, {
        domains: localOrigins,
      });
    tickets = new TenantTickets(platform);
    const getEvents = () => {
      const state = new TradeState();
      for (const stored of [...(manifest.history || []), manifest]) {
        const id = stored.fixtureId,
          ended = stored.stage !== "open",
          at = stored.version;
        const messages = [
          {
            type: 1,
            body: {
              Events: [
                {
                  FixtureId: id,
                  Fixture: {
                    Sport: { Name: "Football" },
                    Status: ended ? 3 : 1,
                    StartDate: new Date(at + 86400000).toISOString(),
                    League: { Name: "DATOS SINTÉTICOS · PRUEBA AISLADA" },
                    Participants: [
                      { Id: 1, Name: "TEST Equipo A" },
                      { Id: 2, Name: "TEST Equipo B" },
                    ],
                  },
                },
              ],
            },
          },
          {
            type: 3,
            body: {
              Events: [
                {
                  FixtureId: id,
                  Markets: [
                    {
                      Id: 1,
                      Name: "Ganador SINTÉTICO · SIN DINERO REAL",
                      Status: ended ? 3 : 1,
                      Bets: [
                        {
                          Id: "99000002",
                          Name: "TEST A",
                          Price: "2.10",
                          Status: ended ? 3 : 1,
                          ...(ended
                            ? { Settlement: stored.stage === "win" ? 2 : 1 }
                            : {}),
                        },
                        {
                          Id: "99000003",
                          Name: "TEST B",
                          Price: "3.50",
                          Status: ended ? 3 : 1,
                          ...(ended
                            ? { Settlement: stored.stage === "loss" ? 2 : 1 }
                            : {}),
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ];
        for (const message of messages) {
          const decoded = decodeMessage(
            Buffer.from(
              JSON.stringify({
                Header: {
                  Type: message.type,
                  MsgGuid: `synthetic-${id}-${message.type}-${at}`,
                  ServerTimestamp: at,
                },
                Body: message.body,
              }),
            ),
          );
          state.apply("prematch", decoded.events, decoded.at);
        }
      }
      state.set("prematch", {
        phase: "connected",
        message: "SIMULACIÓN SINTÉTICA · NO ES LSPORTS",
      });
      state.set("inplay", {
        phase: "connected",
        message: "SIMULACIÓN SINTÉTICA · NO ES LSPORTS",
      });
      return {
        ...state.feed(),
        notice: "DATOS SINTÉTICOS AISLADOS · NO LSPORTS · SIN DINERO REAL",
      };
    };
    app = createApp(
      { getEvents: async () => getEvents() },
      { platform: true, platformStore: platform, publicOrigin: apiOrigin },
    );
    apiServer.removeAllListeners("request");
    apiServer.on("request", (req, res) => {
      if (req.headers.host !== new URL(apiOrigin).host) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.setHeader("X-ADL-Test-Only", "synthetic-isolated");
      app!(req, res);
    });
    const embedded = localDemoServer({
      directory: platform.directory,
      apiOrigin,
      credentialId: manifest.credentialId,
      origin: parentOrigin,
      scope: {
        clientId: manifest.clientId,
        operationId: manifest.operationId,
        currency: "ARS",
        playerId: "test-player",
      },
      synthetic: true,
    });
    const controls = express();
    controls.use(express.json({ limit: "1kb" }));
    controls.post("/synthetic/action", (req, res) => {
      if (
        req.get("Host") !== new URL(parentOrigin).host ||
        req.get("Origin") !== parentOrigin
      ) {
        res.status(403).json({ code: "ORIGIN_REJECTED" });
        return;
      }
      const action = req.body?.action;
      if (
        !["win", "loss", "repeat", "suspend", "resume", "new"].includes(action)
      ) {
        res.status(400).json({ code: "INVALID_TEST_ACTION" });
        return;
      }
      try {
        if (action === "suspend" || action === "resume")
          platform!.updateOperation(
            actor,
            manifest.clientId,
            manifest.operationId,
            { acceptingTickets: action === "resume" },
          );
        else if (action !== "repeat") {
          if (action === "new" && manifest.stage === "open") {
            res
              .status(409)
              .json({ code: "SETTLE_CURRENT_SYNTHETIC_EVENT_FIRST" });
            return;
          }
          if (action === "new") {
            (manifest.history ||= []).push({
              fixtureId: manifest.fixtureId,
              stage: manifest.stage,
              version: manifest.version,
            });
            manifest.fixtureId++;
            manifest.stage = "open";
          } else manifest.stage = action;
          manifest.version = Math.max(Date.now(), manifest.version + 1);
          persist();
        }
        tickets!.reconcile(getEvents());
        res.json({
          testOnly: true,
          stage: manifest.stage,
          fixtureId: manifest.fixtureId,
        });
      } catch {
        res.status(500).json({ code: "SYNTHETIC_ACTION_FAILED" });
      }
    });
    controls.use((req, res) => {
      embedded.emit("request", req, res);
    });
    parentServer.on("request", controls);
    let reconciliationFailed = false;
    timer = setInterval(() => {
      try {
        tickets!.reconcile(getEvents());
        reconciliationFailed = false;
      } catch {
        if (!reconciliationFailed)
          console.error(
            "SYNTHETIC_RECONCILIATION_FAILED: resultados de prueba pendientes; revisá el almacenamiento aislado.",
          );
        reconciliationFailed = true;
      }
    }, 1000);
    return {
      directory,
      apiOrigin,
      parentOrigin,
      platform,
      manifest,
      getEvents,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void startSyntheticDemo()
    .then((demo) => {
      console.log(
        `PRUEBA SINTÉTICA AISLADA · sin LSports ni dinero real\nIframe: ${demo.parentOrigin}/demo/synthetic\nPanel: ${demo.apiOrigin}/control\nDatos exclusivos: ${demo.directory}\nLogin de prueba: ${syntheticLogin.email} / ${syntheticLogin.password}`,
      );
      for (const signal of ["SIGINT", "SIGTERM"] as const)
        process.once(signal, () => {
          void demo.close();
        });
    })
    .catch(() => {
      console.error(
        "No se pudo iniciar la demostración sintética. Revisá puertos 3101/5174 y el directorio exclusivo .local-synthetic-demo; no se imprimen excepciones ni se modifica el entorno real.",
      );
      process.exitCode = 1;
    });
}
