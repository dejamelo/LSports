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
  observation.httpStatus = status(response.status);
  let data = response.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      data = undefined;
    }
  }
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
  try {
    const response = await adapter(config);
    if (observation) {
      observe(observation, response);
      if ((observation.providerStatus || 0) >= 400 || observation.envelopeError)
        throw new Error("Supplier error envelope");
    }
    return response;
  } catch (error) {
    if (observation && axios.isAxiosError(error) && error.response)
      observe(observation, error.response);
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
  for (let i = 0; i < 5 && current && typeof current === "object"; i++) {
    const record = current as Record<string, unknown>;
    if (typeof record.message === "string") text += " " + record.message;
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
  if (!code && /certificate|CERT_|TLS|SSL|self.signed/i.test(text)) {
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
  const observation: Observation = {};
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
