# Transport closure, durable retirement and actor cleanup

## Evidence from the supplied execution

The workflow returned 2 after application succeeded: `cutover.resumable`,
`full_recovery_pending`, status `pending`, reason
`DISTRIBUTION_ACTIVE_NOT_VERIFIED`. The analyzer previously ignored pending
terminal records. The supplied source, image and receipt match 2bd97d2.

Publication is not proven stuck. `file.persist:ok` completed writes 42 and 43
in 60,149 and 59,048 ms. In the later probe, the private checkpoint changed at
11:31:40, then publication entered `projection.write`. Process write counters
advanced by 185,943,336 bytes during the ten-second sample. An unchanged
private target while another public file is written is expected.

The durable connection facade emits socket closure before its SQLite actor
exits. The generic socket closer skipped explicit close after this event.
Meanwhile, a successful pending checkpoint retired its captured inbox prefix
only while the transport was open. Transport loss could therefore preserve
already-persisted rows, leave the actor running and allow another actor on the
same inbox. Interleaved counters alone are not sufficient evidence; regression
on the installed 2bd97d2 session code reproduced this lifecycle defect.

## Minimal behavioral correction

Quiesce intake after transport failure; keep the actor until processing and
persistence finish. Retire a captured prefix only after its persistence succeeds,
including when AMQP has closed. Join actual actor exit before permitting another
owner of the same inbox path. A failed write retains its raw rows. The journal
schema, ACK-after-durable-receipt rule, ordering and memory limits are unchanged.
Logs identify each session and actor to distinguish counters across lifetimes.

The guarded updater permits changes to precisely four worker source files.
It preserves existing backup, original-hash, copy/replay/roundtrip and shutdown
proof gates. No API, Caddy, POSNET, package, migration or commercial change is
included. Existing loaded actors require replacement by the new worker image;
reapplying the old image cannot activate this fix.

## Verification

* Installed-code regression: transport loss during captured persistence leaves
  all 100 raw rows despite a successful checkpoint (expected test failure).
* Corrected code: the same 100 rows retire after persistence; injected write
  failure preserves all 100. Actor ownership is released only on actual exit.
* Worker/session regressions: 37 passed. Diagnostic/validation regressions:
  27 passed. Worker build passed. Upgrade tests: 22 passed, one skipped;
  strict transport source scope: two passed.
* Isolated Docker load: 69 messages/s for ten seconds plus a 300-message burst,
  simultaneous 8 MiB synthetic snapshot; 990 received, ACKed, processed and
  checkpointed, final backlog zero; restart replay verified; maximum process
  RSS 375,857,152 bytes, maximum persistence 596 ms.

This is local regression/load evidence, not acceptance of the full preserved
AWS dataset or sustained production capacity. No AWS deployment was performed
from this workspace. InPlay market delivery remains a separate unresolved issue.

The new executable wrapper saves JSONL progress, applies only this guarded worker
patch, then observes actual durable retirement. Full validation stops with an
explicit not-verified reason if five minutes show no durable PreMatch retirement;
it never treats ACKs or processed counters as completed recovery. The final
report separates workflow exit from confirmed image activation.
