# FlightRules handoff — after Phase 06

Written: 2026-07-25. `main` is green and the working tree is clean.

This replaces the previous session's handoff. Verify every claim below against the repository
before relying on it; the previous handoff contained one inaccuracy, described under "Corrections".

---

## Phase status

| Phase | Status | Phase commit | Merge commit |
|---|---|---|---|
| 00 Source lock and feasibility proof | PASS | `ba600b8` | `1f87df2` |
| 01 Repository foundation and CI | PASS | `9e093da` | `d9052ff` |
| 02 SigNoz deployment through Foundry | PASS | `bb50031` | `3b878ab` |
| 03 Deterministic demo system | PASS | `9a37a88` | `fa172fe` |
| 04 OpenTelemetry instrumentation | PASS | `4d392b0` | `a4101ca` |
| 05 SigNoz MCP client and capability layer | PASS | `074a35a` | `9eda536` |
| 06 Trace graph and normalisation engine | PASS | `7b8e2aa` | `5949148` |
| 07–17 | NOT STARTED | — | — |

Head of `main` is `55a4099`.

## Verified state

Every command below was run against the live stack on `main` at `55a4099`.

```text
make verify              exit 0
make signoz-verify       exit 0
make signoz-reproducibility  exit 0
make test                317 passed, 0 failed, 0 skipped
make test-integration     67 passed, 0 failed, 0 skipped
                         ---
                         384 tests passed
```

Integration breakdown: 8 database, 59 SigNoz. All fail rather than skip when their dependency is
absent.

## Corrections to the previous handoff

The previous session reported "193 tests passed" and Phases 00–04 all PASS. Both were accurate.
However, `docs/ACCEPTANCE_MATRIX.md` had **not** been updated for Phase 04, in breach of
operating-contract rule 23: it read "Last updated: Phase 03" and still marked A2 and A14 as
`PENDING` despite Phase 04 having produced their evidence. Corrected in `2d29bf6` before Phase 05
began. Scope item 6 was set to `IN PROGRESS`, not `DONE`, because metrics and logs are declared
but not yet emitted.

## What Phases 05 and 06 added

### Phase 05 — `packages/signoz-mcp`

The single boundary between FlightRules and SigNoz. Nothing downstream sees a raw MCP object.
Callers receive a discriminated union — `SUCCESS_WITH_ROWS`, `SUCCESS_EMPTY`,
`UNSUPPORTED_RESPONSE`, `MALFORMED_RESPONSE`, `MCP_ERROR`, `TRANSPORT_ERROR` — each failure
carrying a PRD section 19 error code. Capability discovery, bounded retries that never repeat an
answered request, timeouts, a circuit breaker, redacting logging that never records tool
arguments, typed wrappers, and `createAndVerify` implementing the PRD section 16.5
list-create-read-back-compare flow.

### Phase 06 — `packages/normaliser` and `packages/trace-graph`

The ten ordered normalisation steps with a versioned, content-hashed configuration; span
deduplication, root selection, orphan and cycle detection, canonical serialisation, SHA-256 route
fingerprints, weighted feature sets, the twelve typed graph changes, and redacted JSON export.

**The exit gate is proven live**: a v1 run executed minutes after the captured fixture, with
entirely different trace IDs, span IDs, run IDs and timestamps, produces a byte-identical route
fingerprint. v1 and v2 fingerprints differ, and the typed diff names `policy.retrieve` and
`fraud.check` as removed and `payment.refund` as a side effect performed twice against once.

## Important discoveries

New source-lock entries this session: **SL-040 to SL-045**.

| ID | Finding |
|---|---|
| SL-040 | `signoz_execute_builder_query` returns **no** `structuredContent`; the declared `outputSchema` does not predict which tools do. A **successful** response may carry several content entries — the server appends a `[Decisions applied]` advisory — and joining them before parsing corrupts the JSON. Every FlightRules script written before Phase 05 had this bug. |
| SL-041 | The MCP SDK's own `Transport` declarations are not assignable under `exactOptionalPropertyTypes`. Bridged with a typed assertion to the SDK's real `Transport`, not a suppression. |
| SL-042 | A saved view's `compositeQuery` requires **both** `queryType` and `panelType`; neither appears in the tool's input schema. The create returns the identifier as a **bare string** under `data`, refining SL-023. |
| SL-043 | `signoz_get_field_keys`, `signoz_get_field_values` and the list tools use three different response envelopes. `get_field_values` takes `name`, not `key`. `get_alert_history` requires `id`. |
| SL-044 | The Query Builder serialises the nanosecond `timestamp` column as an ISO-8601 string at **millisecond** precision; `duration_nano` keeps full precision. |
| SL-045 | `flightrules_uuid_v7` did not order within a millisecond. Fixed by migration `0002` per RFC 9562 Method 3. |

## Defects found and fixed

All six were found by tests, not by inspection.

1. **Transport connection race** (Phase 05). Capability discovery lists tools and resources
   concurrently; a boolean guard set after the await let both enter the handshake. Fixed by
   caching the in-flight promise, and by not caching a failed handshake.
2. **Three envelopes assumed to be one** (Phase 05). Corrected from observed responses.
3. **Quadratic subtree signatures** (Phase 06). A 10,000-span trace exceeded the maximum string
   length. Signatures are now fixed-width digests.
4. **Quadratic canonical paths** (Phase 06). Dotted paths grew with depth; the 10,000-span test
   took 5.6 s. Replaced with a canonical order index — the graph suite now runs in 209 ms. A time
   budget is asserted so this cannot regress silently.
5. **Prototype-chain lookup** (Phase 06). A span named `toString` resolved to `Object.prototype`
   and crashed the tokeniser. Span names are external input, so this was reachable from telemetry.
   The same pattern was hardened in the Phase 05 `readPath` helper.
6. **`flightrules_uuid_v7` sortability** (pre-existing since Phase 01). The test failed about one
   run in five and had been passing by luck. Fixed in migration `0002`; the test now asserts
   ordering over 200 identifiers rather than two.

## Unresolved limitations

1. **The Phase 04 aborted server span is still unresolved, by design.** In the v2 trace the first
   payment attempt's handler span is never exported: the client aborts while the handler is in
   flight and Fastify 5.10.0's `onRequestAbort` does not fire for it. No attempt was made to
   manufacture it. Phase 06 handles it as a `client_span_without_server_span` trace-quality
   warning that does **not** downgrade the trace, because the duplicate-side-effect evidence lives
   entirely in the two exported client write spans. Two tests hold this in place. Carried forward
   as a Phase 16 investigation item.
2. **The capability snapshot is exposed but not persisted.** PRD Phase 05 task 12 needs the
   database layer from Phase 09.
3. **`signoz_update_*` wrappers are not implemented**, and dashboard/alert read-back verification
   is untested. Both are Phase 10 scope by PRD assignment. `createAndVerify` is resource-agnostic
   and proven against a saved view.
4. **Span links and explicit predecessors are modelled but never populated** — the demo emits
   neither. `inferred_time_order` is deliberately not computed; SL-044's resolution would make it
   unreliable at exactly the scale where it would matter.
5. **Metrics and logs are declared but not emitted** (Phase 04 limitation, unchanged). Instruments
   and their permitted dimension sets exist with a cardinality test; nothing is counted until the
   evaluator exists.
6. **Node timestamps are millisecond-accurate** (SL-044). Excluded from the fingerprint, so
   determinism is unaffected, but Phase 08 latency percentiles inherit the resolution.

---

## Next phase: 07 — Contract schema and deterministic evaluator

PRD section: line 3092. Read it in full, together with section 10 (Contract DSL, lines 1239–1490)
and section 11.11 (evaluation order, line 1665).

### Entry criteria — all SATISFIED

| Criterion | Evidence |
|---|---|
| Phase 06 merged and green | `5949148`; `make verify` exit 0 |
| Deterministic canonical graphs exist | `packages/trace-graph`, exit gate proven live |
| Route fingerprints are stable across runs | Live v1 run matches captured fixture |
| Typed graph diff exists | `packages/trace-graph/src/diff.ts`, twelve change kinds |
| Real fixtures available for both releases | `packages/test-fixtures/traces/` |
| Error codes and severities defined | `packages/domain/src/errors.ts`, `trace.ts` |

### Scope

Branch `phase/07-contract-engine`. Create `packages/contract-schema` and
`packages/contract-engine`. The PRD names eleven rule types (section 10.4): required span,
required ancestry, required direct child, forbidden span, forbidden path, cardinality, allowed
tools, attribute constraint, retry budget, approved routes, latency budget, token budget. Each
needs a passing **and** a violating fixture — the two captured traces supply both for the
safety-critical ones.

Evaluation must follow PRD section 11.11's order exactly, and PRD section 11.12 requires
byte-equivalent canonical evaluation JSON for the same graph, contract, normaliser and evaluator
version. An LLM must never decide whether a rule passed.

Incomplete evidence must produce the PRD's insufficient-evidence outcome
(`EVALUATION_STATUSES` already includes `insufficient_data`), never an automatic violation. This
matters directly for the aborted server span: a rule that required the missing
`payment.refund.handler` span must report insufficient evidence, while the duplicate-write rule
driven by the two client spans must still fail v2.

### Useful facts for the next session

- The demo agent runs at `http://localhost:4100`; `make demo-v1` and `make demo-v2` produce fresh
  traces. Integration tests need a run within the last six hours.
- `scripts/capture-trace-fixtures.mjs` re-captures fixtures from the live stack.
- Source `.env` before any integration test or script: `set -a && . ./.env && set +a`.
- Root-level workspace deps `@flightrules/domain` and `@flightrules/signoz-mcp` exist so
  `scripts/*.mjs` can import them; run `pnpm run build` after changing a package they use.
- Biome forbids `console.*` except `error` and `warn`; scripts use `process.stdout.write`.
- New packages must be added to `tsconfig.build.json` references.
- The known-good route is: `refund.request` → `policy.retrieve`, `order.lookup`, `fraud.check`,
  `refund.calculate`, `payment.refund`, `customer.notify`, each with a `.handler` server span.
  The unsafe route drops policy and fraud and emits `payment.refund` twice at retry 0 and 1.
