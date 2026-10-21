# Resume full-feed validation without worker deployment

`CHECKPOINT_SIZE_LIMIT` in `execute-adl-cutover-aws.py:cutover_status` was a host
reader failure: `trade-feed.json` was capped at 268,435,456 bytes, followed by
`read_bytes()` + `json.loads()` and a whole-file-times-eight memory estimate. The
same legacy path existed in the snapshot inspection helper. None of those errors
proves the worker exited or rejected its checkpoint.

The actual AWS file size is not available in this workspace. The fixed status
reader emits its path/size before parsing, then returns `checkpointReader` with the
open file's size, completion, observed time, duration, and diagnostic-process max RSS.
Do not confuse the 915,036,878-byte synthetic regression input with the AWS file.

The new standard-library reader opens one non-symlink regular file, reads 64 KiB
chunks and retains only metadata or one bounded event (16 MiB record limit).
It counts every event/market/selection, validates all remaining JSON including
private data excluded from the report, and rejects malformed/truncated/trailing
JSON. No arrays or fields are silently skipped without syntax validation. Metadata
and nesting/token/record bounds remain enforced. The memory preflight reserves
192 MiB for bounded record parsing instead of eight times the entire file size.

Atomic worker publication may replace the pathname while diagnostics run. The
reader follows the stable open inode and checks its size/mtime before/after. A
write in place is rejected. Freshness is evaluated at observation/open time, not
after scan completion; read duration is explicit, and worker state is checked again
at the end. Polling accounts for scan duration instead of adding an unnecessary
30-second gap to a long scan. Existing stability requirements are retained.

`consumerCount=1` is broker evidence, not proof of this worker's current-session
registration or delivery. `registrationEvidence` reports broker count separately
from checkpoint active/registeredAt/session, registration-time validity, ACK count
and ACK timestamp. A registered but idle consumer still lacks ACK/market-update
proof. Missing instrumentation does not establish that subscription failed.

`--feed-validation-resume` reuses the completed deployment, performs read-only
health/Mac-absence gates and resumes full validation with the durable ingress
30-minute stability requirement. It never invokes worker upgrade/start/stop or
migration actions. Complete results remain in protected progress; terminal output
is compact. A pending feed is not success and does not trigger a restart.

Local regression: full 915,036,878-byte synthetic document, 16,329 events and
2,351,376 selections, 256 MiB process address-space limit. Complete parse took
16.79 seconds, max RSS 20,316,160 bytes. This is not AWS validation. Other tests
cover malformed ignored metadata, invalid tails, atomic replacement, freshness,
session evidence and separation of broker registration from zero delivery ACKs.
