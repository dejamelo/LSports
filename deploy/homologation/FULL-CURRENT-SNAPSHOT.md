# Current snapshot and continuous consumption — ticket #217525

Supplier confirmation supplied by the user on 2026-10-19, Michal Szczepański:

- PM4511 distribution was automatically disabled at 14:01 and 14:03 UTC when
  unread queue depth reached 10,000, causing AMQP320 / connection_forced.
- `/Fixtures/Get` contains every fixture ever subscribed, not current inventory.
  The five IDs in our previous report are from 2024. Snapshot retention ends
  24h after an event ends, so empty filtered responses for them are expected.
- Use `/Prematch/GetEvents` WITHOUT fixtures to obtain current regular events.
- Full snapshots: at most one per 15s; filtered snapshots: at most one per 1s.
- Keep consuming while distribution is on. Call `/Distribution/Stop` before
  planned consumer shutdown. Never purge the existing queue.

This supersedes the inference in the older partitioned-inventory procedure.
`provider_contract` was not proof of a supplier fault. No subscription changes
are needed or made.

## Worker implementation

PM recovery now uses one ordinary unfiltered POST with the SDK Mapper and
GetEventRequestDto/GetEventRequest serialization. No invented pagination or
vendor streaming endpoint: standard HTTP is incrementally written to a private
0700 temporary directory / 0600 file on the EXISTING feed volume, not the
64MiB tmpfs. No credentials/headers/full payloads are logged.

Hard bounds: 2GiB DECOMPRESSED disk spool; 16MiB per fixture/token; 50,000
unique fixtures; 64KiB other envelope fields, at most64 root keys / 64 characters per key /
128 nesting levels; at least spool cap + 512MiB free
space before HTTP; 20s socket idle timeout, 120s total download deadline; no
redirects. gzip/deflate/br use bounded decompression. These are explicit local
resource limits, not supplier quotas. Existing container 4GiB, heap3072MiB and
InPlay response cap128MiB remain unchanged.

Two disk passes: validate the entire JSON envelope, Header/errors and all row
structures/timestamps/duplicate IDs; then convert/apply each fixture using the
same official GetEventsResultElement TransformerUtil. A bounded tokenizer
retains one fixture rather than a concatenated Body array. Check BOTH physical/
cgroup availability and V8 heap headroom before conversion. Also reserve an
estimated 4 × spool bytes + 128MiB headroom for retained state/publication before
application; this is an estimate, not a guarantee of arbitrary volume fitting
4GiB. Insufficient resources leave recovery blocked, without releasing prices.
Spool files are removed in finally; interrupted-process leftovers remain private.

Raw and SDK counts are checked per row. Malformed/truncated/application-error
snapshots cannot complete a baseline, including a Header placed AFTER Body.
The supplier's current Body itself defines the inventory; no `/Fixtures/Get`
is used by the new recovery path. Outright remains separate. The old optional
partition code stays for historical diagnostics/tests, but the real PM client
always chooses full recovery first; the existing Compose flag is preserved.

Both lanes install the exclusive consumer BEFORE Distribution/Start, and process
deliveries during activation and HTTP recovery. Each finite group contains
at most 100 deliveries (prefetch100). Apply/settlement reconciliation and
atomic persistence complete before any ACK of the group. Unsupported deliveries
still request requeue and block for handler review; nothing is purged/dropped.
Snapshot application shares the serial mutation chain with AMQP; version
ordering retains recent updates and settlements. Events received via AMQP after
snapshot start are retained even if not present in the earlier snapshot view.
Keepalive/control timestamps do not confirm prices. Old quotes and finalized
markets remain blocked by the existing selection/settlement rules.

The previous private checkpoint retained only Outright rows, so an AMQP regular
market received before its fixture could be invisible in the public projection.
An additive v1 regular checkpoint now preserves those rows (including precise
bet ordering), always restored as unconfirmed. Production writes it to
`trade-feed.json.regular-checkpoint.json` BEFORE the public projection and ACK.
The public checkpoint uses `regularExternal:true`, avoiding embedding all raw
regular rows in the API JSON. Existing v1 files without this field still restore;
no timestamp/ticket migration is repeated. A missing/invalid/referenced sidecar
blocks restoration. Restore also checks sidecar type/size/available memory.
If a crash leaves the sidecar ahead of the public feed, its state is safe to
replay idempotently; restored prices remain blocked pending new recovery.
Back up BOTH projection and regular sidecar while the worker is stopped,
alongside Outright checkpoint (embedded in projection), journals and ticket DBs.
New worker-upgrade backup includes the sidecar. Previous backups are preserved.
File fsync, atomic rename and directory fsync precede ACK.

The scheduler's existing persisted reservations, shared locks, Retry-After and
backoff remain intact. The 5-minute refresh remains intact. Production host spacing is now at least15s
for ALL snapshot operations, conservatively covering both full15s and filtered1s
limits. It also extends an older shorter host reservation to this floor, without
shortening any existing operation cooldown, resetting journals or adding probes.

Normal SIGINT/SIGTERM calls SDK Distribution/Stop and verifies distribution off
before closing the transport. During this first upgrade the OLD image lacks
that shutdown behavior: the executor runs a credential-protected, HTTP-only
Stop helper while the OLD consumer is still present, checks off, then sends one
SIGTERM. Failure to confirm Stop blocks the upgrade and preserves the consumer.
Future signals in the corrected image perform Stop as part of shutdown.

## One command, on the Mac

```bash
cd "$HOME/LSports" &&
git pull --ff-only origin feat/sportsbook-demo &&
node deploy/homologation/complete-adl-cutover.mjs --pid 12811 --parent 12809 --full-recovery
```

The PIDs identify the existing migration ledger only; no Mac process is signaled.
The executor audits Mac absence, reuses completed migration, builds a derived
WORKER image offline, tests the parser offline before stopping anything, saves
protected backups, stops supplier distribution before the single controlled
worker replacement, and preserves every saved Compose override and POSNET/API
image/configuration. No subscriptions, queue names or paid resources change.
Existing journals gate the first request automatically; startup does not bypass
cooldown. Re-running the same command resumes the saved upgrade receipt;
completed backup/image/stop/start steps are not replayed.

Validation is read-only against saved AWS diagnostics, up to45min. It reports
actual completed PM full spool bytes/rows/times, AMQP ACK counters and ACKs during
recovery, current-session snapshots on BOTH feeds, selectable selections and
post-fix AMQP320 closures. It does not call extra vendor endpoints. Container
running alone is insufficient. Zero deliveries during recovery means continuity
cannot be observed in that run; it is reported pending, not fabricated.
Full result needs current snapshots, actual ACK evidence during recovery and
currently selectable odds, with projection counts separated per lane (an open
market on InPlay is not inferred from open PreMatch odds). `iframeAuthenticated:false` remains explicit: this
worker-only update cannot create an authenticated iframe session or validate
its browser behavior. AWS homologation still requires its own configured
administrator/client/operation/session for that separate check.

If validation remains pending, retain its concrete diagnostics/cooldown; do not
restart the Mac or repeatedly restart AWS. The supplier queue-cap explanation
is now confirmed, but live throughput/recovery at real volume must be validated
by this execution; isolated tests are not real-feed validation.

## Local tests

- HTTP fixture >256MiB, no fixtures filter, bounded token/item/RSS behavior;
- invalid/truncated/duplicate/application-error envelope, Retry-After429;
- official SDK Stop order and authoritative off confirmation;
- 100 deltas ACKed after persistence while full snapshot remains pending;
- no regressions in requeue, settled outcomes, precise version order;
- market-before-fixture private persistence and restart with availability blocked;
- updater only changes worker, stops distribution before SIGTERM, preserves
  migration/journals/overrides and reuses receipt on resume;
- validation separates current snapshots/ACKs/odds from keepalives/old state.
