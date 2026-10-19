# Ticket #217525 — PreMatch filtered snapshot returns no decoded fixtures

Draft only; not sent automatically. Evidence from the user's saved report and
screenshot collected on 2026-10-19. No new supplier calls or restarts were made
for this investigation.

Hello Szymon / LSports support,

Following the distribution propagation correction, we have a separate PreMatch
snapshot completeness issue in Test, package **4511**, using the official
**trade360-nodejs-sdk 3.10.10**.

The subscription inventory returned **7,485 unique fixture IDs**. The first
filtered snapshot batch requested **10 fixtures**, but our adapter returned
**0 events**; our completeness check reports missing=10, unexpected=0.
Five example missing fixture IDs retained in the diagnostic are:

`12071254, 12382367, 13796395, 14751373, 14877001`

Only five examples were retained; this is not the full ten-ID request body.
These are positive safe integers and pass unchanged through SDK serialization.
We cannot independently confirm that they should have current PreMatch data.

The calls in our code are:

- Customers API: POST `/Fixtures/Get` via `getSubscriptions(new GetSubscriptionsRequestDto({}))`, reading `Body.Fixtures` as numeric IDs.
- Snapshot API: POST `https://stm-snapshot.lsports.eu/Prematch/GetEvents` via `getEvents(new GetEventRequestDto({fixtures: ids}))`.
- SDK request JSON fields: `packageId: 4511`, `username`, `password`, and `fixtures: number[]`. Credentials are deliberately omitted here. No date, sport, location, league or timestamp filter is added.

For illustration only, the retained five-ID subset would be represented as:

```json
{"packageId":4511,"fixtures":[12071254,12382367,13796395,14751373,14877001]}
```

Credentials are omitted from this illustration; this is not a complete request
and not a reconstruction of the original ten-ID batch.

Recorded timestamps, all **2026-10-19 UTC**:

| Diagnostic record | UTC timestamp |
| --- | --- |
| Corrected worker validation reference | 14:01:25.125425Z |
| PreMatch activation check: raw Body.IsDistributionOn=true after measured 2,128 ms | 14:01:45.148Z |
| Repeated activation check: raw true after measured 2,127 ms | 14:03:55.634Z |
| Historical snapshot-validation record: session start | 14:03:52.568Z |
| Historical snapshot-validation record: last attempt | 14:03:59.744Z |
| Historical snapshot-validation record: last error; inventory=7,485, first batch 10→0 | 14:05:58.125Z |
| Most recent stored snapshot error in the later report | 15:04:26.010Z |
| Current session in that later report | 15:31:15.447Z |
| Current last snapshot attempt in that later report | 15:32:23.416Z |
| Read-only report collection | 15:34:01.525Z |

These are persisted diagnostic times, not packet captures. In particular, the
15:04:26 error predates the 15:31:15 session: it must not be attributed to the
15:32:23 attempt. The 7,485 inventory and example IDs belong to the historical
post-fix record; the current partition was waiting with inventory=0.

The SDK maps `Body[].FixtureId` to `fixtureId`. Our local tests using the real
SDK and an isolated HTTP server confirmed that the five IDs survive the wire
format exactly, nonempty valid Body arrays retain all records, and a Body
empty array reproduces a zero-event completeness failure. Malformed nonempty
rows without Fixture fail a different validation; they are not silently filtered.
Our adapter also checks raw versus decoded row counts before the completeness
check. However, **the original rejected HTTP response was not retained**, so we
cannot attach its Header/Body or claim its exact shape. The internal label
`attribution: provider_contract` is a local validation classification, **not
proof of a provider defect**.

Please confirm:

1. For package 4511, do `/Fixtures/Get` subscriptions include historical,
   expired, in-play or Outright IDs that are legitimately absent from regular
   `/Prematch/GetEvents`? Which authoritative inventory/status fields should
   define a complete recoverable PreMatch baseline without cancelling subscriptions?
2. For the five IDs above, what are their product family, subscription status,
   fixture status, coverage and retention/availability in Test? Should each be
   recoverable via regular `/Prematch/GetEvents` at the recorded times?
3. Please inspect the actual ten-ID requests and corresponding response
   Header/Body around the recorded post-fix snapshot attempt/error, and share
   a credential-free response example. Was Body empty, or was an alternate
   envelope or application error returned?
4. Please confirm the supported numeric `fixtures` array format and any
   restrictions on filtered requests, and the documented way to recover the
   complete available inventory in bounded batches.

The separate PreMatch AMQP 320 / connection_forced events remain under
investigation; we do not assume they explain the zero-event snapshot. Mac
consumer remains stopped. No subscription cancellations, distribution resets,
extra probes or speculative worker restarts were performed for this analysis.

Thank you.
