# Offline PreMatch recovery validation

Executed on 20 October 2026. No supplier HTTP calls, actual AMQP broker, AWS operations, POSNET access or Mac consumer startup. **This does not validate recovery on AWS or explain AMQP 320.**

## Result

Final isolated run: exact **516,000,000-byte** HTTP document, **6,000 fixtures**, three simulated downloads; **38.35 seconds** for the integration scenario. Container: **4 GiB RAM**, no additional swap, **2 CPUs**, read-only root, no external network. Peak cgroup memory **2,194,038,784 bytes (2.04 GiB)**, process maximum RSS **1,661,124,608 bytes (1.55 GiB)**. Exit **0**, OOMKilled **false**. Machine-readable evidence is in `OFFLINE-PREMATCH-RECOVERY-RESULTS.json`.

| Scenario | Verified behavior |
|---|---|
| Disconnect during validation | Recovery cancelled; no complete baseline or eligible odds published. Spool removed safely. |
| Disconnect after 100 applied fixtures | Partial state remained blocked and was durably restored. A delivery queued immediately before disconnection was not ACKed. |
| Restore and stable session | New full snapshot validated and applied; all 6,000 fixture IDs present once; newer live quote survived the older snapshot. Unacknowledged message was replayed, including duplicate delivery, without duplicating state. |
| Durability | Eight simulated ACKs checked against the real fsynced private regular checkpoint and atomic public projection. A market without fixture metadata was retained privately without inventing a public event. |
| Eligibility | 95,887 synthetic eligible selections available only with completed baseline, before planned shutdown. Suspended/inactive entities, invalid/missing prices, disk-only quotes and older snapshot versions remained blocked. Markets:null and Bets:null produced no invented markets/quotes. |
| Shutdown/restoration | Planned distribution stop stub ran; restored prices were blocked until a new recovery. No private checkpoint or spool was treated as proof of live feed freshness. |

The test reuses `session`, `fullSnapshot`, SDK conversion, `TradeState`, `coalescedPersistence`, real checkpoint/publisher fsync and atomic rename, and `restore`. No runtime fix was required by the passing scenario. The patch contains tests and review evidence only.

## Limits

The payload is synthetic: 6,000 fixtures, up to four markets/four selections each, with padding to match response size. It does not reproduce the supplier's exact object density, payload contents, latencies, broker behavior or sustained message rate. Real financial/ticket reconciliation and panel/iframe sessions are not exercised. The production-size run tests recovery logic, not real AMQP heartbeat delivery or package entitlements. Production protection and investigation of broker closes remain necessary.

## Reproduce

Small default case (8 MiB, no external calls):

```sh
node --import tsx --test apps/worker/src/full-recovery-offline.test.ts
```

The full run requires a locally cached image with the exact worker runtime under review and installed dependencies. The run here used base `adl-parser-offline` (`sha256:2c62fabd15fa6ff1325eb973f707b6a01d7e097f5d4169e4c5e1d54812ed8b87`). Build the dedicated test image without network:

```sh
docker build --network none -f deploy/homologation/Dockerfile.offline-recovery -t adl-offline-recovery-test .
```

Use a NEW writable disk-backed temporary directory owned by container UID 1000, with mode 0700. Do not mount any production data, credentials or runtime volumes. Run with `--network none --memory 4g --memory-swap 4g --cpus 2 --pids-limit 128 --read-only --tmpfs /tmp:size=33554432,mode=1777`, mount that new directory at `/validation`, and set `TMPDIR=/validation`, `NODE_OPTIONS=--max-old-space-size=3072`, `ADL_OFFLINE_SNAPSHOT_BYTES=516000000`, `ADL_OFFLINE_REQUIRE_4G=1`. Loopback HTTP remains available inside the isolated container. The test removes only its newly created temporary files. A mismatching cgroup limit is refused when the 4 GiB requirement is set.
