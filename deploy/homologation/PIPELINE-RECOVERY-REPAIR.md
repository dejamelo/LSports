# Snapshot and durable processing repair

Local implementation and tests only. No AWS deployment was performed from this workspace.

## Demonstrated bottleneck and correction

`process.availableMemory()` reflects raw cgroup usage, including file cache. The snapshot guard remains unchanged: estimated reclaimable cache is never counted as available memory. A worker-scoped root policy requests at most 512 MiB and half the conservative clean-inactive estimate per pass, excludes dirty/writeback/shmem, requires `swappiness=0`, and measures actual cgroup usage afterward. No global cache drop, heap increase, memory limit increase or POSNET operation. Kernel support and actual headroom must pass before deployment. The policy is persistent and explicitly scoped to the verified 6 GiB worker and isolated labelled rehearsal containers.

Publication previously held the state mutation gate throughout private checkpoint and public projection I/O. The first local load reproduction still waited 10.3 seconds on `state_exclusive`, even after its backlog drained, and failed to finish the snapshot within its acceptance deadline. Publication now captures immutable row references under a short gate; row mutations use copy-on-write, bounded by a 512 MiB heap reserve while a writer is active. Only one publication is active. Both files retain their existing atomic durable publication and checkpoint-before-retirement semantics.

Snapshot batches are bounded to 16 fixtures or 2 MiB source bytes (a single bounded large fixture is handled alone). During full snapshot application, downstream raw inbox processing pauses while reception, durable inbox commits and broker ACKs continue in their separate actor. No messages are discarded. The existing 16 MiB/4096 delivery window remains bounded; processed-but-not-checkpointed IDs are bounded to 32768, with only representative error metadata retained. Normal snapshot heartbeat publications are throttled; final, explicit checkpoint and shutdown writes are preserved.

The previous commit's covering SQLite index avoids scanning payload pages for pending count/oldest age. Query results retain the true minimum timestamp, including nonmonotonic arrival timestamps. Snapshot telemetry identifies processing-queue, state-gate, publication-heap-pressure and apply waits; progress publishes the first batch and periodic completions rather than only every 100 rows.

## Local evidence

See `PIPELINE-LOCAL-RESULTS.json`: Docker 6 GiB, Node old-space 2560 MiB, two CPUs, isolated network. 540714293-byte snapshot, 25416 fixtures, 406656 markets, 2439936 bets; initial durable inbox 674380 messages; 72 messages/s for 300 seconds plus a 300-message burst. All 25416 rows applied, persisted and restored. Measured backlog 670355 -> 110552. Sampled RSS peak 2083762176 bytes; observed cgroup peak 4827832320 bytes. No local OOM.

Limitations: synthetic fixtures and a 100-fixture message hot set; readback row count was checked by this load harness, while exhaustive state equivalence remains mandatory in the separate protected real-copy proof. Largest persistence still took 100925 ms; maximum main event loop delay was 8925 ms. Do not present these results as production stability, full backlog drainage or current odds confirmation. Focused tests additionally cover checkpoint/inbox replay, durable-before-ACK, settlements, suspended/stale selections, immutable publication and low-heap writer waiting.

## Deployment and rollback

Run `apply-pipeline-recovery.mjs` from an immutable archive with the existing Mac repository as `ADL_REPO_ROOT`. It audits Mac absence, verifies and installs the scoped cache policy, then invokes the existing protected resumable executor. The candidate image must first pass the offline load gate before supplier distribution is stopped. The executor preserves identity checks, canonical source/digest comparison, all unrelated Compose fields, existing backups, prepared receipts, a single graceful stop, verified recovery of copies of inbox/WAL and checkpoints, and full preserved-data restoration/readback before activation. A remote advisory lock prevents duplicate upgrades after client interruption. Resume by rerunning the same immutable command; completed candidate receipts are reused.

A fresh backup protects the current running worker's changed data; historical `g2uant6r` remains untouched. No migration or disk expansion. No auto-ack, subscriptions, credentials, Caddy, panel or POSNET changes. Existing memory stays 6442450944 bytes; heap stays 2560 MiB.

Rollback evidence and prior worker image/overrides are retained in the executor's protected backup. Do not start an old OOM worker or copy an old checkpoint over newer inbox data. A failed offline proof blocks activation. To reverse only the cache service, use `sudo systemctl disable --now adl-worker-cache-reserve.service`; this does not restart a worker or change its memory limit. Worker rollback remains subject to the existing recovery and single-consumer gates.

The final production validator must confirm complete snapshots, genuine market processing, decreasing durable backlog with comparable windows, stable memory and current selectable odds in API/sportsbook. It retains the 30-minute stability criterion. InPlay control-only types 31/32 are a separate unresolved coverage issue. No ETA is asserted for real backlog drainage before comparable rates exist.
