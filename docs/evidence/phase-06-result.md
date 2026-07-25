# Phase 06 result — Trace graph and normalisation engine

Branch: `phase/06-trace-graph`
Date: 2026-07-25

## What was built

```text
packages/normaliser/src/identifiers.ts  bounded, non-backtracking identifier recognition
packages/normaliser/src/config.ts       versioned, content-hashed rule configuration
packages/normaliser/src/normalise.ts    the ten ordered steps of PRD section 11.6
packages/trace-graph/src/model.ts       TraceNode, TraceEdge, TraceGraph, quality warnings
packages/trace-graph/src/build.ts       dedup, root selection, orphan and cycle detection
packages/trace-graph/src/canonical.ts   canonical serialisation and SHA-256 fingerprint
packages/trace-graph/src/features.ts    weighted feature sets and Jaccard similarity
packages/trace-graph/src/diff.ts        the twelve typed change kinds
packages/trace-graph/src/export.ts      redacted, deterministic JSON export
scripts/capture-trace-fixtures.mjs      captures real traces from live SigNoz as fixtures
packages/test-fixtures/traces/*.json    the captured v1 and v2 traces
```

## Fixtures are real telemetry

`scripts/capture-trace-fixtures.mjs` pulls the current demo traces from the live deployment
through the Phase 05 client. The script refuses to write a fixture containing any forbidden
attribute key, and stores rows sorted by `span_id` — deliberately *not* the order the graph
engine needs, so a builder that depended on arrival order would fail immediately.

```text
refund-agent-v1  trace ae0c0d8945a3c922b9586ea578f56508  12 spans, 6 services
refund-agent-v2  trace b26b97234e0f594f809f9ef9c169d21f   8 spans, 4 services
```

## Runtime validation

The exit gate is proven against the running system, not only against the fixtures.

| Assertion | Result |
|---|---|
| Known-good release reconstructs as 12 spans over 6 services | Pass, from a live fetch |
| Unsafe release reconstructs as 8 spans over 4 services | Pass, policy and fraud absent |
| A **live** v1 trace fingerprints identically to the captured fixture | Pass |
| Two independent live v1 runs fingerprint identically | Pass |
| v1 and v2 fingerprints differ | Pass |
| The diff names the skipped checks and the duplicated refund | Pass |
| A live v2 trace fingerprints identically to the captured v2 fixture | Pass |

The third row is the phase's real result: two executions minutes apart, with entirely different
trace IDs, span IDs, run IDs and timestamps, produce the same 64-character route fingerprint.
That is the precondition for baseline mining in Phase 08.

## Findings recorded

### SL-044 — timestamps arrive as ISO strings at millisecond precision

The Query Builder serialises the nanosecond `timestamp` column as `2026-07-25T10:37:54.59Z`.
`duration_nano` is full precision. So `startTimeUnixNano` is millisecond-accurate and
`endTimeUnixNano` is derived from the duration. Determinism is unaffected — PRD section 11.7
excludes timestamps from the fingerprint — but two spans starting inside the same millisecond
cannot be ordered from this evidence, which independently confirms why PRD section 11.1 forbids
treating timestamp order as causal truth. Recovering full precision would need a direct ClickHouse
read, which section 12.4 prohibits.

### SL-045 — a pre-existing sortability defect in the identifier generator

While running the regression suite, `packages/db`'s "generates sortable time-ordered identifiers"
test failed. It was not a Phase 06 regression; it was **flaky, failing about one run in five**,
and it had been passing by luck since Phase 01.

The cause was real. `flightrules_uuid_v7` encoded 48-bit milliseconds plus 74 random bits, so two
identifiers generated inside the same millisecond ordered randomly. The old test compared two
identifiers, which is far too small a sample to observe it. PRD section 14 requires a sortable
format, and one that only sorts across millisecond boundaries would break id-ordered pagination
intermittently and almost untraceably.

Fixed in migration `0002_uuid_v7_submillisecond.sql` using RFC 9562 Method 3: the 12 bits of
`rand_a` carry the microsecond remainder from `clock_timestamp()`. The test now generates 200
identifiers in one statement — nearly all inside one millisecond — and asserts they sort exactly
in generation order. Six consecutive runs pass.

## Defects found and fixed during the phase

Three, all found by tests rather than by inspection.

### 1. Subtree signatures grew quadratically and overflowed the string limit

Canonicalisation originally nested each child's signature verbatim inside its parent's, so a
signature's length grew with its subtree. The 10,000-span test failed with
`RangeError: Invalid string length`. Fixed by hashing each subtree into a fixed 64-character
digest, which preserves the property that matters — two subtrees share a signature exactly when
their content matches — at constant width.

### 2. Dotted structural paths made canonicalisation quadratic

With signatures fixed, the same test took **5.6 seconds** and timed out under load. The cause was
the canonical path representation: `0.1.2.3...` strings whose length grows with depth. A
10,000-deep trace produced roughly 50 million characters of path data, and sorting them compared
10,000-segment strings.

Replaced with a canonical **order index** — an integer assigned by a pre-order walk in which
siblings are visited in subtree-digest order. It carries the same information, because it derives
from the same canonical ordering, and structure stays explicit in `depth` and in the edge list.
The full graph suite went from 5.6 s to **209 ms**. The test now asserts a time budget so this
cannot regress silently.

### 3. A prototype-chain lookup in the alias map

The property test asserting that arbitrary input never throws found the counterexample
`"toString"`. `config.aliases[name]` on a plain object resolves `toString` and `valueOf` to
functions on `Object.prototype`, which were then substituted for the span name and crashed the
tokeniser. Span names are external input, so this was reachable from telemetry. Fixed with
`Object.hasOwn`, and the same hardening applied to `readPath` in the Phase 05 write-verification
helper, which had the identical pattern.

A fourth issue was found and fixed in the same pass: the tokeniser split on `-` and `_`, which
destroyed the very identifiers it needed to recognise — a UUID became five unrecognisable tokens
and `run_` was separated from its suffix. The separator set now contains only characters that
genuinely delimit one field from the next.

## The Phase 04 aborted server span

Phase 04 recorded that the v2 trace's first payment attempt has no exported server span: the
client aborts while the handler is still in flight, and Fastify 5.10.0's `onRequestAbort` does not
fire for a request already running. Phase 04 assigned the handling here.

**It is not resolved, and no attempt was made to manufacture the span.** It is a genuine property
of an aborted request, and changing service behaviour to produce it would distort the demo.

The handling is:

- a client span with no server span beneath it raises a `client_span_without_server_span`
  trace-quality warning
- the warning does **not** downgrade the trace to `incomplete`, because the duplicate-side-effect
  evidence lives entirely in the two exported client write spans
- the payment ledger remains corroborating evidence and is never the contract signal

Two tests hold this in place: one asserts the warning is raised, the other asserts the trace stays
usable and both client write spans are present. If a future change lost the *client* spans, the
second test fails loudly rather than the product silently losing its core finding.

## Determinism

Every property PRD Phase 06 requires, with `fast-check`:

| Property | Runs | Result |
|---|---|---|
| Any input row order yields one fingerprint | 200 | Pass |
| Any attribute key order yields one fingerprint | 200 | Pass |
| Regenerated trace, span, run and order IDs yield one fingerprint | 100 | Pass |
| Normalisation is idempotent | 500 | Pass |
| Normalisation never throws on arbitrary input | 500 | Pass |
| Tokenisation round-trips any string | 500 | Pass |

Sensitivity is tested in both directions: removing the fraud check, reparenting a node, and
changing a side-effect classification each change the fingerprint; changing the order ID does not.

Performance: a 1,000-span trace canonicalises well inside the PRD section 20.2 one-second budget,
and a 10,000-deep chain builds and fingerprints without stack overflow in under two seconds.

## Commands run and results

| Command | Exit | Result |
|---|---|---|
| `pnpm run typecheck` | 0 | clean |
| `make test` | 0 | **317 unit tests passed** (233 before, 84 added) |
| `make test-integration` | 0 | **67 integration tests passed** (61 before, 6 added) |
| `make verify` | 0 | complete suite green |
| `make db-migrate` | 0 | migration 0002 applied |
| `make demo-v1`, `make demo-v2` | 0 | fresh traces captured and reconstructed |

Total: **384 tests passed, 0 failed, 0 skipped.**

## Known limitations

1. **Span links and explicit predecessors are modelled but not populated.** `EdgeType` includes
   `span_link` and `explicit_predecessor`, and the canonical form carries edge type, but the demo
   emits neither, so no edge of those kinds is constructed. Building an untested code path for
   telemetry that does not exist would be the placeholder the operating contract forbids. Phase 07
   adds them when a contract rule needs them.
2. **`inferred_time_order` is not computed.** PRD section 11.3 permits it for display only. Given
   SL-044's millisecond resolution it would be unreliable at exactly the sub-millisecond scale
   where it would matter, so it is deliberately absent rather than present and untrustworthy.
3. **Route families are not yet mined.** PRD section 11.8 grouping is Phase 08; this phase
   produces the fingerprint that grouping is exact on.
4. **Similarity is display-only.** It never contributes to a pass or fail decision, by design —
   a threshold on a similarity score is exactly the fuzzy judgement the determinism boundary
   excludes. Phase 08 uses it to choose the nearest family for an unknown route.
5. **Node timestamps are millisecond-accurate** (SL-044). Excluded from the fingerprint, so
   determinism is unaffected, but latency percentiles computed in Phase 08 inherit the resolution.

---

```text
PHASE: 06 Trace graph and normalisation engine
STATUS: PASS
BRANCH: phase/06-trace-graph
COMMITS: recorded in CHANGELOG.md and below
SOURCES VERIFIED: 3 — live Query Builder responses characterising the timestamp column's serialised precision (SL-044); PostgreSQL 16 runtime behaviour of the Phase 01 identifier generator together with RFC 9562 section 6.2 Method 3 (SL-045); and two demo traces captured verbatim from the running deployment as test fixtures
IMPLEMENTED: packages/normaliser with the ten ordered PRD section 11.6 steps, bounded non-backtracking identifier recognition, and a versioned content-hashed configuration; packages/trace-graph with span deduplication by (trace_id, span_id), PRD section 11.4 root selection including a synthetic root, orphan and cycle detection, trace-quality classification, canonical serialisation, SHA-256 route fingerprints, weighted feature sets with Jaccard similarity, the twelve typed graph changes, and redacted deterministic JSON export; a fixture-capture script that reads real traces through the Phase 05 client
TESTS RUN: pnpm run typecheck; make test; make test-integration; make verify; make db-migrate; make demo-v1; make demo-v2
TEST RESULT: passed 384, failed 0, skipped 0 (317 unit, 8 database integration, 59 SigNoz integration). Phase 06 added 84 unit and 6 integration tests. Three defects were found by tests and fixed: quadratic subtree signatures that exceeded the maximum string length, quadratic canonical paths that made a 10,000-span trace take 5.6 seconds, and a prototype-chain lookup reachable from a span named `toString`. A fourth, pre-existing since Phase 01, was found and fixed: the identifier generator did not order within a millisecond, and its test failed about one run in five
RUNTIME VALIDATION: graphs were built from traces fetched live from the running deployment, not only from fixtures. The known-good release reconstructed as 12 spans over 6 services and the unsafe release as 8 spans over 4 services with flightrules-policy-service and flightrules-fraud-service absent. A live v1 trace produced a byte-identical route fingerprint to the captured fixture, and two independent live v1 runs produced identical fingerprints to each other, despite different trace IDs, span IDs, run IDs and timestamps. The v1 and v2 fingerprints differ, and the typed diff names policy.retrieve and fraud.check as removed nodes and payment.refund as a side effect performed twice against once
EVIDENCE: docs/evidence/phase-06-plan.md; docs/evidence/phase-06-result.md; docs/research/source-lock.md SL-044 and SL-045; packages/test-fixtures/traces/
KNOWN LIMITATIONS: five, listed above. None blocks Phase 07. The Phase 04 aborted server span remains unresolved by design and is now handled explicitly as a trace-quality warning that does not suppress the duplicate-side-effect evidence
NEXT PHASE ENTRY CRITERIA: SATISFIED
```
