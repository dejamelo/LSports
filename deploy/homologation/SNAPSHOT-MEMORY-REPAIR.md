# Snapshot + durable ingress memory repair

## Observed production failure (not a supplier attribution)

The protected exit report confirms Docker exit 137, OOMKilled=true,
2026-10-20T22:37:49.229874332Z, memory cap 4,294,967,296 bytes.
At 22:37:22Z the 613,580,938-byte full snapshot had validated 16,329 rows
and applied 1,800. Last completed persistence took 15,274 ms (capture 4,320,
regular write 6,995, projection 3,960), RSS 3,118,718,976 bytes.
These RSS samples do not measure the peak that triggered the cgroup kill.
The earlier InPlay response memory admission rejection is a separate preventive
failure, not itself evidence that an allocation killed the process.

## Local change

- Stream the existing JSON checkpoint and projection representations, fsync and
  atomic rename unchanged. No whole-checkpoint string/UTF8 Buffer beside the
  fully populated state/projection. No new public schema or financial rules.
- Freeze a bounded list of row identities at the start of each write; never chase
  fixtures arriving during that write. Capture regular maps per fixture rather than
  all fixtures at once. Persist
  recovery/settlement metadata as well. A sidecar ahead of its public projection
  is allowed, as before; restored quotes are always blocked pending reconciliation.
- Reuse immutable projections for unchanged regular fixtures in the worker writer,
  invalidating on data changes and recovery. Global availability masks are
  applied per fixture during streaming serialization, without rebuilding the
  entire selection graph when connection/backlog state changes.
  Fresh and cached projections are tested for equivalence; no API/demo caller is
  opted into this cache. This avoids rebuilding a million selection objects for
  every small update batch.
- Restore current checkpoint JSON a row at a time. Validate the complete document
  into a temporary state before committing it. Reject malformed trailing records;
  never commit a partial restore. Keep legacy projection migration available.
  Record size bound 32 MiB; restore reserve 320 MiB; ordinary supplier document
  validation and its 16 MiB per-fixture bound are unchanged.
- Processor window up to 4,096 raw rows, still bounded to 16 MiB including AMQP
  metadata. This is independent of broker prefetch=100/manual ACK. Broker ACK
  still follows SQLite WAL/FULL commit. Delete raw inbox rows only after durable
  application checkpoint/publication. The processor releases delivery credits after application
  without deleting the durable raw rows, so a checkpoint in flight does not stop
  processing subsequent updates. At most 8,192 lightweight receipts are retained
  by the main processor; overload waits for durable progress, never drops rows.
  `processed` measures application; `checkpointed` measures durable retirement;
  `processingBacklog`/`oldestProcessingAgeMs` measure unapplied data, separately
  from retained `backlog`/`oldestAgeMs`. FIFO, versions, suspensions and outcomes
  remain on the existing path. No auto-ACK, dropping, purging, or subscription changes.
- Keep container at 4 GiB. Worker heap is capped at 2,560 MiB (previous 3,072),
  reserving room for native allocations, transport threads and conversion buffers.

## Controlled restart after confirmed OOM

Mac command mode `--snapshot-memory-repair` uses immutable source hashes from
7248e39, verifies original/candidate image identity, and reuses receipts on retry.
It supports the known stopped OOM worker; other unexplained exits still block.
Only this mode can archive stale locks after confirmation that the original
container namespace is dead, restart policy is disabled, no worker is running,
and no other running container mounts the feed volume for writing.
It copies/verifies checkpoints, both inbox databases and WAL/SHM before recovery,
checks SQLite integrity/pending counts, and restores the existing checkpoint in
an offline candidate container before starting. This pre-start verification is
recorded and reused; the Mac absence audit is refreshed again immediately before
activation, after the potentially long offline restore. If an old private full
snapshot spool exists, rehearse its complete validation/application/projection
within 4 GiB too, with the source volume read-only and output discarded. Never
publish this old snapshot or replace original data with rehearsal output. A
failed rehearsal blocks activation; missing spool is reported as not rehearsed. Read-only SQLite may update SHM;
the first verified backup is preserved. Original logical inbox rows are untouched.
No checkpoint rollback or database restore overwrites newly acknowledged messages.

Distribution status/Stop is checked before the restart; existing scheduler journals
and cooldowns remain. Startup stays Start -> SDK propagation once -> consume -> snapshot.
Only the worker image/environment changes; API/panel, Caddy and POSNET are excluded.
`--snapshot-memory-rollback` restores the prior image configuration but keeps that
worker stopped; it does not reactivate the OOM-prone version or discard inbox data.

## Offline evidence and limits

See SNAPSHOT-MEMORY-RESULTS.json. Tests use network-isolated Docker containers,
4 GiB RAM, no swap, two CPUs, actual parser/session/state/checkpoint/inbox code.
Structured fixtures/markets/selections and explicit padding are synthetic; they
are not a captured supplier response and do not prove production recovery.
The original 516 MB test had only 96,000 selections; the dense tests use 1,045,056.
Intermediate trials exposed processing-age failures and a checkpoint that chased
new rows for almost 80 seconds. They were not treated as success. Final tests
separate unapplied data from durable retained prefixes and require progressing
checkpoints during sustained traffic, bounded final processing age, no ongoing
processing-backlog growth and a fully drained inbox. An instantaneous 13,526-message
burst is allowed a recovery period with prices blocked on unapplied gaps. The final passing HTTP test uses a 613,580,938-byte response, 16,329 fixtures,
1,045,056 selections, three minutes at 69/s with ~8.5 KB messages and a 3,000-message
burst at 90 seconds. All 15,420 rows are processed/checkpointed and the inbox drains.
Cold-process restoration/replay is a separate passing 16,329-fixture test; the
optional same-process smoke replay is intended for small regression fixtures.
Production still requires the executor's 30-minute feed validation, snapshots,
market updates, drained internal backlog and eligible current prices. InPlay
market delivery remains independently unproven if only types 31/32 arrive.

For stability, broker depth >500 remains an alert. An unapplied prefix >500 or
older than 5 seconds blocks stability/quotes. The durable retained prefix is
reported independently and must checkpoint forward, stay below 10,000 rows / 60
seconds and not grow continuously. These are local validation safeguards, not a
change to supplier queue policies or to the inbox byte capacity.

The original inbox receipt timestamp is now reported separately from decode time.
Validation uses market receipt time when available, so replaying an old durable
market record does not masquerade as fresh provider delivery in a new session.

Measured limits: final cgroup peak 3,715,850,240 bytes, transport event-loop peak
485 ms, main event-loop peak 10,318 ms during burst, checkpoint max 42,737 ms,
mean 3,222 ms. Final active processing-age samples stay below 1,980 ms.
There are still transient CPU/checkpoint stalls; this is not a zero-latency claim.
Selection blocks remain in force for unapplied gaps. Actual supplier field
richness/volume is not inferred from synthetic padding; the pre-start preserved
spool rehearsal and real AWS observation remain necessary.

Reproduction parameters are in SNAPSHOT-MEMORY-RESULTS.json. Use
`ADL_LOAD_NO_REPLAY=1` for the large HTTP load case; optionally set
`ADL_LOAD_EXPORT_DIR` to retain its synthetic feed/regular checkpoint. Start a new
network-isolated 4 GiB Docker process with `ADL_COLD_FIXTURE_DIR` pointing to those
files and run `durable-cold-replay.test.ts` for cold recovery. These fixtures are
never included in the worker overlay or deployed to AWS.
