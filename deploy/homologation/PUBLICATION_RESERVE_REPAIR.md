Publication reserve / checkpoint retirement (2026-10-23)

Observed: 536,862,480 bytes of heap headroom is 8,432 bytes below the existing
536,870,912-byte copy-on-write reserve. The guard awaits publicationDone, not GC
or a memory polling loop. The publication writer does not acquire the mutation
FIFO after capture. Thus the log alone does not establish a circular deadlock.
90 seconds with no retirement also does not identify the active write operation.

Confirmed code defects corrected:
- processMessage decoded before awaiting the publication reserve, retaining the
  full decoded event graph across that wait and (for committing deliveries)
  persistence. Decode now executes in the same guarded, synchronous turn as apply;
  only metadata/event count escapes the turn. Required state remains retained.
- publicationMutation awaited publicationDone inside the mutation FIFO. It now
  inspects under the FIFO, waits outside, and rechecks under the FIFO. Reserve
  threshold, mutation ordering, immutable captures and COW are preserved. Async
  mutation callbacks still hold their normal turn until complete.

No claim that these defects alone explain the full production delay. New 10s
writer telemetry reports encode/write/fsync/rename/directory-fsync of the private
checkpoint or public projection. Guard logs identify the publication awaited.
Per-lane raw/processed/checkpointed/backlog samples are logged every 10s directly
from the durable actor, independently of the slow publication. Persisted-prefix
logs distinguish waiting_persistence from persisted; only actor/SQL retirement
metrics prove deletion. Durable inbox/ACK behavior and formats are unchanged.

Local validation:
- 27 tests: connected/session scenarios, bounded feed writer/reader, forced-reserve
  full cycle. Forced-reserve child heap 256 MiB verifies the FIFO is available
  while apply waits, no decode/record before reserve release, persistence and
  complete restore before inbox deletion, then new insertion after capacity frees.
- Actual publicationCaptureTurn (the load test previously used publicationTurn),
  Docker 6 GiB / heap 2560 MiB / 2 CPUs: 8 MiB synthetic snapshot, sustained
  69 msg/s for 10s plus 300 burst; 990 received/ACKed/processed/checkpointed,
  final backlog zero, crash/replay of 2 records. Peak RSS 366,469,120 bytes,
  maximum persistence 584ms. Scaled concurrency test, NOT the 779,793-row AWS
  acceptance, sustained production capacity or proof of current odds.
- Initial local run used a 512 MiB tmpfs and correctly hit disk_headroom; stopped
  only that disposable local test container and reran with a disk-backed /tmp.
- Worker workspace TypeScript build passed. Root tsc includes unrelated web/JSX
  configuration errors and is not reported as passed.
- Upgrade tests: 22 (one skip); six existing pipeline/memory tests; two new strict
  publication-source scope tests; one WAL read-only cohort test.

Deployment wrapper: first require API Docker healthy AND /control HTTP200, then
use existing worker-only guarded executor. Keep 6 GiB/heap unchanged, no cache
cleanup/migration/disk expansion. Existing real-copy restoration, backup,
shutdown-recovery proof, image identity, rollback and activation ordering apply.
New explicit repair scope permits only state.ts, connected.ts, persistence.ts,
feed-store/index.ts; old pipeline allowlist is unchanged. Source digest/receipt
verification remains mandatory. API/Caddy/POSNET containers are not updated.
Afterward collect WAL-aware scalar retirement windows; abort observation
immediately if worker stopped. Report files are private and progress is visible.

AWS health, actual awaited write, real-copy acceptance, sustainable drain, snapshot
completion and odds remain unverified here. The previously deployed API's large
projection fail-closed containment remains; this worker patch does not implement
an indexed API reader. InPlay 31/32 vs real market delivery remains separate.
