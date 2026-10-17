import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import type { AxiosStatic } from "axios";
// SDK is CommonJS; importing Axios through ESM creates a different defaults singleton.
// Resolve the exact CommonJS instance used by the installed SDK, including nested installs.
const sdkRequire = createRequire(
  createRequire(import.meta.url).resolve("trade360-nodejs-sdk"),
);
export const sdkAxios = sdkRequire("axios") as AxiosStatic;
const axios = sdkAxios;
import type { IntegrationDiagnostic } from "@lsports/contracts";
export type Operation = IntegrationDiagnostic["operation"];
export type Protocol = IntegrationDiagnostic["protocol"];
type Observation = {
  rawResponse?: unknown;
  startedAt?: number;
  bodyShape?: "array" | "single_event" | "events_wrapper" | "other" | "missing";
  providerRows?: number;
  fixturesCount?: number;
  reason?: IntegrationDiagnostic["reason"];
  clientCode?: string;
  timeoutMs?: number;
  responseLimitBytes?: number;
  httpStatus?: number;
  providerStatus?: number;
  envelopeError?: boolean;
  credentialRejection?: boolean;
};
const observations = new AsyncLocalStorage<Observation>();
const status = (n: unknown) =>
  typeof n === "number" && Number.isInteger(n) && n >= 100 && n <= 599
    ? n
    : undefined;
// Observe only tagged SDK requests, before the SDK replaces AxiosError and can lose its status.
const adapter = axios.getAdapter(axios.defaults.adapter);
function observe(
  observation: Observation,
  response: { status: number; data: unknown },
) {
  observation.rawResponse = response.data;
  observation.httpStatus = status(response.status);
  let data = response.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      data = undefined;
    }
  }
  if (typeof data === "string" && data.trim())
    observation.reason = "non_json_response";
  const body =
    data && typeof data === "object" && "Body" in data
      ? (data as Record<string, unknown>).Body
      : undefined;
  observation.bodyShape =
    body === undefined
      ? "missing"
      : Array.isArray(body)
        ? "array"
        : body && typeof body === "object" && "FixtureId" in body
          ? "single_event"
          : body &&
              typeof body === "object" &&
              "Events" in body &&
              Array.isArray(body.Events)
            ? "events_wrapper"
            : "other";
  observation.providerRows = Array.isArray(body)
    ? body.length
    : observation.bodyShape === "single_event"
      ? 1
      : observation.bodyShape === "events_wrapper"
        ? (body as { Events: unknown[] }).Events.length
        : undefined;
  observation.fixturesCount =
    body &&
    typeof body === "object" &&
    "Fixtures" in body &&
    Array.isArray(body.Fixtures)
      ? body.Fixtures.length
      : undefined;
  const header =
    data && typeof data === "object" && "Header" in data
      ? (data.Header as Record<string, unknown>)
      : undefined;
  observation.providerStatus = status(header?.HttpStatusCode);
  observation.envelopeError =
    Array.isArray(header?.Errors) && header.Errors.length > 0;
  observation.credentialRejection =
    Array.isArray(header?.Errors) &&
    header.Errors.some(
      (e: unknown) =>
        !!e &&
        typeof e === "object" &&
        "Message" in e &&
        typeof e.Message === "string" &&
        /incorrect user ?name or password|invalid credentials/i.test(e.Message),
    );
}
axios.defaults.adapter = async (config) => {
  const observation = observations.getStore();
  if (observation) {
    if (typeof config.timeout === "number" && config.timeout > 0)
      observation.timeoutMs = config.timeout;
    if (
      typeof config.maxContentLength === "number" &&
      config.maxContentLength > 0
    )
      observation.responseLimitBytes = config.maxContentLength;
  }
  try {
    const response = await adapter(config);
    if (observation) {
      observe(observation, response);
      if ((observation.providerStatus || 0) >= 400 || observation.envelopeError)
        throw new Error("Supplier error envelope");
    }
    return response;
  } catch (error) {
    if (observation && axios.isAxiosError(error)) {
      if (error.response) observe(observation, error.response);
      else
        observation.httpStatus =
          status(error.request?.res?.statusCode) || observation.httpStatus;
      if (typeof error.code === "string" && clientCodes.has(error.code))
        observation.clientCode = error.code;
      observation.reason = classifyReason(error.message) || observation.reason;
    }
    throw error;
  }
};
export class OperationError extends Error {
  constructor(public readonly diagnostic: IntegrationDiagnostic) {
    super(formatDiagnostic(diagnostic));
    this.name = "OperationError";
  }
}
const networkCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNABORTED",
  "EPIPE",
  "ERR_NETWORK",
]);
const clientCodes = new Set([
  ...networkCodes,
  "ERR_BAD_RESPONSE",
  "ERR_BAD_REQUEST",
  "ERR_FR_TOO_MANY_REDIRECTS",
  "ERR_INVALID_URL",
  "ERR_NOT_SUPPORT",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);
function classifyReason(
  text: string,
): IntegrationDiagnostic["reason"] | undefined {
  if (
    /maxContentLength|response size.*exceed|maximum response size/i.test(text)
  )
    return "response_size_limit";
  if (/maxBodyLength/i.test(text)) return "request_size_limit";
  if (/timeout|timed out/i.test(text)) return "timeout";
  if (/maximum.*redirect|too many redirects/i.test(text))
    return "redirect_limit";
  if (/socket hang up|ECONNRESET/i.test(text)) return "connection_reset";
  if (/getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(text)) return "dns";
  if (/certificate|CERT_|TLS|SSL|self.signed/i.test(text)) return "tls_failure";
  if (/Invalid snapshot (event|response)/i.test(text))
    return "invalid_snapshot";
  return undefined;
}
export function describeFailure(
  error: unknown,
  operation: Operation,
  protocol: Protocol,
  observation: Observation = {},
): IntegrationDiagnostic {
  if (error instanceof OperationError) return error.diagnostic;
  let current = error;
  let httpStatus = observation.httpStatus;
  let amqpCode: number | undefined;
  let networkCode: string | undefined;
  let text = "";
  let reason = observation.reason;
  let clientCode = observation.clientCode;
  let errorType: IntegrationDiagnostic["errorType"] = "unknown";
  for (let i = 0; i < 5 && current && typeof current === "object"; i++) {
    const record = current as Record<string, unknown>;
    if (typeof record.message === "string")
      text += " " + record.message.slice(0, 4096);
    if (errorType === "unknown") {
      const types: Record<
        string,
        NonNullable<IntegrationDiagnostic["errorType"]>
      > = {
        AxiosError: "axios",
        HttpResponseError: "sdk_http",
        ConversionError: "sdk_conversion",
        IdTransformationError: "sdk_conversion",
        ValidationError: "sdk_validation",
        ZodError: "sdk_validation",
        SyntaxError: "syntax",
        TypeError: "type",
        RangeError: "range",
      };
      if (typeof record.name === "string" && Object.hasOwn(types, record.name))
        errorType = types[record.name];
    }
    if (typeof record.code === "string" && clientCodes.has(record.code))
      clientCode ??= record.code;
    if (
      protocol === "http" &&
      record.response &&
      typeof record.response === "object"
    )
      httpStatus ??= status(
        (record.response as Record<string, unknown>).status,
      );
    if (protocol === "amqp")
      amqpCode ??= status(record.replyCode) ?? status(record.code);
    if (typeof record.code === "string" && networkCodes.has(record.code))
      networkCode = record.code;
    current = record.cause;
  }
  if (networkCodes.has(clientCode || "")) networkCode ??= clientCode;
  if (!reason && errorType === "sdk_conversion") reason = "sdk_conversion";
  if (!reason && errorType === "sdk_validation") reason = "sdk_validation";
  if (!reason && (observation.providerStatus || httpStatus || 0) < 400)
    reason = classifyReason(text);
  if (protocol === "amqp" && !amqpCode) {
    const match = text.match(
      /(?:code[=: ]+|\b)(403|404|405|406|530|541)\s*(?:\(|-|ACCESS_REFUSED|NOT_FOUND|ACCESS-REFUSED|NOT-FOUND)/i,
    );
    if (match) amqpCode = Number(match[1]);
  }
  const code =
    ((observation.providerStatus || 0) >= 400
      ? observation.providerStatus
      : undefined) ||
    httpStatus ||
    amqpCode;
  let category: IntegrationDiagnostic["category"] = "unexpected";
  let message =
    "Falló la operación. No se publica el texto crudo del proveedor por seguridad.";
  if (reason === "response_size_limit") {
    category = "response_limit";
    message =
      "La respuesta superó el límite local de tamaño. Revisá responseLimitBytes; no es un rechazo de autenticación.";
  } else if (reason === "request_size_limit") {
    category = "invalid_request";
    message = "La solicitud superó el límite de tamaño del cliente HTTP.";
  } else if (reason === "timeout") {
    category = "network";
    message =
      "La solicitud agotó el tiempo de espera. Revisá timeoutMs y conectividad; no confirma un error de credenciales.";
  } else if (reason === "redirect_limit") {
    category = "redirect";
    message =
      "El cliente rechazó una redirección HTTP. Revisá el endpoint canónico; no se reenvían credenciales automáticamente.";
  } else if (!code && reason === "tls_failure") {
    category = "tls";
    message =
      "Falló la negociación o verificación TLS. Revisá listener, puerto y certificado.";
  } else if (networkCode) {
    category = "network";
    message = "Fallo de red o tiempo de espera. Revisá conectividad y destino.";
  } else if (code === 401 || observation.credentialRejection) {
    category = "authentication_rejected";
    message =
      "El proveedor rechazó la autenticación del paquete. Revisá usuario, contraseña y asociación al package ID.";
  } else if (protocol === "amqp" && code === 403) {
    category = "authentication_or_permission";
    message =
      operation === "amqp.connect"
        ? "AMQP rechazó el acceso: credenciales, mecanismo PLAIN o permiso del vhost. No permite distinguirlos con certeza."
        : "AMQP rechazó el permiso de la operación sobre la cola o el canal.";
  } else if (code === 403) {
    category = "permission_denied";
    message =
      "HTTP 403: acceso denegado por proveedor o intermediario. No prueba que la contraseña sea incorrecta.";
  } else if (code === 404) {
    category = "not_found";
    message =
      protocol === "amqp"
        ? "La cola o el recurso AMQP no existe en el vhost configurado."
        : "La ruta HTTP no está disponible en el destino configurado.";
  } else if (code === 429) {
    category = "rate_limited";
    message = "El proveedor limitó las consultas. Esperá antes de reintentar.";
  } else if (code === 400 || code === 422) {
    category = "invalid_request";
    message =
      "El proveedor rechazó los parámetros de la solicitud; no se interpreta como contraseña incorrecta.";
  } else if (
    protocol === "amqp" &&
    (code === 530 || /vhost.*not found/i.test(text))
  ) {
    category = "permission_denied";
    message =
      "El broker rechazó el acceso al vhost; verificá nombre y permisos asignados.";
  } else if ((code || 0) >= 500) {
    category = "supplier_error";
    message =
      "Fallo del proveedor o intermediario; no se interpreta como credenciales ausentes.";
  } else if (observation.envelopeError) {
    category = "supplier_error";
    message =
      "El proveedor devolvió errores en Header.Errors; contenido crudo omitido.";
  } else if (reason === "sdk_conversion" || reason === "sdk_validation") {
    category = "sdk_error";
    message =
      reason === "sdk_conversion"
        ? "El SDK no pudo convertir la respuesta. Revisá el esquema del proveedor y la versión del SDK."
        : "El SDK rechazó la configuración o estructura de la solicitud antes de completarla.";
  } else if (
    reason === "invalid_snapshot" ||
    reason === "non_json_response" ||
    (protocol === "http" && ["syntax", "type", "range"].includes(errorType))
  ) {
    category = "invalid_response";
    message =
      reason === "non_json_response"
        ? "El servidor devolvió contenido que no es JSON; puede ser una página de proxy o un endpoint incorrecto."
        : "La respuesta no pudo normalizarse como snapshot válido. No se reemplaza por datos demo.";
  } else if (protocol === "http" && httpStatus && httpStatus < 300) {
    category = "invalid_response";
    message =
      "La respuesta HTTP no contiene una estructura válida para esta operación.";
  }
  return {
    operation,
    protocol,
    category,
    message,
    ...(reason
      ? { reason }
      : category === "unexpected"
        ? { reason: "unknown_exception" as const }
        : {}),
    ...(protocol === "http"
      ? {
          stage: (errorType === "sdk_conversion"
            ? "sdk"
            : errorType === "sdk_validation"
              ? "validation"
              : httpStatus
                ? "response"
                : "request") as IntegrationDiagnostic["stage"],
          errorType,
        }
      : {}),
    ...(clientCode ? { clientCode } : {}),
    ...(observation.startedAt
      ? { elapsedMs: Math.max(0, Date.now() - observation.startedAt) }
      : {}),
    ...(observation.timeoutMs ? { timeoutMs: observation.timeoutMs } : {}),
    ...(observation.responseLimitBytes
      ? { responseLimitBytes: observation.responseLimitBytes }
      : {}),
    ...(httpStatus ? { httpStatus } : {}),
    ...(observation.providerStatus
      ? { providerStatus: observation.providerStatus }
      : {}),
    ...(amqpCode ? { amqpCode } : {}),
    ...(networkCode ? { networkCode } : {}),
  };
}
export async function operation<T>(
  name: Operation,
  protocol: Protocol,
  action: () => Promise<T>,
): Promise<T> {
  const observation: Observation = { startedAt: Date.now() };
  return observations.run(observation, async () => {
    try {
      return await action();
    } catch (error) {
      throw new OperationError(
        describeFailure(error, name, protocol, observation),
      );
    }
  });
}
export function formatDiagnostic(d: IntegrationDiagnostic) {
  return `${d.operation} [${[d.httpStatus && `HTTP ${d.httpStatus}`, d.providerStatus && `Header ${d.providerStatus}`, d.amqpCode && `AMQP ${d.amqpCode}`, d.networkCode].filter(Boolean).join(" / ") || d.category}]: ${d.message}`;
}
export function configError(
  category: "missing_credentials" | "configuration",
  fields: string[],
  message: string,
): OperationError {
  return new OperationError({
    operation: "config",
    protocol: "local",
    category,
    fields,
    message,
  });
}

export function responseEvidence() {
  const o = observations.getStore();
  return {
    bodyShape: o?.bodyShape || ("missing" as const),
    providerRows: o?.providerRows,
    fixturesCount: o?.fixturesCount,
  };
}

// Internal conversion only. Never include this value in logs, diagnostics or public responses.
export function snapshotResponsePayload(): unknown { return observations.getStore()?.rawResponse; }
