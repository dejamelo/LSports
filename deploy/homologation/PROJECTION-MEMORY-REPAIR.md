# Projection serialization recovery

The `bde206b` real rehearsal finalized 16,329 fixtures, then exhausted V8 heap in
`projection.serialize` (effective heap 2,885,681,152 bytes). Read access had passed.
This is separate from the historical worker Docker OOM; exit 139 alone is not Docker OOM evidence.

## Change

The previous save called `state.feed()` before writing. That constructed and retained
all projected markets/selections, ticket outcome/version arrays, and cached regular
projections alongside the restored source state. The old writer streamed root arrays,
but still used aggregate `JSON.stringify` for nested objects and cloned masked events.

The worker now captures row references and generates the public projection one fixture
at a time using the same projection rules. Ticket outcome/version collections are
replayable lazy arrays. A row changed during publication is copied on first mutation,
so an in-flight captured projection retains consistent row contents. Nested JSON is
written with a 64 KiB output buffer, including checkpoint arrays. This bounds additional
serialization memory by a fixture/leaf and buffer, rather than the entire public graph;
it does not claim the resident source state itself is constant size.

Existing JSON fields, InPlay duplicate precedence, settlement/version reconciliation,
restored-price blocking, fsync and atomic publication are retained. No memory increase,
queue purge, data deletion, credential or commercial subscription changes.

## Real-copy gate

`--snapshot-memory-repair` reuses the protected stopped-worker backup and verified
prepared-image ancestry. Only the worker source layer changes. It retains the non-root
read-access gate and original read-only `/recovery` mount. Generated output is written
to a separate private `/output` bind, owned like the verified rehearsal copy.

With the same image, node UID/GID and limits (4 GiB container, old space 2560 MiB),
the gate restores the checkpoint, validates/applies the saved spool, serializes the
projection, fsyncs, and rereads the entire file. It compares each event's complete
serialized content against a bounded projection of that fixture, checks published
counts and validates the remaining JSON grammar. Only then is
`projectionReadbackVerified=true` recorded alongside `oomRestoreVerified=true`.
Failure keeps feeds stopped and retains a fresh private attempt log plus phase/memory
metrics. Originals, WAL/inbox and prior attempt logs are not overwritten.

After that gate, the existing Mac-absence audit, controlled activation and real-feed
validation resume. Do not restart the old OOM image as a rollback experiment. Local
proof is not AWS recovery, current odds, or resolution of the separate InPlay issue.

## Local evidence

Generated data is synthetic, not a supplier response or a copy of the protected AWS
backup. The denser fixture generator is `scripts/fixtures/projection-memory-snapshot.py`:
16,329 fixtures, 195,948 markets, 2,351,376 selections; 377,276,686 structured bytes
inside a 516,000,000-byte document. It includes names, timestamped prices, suspended
markets/selections and settlements. It exceeds the density of the earlier padding-heavy
sample. The input checkpoint and regular sidecar are separately restored first.

Unit coverage compares complete ordinary and streamed JSON, duplicate precedence,
outright diagnostics, version recoveries, settlement preservation, quote quarantine,
copy-on-write during live updates, and guards against nested aggregate stringify.
The durable load test uses the new publication path, 69 messages/s plus a burst and
crash replay, and checks received/ACK/processed/checkpointed totals and a drained inbox.

Measured constrained-container results are recorded in `projection-memory-results.json`.
The real backup is accessible only on AWS and remains an explicit deployment gate.

The A/B regression uses the same dense fixture and limits. Retaining the old
`feed(now,true,true)` aggregate path reproduced fatal `javascript_heap_out_of_memory`
in `projection.serialize` after all 16,329 fixtures (exit 139, last GC 2546.5 MiB).
The incremental path passed the entire write and streamed reread with max RSS
2,269,126,656 bytes; the earlier 8x8 fixture peaked at 1,793,519,616 bytes.
These are local synthetic measurements. The strengthened per-event content comparison
is separately required by the real-copy deployment gate.

The exact strengthened executor rehearsal also passed full event-content comparison:
318745 ms; max RSS 2248437760 bytes; sampled heap peak 1920506664 bytes.
This used the same 4 GiB/2560 MiB limits and no provider network access.
