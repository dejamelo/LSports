import type { TradeEvent } from "./state.js";
export function snapshotEvidence(payload: unknown, rows: TradeEvent[]) {
  const obj = (value: unknown): value is Record<string, any> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const body = obj(payload) ? payload.Body : undefined;
  const raw: Array<Record<string, any>> | undefined = Array.isArray(body)
    ? body
    : obj(body) && Number.isSafeInteger(body.FixtureId)
      ? [body]
      : undefined;
  const count = (values: unknown[]) =>
    values.reduce<Record<string, number>>((out, n) => {
      const key = Number.isInteger(n) ? String(n) : "missing";
      out[key] = (out[key] || 0) + 1;
      return out;
    }, {});
  const markets =
    raw?.flatMap((r) => (Array.isArray(r.Markets) ? r.Markets : [])) ?? [];
  const sdkMarkets = rows.flatMap((r) => r.markets ?? []);
  return {
    rawStructureRecognized: !!raw,
    providerFixtureStatusCounts: raw
      ? count(raw.map((r) => r.Fixture?.Status))
      : null,
    sdkFixtureStatusCounts: count(rows.map((r) => r.fixture?.status)),
    providerMarketStatusCounts: raw
      ? count(markets.map((m) => m.Status))
      : null,
    sdkMarketStatusCounts: count(sdkMarkets.map((m) => m.status)),
    providerMarkets: raw ? markets.length : null,
    sdkMarkets: sdkMarkets.length,
    providerPricedSelections: raw
      ? markets
          .flatMap((m) => (Array.isArray(m.Bets) ? m.Bets : []))
          .filter(
            (b) => Number.isFinite(Number(b.Price)) && Number(b.Price) > 1,
          ).length
      : null,
    sdkPricedSelections: sdkMarkets
      .flatMap((m) => m.bets ?? [])
      .filter((b) => Number.isFinite(Number(b.price)) && Number(b.price) > 1)
      .length,
    examples:
      raw
        ?.filter((r) => Number.isSafeInteger(r.FixtureId) && r.FixtureId > 0)
        .slice(0, 5)
        .map((r) => ({
          fixtureId: r.FixtureId,
          status: Number.isInteger(r.Fixture?.Status) ? r.Fixture.Status : null,
        })) ?? [],
  };
}
