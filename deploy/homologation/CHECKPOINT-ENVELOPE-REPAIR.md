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

## Build failure follow-up

The checkpoint derivation used a bare `FROM sha256:<local-image-id>`. A local
BuildKit reproduction resolved that as `docker.io/library/sha256:<id>` and failed
with source metadata/pull authorization errors. Derivation now tags the verified
local image as `adl-partition-base:<id>` and verifies the tag's image ID before
using it in FROM. The tagged Docker build with the two parser files succeeded
locally. This proves the local build defect, not the cause of the remote attempt.

The existing read-only `--worker-exit-report` includes
`offlineRehearsal.checkpointImageBuild`: protected build-log hash, recognized
Docker error phrases, context Dockerfile hash/base reference and reconstructed
build argv. Arbitrary log text, registry addresses and credentials are excluded.
The failed context remains intact; the fixed context uses `checkpoint-fix-tagged-*`
and checks existing file contents on retry. No worker or distribution operation
is performed by this report. Read the actual remote log before resuming.

The subsequent protected report confirmed source resolution of
`docker.io/library/sha256` for the failed AWS attempt. The resume additionally
pins `docker build --builder default` so the build uses the daemon-local image
store instead of an externally selected buildx builder. The local build of the
two parser files using this exact builder/flags completed. Import smoke passed
with the current feed-store/contracts dependencies mounted; this is not an AWS
restoration proof. The previous build log is archived before retry. Preparation
emits the verified base image ID, local tag and builder without credentials.
The copied-backup restore remains the mandatory next remote gate before start.

## Rehearsal copy access

The privileged executor created the rehearsal directories as root/0700 and
copied files root/0600, while the image runs as node. These copies were unreadable
by the rehearsal process. The executor now probes UID/GID/groups using the image
and the Compose user (or image user), rejects root/unknown identity, and applies
0700 directories and 0600 files owned by that identity **only inside the separate
rehearsal copy**. Sources, backup parent and original feed volume are not chowned
or chmodded. Symlinks, hardlinks and shared original/copy inodes are rejected;
content hashes are checked before/after. The restore runs explicitly with the
same selected user and the read-only /recovery bind plus writable /tmp tmpfs.

Before changing the copy it emits known EACCES/EPERM operations and safe /recovery
paths extracted from the existing private log. This workspace cannot read that
AWS log: the resume performs this extraction remotely before attempting restore.
The private log is append-only across attempts; combined snapshot rejection and
permission signals must not be presumed to describe the same attempt.

Local Docker reproduction: node failed to open the restricted copy, then restored
16,329 synthetic fixtures after the copy-only ownership correction, using
UID/GID 1000, read-only mount, 4 GiB cgroup, swap disabled and 2560 MiB heap.
Source hashes, UID/GID and modes matched their recorded initial values. This is
not a validation of the protected AWS backup. Helper tests also reject root,
symlinks/hardlinks and verify originals are unchanged. No worker source, image
digest, commercial settings, distribution or migration step changed in this fix.

## Mandatory in-container read gate and current-attempt logs

The previous executor checked ownership on the host but did not demonstrate
`open` inside the mounted namespace before attempting the expensive restore.
Its append-only historical log could also report an earlier EACCES for a later
failure. Those are executor defects; the workspace still cannot assert the exact
current AWS filesystem cause without the mounted view.

Resume now runs the same immutable image ID, Compose/image user and Docker
mount/options for a small Node probe and the full rehearsal. The probe records
UID/GID/groups, numeric uid_map/gid_map, lstat modes/owners/types for `/`,
`/recovery` and the checkpoint, and detects links without following them. It must
open the checkpoint with O_NOFOLLOW and read one byte. Unsafe/missing paths stop;
copy permissions translate namespace IDs for host-side ownership when needed and
are followed by a second in-container probe. Only that successful open allows
the full restore. Original volume and protected backup are never chowned.

Each full rehearsal now has a separate protected `oom-restore-attempt-*` log and
an atomic latest pointer. Existing logs remain intact. Reports distinguish the
current attempt from old append-only evidence. No old EACCES is silently reused
as the failure of a new attempt.

The local synthetic test reproduced root/0700 traversal denial, passed the exact
probe after copy-only correction, restored 16,329 fixtures as UID/GID 1000 under
4 GiB, and rejected a symlink without following it. Original source hashes and
metadata remained unchanged. Tests assert probe/restore share Docker arguments,
and a failed probe never runs restore or starts the worker. The real AWS backup
and namespace view remain to be validated by the single resume command.
