// Never print errors, response bodies, headers, secret hashes or session URLs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { platformDirectory, digest } from "@lsports/feed-store/platform";
const args = process.argv.slice(2);
const option = (name: string, fallback = "") => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1] || "";
};
let stage = "arguments";
const report = (data: object) =>
  console.log(
    JSON.stringify({ operation: "integration.diagnose", stage, ...data }),
  );
let db: DatabaseSync | undefined;
try {
  const id = option("credential-id");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    throw new Error("INVALID_ARGUMENT");
  const base = new URL(option("base-url", "http://localhost:3001"));
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
    base.protocol !== "http:" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("INVALID_ARGUMENT");
  stage = "credential.read";
  const secret = readFileSync(
    option("key-file", join(platformDirectory(), "credentials", `${id}.key`)),
    "utf8",
  );
  const valid = /^adl_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/.test(secret);
  report({
    status: valid ? "ok" : "error",
    formatValid: valid,
    hasWhitespace: /\s/.test(secret),
    hasQuotes: /["']/.test(secret),
    isIdOnly: /^[0-9a-f-]{36}$/i.test(secret.trim()),
    action: valid
      ? "continue"
      : "use_original_server_key_file_without_quotes_or_newlines",
  });
  if (!valid) throw new Error("INVALID_KEY_INPUT");
  stage = "credential.persistence";
  db = new DatabaseSync(join(platformDirectory(), "control.sqlite"), {
    readOnly: true,
  });
  const row = db
    .prepare(
      "SELECT client_id,operation_id,currency,hash,revoked FROM operation_credentials WHERE id=?",
    )
    .get(id);
  const matches = !!row && row.hash === digest(secret);
  const scopeMatches =
    !!row &&
    row.client_id === option("client-id") &&
    row.operation_id === option("operation-id") &&
    row.currency === option("currency");
  report({
    status: matches && !row?.revoked && scopeMatches ? "ok" : "error",
    recordFound: !!row,
    secretMatches: matches,
    revoked: !!row?.revoked,
    scopeMatches,
    readOnly: true,
  });
  if (!matches || row?.revoked || !scopeMatches)
    throw new Error("PERSISTENCE_OR_SCOPE_MISMATCH");
  if (args.includes("--probe")) {
    stage = "authorization.build";
    const headers = new Headers({
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    });
    report({ status: "ok" });
    stage = "embed-session.request";
    const response = await fetch(
      new URL("/api/integration/v1/embed-sessions", base),
      {
        method: "POST",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          clientId: row!.client_id,
          operationId: row!.operation_id,
          currency: row!.currency,
          playerId: option("player-id", "demo-001"),
          parentOrigin: option("parent-origin", "http://localhost:5173"),
          channel: option("channel", "web"),
        }),
      },
    );
    report({
      status: response.status === 201 ? "ok" : "error",
      httpStatus: response.status,
      action:
        response.status === 401
          ? "check_running_api_platform_data_dir_and_current_credential_file"
          : response.status === 403
            ? "check_scope_and_authorized_parent_origin"
            : response.status === 201
              ? "temporary_embed_code_created_not_displayed"
              : "inspect_api_configuration",
    });
    await response.body?.cancel();
    if (response.status !== 201) process.exitCode = 1;
  }
} catch (error) {
  const e = error as {
    code?: string;
    name?: string;
    message?: string;
    cause?: { code?: string };
  };
  const codes = [
    "ENOENT",
    "EACCES",
    "EPERM",
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
  ];
  const code = [e.code, e.cause?.code].find((c) => c && codes.includes(c));
  const local = [
    "INVALID_ARGUMENT",
    "INVALID_KEY_INPUT",
    "PERSISTENCE_OR_SCOPE_MISMATCH",
  ].includes(e.message || "")
    ? e.message
    : undefined;
  report({
    status: "error",
    code: code || local || "LOCAL_OPERATION_FAILED",
    exceptionType: ["TypeError", "TimeoutError", "AbortError"].includes(
      e.name || "",
    )
      ? e.name
      : "Error",
    httpStatus: null,
    message:
      "No se imprime la excepción original. Un fallo sin HTTP no demuestra que la API esté fuera de servicio; revisá la etapa indicada.",
  });
  process.exitCode = 1;
} finally {
  db?.close();
}
