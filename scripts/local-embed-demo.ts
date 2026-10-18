import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { platformDirectory } from "@lsports/feed-store/platform";

export function localDemoServer(
  options: {
    directory?: string;
    apiOrigin?: string;
    credentialId?: string;
    origin?: string;
  } = {},
) {
  if (process.env.NODE_ENV === "production")
    throw new Error("LOCAL_DEMO_DEVELOPMENT_ONLY");
  const origin = options.origin || "http://localhost:5173";
  const api = new URL(options.apiOrigin || "http://localhost:3001");
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) ||
    api.protocol !== "http:" ||
    api.username ||
    api.password ||
    api.pathname !== "/" ||
    api.search ||
    api.hash
  )
    throw new Error("LOCAL_API_REQUIRED");
  const credentialId =
    options.credentialId || "29338d81-0a16-4377-94f0-1be91386ccbf";
  if (!/^[a-f0-9-]{36}$/i.test(credentialId))
    throw new Error("INVALID_CREDENTIAL_ID");
  const scope = {
    clientId: "941e6249-4e84-4154-a71e-1b15d9983ca3",
    operationId: "6685c19e-9f27-4769-a2c2-772abd4053d0",
    currency: "ARS",
    playerId: "demo-001",
    parentOrigin: origin,
    channel: "web",
  };
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const json = (status: number, body: object) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress || "",
      ) ||
      req.headers.host !== new URL(origin).host
    ) {
      json(403, { code: "LOCAL_ONLY" });
      return;
    }
    if (req.method === "GET" && req.url === "/demo/argentina") {
      const nonce = randomBytes(18).toString("base64");
      res.setHeader(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-src ${api.origin}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      );
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html lang="es-AR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Apuesta DEPORTIVA LAT · Argentina Demo</title><style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;background:#0b1424;color:#eef4ff;font:15px system-ui}header{padding:14px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}strong{color:#59dfb1}button{background:#59dfb1;border:0;border-radius:6px;padding:10px;cursor:pointer}iframe{display:block;width:100%;height:calc(100dvh - 110px);min-height:600px;border:0}p{margin:0;padding:8px 20px;color:#bccbe1}</style><header><strong>ADL · Apuesta DEPORTIVA LAT</strong><span>Argentina Demo · ARS · demo-001</span><button id="open">Abrir / renovar sesión</button></header><p id="status" role="status">Demostración local. Billetera y billetes en simulación.</p><iframe id="sportsbook" title="Apuesta DEPORTIVA LAT · Sportsbook Argentina Demo" allow="fullscreen"></iframe><script nonce="${nonce}">const button=document.getElementById('open'),status=document.getElementById('status');async function openSession(){button.disabled=true;status.textContent='Creando sesión de prueba…';try{const response=await fetch('/local-demo/session',{method:'POST'});const data=await response.json();if(response.status!==201||typeof data.iframeUrl!=='string'){status.textContent='No se pudo abrir la sesión. HTTP '+response.status+' · '+data.code;return}document.getElementById('sportsbook').src=data.iframeUrl;status.textContent='Sesión de prueba abierta · ARS · sin dinero real.'}catch{status.textContent='No se pudo completar la solicitud local. Revisá el servidor de demostración.'}finally{button.disabled=false}}button.onclick=openSession;openSession();</script></html>`,
      );
      return;
    }
    if (req.method !== "POST" || req.url !== "/local-demo/session") {
      json(404, { code: "NOT_FOUND" });
      return;
    }
    if (
      req.headers.origin !== origin ||
      (req.headers["sec-fetch-site"] &&
        req.headers["sec-fetch-site"] !== "same-origin")
    ) {
      json(403, { code: "ORIGIN_REJECTED" });
      return;
    }
    let stage = "credential.read";
    try {
      const secret = readFileSync(
        join(
          options.directory || platformDirectory(),
          "credentials",
          `${credentialId}.key`,
        ),
        "utf8",
      );
      if (!/^adl_[a-f0-9-]{36}_[A-Za-z0-9_-]{43}$/.test(secret)) {
        json(503, { code: "KEY_FILE_INVALID" });
        return;
      }
      stage = "embed-session.request";
      const response = await fetch(
        new URL("/api/integration/v1/embed-sessions", api),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(scope),
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        },
      );
      if (response.status !== 201) {
        await response.body?.cancel();
        json(response.status >= 400 ? response.status : 502, {
          code: "EMBED_SESSION_REJECTED",
          stage,
          httpStatus: response.status,
        });
        return;
      }
      const data = await response.json();
      const url = new URL(data.iframeUrl);
      if (
        url.origin !== api.origin ||
        url.pathname !==
          `/embed/${scope.clientId}/${scope.operationId}/sportsbook` ||
        !url.hash.startsWith("#code=")
      ) {
        json(502, { code: "INVALID_SESSION_RESPONSE" });
        return;
      }
      json(201, { iframeUrl: url.href });
    } catch {
      json(503, {
        code:
          stage === "credential.read"
            ? "KEY_FILE_UNAVAILABLE"
            : "LOCAL_SESSION_REQUEST_FAILED",
        stage,
      });
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const server = localDemoServer();
  server.on("error", () => {
    console.error(
      "Local demo could not start. Check port 5173 and local configuration.",
    );
    process.exitCode = 1;
  });
  server.listen(5173, "127.0.0.1", () =>
    console.log(
      "Demo local: http://localhost:5173/demo/argentina · simulación",
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      server.close();
      server.closeAllConnections();
    });
}
