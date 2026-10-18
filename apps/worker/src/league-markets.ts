import {
  OutrightLeagueMarketUpdate,
  TransformerUtil,
} from "trade360-nodejs-sdk";
import { OperationError } from "./diagnostics.js";
import {
  normalizeSdkTimestamps,
  attachTimestampPrecision,
  hasInvalidProviderTimestamp,
} from "./timestamp-contract.js";
import { inspectSettlements } from "./settlement-evidence.js";
import type { TradeEvent } from "./state.js";
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
const invalid = (): never => {
  throw new OperationError({
    operation: "feed.decode",
    protocol: "amqp",
    category: "invalid_message",
    reason: "invalid_event_body",
    decodeStage: "entity",
    message:
      "Tipo 40 requiere Competition.Competitions[].Events[].Markets; no se confirma el mensaje.",
  });
};
/** Type 40 is a league/season hierarchy, not the flat fixture message 41. */
export function leagueMarketEvents(body: unknown): TradeEvent[] {
  if (!object(body) || !object(body.Competition)) return invalid();
  const raw = body.Competition;
  if (
    !id(raw.Id) ||
    Object.hasOwn(raw, "Events") ||
    !Array.isArray(raw.Competitions)
  )
    return invalid();
  for (const season of raw.Competitions) {
    if (!object(season) || !id(season.Id) || !Array.isArray(season.Events))
      return invalid();
    for (const event of season.Events) {
      if (
        !object(event) ||
        !id(event.FixtureId) ||
        !Array.isArray(event.Markets)
      )
        return invalid();
      for (const market of event.Markets) {
        if (
          !object(market) ||
          !id(market.Id) ||
          (market.Bets !== undefined &&
            (!Array.isArray(market.Bets) ||
              market.Bets.some((b: unknown) => !object(b))))
        )
          return invalid();
      }
    }
  }
  if (hasInvalidProviderTimestamp(body))
    throw new OperationError({
      operation: "feed.decode",
      protocol: "amqp",
      category: "invalid_message",
      reason: "invalid_timestamp",
      decodeStage: "entity",
      message: "LastUpdate inválido en tipo 40; no se aplica la actualización.",
    });
  const sdk = TransformerUtil.transform(
    normalizeSdkTimestamps(body),
    OutrightLeagueMarketUpdate,
  );
  attachTimestampPrecision(body, sdk);
  const competition = sdk.competition;
  if (
    !competition ||
    competition.id !== raw.Id ||
    competition.competitions?.length !== raw.Competitions.length
  )
    return invalid();
  const events: TradeEvent[] = [];
  for (const [s, season] of competition.competitions.entries()) {
    const original = raw.Competitions[s] as Record<string, unknown>;
    const rawEvents = original.Events as Record<string, unknown>[];
    if (season.id !== original.Id || season.events?.length !== rawEvents.length)
      return invalid();
    for (const [i, event] of season.events.entries()) {
      if (
        event.fixtureId !== rawEvents[i].FixtureId ||
        !Array.isArray(event.markets) ||
        event.markets.some((m) =>
          m.bets?.some((b) => typeof b.id !== "string" || !b.id.trim()),
        )
      )
        return invalid();
      const inspection = inspectSettlements(
        rawEvents[i].Markets,
        event.markets,
        "amqp",
        { competitionId: competition.id!, fixtureId: event.fixtureId },
      );
      events.push({
        fixtureId: event.fixtureId,
        outright: {
          competitionId: competition.id!,
          competitionName: competition.name,
          competitionType: competition.type,
          leagueSeason: {
            id: season.id!,
            name: season.name,
            type: season.type,
          },
          fixtureName: event.fixtureName,
        },
        markets: event.markets,
        marketMessageType: 40,
        settlementInspection: inspection,
      });
    }
  }
  return events;
}
