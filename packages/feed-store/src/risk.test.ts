import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformStore } from "./platform.js";
import { TenantTickets } from "./tenant-tickets.js";
import { defaultRiskConfig, riskObservationMayExist } from "./operation-risk.js";
import { MAX_SHARED_RECONCILIATION_RECORDS, sharedReconciliationFeed } from "./tenant-tickets.js";
import { exposure } from "./risk-exposure.js";
import type { EventFeed, TestTicket } from "@lsports/contracts";
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "adl-risk-test-"));
  const platform = new PlatformStore(dir);
  await platform.bootstrap("admin@test.example", "isolated-password-platform");
  const admin = (
    await platform.login(
      "admin@test.example",
      "isolated-password-platform",
      "test",
    )
  ).admin;
  const client = await platform.createClient(admin, {
      name: "ISOLATED",
      adminEmail: "client@test.example",
      adminPassword: "isolated-client-password",
    }),
    op = platform.createOperation(admin, client.id, {
      name: "ARS",
      country: "AR",
      currency: "ARS",
    }),
    registry = new TenantTickets(platform),
    store = registry.store(op.id);
  const feed = {
    mode: "connected",
    health: "ok",
    updatedAt: new Date().toISOString(),
    connections: { prematch: { phase: "connected" } },
    events: [
      {
        id: "prematch:9001",
        source: "prematch",
        available: true,
        status: 1,
        time: "INICIO DE PRUEBA",
        live: false,
        markets: [
          {
            id: "160",
            name: "Race Winner ISOLATED",
            status: 1,
            selections: [
              {
                id: "runner",
                label: "SYNTHETIC A",
                available: true,
                status: 1,
                odds: 2,
              },
              {
                id: "other",
                label: "SYNTHETIC B",
                available: true,
                status: 1,
                odds: 3,
              },
            ],
          },
        ],
      },
    ],
  } as EventFeed;
  const input = {
    clientId: client.id,
    operationId: op.id,
    currency: "ARS",
    channel: "web",
    stakeMinor: "100",
    selections: [
      {
        eventId: "prematch:9001",
        marketId: "160",
        selectionId: "runner",
        expectedOdds: 2,
      },
    ],
  };
  const create = (
    key: string,
    amount = "100",
    player = "stable",
    channel = "web",
  ) =>
    store.create(
      {
        ...input,
        stakeMinor: amount,
        channel,
        ...(channel === "pos" ? { terminalId: "POS-0001" } : {}),
      },
      player,
      key,
      () => {
        feed.updatedAt = new Date().toISOString();
        return feed;
      },
    );
  return {
    dir,
    platform,
    admin,
    client,
    op,
    registry,
    store,
    feed,
    input,
    create,
    close: async () => {
      registry.close();
      platform.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("scenario exposure distinguishes mutually exclusive singles, gross liability and conservative multiple bounds with integer amounts", () => {
  const make = (
    id: string,
    stake: number,
    legs: { selectionId: string; oddsMicros: number }[],
  ) =>
    ({
      id,
      status: "PENDING",
      stakeMinor: stake,
      selections: legs.map((l) => ({
        ...l,
        eventId: "prematch:9001",
        marketId: "160",
      })),
    }) as TestTicket;
  const a = make("a", 10, [{ selectionId: "winner-a", oddsMicros: 3000000 }]),
    b = make("b", 20, [{ selectionId: "winner-b", oddsMicros: 2000000 }]);
  const result = exposure([a, b], ["160"]);
  assert.equal(result.stakeMinor, "30");
  assert.equal(result.potentialGrossMinor, "70");
  assert.equal(result.conservativeNetLowerBoundMinor, "-40");
  assert.equal(
    result.simpleMarkets[0].scenarios.find((s) => s.selectionId === "winner-b")!
      .netResultMinor,
    "-10",
  );
  assert.equal(
    result.simpleMarkets[0].scenarios.find((s) => s.selectionId === "winner-a")!
      .netResultMinor,
    "0",
  );
  const multiple = make("multiple", 5, [
    { selectionId: "a", oddsMicros: 2000000 },
    { selectionId: "b", oddsMicros: 3000000 },
  ]);
  const combined = exposure([a, b, multiple], ["160"]);
  assert.equal(combined.multiples.potentialGrossBoundMinor, "30");
  assert.equal(
    combined.multiples.methodology,
    "all_legs_win_conservative_bound_not_exact_loss",
  );
  assert.equal(exposure([a, b], []).simpleMarkets[0].scenarios.length, 0);
});
test("informational alerts do not block, duplicate replay does not duplicate alerts; explicit blocking rolls back ticket and reservations with audit", async () => {
  const s = await setup();
  try {
    let config = defaultRiskConfig();
    config.rules.largeStake = {
      ...config.rules.largeStake,
      enabled: true,
      thresholdMinor: "99",
      action: "alert",
    };
    s.store.risk.configure(s.admin, config);
    const ticket = s.create("informative-key");
    assert.equal(s.create("informative-key").id, ticket.id);
    let dash = s.store.risk.dashboard();
    assert.equal(dash.alerts.length, 1);
    assert.equal(dash.alerts[0].occurrences, 1);
    assert.equal(dash.exposure.pendingTickets, 1);
    config.rules.largeStake.action = "block";
    s.store.risk.configure(s.admin, config);
    assert.throws(() => s.create("blocked-request"), {
      code: "RISK_PREVENTIVE_BLOCK",
    });
    assert.equal(s.store.report().acceptedTickets, 1);
    dash = s.store.risk.dashboard();
    assert.equal(dash.alerts.length, 1);
    assert(dash.alerts[0].ticketIds.includes(ticket.id));
    assert.match(JSON.stringify(dash.audit), /risk.preventive.block/);
    const alert = dash.alerts[0];
    s.store.risk.updateAlert(s.admin, alert.id, {
      status: "review",
      assignee: "operator@test.example",
      note: "Revisión manual sin alterar billetes.",
    });
    s.store.risk.updateAlert(s.admin, alert.id, {
      status: "closed",
      assignee: "operator@test.example",
      note: "Cerrada la revisión.",
    });
    assert.equal(s.store.risk.dashboard().alerts[0].status, "closed");
    assert.equal(s.store.get(ticket.id)!.selections[0].acceptedOdds, 2);
    assert.equal(s.store.get(ticket.id)!.status, "PENDING");
  } finally {
    await s.close();
  }
});
test("historical size requires sufficient samples; frequency and fragmentation share player identity across web/mobile/POS", async () => {
  const s = await setup();
  try {
    const config = defaultRiskConfig();
    config.rules.unusualStake = {
      ...config.rules.unusualStake,
      enabled: true,
      minHistory: 3,
      multiplierBps: 20000,
    };
    config.rules.frequency = {
      ...config.rules.frequency,
      enabled: true,
      maxTickets: 3,
    };
    config.rules.fragmentation = {
      ...config.rules.fragmentation,
      enabled: true,
      maxTickets: 3,
      thresholdMinor: "250",
    };
    s.store.risk.configure(s.admin, config);
    s.create("history-one", "100", "stable", "web");
    s.create("history-two", "100", "stable", "mobile");
    assert(
      !s.store.risk.dashboard().alerts.some((a) => a.kind === "unusualStake"),
    );
    s.create("history-three", "100", "stable", "pos");
    s.create("history-large", "500", "stable", "web");
    const kinds = s.store.risk.dashboard().alerts.map((a) => a.kind);
    assert(kinds.includes("unusualStake"));
    assert(kinds.includes("frequency"));
    assert(kinds.includes("fragmentation"));
    s.create("another-player", "500", "different", "mobile");
    assert.equal(
      s.store.risk
        .dashboard({ playerId: "different" })
        .alerts.some((a) => a.kind === "unusualStake"),
      false,
    );
  } finally {
    await s.close();
  }
});
test("event/market/selection suspension applies to POS and preserves accepted ticket result processing and accepted price", async () => {
  const s = await setup();
  try {
    const ticket = s.create("before-suspension");
    s.store.risk.suspend(s.admin, {
      kind: "selection",
      eventId: "9001",
      marketId: "160",
      selectionId: "runner",
      active: true,
      reason: "Revisión operativa",
    });
    assert.throws(() => s.create("blocked-pos", "100", "stable", "pos"), {
      code: "RISK_TARGET_SUSPENDED",
    });
    assert.equal(s.store.report().acceptedTickets, 1);
    s.feed.ticketOutcomes = [
      {
        eventId: "prematch:9001",
        marketId: "160",
        selectionId: "runner",
        settlement: 1,
        updatedAt: new Date().toISOString(),
      },
    ];
    s.store.reconcile(s.feed);
    const result = s.store.get(ticket.id)!;
    assert.equal(result.status, "LOST");
    assert.equal(result.selections[0].acceptedOdds, 2);
    assert.equal(result.revision, 1);
    const projected = s.store.risk.overlay(s.feed);
    assert.equal(
      projected.events[0].markets![0].selections[0].available,
      false,
    );
    assert.equal(s.feed.events[0].markets![0].selections[0].available, true);
  } finally {
    await s.close();
  }
});
test("risk reconciliation and suspension overlay support lazy worker event iterables", async()=>{
  const s=await setup();
  try{
    const events=s.feed.events;
    const streamed={...s.feed,events:{[Symbol.iterator]:function*(){yield* events;}}} as unknown as EventFeed;
    assert.equal(Array.isArray(streamed.events),false);
    assert.doesNotThrow(()=>s.store.reconcile(streamed));
    s.store.risk.suspend(s.admin,{kind:"selection",eventId:"9001",marketId:"160",selectionId:"runner",active:true,reason:"isolated test"});
    const projected=s.store.risk.overlay(streamed);
    assert.equal(Array.isArray(projected.events),false);
    const event=[...projected.events][0];
    assert.equal(event.markets![0].selections[0].available,false);
    assert.equal(s.feed.events[0].markets![0].selections[0].available,true);
  }finally{await s.close();}
});
test("odds-jump rule only evaluates two reliable explicit versions; ambiguous timestamps are ignored and technical blocking remains intact", async () => {
  const s = await setup();
  try {
    const config = defaultRiskConfig();
    config.rules.oddsJump = {
      ...config.rules.oddsJump,
      enabled: true,
      changeBps: 1000,
    };
    s.store.risk.configure(s.admin, config);
    const selection = s.feed.events[0].markets![0].selections[0];
    selection.priceOrderingSafe = true;
    selection.priceVersionAt = "2026-10-18T14:00:00";
    s.store.reconcile(s.feed);
    assert.equal(s.store.risk.dashboard().priceHistory.reliableSamples, 0);
    selection.priceVersionAt = new Date(Date.now() - 1000).toISOString();
    s.store.reconcile(s.feed);
    selection.odds = 3;
    s.input.selections[0].expectedOdds = 3;
    selection.priceVersionAt = new Date().toISOString();
    s.store.reconcile(s.feed);
    s.create("near-odds-jump");
    assert(s.store.risk.dashboard().alerts.some((a) => a.kind === "oddsJump"));
    selection.available = false;
    selection.unavailableReasons = ["ambiguous_snapshot_timestamp"];
    assert.throws(() => s.create("unsafe-timestamp"), {
      code: "SELECTION_UNAVAILABLE",
    });
    assert(s.store.risk.dashboard().alerts.some((a) => a.kind === "technical"));
  } finally {
    await s.close();
  }
});
test("event/market/selection concentration stays scoped and a blocked event does not prevent unrelated events", async () => {
  const s = await setup();
  try {
    const config = defaultRiskConfig();
    for (const kind of [
      "eventConcentration",
      "marketConcentration",
      "selectionConcentration",
    ] as const)
      config.rules[kind] = {
        ...config.rules[kind],
        enabled: true,
        thresholdMinor: "50",
      };
    s.store.risk.configure(s.admin, config);
    s.create("concentration-one");
    for (const kind of [
      "eventConcentration",
      "marketConcentration",
      "selectionConcentration",
    ])
      assert(
        s.store.risk
          .dashboard()
          .alerts.some((a) => a.kind === kind && a.eventId === "9001"),
      );
    config.rules.eventConcentration.action = "block";
    s.store.risk.configure(s.admin, config);
    assert.throws(() => s.create("concentration-denied"), {
      code: "RISK_PREVENTIVE_BLOCK",
    });
    const second = structuredClone(s.feed.events[0]);
    second.id = "prematch:9002";
    s.feed.events.push(second);
    // Existing concentration in 9001 does not block a 1-unit bet in 9002.
    const accepted = s.store.create(
      {
        ...s.input,
        stakeMinor: "1",
        selections: [{ ...s.input.selections[0], eventId: "prematch:9002" }],
      },
      "other",
      "unrelated-event",
      () => s.feed,
    );
    assert(accepted.id);
  } finally {
    await s.close();
  }
});

test("risk reconciliation skips a verified projection with no selectable odds", async () => {
  const s = await setup();
  try {
    let traversed = false;
    const feed = {
      ...s.feed,
      coverage: {
        prematch: { eventsWithSelectableOdds: 0 },
        inplay: { eventsWithSelectableOdds: 0 },
      },
      events: {
        *[Symbol.iterator]() {
          traversed = true;
          throw new Error("zero-odds feed should not be traversed for risk prices");
        },
      },
    } as unknown as EventFeed;
    assert.equal(riskObservationMayExist(feed), false);
    s.store.risk.observe(feed);
    assert.equal(traversed, false);
  } finally {
    await s.close();
  }
});

test("small lazy settlement indexes are shared across tenant reconciliations", () => {
  let walks = 0;
  const outcomes = {
    *[Symbol.iterator]() {
      walks++;
      yield { eventId: "prematch:1", marketId: "160", selectionId: "a", settlement: 1, updatedAt: new Date().toISOString() };
    },
  };
  const feed = { mode: "connected", notice: "", events: [], ticketOutcomes: outcomes } as unknown as EventFeed;
  const shared = sharedReconciliationFeed(feed);
  assert.notEqual(shared, feed);
  assert.equal([...shared.ticketOutcomes!].length, 1);
  assert.equal([...shared.ticketOutcomes!].length, 1);
  assert.equal(walks, 1);
});

test("large lazy reconciliation indexes retain the bounded legacy path", () => {
  let yielded = 0;
  const outcomes = {
    *[Symbol.iterator]() {
      while (yielded < MAX_SHARED_RECONCILIATION_RECORDS + 1) {
        yielded++;
        yield { eventId: "prematch:1", marketId: "160", selectionId: String(yielded), settlement: 1, updatedAt: new Date().toISOString() };
      }
    },
  };
  const feed = { mode: "connected", notice: "", events: [], ticketOutcomes: outcomes } as unknown as EventFeed;
  assert.equal(sharedReconciliationFeed(feed), feed);
  assert.equal(yielded, MAX_SHARED_RECONCILIATION_RECORDS + 1);
});
