# Isolated concurrency reproduction — 2026-10-20

Input: synthetic 424,384,892-byte document, 6,000 fixtures, 400 selections per fixture. No provider request or AMQP network connection. Same Node process, sequential before/after trials; warm-cache/GC and run-to-run variation limit generalization. Environment cgroup CPU quota 4 cores, memory cap 32 GiB; these are NOT the AWS worker's limits.

While validating/converting every fixture, timers simulated deliveries and heartbeat scheduling, with coalesced real regular-checkpoint + projection writes and fsync (8 MiB synthetic projection). Each simulated ACK checked its delivery was persisted. The test does not simulate broker-side queue limits or real negotiated heartbeat behavior.

| Measurement | Existing token-at-a-time parser | Batched token parser |
|---|---:|---:|
| Validation and final drain | 120,741 ms | 104,693 ms |
| Simulated deliveries confirmed | 893 | 781 |
| Durable writes | 970 | 856 |
| Maximum total persistence duration | 1,335 ms | 742 ms |
| Maximum timer scheduling lag | 133 ms | 76 ms |
| Sampled process RSS high-water mark | 528,986,112 bytes | 576,860,160 bytes |
| Persisted before every checked ACK | yes | yes |

Different delivery totals reflect different elapsed durations, not message loss. RSS is process-wide and after runs in the same process; it is not an independent peak-memory comparison or evidence of compliance with AWS limits. Worker memory cap remains 4 GiB; bounded spool/item/token limits and live headroom checks remain in force.

The parser's per-token async iteration overhead is measurable. Token batching reduces this overhead while yielding at every 64 KiB input chunk. Complete first-pass envelope/SDK validation still precedes application. The experiment did NOT reproduce a 30-second heartbeat outage and does NOT prove the cause of AMQP 320. AWS logs also contain closures without active validation. Existing 14,327 ms persistence durations include capture, asynchronous writes/fsync and scheduling; they are not measured continuous event-loop blockage.

Added minimal runtime measurements: capture duration, regular-checkpoint duration, projection-publish duration, maximum event-loop delay since the previous persistence log, and process RSS. Metrics are shared-worker measurements, not independent per-feed timings. No payloads or credentials are logged. ACK ordering, queues, startup order and planned Distribution/Stop remain unchanged.

Reproduce locally (isolated synthetic data, significant temporary disk writes):

```sh
node --import tsx scripts/benchmark-snapshot-concurrency.mts
```

A separate offline image test uses no network, 512 MiB and 0.5 CPU, verifies dense-token parsing yields timer turns, and must pass before worker activation. This is not real AWS validation.
