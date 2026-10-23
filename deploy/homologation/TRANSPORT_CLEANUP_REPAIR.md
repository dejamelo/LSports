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

## Storage-blocked activation follow-up

A later workflow stopped before activation because the full preserved-data disk
plan runs after guarded old-container finalization. This ordering could leave
an intentionally finalized worker stopped if rehearsal storage was insufficient.
The updater now adds a conservative pre-stop capacity gate before provider Stop
or SIGTERM; the stopped-state plan remains mandatory and authoritative.

`resume-transport-storage.mjs` binds the local preparation reference to exactly
one protected remote receipt, verifies prepared image label/digest and original
container identity, reads the latest disk plan within THAT preparation, and
prints current free/required/missing bytes, findmnt and lsblk capacities. It
never chooses a backup by recency, deletes data, expands disks or resends stop
signals. If space suffices it resumes the existing guarded preparation. If not,
it exits with those exact measurements, leaving all originals intact.

A stopped worker used to make the retirement observer raise
WORKER_NOT_RUNNING_NO_OBSERVATION, surfaced by the caller as generic
READ_ONLY_SSH_INSPECTION_FAILED. It now emits an explicit skipped observation;
actual structured inspection errors propagate with their stage. Neither code
137 nor the skipped observation is evidence of OOM. The receipt's verified
finalization signal, matching container identity and recovery proof must establish
whether termination was the guarded SIGKILL after recovery validation.

Additional regressions: four storage/stopped-worker cases, seven offline disk
cases, 22 upgrade cases (one skipped). No AWS capacity or activation result is
claimed by these local tests.

## Verified 160-GiB destination and 184-GiB continuation

User supplied the exact p1znn7u6 preparation: 29,281,841,152 free bytes,
46,012,602,712 required and 16,730,761,560 missing. Device is already 160 GiB,
partition 170,723,884,544 bytes and ext4 165,295,407,104 bytes. This is not the
old 64/80-GiB volume. Requested 184 GiB adds 24 GiB against the measured 15.58
GiB deficit, approximately 8.42 GiB extra before ext4 overhead, in addition to
the existing plan reserve. Conditional gp3 estimate at USD 0.08/GiB-month:
USD 1.92/month extra; confirm current AWS rate/type, excluding IOPS and taxes.

Console action must verify vol-03fa30ff2fc37a28e is attached to
instance i-04690a17692088df9 in us-east-2 before modification. No EBS API mutation
is performed by the continuation. After console modification is optimizing or
completed, expand-prepared-transport.mjs checks IMDS instance/region, NVMe volume
serial, exact prepared receipt, root ext4 mount and hashes of the four lifecycle
source files from 7b8bf4b. It requires visible capacity >=184 GiB, uses growpart
with explicit NOCHANGE handling and resize2fs, then invokes the guarded receipt
resume. A failed check never starts a worker. No backups or inbox records are
removed to make space. Existing completed finalization is reused.

The final JSONL separates image/source verification, activation, old-cohort
retirement, pending-row decrease, and complete feed validation. InPlay types
31/32 alone never count as real market recovery. Five additional identity,
capacity and source-hash tests passed, plus the four storage regressions.
Neither tests nor preparation imply that AWS recovery has already completed.

## Exact startup exception boundary (23 October)

The supplied retirement-publication trace verifies socket closure at
13:40:48 UTC and worker.start failures at 13:46:47 and 13:52:54 UTC. Shared
file.persist succeeds at 13:53:50 while InPlay remains active. The last PreMatch
actor sample is 831.6 seconds old; it does not establish a live blocked actor.
The installed transport sends only INGRESS_FAILED for most exceptions. Its
original type/code/stack are discarded before describeFailure returns
unknown_exception. No historical exception has been recovered from that report.

The patch records explicit startup stages (ownership/spawn, inbox open, AMQP
connect/channel/prefetch/consume), actor closing/exit, UUID session/actor identity,
allowlisted type and code, SQLite numeric errcode and bounded repository stack
coordinates. It never prints the original error message, endpoint, credentials,
queue, payload or absolute path. Checkpoint logs now carry session/actor IDs.
The reader preserves these structured fields rather than returning the same
generic error. It changes diagnostics, not message disposition or recovery rules.

Tests reproduce real inbox-open failure and local AMQP refusal with distinct
sanitized diagnoses; failed actor initialization releases ownership. The session
regression preserves 100 rows on failed persistence, then opens a new session,
replays/retires all 100, processes a fresh update, verifies current metrics and
restores the persisted final price. Existing consumer regressions pass. These
are local proofs; they neither identify the historical AWS exception nor prove
that PreMatch has recovered there.

apply-startup-diagnostic-repair.mjs performs one guarded worker diagnostic update
through existing source-scope, backup and offline recovery gates, then includes
the exact current startup error and durable retirement result in its final JSONL.
No interface, API, POSNET, memory limit or commercial configuration is changed.
An additional restart is not an automatic response to a failed diagnostic run.
