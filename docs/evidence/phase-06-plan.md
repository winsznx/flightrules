# Phase 06 plan — Trace graph and normalisation engine

Branch: `phase/06-trace-graph`
Date: 2026-07-25
PRD sections: Phase 06, plus 11.1–11.12, FR-004, FR-005, FR-006.

## Entry criteria, verified

| Criterion | Check | Result |
|---|---|---|
| Phase 05 merged and green | `git log`, `make verify` | `074a35a` phase, `9eda536` merge, `57d2200` hashes; verify exit 0 |
| Full suite passing | `make test`, `make test-integration` | 233 unit + 61 integration = 294, 0 failed, 0 skipped |
| The MCP client can retrieve complete traces | Phase 05 integration tests | 21 tests against the pinned v0.9.0 server |
| Live stack healthy | `make signoz-verify` | Exit 0 |

## Real fixtures, not invented ones

`scripts/capture-trace-fixtures.mjs` pulls the current demo traces from the live deployment
through the Phase 05 client and writes them to `packages/test-fixtures/traces/`. PRD Phase 06
requires fixtures from real local SigNoz, and normalisation proved against invented identifiers
would prove nothing.

Captured:

```text
refund-agent-v1  trace ae0c0d8945a3c922b9586ea578f56508  12 spans
refund-agent-v2  trace b26b97234e0f594f809f9ef9c169d21f   8 spans
```

Rows are stored sorted by `span_id`, which is deliberately *not* the order the graph engine
needs. The capture script refuses to write a fixture containing any forbidden attribute key.

## Runtime finding that shapes the model

The Query Builder returns the `timestamp` column as an **ISO-8601 string at millisecond
precision** (`2026-07-25T10:37:54.59Z`), not as the nanosecond integer the ClickHouse column
holds. `duration_nano` *is* full nanosecond precision.

So `startTimeUnixNano` is reconstructed from the ISO string and is accurate to a millisecond, and
`endTimeUnixNano` is derived as start + duration. This does not affect determinism, because PRD
section 11.7 excludes timestamps from the fingerprint entirely. It does mean latency ordering
between two spans starting within the same millisecond is not decidable from this response, which
reinforces PRD section 11.1: timestamp order is weak evidence and must not be treated as causal
truth. Recorded as a source-lock entry.

## Scope

Two packages, matching PRD section 13.

```text
packages/normaliser     ordered, versioned, hashed normalisation rules
packages/trace-graph    graph construction, canonicalisation, fingerprint, features, diff
```

### `packages/normaliser`

The ten ordered steps of PRD section 11.6, each a named rule, applied in a fixed sequence. The
configuration carries its own version and a SHA-256 hash of its own content, and every fingerprint
records the normaliser version that produced it — a fingerprint whose normaliser changed is not
comparable with one that came before.

Identifier replacement covers UUID, ULID, long hex, numeric path segments, and configured
customer, order, run and session identifiers. Replacement is by explicit tokenisation on path and
word boundaries, not by an unbounded regular expression over the whole string: PRD section 18.1
names regular-expression denial of service as a threat, and span names are external input.

### `packages/trace-graph`

```text
model.ts      TraceNode, TraceEdge, TraceGraph, TraceQualityWarning
build.ts      dedup, root selection, orphan and cycle detection, quality classification
canonical.ts  canonical serialisation and SHA-256 fingerprint
features.ts   weighted feature sets and deterministic Jaccard similarity
diff.ts       the twelve typed change kinds
export.ts     safe JSON export
```

Deduplication is by `(trace_id, span_id)`. Duplicates that agree on core identity merge by
attribute completeness; duplicates that disagree mark the trace `inconsistent`, which excludes it
from baseline mining rather than silently picking one.

Root selection follows PRD section 11.4 exactly: configured root selector, then earliest
parentless span, then a synthetic root over all orphans. More than one root is a trace-quality
warning, not an error.

Canonical serialisation sorts nodes by structural path then stable label, sorts attribute keys and
set values, and excludes trace ID, span ID, timestamps and volatile values. SHA-256 over the
result.

### The Phase 04 aborted-server-span limitation

Phase 04 recorded that the v2 trace's first payment attempt has no exported server span: the
client aborts while the handler is still in flight, and `onRequestAbort` does not fire for it in
Fastify 5.10.0. Phase 04 assigned the handling to this phase.

This phase does **not** attempt to change service behaviour to manufacture the span. It is a
genuine property of an aborted request. Instead:

- a client span with no matching server span becomes a `client_span_without_server_span`
  trace-quality warning, not evidence of absence
- the warning does not by itself make a trace `incomplete`, because the two client-side write
  spans carry the full duplicate-side-effect evidence
- the payment ledger stays corroborating evidence and is never the contract signal

A test asserts the v2 fixture raises exactly this warning and still produces a usable graph, so a
future regression that loses the *client* spans fails loudly.

## Tests

Every test PRD Phase 06 names, plus determinism properties with `fast-check`.

| Requirement | Test |
|---|---|
| fixture traces from real SigNoz | `packages/test-fixtures/traces/*.json`, captured live |
| input-order permutation | property: any permutation of rows yields one fingerprint |
| attribute-order permutation | property: reordered attribute keys yield one fingerprint |
| volatile-ID invariance | property: regenerated trace, span, run and order IDs yield one fingerprint |
| meaningful-node-change | removing the fraud step changes the fingerprint |
| edge-change | reparenting a node changes the fingerprint |
| duplicate-span | identical duplicates collapse |
| conflicting-duplicate | disagreeing duplicates mark the trace inconsistent |
| orphan-root | orphans attach to a synthetic root and raise a warning |
| cycle detection | a parent cycle is detected rather than recursed into |
| 1,000-span benchmark | canonicalisation under the PRD section 20.2 budget |
| no stack overflow on deep traces | a 10,000-deep chain builds iteratively |

## Runtime validation

1. Build graphs from both captured fixtures and from freshly fetched live traces.
2. Assert the v1 fingerprint is identical across a re-fetch of an equivalent run.
3. Assert v1 and v2 fingerprints differ.
4. Assert the diff reports the skipped prerequisites and the duplicated side effect as typed
   changes.

## Exit gate

The same logical v1 trace always produces the same fingerprint, and the unsafe v2 trace produces
a structured diff.

## Out of scope

Baseline mining and route families (Phase 08), contract evaluation (Phase 07), persistence
(Phase 09). This phase produces the graph, the fingerprint and the diff those phases consume.
