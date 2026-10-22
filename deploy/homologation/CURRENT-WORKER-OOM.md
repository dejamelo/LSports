# Current worker OOM collection, not a replay of historical rehearsal evidence

The user confirmed Docker OOMKilled=true and exit 137 for container
`7f43cb2939c7de18715ae67ae07e368a1702b06edc48c2e8fb770cb4b2c56f`.
The allocation/site causing this OOM is not yet proved. Offline rehearsal success
or a diagnosis from an older container cannot establish its cause.

The failed progress collector used JS `toISOString()` (milliseconds), whereas
`existing_recovery_timeline` accepted only whole seconds. The fix accepts RFC3339 UTC
Z timestamps with optional 1–9 fractional digits, validates calendar/time, identifies
`window.fromUTC`, `window.toUTC` or `State.FinishedAt` on failure, and retains positive
bounded windows of at most one hour. Arbitrary invalid strings are not echoed.

Run existing `--worker-exit-report` with `ADL_CURRENT_EXIT_ONLY=1` and
`ADL_EXPECTED_WORKER_ID` set to the exact confirmed ID. A mismatch stops collection;
no replacement container is silently used. The output omits historical offline
rehearsal evidence and is saved to a container-suffixed protected report so the prior
report is preserved.

Collection is read-only: inspect current image/limit/sanitized Node old-space option,
exact Docker StartedAt/FinishedAt, last 20 minutes anchored to FinishedAt, last log
signals/stack frames, and a bounded full read of the last published checkpoint.
Persisted snapshot, ingress and shared persistence metrics retain their timestamps;
they are last-known state, not proof of the precise allocation active at the OOM.
Checkpoint parsing failure is recorded without losing exit/log evidence.

Kernel journal collection is optional and bounded. It matches this container's cgroup
ID and correlated killed host PID, returns numeric RSS fields only, and excludes older
containers' events. Unavailable journal data does not block the rest of collection.
No raw logs, credentials, database opens/writes, provider requests, restarts, distribution
changes, checkpoint rewrites, memory increases, panel or POSNET changes.

Tests: millisecond/nanosecond UTC, invalid/missing timestamps and redaction, exact
container fencing, kernel correlation excluding another container, existing checkpoint
and collector regressions. Actual server evidence and preserved-data replay remain
necessary before selecting and deploying a proven memory correction.
