// Read-only: no SDK calls, locks, migrations, ticket database or writes.
import { readFile } from "node:fs/promises";
import { statePath } from "@lsports/feed-store";
import { providerTimestamp } from "../apps/worker/src/timestamp-contract.js";
try {
  const saved = JSON.parse(await readFile(statePath(), "utf8"));
  const rows = saved.workerCheckpoint?.outright;
  if (!Array.isArray(rows)) throw new Error("NO_CHECKPOINT");
  const items: object[] = [];
  let storedVersions = 0,
    versionsWithoutRawEvidence = 0,
    historicalMismatches = 0;
  for (const row of rows) {
    if (!["prematch", "inplay"].includes(row?.lane)) continue;
    const versions = new Map(row.betAt || []);
    storedVersions += versions.size;
    const traces = new Map(row.settlementAudit || []);
    for (const key of versions.keys()) {
      const trace: any = traces.get(key);
      if (
        !["lastSnapshot", "last41", "last42"].some((source) =>
          providerTimestamp(trace?.[source]?.timestamp?.rawLastUpdate),
        )
      )
        versionsWithoutRawEvidence++;
    }
    for (const [key, trace] of row.settlementAudit || []) {
      for (const source of ["lastSnapshot", "last41", "last42"]) {
        const proof = trace?.[source];
        const raw = proof?.timestamp?.rawLastUpdate;
        const parsed = providerTimestamp(raw);
        if (!parsed || parsed.timezone !== "absent") continue;
        const [marketId, selectionId] = String(key).split(":");
        if (
          !/^[a-zA-Z0-9_-]{1,200}$/.test(selectionId) ||
          !/^\d+$/.test(marketId) ||
          !Number.isSafeInteger(row.fixtureId)
        )
          continue;
        const recorded = Date.parse(proof.versionAt || "");
        if (recorded !== parsed.milliseconds) historicalMismatches++;
        items.push({
          lane: row.lane,
          fixtureId: row.fixtureId,
          marketId,
          selectionId,
          source,
          rawLastUpdate: raw,
          contractUtc: new Date(parsed.milliseconds).toISOString(),
          orderingKey: parsed.order,
          historicalConversionMatches: recorded === parsed.milliseconds,
          storedMatchesContract: versions.get(key) === parsed.milliseconds,
          decision: [
            "stored",
            "ignored_older",
            "ignored_null",
            "ignored_missing",
          ].includes(proof.decision)
            ? proof.decision
            : "unknown",
          action:
            recorded === parsed.milliseconds
              ? "no_clock_change_indicated"
              : "review_only_no_automatic_replay",
        });
      }
    }
    for (const [key, entry] of row.deferredTimestampBets || []) {
      const parsed = providerTimestamp(entry?.inspection?.rawLastUpdate);
      if (!parsed || parsed.timezone !== "absent") continue;
      const [marketId, selectionId] = String(key).split(":");
      if (
        !/^\d+$/.test(marketId) ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(selectionId) ||
        !Number.isSafeInteger(row.fixtureId)
      )
        continue;
      items.push({
        lane: row.lane,
        fixtureId: row.fixtureId,
        marketId,
        selectionId,
        source: "saved_quarantine",
        contractUtc: new Date(parsed.milliseconds).toISOString(),
        action: "requires_fresh_supplier_confirmation_no_price_replay",
      });
    }
  }
  console.log(
    JSON.stringify(
      {
        readOnly: true,
        contract:
          "LSports #217525 UTC with/without Z; Szymon Luka; customer confirmation 2026-10-18",
        items,
        coverage: {
          storedVersions,
          versionsWithoutRawEvidence,
          historicalMismatches,
        },
        observation: historicalMismatches
          ? "review_required_no_migration_applied"
          : versionsWithoutRawEvidence
            ? "incomplete_historical_evidence"
            : "no_mismatch_in_available_evidence",
        writes: 0,
        supplierRequests: 0,
        ticketsOpened: false,
      },
      null,
      2,
    ),
  );
} catch {
  console.error(
    JSON.stringify({
      readOnly: true,
      status: "error",
      code: "CHECKPOINT_NOT_READABLE_OR_UNSUPPORTED",
      writes: 0,
      supplierRequests: 0,
      ticketsOpened: false,
    }),
  );
  process.exitCode = 1;
}
