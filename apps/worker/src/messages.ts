import { inspectSettlements } from "./settlement-evidence.js";
import { createHash } from "node:crypto";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { TextDecoder } from "node:util";
import {
  FixtureMetadataUpdate,
  OutrightFixtureUpdate,
  OutrightScoreUpdate,
  OutrightFixtureMarketUpdate,
  OutrightSettlementsUpdate,
  LivescoreUpdate,
  MarketUpdate,
  SettlementUpdate,
  HeartbeatUpdate,
  KeepAliveUpdate,
  TransformerUtil,
  IdSafeJsonParser,
  knownEntityKeys,
} from "trade360-nodejs-sdk";
import type {
  FeedMessageMetadata,
  IntegrationDiagnostic,
} from "@lsports/contracts";
import type { TradeEvent } from "./state.js";
import { OperationError } from "./diagnostics.js";
export interface MessageProperties {
  contentType?: string;
  contentEncoding?: string;
  timestamp?: number;
}
export interface Decoded {
  guid: string;
  at: number;
  events: TradeEvent[];
  interrupted: boolean;
  type: number;
  metadata: FeedMessageMetadata;
  keepAliveActiveEvents?: number;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const scalar = (value: unknown) =>
  Buffer.isBuffer(value)
    ? value.toString("utf8")
    : typeof value === "string" || typeof value === "number"
      ? String(value)
      : undefined;
const date = (value: unknown) => {
  const ms =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(ms) && ms > 0 && ms <= 8640000000000000
    ? ms
    : undefined;
};
const utf8 = new TextDecoder("utf-8", { fatal: true });
export function decodeMessage(
  content: Buffer,
  headers: Record<string, unknown> = {},
  properties: MessageProperties = {},
  redelivered = false,
  limits = { wireBytes: 50 * 1024 * 1024, decodedBytes: 50 * 1024 * 1024 },
): Decoded {
  const mime = properties.contentType?.split(";")[0].trim().toLowerCase();
  const encoding = properties.contentEncoding?.trim().toLowerCase();
  const safeMimes = new Set([
    "application/json",
    "text/json",
    "text/plain",
    "application/octet-stream",
    "application/gzip",
    "application/x-gzip",
  ]);
  const safeEncodings = new Set([
    "utf8",
    "utf-8",
    "identity",
    "gzip",
    "x-gzip",
    "deflate",
    "br",
  ]);
  const gzip =
    content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b;
  const zlib =
    content.length >= 2 &&
    (content[0] & 15) === 8 &&
    ((content[0] << 8) + content[1]) % 31 === 0;
  const signature: FeedMessageMetadata["signature"] = !content.length
    ? "empty"
    : gzip
      ? "gzip"
      : zlib
        ? "zlib"
        : content[0] === 123
          ? "json_object"
          : content[0] === 91
            ? "json_array"
            : "other";
  const metadata: FeedMessageMetadata = {
    wireBytes: content.length,
    contentType: !mime
      ? "unspecified"
      : safeMimes.has(mime)
        ? mime
        : mime.endsWith("+json")
          ? "application/*+json"
          : "other",
    contentEncoding: !encoding
      ? "unspecified"
      : safeEncodings.has(encoding)
        ? encoding
        : "other",
    signature,
    amqpHeadersPresent: [
      "MessageGuid",
      "MessageType",
      "timestamp_in_ms",
      "MessageSequence",
      "FixtureId",
      "MarketId",
      "SportId",
    ].filter((key) => Object.hasOwn(headers, key)),
    redelivered,
    warnings: [],
  };
  const fail = (
    reason: NonNullable<IntegrationDiagnostic["reason"]>,
    stage: NonNullable<IntegrationDiagnostic["decodeStage"]>,
    message: string,
    fields?: string[],
  ): never => {
    throw new OperationError({
      operation: "feed.decode",
      protocol: "amqp",
      category:
        reason === "unsupported_message_type" ||
        reason === "unsupported_content_encoding" ||
        reason === "unsupported_content_type"
          ? "unsupported_message"
          : "invalid_message",
      reason,
      decodeStage: stage,
      message,
      messageMetadata: structuredClone(metadata),
      ...(fields ? { fields } : {}),
    });
  };
  if (content.length > limits.wireBytes)
    fail(
      "message_too_large",
      "properties",
      "El mensaje supera el límite local de bytes recibidos.",
    );
  // The official SDK parses JSON regardless of MIME. Unknown MIME is observable,
  // but does not invalidate an otherwise valid JSON envelope.
  if (mime && !safeMimes.has(mime) && !mime.endsWith("+json"))
    metadata.warnings!.push("unrecognized_content_type");
  if (encoding && !safeEncodings.has(encoding))
    fail(
      "unsupported_content_encoding",
      "properties",
      "contentEncoding no soportado. No se interpreta ni descarta el mensaje.",
      ["properties.contentEncoding"],
    );
  const charset = properties.contentType
    ?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]
    ?.toLowerCase();
  if (charset && !["utf8", "utf-8"].includes(charset))
    fail(
      "unsupported_content_encoding",
      "properties",
      "El charset declarado no es UTF-8.",
      ["properties.contentType.charset"],
    );
  let bytes = content;
  metadata.compression =
    encoding === "gzip" ||
    encoding === "x-gzip" ||
    mime === "application/gzip" ||
    mime === "application/x-gzip"
      ? "gzip"
      : encoding === "deflate"
        ? "deflate"
        : encoding === "br"
          ? "br"
          : gzip
            ? "gzip"
            : zlib
              ? "deflate"
              : "none";
  if (
    (gzip || zlib) &&
    (!encoding || ["utf8", "utf-8", "identity"].includes(encoding))
  )
    metadata.warnings!.push("compression_detected_by_signature");
  try {
    if (metadata.compression === "gzip")
      bytes = gunzipSync(content, { maxOutputLength: limits.decodedBytes });
    else if (metadata.compression === "deflate")
      bytes = inflateSync(content, { maxOutputLength: limits.decodedBytes });
    else if (metadata.compression === "br")
      bytes = brotliDecompressSync(content, {
        maxOutputLength: limits.decodedBytes,
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE")
      fail(
        "message_too_large",
        "decompress",
        "El mensaje descomprimido supera el límite local.",
      );
    fail(
      "decompression_failed",
      "decompress",
      "No se pudo descomprimir el mensaje con el formato declarado o detectado.",
    );
  }
  metadata.decodedBytes = bytes.length;
  if (bytes.length > limits.decodedBytes)
    fail(
      "message_too_large",
      "decompress",
      "El mensaje descomprimido supera el límite local.",
    );
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    fail("invalid_utf8", "text", "El mensaje no contiene UTF-8 válido.");
  }
  let parsed: unknown;
  try {
    parsed = IdSafeJsonParser.parse(text!);
  } catch {
    fail(
      "invalid_json",
      "json",
      "El mensaje no contiene JSON válido después de interpretar encoding y compresión.",
    );
  }
  metadata.rootShape =
    parsed === null
      ? "null"
      : Array.isArray(parsed)
        ? "array"
        : (typeof parsed as FeedMessageMetadata["rootShape"]);
  if (!object(parsed) || !object(parsed.Header))
    fail(
      "invalid_envelope",
      "envelope",
      "Se esperaba un objeto JSON con Header y Body, según WrappedMessage del SDK.",
      ["Header"],
    );
  const envelope = parsed as Record<string, unknown>;
  const header = envelope.Header as Record<string, unknown>;
  const rawType = header.Type ?? scalar(headers.MessageType);
  const type =
    typeof rawType === "number"
      ? rawType
      : typeof rawType === "string" && /^\d+$/.test(rawType)
        ? Number(rawType)
        : NaN;
  if (!Number.isInteger(type) || type < 1 || type > 65535)
    fail(
      "invalid_message_headers",
      "envelope",
      "Header.Type no es un tipo de mensaje válido.",
      ["Header.Type", "MessageType"],
    );
  metadata.messageType = type;
  metadata.messageTypeName = knownEntityKeys.get(type) || "unknown";
  if (header.Type === undefined)
    metadata.warnings!.push("message_type_from_transport");
  const transportType = Number(scalar(headers.MessageType));
  if (Number.isFinite(transportType) && transportType !== type)
    metadata.warnings!.push("transport_type_differs_from_envelope");
  const envelopeGuid =
    typeof header.MsgGuid === "string" ? header.MsgGuid.trim() : undefined;
  let guid = envelopeGuid || scalar(headers.MessageGuid)?.trim();
  if (!guid && (type === 31 || type === 32)) {
    guid = `control:${createHash("sha256").update(content).digest("hex")}`;
    metadata.guidSource = "control_fingerprint";
    metadata.warnings!.push("control_without_guid");
  }
  if (!guid || guid.length > 512)
    fail(
      "invalid_message_headers",
      "transport_headers",
      "Falta identificador estable en Header.MsgGuid y MessageGuid.",
      ["Header.MsgGuid", "MessageGuid"],
    );
  metadata.guidSource ??= envelopeGuid ? "envelope" : "transport";
  if (!headers.MessageGuid) metadata.warnings!.push("transport_guid_absent");
  if (![1, 2, 3, 31, 32, 35, 37, 39, 41, 42].includes(type))
    fail(
      "unsupported_message_type",
      "entity",
      "Tipo de mensaje recibido sin un handler implementado. Se conserva en la cola; requiere soporte explícito.",
    );
  const transportAt = Number(scalar(headers.timestamp_in_ms));
  let at = date(transportAt);
  metadata.timestampSource = "timestamp_in_ms";
  if (!at) {
    at =
      typeof properties.timestamp === "number"
        ? date(properties.timestamp * 1000)
        : undefined;
    metadata.timestampSource = "amqp_timestamp";
  }
  if (!at) {
    at = date(header.ServerTimestamp);
    metadata.timestampSource = "server_timestamp";
  }
  if (!at) {
    at = date(header.CreationDate);
    metadata.timestampSource = "creation_date";
  }
  if (!at && (type === 31 || type === 32)) {
    at = Date.now();
    metadata.timestampSource = "received_control";
    metadata.warnings!.push("control_without_provider_timestamp");
  }
  if (!at)
    fail(
      "missing_timestamp",
      "transport_headers",
      "No hay timestamp válido para ordenar actualizaciones del evento. No se inventa tiempo del proveedor.",
      [
        "timestamp_in_ms",
        "properties.timestamp",
        "Header.ServerTimestamp",
        "Header.CreationDate",
      ],
    );
  if (metadata.timestampSource !== "timestamp_in_ms")
    metadata.warnings!.push("transport_timestamp_absent_or_invalid");
  const body = envelope.Body;
  if (
    type !== 31 &&
    type !== 32 &&
    ![37, 39, 41, 42].includes(type) &&
    (!object(body) || !Array.isArray(body.Events))
  )
    fail(
      "invalid_event_body",
      "entity",
      "El tipo de actualización requiere Body.Events como array.",
      ["Body.Events"],
    );
  if ([37, 39, 41, 42].includes(type)) {
    if (!object(body) || !object(body.Competition) ||
        !Number.isSafeInteger(body.Competition.Id) || Number(body.Competition.Id) <= 0 ||
        !Array.isArray(body.Competition.Events))
      fail("invalid_event_body", "entity", "Outright requiere Competition con ID y Events válidos.", ["Body.Competition"]);
    const competition = (body as Record<string, unknown>).Competition as Record<string, unknown>;
    const rawEvents = competition.Events as unknown[];
    if (type === 39 && rawEvents.some(event => {
      if (!object(event) || !object(event.OutrightScore)) return true;
      const score = event.OutrightScore;
      return (score.Status !== undefined && (!Number.isInteger(score.Status) || Number(score.Status) < 0)) ||
        (score.ParticipantResults !== undefined && (!Array.isArray(score.ParticipantResults) || score.ParticipantResults.some((p: unknown) =>
          !object(p) || (p.ParticipantId !== undefined && (!Number.isSafeInteger(p.ParticipantId) || Number(p.ParticipantId) <= 0)) ||
          (p.Name !== undefined && typeof p.Name !== "string") ||
          (p.Result !== undefined && (typeof p.Result !== "number" || !Number.isFinite(p.Result))))));
    })) fail("invalid_event_body", "entity", "OutrightScore o ParticipantResults inválidos; se conserva el mensaje.", ["Body.Competition.Events.OutrightScore"]);
    if (rawEvents.some((event) => !object(event) || (type === 37
      ? !object(event.OutrightFixture) || (event.OutrightFixture.Participants !== undefined &&
          (!Array.isArray(event.OutrightFixture.Participants) || event.OutrightFixture.Participants.some((p: unknown) => !object(p))))
      : type === 39 ? !object(event.OutrightScore) : !Array.isArray(event.Markets) || event.Markets.some((market: unknown) => !object(market) ||
          !Number.isSafeInteger(market.Id) || Number(market.Id) <= 0 ||
          (market.Bets !== undefined && (!Array.isArray(market.Bets) || market.Bets.some((bet: unknown) => !object(bet))))))))
      fail("invalid_event_body", "entity", "Evento outright sin fixture o mercados válidos; se conserva para reprocesar.", ["Body.Competition.Events"]);
    if (type === 39) metadata.participantResultCount = rawEvents.reduce<number>((count, event) => {
      const score = (event as Record<string, unknown>).OutrightScore as Record<string, unknown>;
      return count + (Array.isArray(score.ParticipantResults) ? score.ParticipantResults.length : 0);
    }, 0);
    metadata.marketCount = rawEvents.reduce<number>((count, event) => count +
      (Array.isArray((event as Record<string, unknown>).Markets) ? ((event as Record<string, unknown>).Markets as unknown[]).length : 0), 0);
    metadata.betCount = rawEvents.reduce<number>((count, event) => {
      const markets = (event as Record<string, unknown>).Markets;
      return count + (Array.isArray(markets) ? markets.reduce((n, m) => n + (object(m) && Array.isArray(m.Bets) ? m.Bets.length : 0), 0) : 0);
    }, 0);
  }
  if ((type === 31 || type === 32) && body != null && !object(body))
    fail(
      "invalid_event_body",
      "entity",
      "El cuerpo de control debe ser objeto, null o ausente.",
      ["Body"],
    );
  if (
    type === 32 &&
    object(body) &&
    body.FeedInterrupted !== undefined &&
    (!Array.isArray(body.FeedInterrupted) ||
      body.FeedInterrupted.some((v) => typeof v !== "number"))
  )
    fail(
      "invalid_event_body",
      "entity",
      "FeedInterrupted debe ser un array de códigos numéricos.",
      ["Body.FeedInterrupted"],
    );
  let events: TradeEvent[] = [];
  let interrupted = false;
  let keepAliveActiveEvents: number | undefined;
  try {
    const value = (body || {}) as Record<string, unknown>;
    if (type === 37) {
      const competition = TransformerUtil.transform(value, OutrightFixtureUpdate).competition;
      if (!competition || !Array.isArray(competition.events)) throw new Error("Invalid competition");
      events = competition.events.map((event) => ({
        fixtureId: event.fixtureId,
        outright: { competitionId: competition.id!, competitionName: competition.name,
          competitionType: competition.type, fixture: event.outrightFixture! },
      }));
      if (events.length !== ((value.Competition as Record<string, unknown>).Events as unknown[]).length)
        throw new Error("Conversion lost events");
    }
    if (type === 39) {
      const competition = TransformerUtil.transform(value, OutrightScoreUpdate).competition;
      if (!competition || !Array.isArray(competition.events)) throw new Error("Invalid score competition");
      events = competition.events.map(event => ({ fixtureId: event.fixtureId,
        outright: {competitionId: competition.id!, competitionName: competition.name, competitionType: competition.type},
        outrightScore: event.outrightScore,
      }));
      if (events.length !== ((value.Competition as Record<string, unknown>).Events as unknown[]).length)
        throw new Error("Conversion lost score events");
    }
    if (type === 41 || type === 42) {
      const competition = type === 41
        ? TransformerUtil.transform(value, OutrightFixtureMarketUpdate).competition
        : TransformerUtil.transform(value, OutrightSettlementsUpdate).competition;
      if (!competition || !Array.isArray(competition.events)) throw new Error("Invalid competition");
      events = competition.events.map((event, index) => ({
        fixtureId: event.fixtureId,
        outright: { competitionId: competition.id!, competitionName: competition.name, competitionType: competition.type },
        markets: event.markets,
        marketMessageType: type,
        settlementInspection: inspectSettlements(((value.Competition as Record<string, unknown>).Events as Record<string, unknown>[])[index].Markets, event.markets || []),
      }));
      if (events.length !== ((value.Competition as Record<string, unknown>).Events as unknown[]).length)
        throw new Error("Conversion lost events");
    }
    if (type === 1)
      events =
        TransformerUtil.transform(value, FixtureMetadataUpdate).events || [];
    if (type === 2)
      events = (TransformerUtil.transform(value, LivescoreUpdate).events ||
        []) as TradeEvent[];
    if (type === 3)
      events = TransformerUtil.transform(value, MarketUpdate).events || [];
    if (type === 35)
      events = TransformerUtil.transform(value, SettlementUpdate).events || [];
    if (type === 32)
      interrupted = !!TransformerUtil.transform(value, HeartbeatUpdate)
        .feedInterrupted?.length;
    if (type === 31) {
      const keepAlive = TransformerUtil.transform(
        value,
        KeepAliveUpdate,
      ).keepAlive;
      if (Array.isArray(keepAlive?.activeEvents))
        keepAliveActiveEvents = keepAlive.activeEvents.length;
    }
  } catch {
    fail(
      "entity_conversion",
      "entity",
      "El SDK no pudo convertir la entidad. No se publica el ID ni el contenido que provocó el error.",
    );
  }
  if (
    events.some(
      (e) =>
        !Number.isSafeInteger(e.fixtureId) ||
        e.fixtureId <= 0 ||
        (type === 1 && !e.fixture) ||
        (type === 37 && !e.outright?.fixture) ||
        (type === 39 && !e.outrightScore) ||
        ([3, 35, 41, 42].includes(type) && !Array.isArray(e.markets)) ||
        (type === 2 && !e.livescore && !e.fixture),
    )
  )
    fail(
      "invalid_event_body",
      "entity",
      "La entidad contiene un evento sin ID seguro o sin los campos requeridos para su tipo.",
    );
  if ([41, 42].includes(type) && events.some((event) => event.markets?.some((market) =>
      market.bets?.some((bet) => typeof bet.id !== "string" || !bet.id.trim()))))
    fail("invalid_event_body", "entity", "Selección outright sin ID estable; no se confirma el mensaje.");
  metadata.eventCount = events.length;
  return {
    guid: guid!,
    at: at!,
    events,
    interrupted,
    type,
    metadata,
    keepAliveActiveEvents,
  };
}
