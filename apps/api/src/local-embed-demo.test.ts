import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localDemoServer } from "../../../scripts/local-embed-demo.js";
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
test("local embed backend reads protected key, fixes operation scope, hides secret and rejects cross-origin/host requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adl-local-demo-"));
  const id = "29338d81-0a16-4377-94f0-1be91386ccbf";
  const secret = `adl_${id}_${"x".repeat(43)}`;
  await mkdir(join(directory, "credentials"));
  await writeFile(join(directory, "credentials", `${id}.key`), secret, {
    mode: 0o600,
  });
  let calls = 0,
    apiOrigin = "",
    status = 201;
  const upstream = createServer(async (req, res) => {
    calls++;
    assert(req.headers.authorization === `Bearer ${secret}`);
    let text = "";
    for await (const chunk of req) text += chunk;
    const scope = JSON.parse(text);
    assert.equal(scope.currency, "ARS");
    assert.equal(scope.playerId, "demo-001");
    assert.equal(scope.parentOrigin, "http://localhost:5173");
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        status === 201
          ? {
              iframeUrl: `${apiOrigin}/embed/${scope.clientId}/${scope.operationId}/sportsbook#code=temporary-test-code`,
            }
          : { error: secret },
      ),
    );
  });
  apiOrigin = await listen(upstream);
  const demo = localDemoServer({ directory, apiOrigin });
  const base = await listen(demo);
  try {
    const request = (
      path: string,
      method = "GET",
      origin?: string,
      host = "localhost:5173",
    ) =>
      new Promise<Response>((resolve, reject) => {
        const req = httpRequest(
          base + path,
          {
            method,
            headers: { Host: host, ...(origin ? { Origin: origin } : {}) },
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () =>
              resolve(
                new Response(body, {
                  status: res.statusCode,
                  headers: res.headers as Record<string, string>,
                }),
              ),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
    const page = await request("/demo/argentina");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert(!html.includes(secret));
    assert(!html.includes(id));
    assert(html.includes("iframe"));
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal((await request("/local-demo/session", "POST")).status, 403);
    assert.equal(
      (await request("/local-demo/session", "POST", "https://attacker.example"))
        .status,
      403,
    );
    assert.equal(
      (await request("/demo/argentina", "GET", undefined, "attacker.example"))
        .status,
      403,
    );
    assert.equal(calls, 0);
    const result = await request(
      "/local-demo/session",
      "POST",
      "http://localhost:5173",
    );
    assert.equal(result.status, 201);
    assert(!(await result.text()).includes(secret));
    assert.equal(calls, 1);
    status = 401;
    const rejected = await request(
      "/local-demo/session",
      "POST",
      "http://localhost:5173",
    );
    assert.equal(rejected.status, 401);
    assert(!(await rejected.text()).includes(secret));
    status = 200;
    const invalidSuccess = await request(
      "/local-demo/session",
      "POST",
      "http://localhost:5173",
    );
    assert.equal(invalidSuccess.status, 502);
    await rm(join(directory, "credentials", `${id}.key`));
    const missing = await request(
      "/local-demo/session",
      "POST",
      "http://localhost:5173",
    );
    assert.equal(missing.status, 503);
    assert.equal((await missing.json()).stage, "credential.read");
    assert.equal(calls, 3);
  } finally {
    await close(demo);
    await close(upstream);
    await rm(directory, { recursive: true, force: true });
  }
});
test("local demo refuses production and external API origins", () => {
  assert.throws(() =>
    localDemoServer({ apiOrigin: "https://external.example" }),
  );
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(() => localDemoServer());
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
