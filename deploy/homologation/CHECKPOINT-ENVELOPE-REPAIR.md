# Checkpoint envelope repair

The protected report identified `checkpoint_restore`, `item_size_limit` in
`walkSnapshot` while reading a root metadata value. Code inspection confirms
that the complete `workerCheckpoint` object was passed to `rawValue` with the
32 MiB checkpoint record limit. Its embedded regular/outright arrays are an
aggregate, not an individual fixture.

The reader now traverses that envelope and parses one regular/outright fixture
at a time. The 32 MiB per-fixture cap, token/depth guards, strict JSON and row
validation remain. Metadata is separately bounded to 64 KiB. Duplicate keys,
invalid arrays, truncated/trailing JSON and duplicate fixture identities fail
without committing the temporary recovered state. External version-1 sidecars
remain supported. Legacy projection restore no longer reads the whole file.
Restored selections remain blocked; this change does not assert freshness.

## Controlled resume

Use the existing `--snapshot-memory-repair` executor, pinned to this revision.
It checks the protected ledger's prepared backup and receipt. For a stopped,
failed rehearsal with the memory image verified, it verifies original source
digest and image label and permits changes only to `full-snapshot.ts` and
`persistence.ts`. It derives a new parser image from the already prepared image;
the old image, receipt, backup and stop evidence are preserved. It does not
repeat migration or Distribution/Stop. This necessarily creates a new image:
the previously prepared image contains the defective reader.

Checkpoint/inbox/WAL and scheduler backups retain their SHA-256 records. The
rehearsal uses separate hash-verified copies under the same protected backup,
plus a copy of the preserved response spool. The container has no network,
read-only mounts, 4 GiB memory and 2560 MiB V8 heap. It must restore, validate the
complete spool, apply all fixtures and serialize the projection before the
executor can configure/start the new worker. No data or queue is discarded.
The previous rehearsal log is archived before a new attempt. Insufficient disk
for copies blocks activation rather than weakening the proof.

A fresh Mac absence audit is required again before activation. Live validation
then requires both snapshots and actual updates, durable ACK/inbox progress and
30 minutes of stability. InPlay market delivery remains independently assessed.
`--snapshot-memory-rollback` restores the prior configuration with the worker
**stopped**; it does not restart the known OOM image.

## Evidence limits

Local synthetic regressions and constrained load results are recorded in
`CHECKPOINT-ENVELOPE-RESULTS.json`. They are not AWS validation. The real backup
is remote and unavailable to this workspace. Its copied-data rehearsal will run
on AWS as the mandatory pre-activation gate; no claim that it has passed locally.
