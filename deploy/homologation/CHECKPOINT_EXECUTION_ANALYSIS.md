Targeted investigation of the reported 2bd97d2 execution

No application/worker patch is included. The current execution JSONL and observer
JSON were not attached/mounted in this workspace; the newest accessible attachment
is api-worker-health-1792718599939.json, from before this execution. Its older
worker cannot prove the current installed correction or current failure cause.

Confirmed interpretation defect: file.persist elapsedMs is whole-publication
elapsed time, and publicationStage is sampled every 10s. Seeing
regular_checkpoint.write at 20s and 30s does not prove one writeFile blocked for
20–30s. It can represent distinct successful chunk writes. Likewise processed
32768 and 20480 require metric window, container/session identity and provenance
before being interpreted as regression/replay/reset. checkpointed=0/zero SQL
retirement remain the actual blocked criterion.

One read-only Mac entrypoint: analyze-publication-execution.mjs.
1. Find completed execution of the EXACT immutable 2bd97d2 wrapper by SHA256,
   deployment=2 / observation=0 tuple. Use the last such completed execution
   timestamp; reject a different executor. This selects reports only, never data,
   backup or image candidates. No 90-second observation is repeated.
2. Analyze the complete existing JSONL, result.log and full observer JSON from
   that run (not only the eight lines echoed by its wrapper). Locate the terminal
   child failure before the observer boundary. Unknown/missing cause stays unknown.
3. Compare counter sources/windows and explicit session/container identities;
   never infer new delivery, replay or loss from processed/decode alone.
4. Check the exact same current worker identity. Read four FIXED source files
   through /proc/INIT_PID/root/app and compare SHA256 to 2bd97d2; compare image ID
   and tag, protected original preparation receipt, source digest label and backup
   existence. Only sanitized fields are emitted. No docker exec/run or restart.
5. Three file/FD observations 5 seconds apart: exact checkpoint target and
   PID.tmp inode/device/size/allocation, matching descriptors/positions, kernel I/O
   syscall if observable (only matched FD/count, NEVER pointer arguments), cgroup
   I/O pressure/quota, CPU/memory pressure, plus relevant existing logs starting at
   the report's first known publication. Writes/renames are distinguished from no
   observable change; a short unchanged window is never called deadlock. A rename
   alone does not prove directory fsync/public commit/inbox retirement.

Reports are saved privately under ~/Library/Application Support/ADL/Diagnostics.
No original data, inbox/WAL, checkpoint, backup, distribution, POSNET, API or Mac
consumer is modified. A timeout can terminate only the local read-only SSH client.
If originals are missing, identity changed or source is not proven, output a
specific blocked result instead of silently picking another report/container.

12 local tests: terminal deployment vs observer failure; missing cause; stale and
mixed-source counter decreases; explicit/unknown sessions; raw error redaction;
exact-wrapper discovery; advancing file inode; private rename not overstated;
unchanged file not stall proof; source hashes pinned to commit; matching-FD kernel
write/fsync decoding without addresses. These validate the collector, NOT AWS
checkpoint progress. No current AWS integration success is claimed.

Entrypoint correction after 745d6b1:
The former lexical argv/module path comparison reproduced exit=0 and empty
stdout/stderr when invoked through a directory alias. This corresponds to macOS
/var vs /private/var. Both paths now use realpath before comparison. The CLI emits
collector_start and reportDirectory before discovery, saves start/error/exit JSON
privately even when discovery fails, and always prints collector_exit after a
started run. A report-directory failure is explicitly reported without claiming
files were saved. Imports remain inert.
Five additional CLI regressions passed (12 analyzer tests total): canonical and
aliased invocation, report-directory creation failure, import-only behavior, and
complete report analysis via alias with an isolated fake SSH fixture. No AWS
worker or deployment is changed by this fix.
