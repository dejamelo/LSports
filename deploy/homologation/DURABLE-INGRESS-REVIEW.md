# Durable ingress, LSports ticket 217525

## Proven bottleneck and choice

The previous business delivery path called `save()` before every broker ACK. That save captures the entire TradeState, reconciles tickets, writes/fsyncs the private regular checkpoint and publishes the public projection. The snapshot handoff also had a per-message save path. LSports observed 69 deliveries/s versus 3.4 ACK/s, leading to the 10,000-ready-message policy. Both local paths are now separated from broker acknowledgement.

Keep **manual ACK**, prefetch 100 and exclusive consume. A dedicated Node worker thread owns the AMQP socket, heartbeat (30 seconds) and private SQLite inbox. Raw payload, AMQP headers/properties (including Buffer values), transport fields and receipt time are committed with WAL + `synchronous=FULL` before broker ACK. The worker never deserializes provider JSON or mutates business state. A transaction failure/capacity breach never acknowledges that delivery.

Business processing pulls an ordered prefix (up to 500 rows / 16 MiB) from this inbox. The existing SDK-backed decoder routes headers/message types to the existing fixture, market, suspension, settlement and control handlers. Nothing is dropped based on type. Processing is globally ordered, which also preserves fixture order. GUID and version-order guards remain; raw rows are deleted only after the existing durable business checkpoint/settlement reconciliation/publication succeeds. A crash between checkpoint and row deletion replays idempotently. Business writes batch at a 250ms cadence, including snapshot handoff; they do not hold the AMQP prefetch window.

Auto-ack was deliberately not enabled: it would lose delivered-but-unpersisted messages on crash and render prefetch irrelevant as a pending-work limit. This design establishes the durable inbox first instead.

## Bounds and recovery

- AMQP manual prefetch: 100. Raw record/IPC prefix: at most 16 MiB; header/field metadata: 64 KiB per record. Pending append batches flush at 5ms/100 records with an 8 MiB aggregation boundary. No unbounded in-memory work queue.
- Inbox logical payload/metadata cap: 2 GiB, with a 128 MiB free-disk guard. SQLite may retain reusable pages/WAL beyond live payload size; free disk is checked before every append. Capacity failure pauses processing, preserves records, blocks selections and attempts Distribution/Stop; no purge, no automatic subscription changes, no retry loop that hides overload.
- Business thread uses existing snapshot disk spool, whole-document validation and 4 GiB worker limit. Oldest internal backlog >5 seconds blocks selections (including while connected); existing restored/incomplete/suspended/invalid-odds guards remain.
- A recovery anchor is written ONLY after a completed full snapshot and durable business checkpoint. It is an overlapping epoch-seconds anchor bounded by BOTH full-snapshot start and the earliest validated, actually processed provider data-event timestamp in the session, conservatively backed off before any older pending inbox prefix. No anchor is inferred from local receipt time or control-only traffic when there is no processed data timestamp. It is NOT the latest received heartbeat and does not assert queued messages have been processed. Pending rows remain durable and replay first/in order.
- SDK 3.10.10 `GetSnapshotRequest.timestamp` explicitly documents epoch **seconds**. Recovery sends that field through `GetEventRequestDto`/Mapper to the same `/Prematch/GetEvents` disk spool; filtered results are validated/applied and persisted, including returned settlement fields, before a separate unfiltered full baseline can release selections. A filtered response is never used as a complete inventory. Both share the existing snapshot scheduler/journal; cooldowns are not cleared or shortened. No invented `since`/settlement endpoint or heartbeat parameter.
- This does not establish supplier retention for historical settlements absent from its response (support says snapshots are retained up to 24h after fixture end). Missing historical outcomes remain unresolved; no result is fabricated. Current feed validation is not proof all historical tickets settled. Existing settlement/ticket guards and evidence remain authoritative.
- Planned shutdown preserves Distribution/Stop before consumer close. Startup preserves Start, the single SDK-owned 2000ms propagation/verification, connection/consume, then snapshot.

## Metrics and validation

Per feed: received, durable ACK, business processed, raw bytes, backlog, oldest age, commit duration, safe numeric header-type counts, last receipt/ACK, ingress event-loop maximum and explicit metric window. RSS is process-wide/shared; do not sum it across feeds. Main persistence remains a shared measurement; its event-loop maximum now has its own reset-window timestamps.

The new `--durable-ingress-repair` uses the existing protected migration ledger, fixed file allowlist, base-image/source checks, captured nullable-row proof, offline image gates, fresh Mac-absence audit, stopped-state checks, hash-verified backups and a worker-only Compose override. It does not deploy panel/API or alter Caddy. Completed preparation/activation is reused. SQLite inbox/WAL files join the stopped-worker backup. The old image and all existing overrides are retained.

After activation the executor observes status, polls Distribution Status through the running worker at 30s intervals, warns at broker depth >500 when available, and requires a 30-minute current-session stability window with advancing business processing/markets, no rising/stale internal backlog and no queue alert. PreMatch stability is reported independently of InPlay's market-update evidence. Absent queue metrics are marked unavailable, not treated as zero. The Mac must remain stopped. A pending or failed validation is not success and does not trigger speculative restarts.

Rollback: `--durable-ingress-rollback` through the same pinned executor restores the previous worker image configuration and **keeps it stopped**. It does not restore an old data volume or discard inbox records acknowledged by the new worker. Restarting a legacy image that cannot replay the inbox would require explicit reconciliation; the executor does not do that automatically.

## Trading Floor proposal — not applied

| Setting | Proposed review | Impact to measure before changing |
| --- | --- | --- |
| Min Difference | 1% initial candidate per support, with market overrides | Replay/export price-move histogram: suppressed movement counts, displayed-price staleness, suspended/settled controls unaffected. No assumed percentage reduction. |
| Data Limit | Inventory current value; propose a fixture horizon matching displayed calendar | Count fixtures excluded by each candidate day horizon and required competitions; 0 means unlimited per support, current value not assumed. |
| Providers | Compare configured lists with actual displayed/recommended coverage | Messages per provider/market, fallback loss, fixture coverage; no automatic removal. |
| Offered markets | Compare catalog with UI use | Market/selection coverage and retention requirements before disabling anything. |
| Lines | Consider Main Line Only / bounded lines on AH and totals | Count removed alternative lines and affected displayed markets before selecting a policy. |
| Odds ladder | Evaluate with Floor versus current rounding | Price precision and frequency changes; no assumption of equivalence to current odds rules. |

Collect current Trading Floor settings first. Compare volume, fixture/market coverage and price freshness before/after any approved change. No commercial configuration, provider list, booking or subscription was changed by this patch.

## Reproduction

Unit/regression: `node --import tsx --test --test-concurrency=2 apps/worker/src/*.test.ts` (real RabbitMQ case explicitly skipped unless opted in). SDK timestamp, settlement/null collection guards, capacity, Buffer-header roundtrip, abrupt ingress-thread death and durable replay are tested.

Paced load: `ADL_LOAD_SNAPSHOT_BYTES=516000000 ADL_LOAD_DURATION_MS=60000 ADL_OFFLINE_REQUIRE_4G=1 node --max-old-space-size=2816 --import tsx --test apps/worker/src/durable-load.test.ts`, in a network-none Docker container capped to 4GiB / two CPUs. It builds a 516MB synthetic response with 6,000 fixtures, 24,000 markets, 96,000 selections; independent ingress generates 69 messages/s for 60s plus a 300-message burst, with market-update payloads about 1KiB. It checks whole-document completion, eligibility gating, sustained backlog age/trend, durable ACK counts and abrupt thread death with two uncheckpointed durable rows, restore and duplicate replay.

Real AMQP: opt-in `ADL_LOCAL_AMQP_TEST=1 ... durable-amqp.test.ts`, against an isolated local RabbitMQ 4 container with no external network. It checks manual ACK and exclusive consume, 1,000 messages beyond the 100-prefetch window while business JS is blocked, disk retention before processing, then durable completion. This is not the supplier's broker, TLS path or AWS storage.

Local results do not prove AWS recovery. The 30-minute AWS run, real package 4511 queue/traffic, actual market-update freshness and package 4510 market delivery remain to be validated after user execution.

## Measured local results

See `DURABLE-INGRESS-RESULTS.json`. At 4 GiB / two CPUs: 4,440 received, durably acknowledged and processed (69/s for 60 seconds + 300-message burst); peak internal backlog 411, oldest sampled age 1,615ms, final backlog 0; peak process RSS 919,437,312 bytes (~877 MiB); max ingress loop delay 241ms and main-business loop delay 461ms. The 516,000,000-byte document validated/applied all 6,000 fixtures / 24,000 markets / 96,000 selections. Two raw ACKed-but-uncheckpointed rows survived an abrupt ingress-thread termination and duplicate-safe replay. Real local RabbitMQ delivered/ACKed/processed 1,000 messages, beyond the 100-prefetch window, while business JS was deliberately blocked for 1.5 seconds.

The synthetic document includes padding to reach 516MB; its provider mix, compression and distribution of individual message/fixture sizes are not claimed identical to the live package. The market-update message template is ~1KiB. This proves the implemented local path and bounded recovery for this workload, not maximum sustainable production capacity, cloud I/O latency, broker policy or settlement-history completeness. No supplier request or AWS restart was used in these tests.

## Mac process gate follow-up

The previous gate searched the whole command line for worker paths. A suspended `git show <ref>:apps/worker/...` could therefore be classified as a consumer. The gate now cross-checks `ps ... command` against independent `ps ... comm`, parses the executed Node/TSX entrypoint, and excludes Git only with matching executable evidence. Its Node parent is evaluated separately: a known pinned cutover executor is a tool, a real worker/supervisor still blocks, and an unknown/dynamic/mismatched/missing identity blocks with `PROCESS_IDENTITY_INCONCLUSIVE`. No signal or lock removal is used.

Nonzero audit exits now carry allowlisted blocker reason, `audit.<stage>` and exit code through the executor. Raw command lines and stderr remain private. The executor invokes the audit entrypoint from its pinned runtime archive, not the potentially older Mac checkout; the Mac command must archive `scripts`, `package.json` and `tsconfig.json` alongside `deploy/homologation` and link the existing local `node_modules`. Tests cover Git PID 49460 + Node parent 49384, verified tool versus unknown parent, true suspended consumers, executable-query failure, real child exit propagation and audit CLI execution from a temporary pinned tree. AWS/Mac runtime state has not been asserted by these offline tests. The worker-image source manifest is unchanged by this follow-up, so an already prepared image/backup can be reused.

The targeted Mac collection then identified PID 49384 as `update-adl-api.mjs`, with Node executable, no dynamic execution and seven arguments; its parent 49372 was a suspended Bash. The API publisher source was reviewed: it archives Git source and invokes the API-only remote updater, not a local AMQP consumer. The gate now recognizes its exact `deploy/homologation/update-adl-api.mjs` entrypoint only after independent Node executable verification and the same loader/eval checks. A matching basename at an unrelated path remains inconclusive. Regression tests cover the suspended API publisher + Git child + Bash parent, and still block a genuine worker child. No old updater/shell/Git process is resumed or terminated. This changes only the Mac gate; prepared worker-image sources/backup digest remain unchanged.

## Offline deployment gate correction

The Docker gate previously launched an eval module with `--input-type=module`.
The transport Worker inherited that flag and failed with `ERR_INPUT_TYPE_NOT_ALLOWED`.
Independently, the 64 MiB test tmpfs could never satisfy the inbox 128 MiB free-space reserve.
The gate now uses a read-only, verified real module file in the existing protected backup,
with a bounded 256 MiB tmpfs and unchanged 512 MiB helper memory cap, no network.
No worker-image source or digest changes: the existing prepared image/receipt is reused.
Local Docker reproduction verifies both prior failures and successful durable ACK/replay
with the corrected invocation. This is an offline gate result, not AWS feed validation.
Opt-in reproduction: `ADL_OFFLINE_PROOF_IMAGE=adl-full-recovery-offline-reviewed python3 deploy/homologation/test-upgrade-partitioned-worker.py`.
