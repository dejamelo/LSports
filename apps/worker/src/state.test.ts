import { test } from "node:test";
import assert from "node:assert/strict";
import { TradeState, classifySport } from "./state.js";
import type { TradeEvent } from "./state.js";
const at = 1700000000000;
export const fixture = (): TradeEvent => ({
  fixtureId: 100,
  fixture: {
    sport: { id: 6046, name: "Football" },
    status: 1,
    participants: [
      { position: "1", name: "Equipo A" },
      { position: "2", name: "Equipo B" },
    ],
  },
  markets: [
    {
      id: 1,
      name: "1X2",
      status: 1,
      bets: [
        {
          id: "9223372036854775807",
          name: "1",
          price: "2.10",
          status: 1,
          isChanged: 0,
        },
        { id: "2", name: "X", price: "3.20", status: 1, isChanged: 0 },
      ],
    },
  ],
});
test("snapshot + deltas preserve unrelated bets, reject older odds, suspend markets and clear removed fixtures", () => {
  const state = new TradeState();
  state.replace("prematch", [fixture()], at);
  state.set("prematch", { phase: "connected" });
  assert.equal(state.feed().events[0].selections[0].available, true);
  state.apply(
    "prematch",
    [
      {
        fixtureId: 100,
        markets: [
          {
            id: 1,
            bets: [{ id: "2", price: "3.80", status: 1, isChanged: 0 }],
          },
        ],
      },
    ],
    at + 2000,
  );
  state.apply(
    "prematch",
    [
      {
        fixtureId: 100,
        markets: [
          {
            id: 1,
            bets: [{ id: "2", price: "3.00", status: 1, isChanged: 0 }],
          },
        ],
      },
    ],
    at + 1000,
  );
  assert.equal(state.feed().events[0].selections.length, 2);
  assert.equal(state.feed().events[0].selections[1].odds, 3.8);
  state.apply(
    "prematch",
    [{ fixtureId: 100, markets: [{ id: 1, status: 2 }] }],
    at + 3000,
  );
  assert(state.feed().events[0].selections.every((s) => !s.available));
  state.replace("prematch", [], at + 4000);
  assert.deepEqual(state.feed().events, []);
});
test("publication projection reuses unchanged fixtures, remasks availability and invalidates changed rows", () => {
  const state = new TradeState();
  state.replace("prematch", [fixture()], at);
  state.set("prematch", { phase: "connected" });

  const first = [...state.projection(at, false).events][0];
  const unchanged = [...state.projection(at + 1000, false).events][0];
  assert.strictEqual(unchanged, first);
  assert.equal(unchanged.selections[0].available, true);

  state.set("prematch", { phase: "recovering" });
  assert.equal([...state.projection(at + 2000, false).events][0].selections[0].available, false);
  state.set("prematch", { phase: "connected" });
  assert.equal([...state.projection(at + 3000, false).events][0].selections[0].available, true);

  state.apply("prematch", [{ fixtureId: 100, markets: [{ id: 1, bets: [{ id: "2", price: "3.80", status: 1, isChanged: 0 }] }] }], at + 4000);
  const changed = [...state.projection(at + 4000, false).events][0];
  assert.notStrictEqual(changed, first);
  assert.equal(changed.selections[1].odds, 3.8);
});
test("publication coverage reuses unchanged row summaries and remasks dynamic feed availability", () => {
  const state = new TradeState();
  state.replace("prematch", [fixture()], at);
  state.set("prematch", { phase: "connected" });

  const coverage = () => state.projection(at, false).coverage!.prematch;
  assert.equal(coverage().eventsWithMarkets, 1);
  assert.equal(coverage().eventsWithSelections, 1);
  assert.equal(coverage().eventsWithSelectableOdds, 1);
  assert.equal(coverage().eventsWithSelectableOdds, 1);

  state.set("prematch", { ingressProgress: { processingBacklog: 1, oldestProcessingAgeMs: 5001 } as any });
  assert.equal(coverage().eventsWithSelectableOdds, 0);
  state.set("prematch", { ingressProgress: { processingBacklog: 0, oldestProcessingAgeMs: 0 } as any });
  assert.equal(coverage().eventsWithSelectableOdds, 1);

  state.apply("prematch", [{ fixtureId: 100, markets: [{ id: 1, status: 2 }] }], at + 1);
  assert.equal(coverage().eventsWithSelectableOdds, 0);
});
test("disconnects, settlement and terminal fixtures disable selection; inplay wins duplicate", () => {
  const state = new TradeState();
  state.replace("prematch", [fixture()], at);
  assert(!state.feed().events[0].available);
  state.set("prematch", { phase: "connected" });
  state.apply(
    "prematch",
    [
      {
        fixtureId: 100,
        markets: [{ id: 1, bets: [{ id: "2", settlement: 2, isChanged: 0 }] }],
      },
    ],
    at + 1,
  );
  assert.equal(state.feed().events[0].selections[1].available, false);
  state.replace(
    "inplay",
    [{ ...fixture(), fixture: { ...fixture().fixture, status: 2 } }],
    at,
  );
  state.set("inplay", { phase: "connected" });
  assert.equal(state.feed().events.length, 1);
  assert.equal(state.feed().events[0].source, "inplay");
  state.apply(
    "inplay",
    [{ fixtureId: 100, livescore: { scoreboard: { status: 3 } } }],
    at + 3000,
  );
  assert.equal(
    state.feed().events.find((e) => e.source === "inplay")?.available,
    false,
  );
});
test("horse racing is observed from events, not inferred from catalog or absence", () => {
  const state = new TradeState();
  assert.equal(state.feed().horseRacing?.status, "unknown");
  for (const lane of ["prematch", "inplay"] as const) {
    state.replace(lane, [], at);
    state.set(lane, { catalogHorseRacing: true });
  }
  assert.equal(state.feed().horseRacing?.status, "not_observed");
  state.apply(
    "prematch",
    [{ fixtureId: 200, fixture: { sport: { name: "Horse Racing" } } }],
    at,
  );
  assert.equal(state.feed().horseRacing?.status, "observed");
  assert.equal(classifySport("American Football"), "otros");
});
