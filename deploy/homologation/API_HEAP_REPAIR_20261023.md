API heap containment and durable inbox evidence (2026-10-23)

Evidence: api-worker-health-1792718599939.json shows a Node heap failure at
01:12:31.679694986Z and API restart at 01:12:32.213430363Z. It provides no JS
stack/native allocation frames or projection file size. It does not explain all
29 restarts. Current cgroup counters/peak describe the restarted process.

Confirmed code defect: readConnectedFeed readFile + JSON.parse materializes the
whole document including a private workerCheckpoint before dropping it. Parallel
calls duplicate those allocations. /control serves static HTML independently;
healthy /control is not evidence of successful projection loading.

Change: bounded, inspected-inode reads; growth check; dynamic heap reserve;
8 MiB hard input ceiling, 48x allocation allowance and 128 MiB heap reserve;
coalescing concurrent reads without a retained graph cache. Never return a
truncated feed. Keep stale-price blocking. No memory/container increase.
Oversized complete projections return an explicit unavailable notice and a
sanitized allocation-budget diagnostic. This is containment, NOT an indexed
large-projection reader, and cannot restore odds for oversized projections.
An indexed/query-based source is still needed to serve such projections safely;
increasing API heap alone also leaves whole-document response allocation.

Local checks:
- 43 API/feed-store tests passed after building existing web assets (initial
  tests without those assets returned expected WEB_BUILD_REQUIRED 503).
- 8 deployment tests, 3 rollback tests, 1 WAL/cohort test and source-scope test.
- Docker node:24-bookworm-slim, 768 MiB, heap 512 MiB, 0.5 CPU, network none:
  791,215,003-byte existing synthetic projection, 40 concurrent reads rejected
  without parsing; ~4 ms, peak RSS 78,127,104 bytes.
- Allocation stress (NOT sports-data validation): 7,800,078-byte complete JSON,
  2.6M empty objects, 40 coalesced reads plus response encoding: 4.01 s,
  peak RSS 389,328,896 bytes (~371 MiB), heap used 181,904,168 bytes.
  This is not a guarantee for arbitrary API workloads or AWS feed recovery.
- TypeScript noEmit passed. No AWS deployment was performed here.

API-only updater preserves the exact historical fatal window privately before
replacing the API, emits only fixed native-allocation hints, and exercises the
candidate against the actual read-only feed using installed API limits before
replacement. Existing backup/rollback and worker/Caddy/POSNET identity guards
remain. Complete API update explicitly reports integrationVerified=false.

collect-session-recovery.mjs --api-health --drain adds three read-only scalar
SQLite samples 45 s apart. WAL is included (mode=ro, never immutable=1); payloads
are never selected. The original cohort's disappearance measures retirement
following business checkpoint, while new committed IDs/cohorts distinguish new
inbox receipts. This does not prove provider timestamps are current. A single
90 s window is not proof of sustainable throughput or snapshot completion.

Worker evidence: reconnect attempts occurred at 01:14 and 01:20; reconnect at
01:16 failed with an opaque worker.start exception. Capacity paused at 01:06
and 01:22 with the same logical bytes. decode alone does not establish retirement
or whether those messages are old/new. InPlay market delivery remains separate.
