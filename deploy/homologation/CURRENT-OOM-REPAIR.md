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
