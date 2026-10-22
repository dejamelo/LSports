# Current worker OOM: isolated publication

Actual AWS evidence: container prefix `7f43cb2939c7`, exited 2026-10-21T16:35:10.819619701Z, Docker OOMKilled=true, exit137, 4GiB cgroup, Node old-space2560MiB. Kernel anonymous RSS4216967168; latest completed persistence54.2s, RSS3902218240. This proves Docker OOM, not the exact allocation responsible. These observations are distinct from previous offline V8 heap failures.

Code-level reproducer: retaining a captured lazy projection while updating its SDK rows keeps a shadow copy through checkpoint/publication. A dense synthetic baseline reproduced V8 heap exhaustion at old-space2560MiB. Publication now holds a FIFO state-mutation gate while the independent ingress thread continues receiving, FULL-committing its bounded inbox and acknowledging. Processing resumes afterwards; inbox rows are not deleted until the checkpoint is durable. No full-state clone or auto-ack was added. Per-record JSON is reused; the Argentine date formatter is shared. Coverage counts no longer construct every event a second time. Wire/checkpoint schemas, settlement/quote freshness checks and snapshot reconciliation remain unchanged.

## Local evidence (not AWS validation)

Docker Node24, 2 CPUs, 4GiB memory/swap cap, old-space2560MiB, no network. Synthetic input:516000000 bytes,16329 fixtures,195948 markets,2351376 selections. No supplier data copied into tests.

- Baseline concurrent8192 mutations: V8 heap exhausted (exit139), not presented as a Docker OOM reproduction.
- Corrected publication:8192 queued updates, zero shadow-row copies; write26098ms, maxRSS1376440320. Includes real start dates and local-time formatting.
- Fresh-process restore plus complete streamed reread of the written projection:16329 events,195948 markets,2351376 selections; maxRSS1425383424. Separate process avoids holding two complete restored graphs.
- Worker/feed-store regressions:269 passed,2 optional skipped; seven focused publication tests and sixteen upgrade tests passed (one optional Docker proof skipped). TypeScript compilation passed.
- Separate sustained ingress/replay test:69 messages/s for60s plus300-message burst,4440 received/ACKed/processed/checkpointed, peak backlog41 then zero;238 writes, max141ms, mean38ms; ingress loop delay26ms; RSS395186176. Snapshot8MiB/200 fixtures, so this does NOT claim sixty seconds of dense516MB graph throughput. Replay after interruption restored two durable messages.

Reproducer: run `node --import tsx deploy/homologation/offline-persistence-memory-proof.mjs INPUT OUTPUT` inside the same constrained Docker environment, with a synthetic dense checkpoint/sidecar under INPUT read-only and a separate owned OUTPUT. Script writes only OUTPUT; it makes no provider requests. BASELINE=1 is only for comparison against the previous archived source. The sustained ingress test is `apps/worker/src/durable-load.test.ts`; its smaller snapshot tests reception/commit/ACK/replay, not the dense graph's full throughput.

## Controlled remote continuation

`ADL_LIVE_OOM_REPAIR=1 ADL_EXPECTED_OOM_PREFIX=7f43cb2939c7` with `--snapshot-memory-repair` verifies the unique stopped OOM worker and immutable image against its protected successful upgrade receipt and source digest. Only the four worker/persistence source files can differ. Prepare creates a NEW backup from CURRENT checkpoint, sidecar, inbox/WAL and protected deployment configuration. It never restores the old backup over the latest inbox.

Existing gates still require planned Distribution/Stop, copying preserved data, restore/serialization/full readback under the real user/mounts and4GiB limit, fresh Mac-consumer absence audit, then one activation with Start/SDK propagation/consumer/snapshot order. Receipts permit resuming completed stages. Failure preserves data and leaves consumption stopped; rollback preserves data and keeps the old OOM image stopped. No automatic restart loop.

After activation the existing thirty-minute validator must establish complete snapshots, actual market updates, bounded/draining processing backlog and current selectable odds/API visibility. Local results do not establish those conditions. Dense synthetic publication still takes26s: this is above the API20s freshness threshold at that synthetic size; freshness was NOT relaxed. Real coverage, processing rate and API freshness remain explicit production validation risks. InPlay control-only types31/32 remain a separate unresolved supplier delivery question.

## Replay fairness follow-up

Post-activation observation 2026-10-22T04:47:58–04:50:26: running, RSS1603436544; PM processingBacklog263392→273948, processed54→91, checkpointed0. Measured arrival68.7733/s, processing0.2417/s. This is not a new observed OOM or a draining backlog. InPlay completed a current snapshot but still decoded only control31/32. Full PM snapshot stage was not observed; absence alone is not proof of a stuck parser.

A deterministic scheduling test reproduces a separate local defect: with a persistence request queued behind an active publication, the FIFO gate can insert the next whole-file write after just ONE message in an already waiting4096-message batch. Publication requests now yield one event-loop turn BEFORE joining the mutation gate. This allows the bounded batch's pending microtask chain to run, while writes themselves remain exclusive. The test compares both schedulers: old capture after1 record; corrected capture after4096. No complete-state cloning, limit increase, inbox deletion, concurrent writer or weakened checkpoint receipt.

`publicationTurn` is used by runtime and the sustained ingress/replay harness. This establishes the scheduling defect and the local fix, not sole causation of all live processing delays. Remote queue drain and full snapshot completion must be measured after controlled application.

Use `ADL_LIVE_PERSISTENCE_REPAIR=1 ADL_EXPECTED_LIVE_IMAGE=adl-worker-partitioned:1e2c5d0bdaded181fa4e4438` with snapshot-memory-repair. It requires the exact running image and its protected successful receipt/source digest; skips obsolete backup derivation, prepares a new image and current-data backup, uses the existing Distribution/Stop-before-stop and offline-copy restore/readback gates, then activates once. Repeating a completed activation does not restart it. Preserve the old backup and all inbox data; rollback keeps the superseded worker stopped.

Follow-up validation:271 worker/feed-store tests passed,2 opt-in skipped;17 upgrade tests passed,1 opt-in skipped;12 temporal-validator tests passed; TypeScript build passed. Constrained4GiB/2560MiB-heap test with the new scheduler:69/s for60s plus300-message burst,4440 received/ACKed/processed/checkpointed, peak backlog331, final0, maxRSS411516928, ingress loop delay28ms, persistence max116ms. Its snapshot is8MiB/200 fixtures: it does not establish production dense-state drain rate or revalidate the unchanged dense serializer. No AWS application or supplier request was performed by these local tests.

## Resume at graceful-stop gate

`ADL_RESUME_BACKUP=/var/backups/adl-partitioned-upgrade-oqxi48jd` pins continuation to the existing protected receipt, exact candidate-source digest and backup. A missing/different receipt fails before preparing another image. It does not reissue Distribution/Stop or SIGTERM when phase=stop_requested.

The resumed stop gate verifies the old container ID and base image ID, observes sanitized existing logs plus checkpoint/temp/inbox/WAL file metadata, and records each observation in the protected receipt. Maximum observation180s, every15s; if no log/file change for90s it stops with UPGRADE_STOP_NO_OBSERVABLE_PROGRESS_NO_MORE_SIGNALS. This is an evidence limit, not proof of a deadlock. Original signal time may be absent in an old receipt; elapsed time since the confirmed distribution stop is separately named and never presented as signal time. New signal requests record their timestamp.

If the container already exited, the existing persistence/inbox integrity and offline-copy gates run immediately without replaying signals. No force-stop path was added: consistency of a live checkpoint/inbox/WAL is not established by file metadata. Offline validation and backups must still pass before starting the prepared worker. POSNET, panel, original data and previous backups are untouched.

`--pipeline-report` is an additional read-only mode, not required to resume: exact expected/found image references and IDs, source-hash comparisons, override fingerprints, persisted-format scalars, cgroup memory and three recovery observations are written into a protected local report. No provider queries, worker restarts or app imports are used by its identity probe. Compatibility is explicitly not claimed from matching hashes alone.
