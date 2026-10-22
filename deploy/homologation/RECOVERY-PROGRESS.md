# Short read-only recovery measurement

The supplied single observation proves durable reception but not processing completion.
It reports 673,912 received/ACKed, 528,384 processed, 520,192 checkpointed and an
explicit processing backlog of 170,182, with oldest processing age 2,657,557 ms.
The processed/checkpointed gap is 8,192. Oldest age is not time remaining; explicit
backlog can include earlier durable work and is not reconstructed from session counters.

In the worker, full snapshot application is chained through `processing.then(...)`.
That is a proven serialization dependency, not proof of the active bottleneck.
ACKs continue independently after durable inbox storage. The current worker must not
be restarted or reconfigured based on a single point.

`--recovery-progress` reuses completed migration/image activation and performs the
existing read-only health/Mac-absence gates. It takes exactly three checkpoint samples,
separated by 60 seconds, and reads existing sanitized worker logs from the preceding
10 minutes to locate current-session snapshot stages/row progress. Total duration
includes checkpoint scanning (roughly three minutes with the local representative
scan time). No provider calls, worker changes, SQL writes or new stability wait.

Rates use actual ingress metric-window timestamps, require the same session and
monotone counters, and separately report receive/ACK/process/checkpoint rates.
Net drain is the decrease in explicit processing backlog per second. An ETA is
reported only if every measured interval shrinks, using end backlog/net drain; it
assumes constant service/arrival rates and excludes future snapshot work. Flat/reused
metric windows cannot establish a rate. Snapshot progress from logs remains separate
from published/checkpoint progress. Shared persistence timing is reported once.

The result and samples are stored in the protected Mac Cutover progress and
`recovery-progress-12811-12809.json`. Console output is short. InPlay types 31/32
remain control/delivery evidence, not proof of market updates. This measurement is
not full-feed recovery validation and does not mark the migration recovered.

Local tests cover drain ETA, growth with snapshot advancement, counter/session reset,
stale windows, unstable rate direction, exclusion of historical progress and a bounded
three-read executor that preserves completed migration steps. AWS observations remain
necessary to select a proven processing/snapshot optimization.
