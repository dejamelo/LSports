import type {
  EventFeed,
  IntegrationDiagnostic,
  Lane,
  SportEvent,
} from "@lsports/contracts";
import { explainOpenEventExclusions } from "./open-event-diagnostics.js";
const counts = (values: (string | number | undefined)[]) =>
  values.reduce<Record<string, number>>((out, value) => {
    const key = String(value ?? "missing");
    out[key] = (out[key] || 0) + 1;
    return out;
  }, {});
const iso = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) &&
  Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
const id = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9:_-]{1,200}$/.test(value)
    ? value
    : "nonstandard-id";
const safeLabel = (value?:string) => value && /^[a-z_]{1,60}$/.test(value)?value:undefined;
const safeCode = (value?:string) => value && /^[A-Z_]{1,60}$/.test(value)?value:undefined;
const safeName = (value?:string) => value && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(value)?value:undefined;
export const safeFeedDiagnostic = (diagnostic?: IntegrationDiagnostic) =>
  diagnostic
    ? {
        operation: /^[a-z_.]{1,80}$/.test(diagnostic.operation)
          ? diagnostic.operation
          : "unknown",
        category: /^[a-z_]{1,40}$/.test(diagnostic.category)
          ? diagnostic.category
          : "unknown",
        reason:
          diagnostic.reason && /^[a-z_]{1,60}$/.test(diagnostic.reason)
            ? diagnostic.reason
            : undefined,
        httpStatus: diagnostic.httpStatus,
        amqpCode: diagnostic.amqpCode,
        deferred: diagnostic.deferred === true,
        retryAt: iso(diagnostic.retryAt),
        retryAfterMs: diagnostic.retryAfterMs,
        rateLimitSource: diagnostic.rateLimitSource,
        requesterPid: diagnostic.requesterPid,
        coordinator: diagnostic.coordinator ? {
          packageId:diagnostic.coordinator.packageId,pid:diagnostic.coordinator.pid,
          operation:/^[a-z_.]{1,80}$/.test(diagnostic.coordinator.operation)?diagnostic.coordinator.operation:"unknown",
          at:iso(diagnostic.coordinator.at),completedAt:iso(diagnostic.coordinator.completedAt),
          outcome: ["reserved","success","rate_limited","failed"].includes(diagnostic.coordinator.outcome)?diagnostic.coordinator.outcome:"unknown",
          failure:diagnostic.coordinator.failure ? {
            category: safeLabel(diagnostic.coordinator.failure.category),reason:safeLabel(diagnostic.coordinator.failure.reason),
            httpStatus:diagnostic.coordinator.failure.httpStatus,errorType:safeLabel(diagnostic.coordinator.failure.errorType),
            clientCode:safeCode(diagnostic.coordinator.failure.clientCode),networkCode:safeCode(diagnostic.coordinator.failure.networkCode),stage:safeLabel(diagnostic.coordinator.failure.stage),
          }:undefined,
        } : undefined,
        decodeStage:diagnostic.decodeStage,
        retryPolicy:diagnostic.retryPolicy,
        deliveryDisposition:diagnostic.deliveryDisposition,
        messageMetadata: diagnostic.messageMetadata ? {
          messageType:diagnostic.messageMetadata.messageType,
          entityShape:diagnostic.messageMetadata.entityShape,
          messageTypeName:safeName(diagnostic.messageMetadata.messageTypeName),
          wireBytes:diagnostic.messageMetadata.wireBytes,decodedBytes:diagnostic.messageMetadata.decodedBytes,
          redelivered:diagnostic.messageMetadata.redelivered,
          compression:diagnostic.messageMetadata.compression,
          signature:diagnostic.messageMetadata.signature,
        }:undefined,
      }
    : null;
const selectable = (event: SportEvent) =>
  event.available === true &&
  [1, 2, 9].includes(event.status ?? 0) &&
  (event.markets || []).some(
    (m) =>
      m.status === 1 &&
      m.selections.some(
        (s) => s.available === true && Number.isFinite(s.odds) && s.odds > 1,
      ),
  );
/** Pure local evidence. Does not query providers, reproject prices or reconcile tickets. */
export function feedEvidence(feed: EventFeed, now = Date.now()) {
  const candidates = feed.events.filter(selectable);
  const lanes = (["prematch", "inplay"] as Lane[]).map((lane) => {
    const connection = feed.connections?.[lane],
      coverage = feed.coverage?.[lane],
      events = feed.events.filter((e) => e.source === lane);
    return {
      lane,
      packageId: lane === "prematch" ? 4511 : 4510,
      phase: connection?.phase ?? "unknown",
      diagnostic: safeFeedDiagnostic(connection?.diagnostic),
      recoveryProgress:connection?.recoveryProgress?{
        stage:connection.recoveryProgress.stage,
        startedAt:iso(connection.recoveryProgress.startedAt),completedAt:iso(connection.recoveryProgress.completedAt),
        queuedAtHandoff:connection.recoveryProgress.queuedAtHandoff,
        processedAtHandoff:connection.recoveryProgress.processedAtHandoff,
        lastProgressAt:iso(connection.recoveryProgress.lastProgressAt),
        regularSnapshotReady:connection.recoveryProgress.regularSnapshotReady,
        nextRegularAttemptAt:iso(connection.recoveryProgress.nextRegularAttemptAt),
      }:null,
      transport: {
        lastMessageAt: iso(connection?.lastMessageAt),
        note: "Any AMQP message, including keepalive; not evidence of a new quote.",
      },
      activity: coverage?.activity
        ? Object.fromEntries(
            Object.entries(coverage.activity).map(([k, v]) => [k, iso(v)]),
          )
        : null,
      snapshot: {
        lastAttemptAt: iso(connection?.lastSnapshotAttemptAt),
        lastSuccessAt: iso(connection?.lastSnapshotAt),
        lastErrorAt: iso(connection?.lastSnapshotErrorAt),
        diagnostic: safeFeedDiagnostic(connection?.lastSnapshotDiagnostic),
        events: connection?.snapshotEvents,
        audit: coverage?.snapshot ?? null,
      },
      outrightRecovery: connection?.outrightRecovery
        ? {
            operations: connection.outrightRecovery.operations
              ? Object.fromEntries(
                  Object.entries(connection.outrightRecovery.operations).map(
                    ([k, v]) => [
                      k,
                      {
                        lastAttemptAt: iso(v?.lastAttemptAt),
                        lastSuccessAt: iso(v?.lastSuccessAt),
                        lastErrorAt: iso(v?.lastErrorAt),
                      },
                    ],
                  ),
                )
              : null,
            status: connection.outrightRecovery.status,
            checkedAt: iso(connection.outrightRecovery.checkedAt),
            fixtures: connection.outrightRecovery.fixtures,
            marketEvents: connection.outrightRecovery.marketEvents,
            timestampRejected:
              connection.outrightRecovery.timestampRejections?.length ?? 0,
            diagnostics:
              connection.outrightRecovery.diagnostics?.map(
                safeFeedDiagnostic,
              ) ?? [],
          }
        : null,
      projection: {
        rowsStored: coverage?.rowsStored,
        rowsWithoutFixture: coverage?.rowsWithoutFixture,
        rowsHiddenAsDuplicate: coverage?.rowsHiddenAsDuplicate,
        rowsPublished: coverage?.rowsPublished,
        eventsWithSelectableOdds: coverage?.eventsWithSelectableOdds,
        staleUpdatesIgnored: coverage?.staleUpdatesIgnored,
        messagesByType: coverage?.messagesByType ?? {},
        messages: coverage?.messages ?? null,
        eventUpdatesReceived: coverage?.eventUpdatesReceived ?? null,
        keepAliveActiveEvents: coverage?.keepAliveActiveEvents ?? null,
      },
      published: events.length,
      candidates: events.filter(selectable).length,
    };
  });
  const byEvent = feed.events.map((e) => ({
    eventId: id(e.id),
    source: e.source,
    sport: e.sport,
    status: e.status ?? null,
    live: !!e.live,
    available: e.available === true,
    startsAt: iso(e.startsAt),
    projectionRowUpdatedAt: iso(e.updatedAt),
    restoredLineage: e.restored === true,
    observation: e.observation
      ? {
          snapshotReceivedAt: iso(e.observation.snapshotReceivedAt),
          amqpEventReceivedAt: iso(e.observation.amqpEventReceivedAt),
          amqpMarketReceivedAt: iso(e.observation.amqpMarketReceivedAt),
        }
      : null,
    evidence:
      e.observation?.snapshotReceivedAt || e.observation?.amqpEventReceivedAt
        ? "observed_in_current_worker_session"
        : e.restored
          ? "restored_without_new_observation"
          : "unknown_older_diagnostic_version",
    markets: (e.markets || []).length,
    openMarkets: (e.markets || []).filter((m) => m.status === 1).length,
    marketStatusCounts: counts((e.markets || []).map((m) => m.status)),
    selectableSelections: (e.markets || [])
      .filter((m) => m.status === 1)
      .flatMap((m) => m.selections)
      .filter(
        (s) => s.available === true && Number.isFinite(s.odds) && s.odds > 1,
      ).length,
    selectionBlockingReasonCounts: counts(
      (e.markets || []).flatMap((m) =>
        m.selections.flatMap((s) =>
          s.available === true
            ? []
            : s.unavailableReasons?.length
              ? s.unavailableReasons
              : ["not_reported_by_projection"],
        ),
      ),
    ),
  }));
  const degradedReasons = lanes.flatMap((l) => [
    ...(l.phase !== "connected"
      ? [
          {
            lane: l.lane,
            component: "amqp_or_regular_recovery",
            phase: l.phase,
            diagnostic: l.diagnostic,
          },
        ]
      : []),
    ...(["partial", "rate_limited"].includes(l.outrightRecovery?.status ?? "")
      ? [
          {
            lane: l.lane,
            component: "outright_recovery",
            status: l.outrightRecovery!.status,
            diagnostics: l.outrightRecovery!.diagnostics,
          },
        ]
      : []),
    ...(l.diagnostic
      ? [
          {
            lane: l.lane,
            component: "lane_diagnostic",
            diagnostic: l.diagnostic,
          },
        ]
      : []),
  ]);
  return {
    readOnly: true,
    supplierRequests: 0,
    writes: 0,
    capturedAt: new Date(now).toISOString(),
    mode: feed.mode,
    health: feed.health ?? "unknown",
    projectionPublishedAt: iso(feed.updatedAt),
    projectionAgeMs: iso(feed.updatedAt)
      ? now - Date.parse(feed.updatedAt!)
      : null,
    projectionUsableByApi:
      !!iso(feed.updatedAt) &&
      now - Date.parse(feed.updatedAt!) >= -5000 &&
      now - Date.parse(feed.updatedAt!) <= 20000,
    restoration: feed.restoration
      ? {
          at: iso(feed.restoration.at),
          source: ["checkpoint", "legacy_projection", "missing"].includes(
            feed.restoration.source,
          )
            ? feed.restoration.source
            : "other",
          rows: feed.restoration.rows,
        }
      : null,
    observedEvents: feed.events.length,
    candidateEvents: candidates.length,
    lanes,
    degradedReasons,
    ui: {
      dateFilter: false,
      filters: ["sport", "prepartido_or_live_tab", "search_text"],
      sportCounts: counts(feed.events.map((e) => e.sport)),
      footballPreMatchNoSearch: feed.events.filter(
        (e) => e.sport === "futbol" && !e.live,
      ).length,
      footballLiveNoSearch: feed.events.filter(
        (e) => e.sport === "futbol" && e.live,
      ).length,
      fixtureStatusCounts: counts(feed.events.map((e) => e.status)),
    },
    events: byEvent,
    exclusions: explainOpenEventExclusions(
      feed.events,
      new Set(candidates.map((e) => e.id)),
    ),
    interpretation: candidates.length
      ? "open_candidates_in_local_projection"
      : feed.events.length
        ? "no_open_candidates_in_local_projection"
        : "no_events_in_local_projection",
    notes: [
      "Keepalives and projection publication do not prove new fixtures or odds.",
      "Restored lineage can coexist with a new observation; observation describes receipt, not acceptance of every field.",
      "Provider LastUpdate is a version, not a timestamp of the last snapshot request.",
      "projectionRowUpdatedAt is aggregate row metadata and can use snapshot start; it is not proof of a price change.",
      "Missing activity/observation means older instrumentation or no observation; it is not proof of provider absence.",
      "Closed fixtures/markets remain closed. No dates, prices, results or subscriptions are changed.",
    ],
  };
}

export function supportFeedMessage(report: ReturnType<typeof feedEvidence>) {
  const lanes = report.lanes
    .map(
      (l) =>
        `${l.lane} package ${l.packageId}: phase=${l.phase}; diagnostic=${JSON.stringify(l.diagnostic)}; regular snapshot=${JSON.stringify(l.snapshot)}; AMQP activity=${JSON.stringify(l.activity)}; Outright recovery=${JSON.stringify(l.outrightRecovery)}`,
    )
    .join("\n");
  return `Hello Szymon / LSports Support, continuing ticket #217525.\nEnvironment: TRADE Test; PreMatch 4511, InPlay 4510. Evidence captured at ${report.capturedAt} (UTC).\nOur local projection contains ${report.observedEvents} fixtures, ${report.candidateEvents} open candidates. Football visible with no search in the pre-match tab: ${report.ui.footballPreMatchNoSearch}. Fixture statuses: ${JSON.stringify(report.ui.fixtureStatusCounts)}. No date filter is applied.\n${lanes}\nExample fixture IDs/statuses: ${JSON.stringify(report.events.slice(0, 5).map((e) => ({ eventId: e.eventId, status: e.status, startsAt: e.startsAt, marketStatusCounts: e.marketStatusCounts })))}.\nPlease confirm whether these Test packages are currently publishing only historical/finished fixtures, and provide test fixtures that are still open with updated recommended prices (1X2 for football and Race Winner 160 for subscribed racing, if available), including an open InPlay example. Please confirm the existing package distribution and any subscription/filter settings required for these fixtures, and that they appear in the appropriate snapshots and AMQP updates. Do not create paid subscriptions or change our existing subscriptions without authorization.\nWe preserve UTC timestamps according to your written confirmation, including values without Z. We have not reopened settled markets or fabricated prices. Keepalives alone are not treated as odds updates. Missing instrumentation is reported as unknown, not proof of provider absence. Please correlate the capture time, IDs and snapshot/AMQP diagnostics above. No credentials or raw payloads are included.`;
}
