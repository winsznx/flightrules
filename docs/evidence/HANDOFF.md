# FlightRules handoff — after Phase 07

Written: 2026-07-25. `main` is green and the working tree is clean.

This replaces the previous handoff. Verify every claim below against the repository before relying
on it; corrections to the previous handoff are listed under "Corrections".

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
| 07 Contract schema and deterministic evaluator | PASS | `ca4225b` | `12e133b` |
| 08–17 | NOT STARTED | — | — |

## Verified state

Every command below was run against the live stack on `main` after the Phase 07 merge.

```text
make verify              exit 0
make signoz-verify       exit 0
make contract-validate   exit 0, 19 contract documents valid
make test                599 passed, 0 failed, 0 skipped   (25 files)
make test-integration     75 passed, 0 failed, 0 skipped   ( 5 files)
                         ---
                         674 tests passed
```

Integration breakdown: 8 database, 67 SigNoz. All fail rather than skip when their dependency is
absent.

## Corrections to the previous handoff

One inaccuracy, corrected rather than propagated: the previous handoff described the known-good
route as six steps "each with a `.handler` server span". `refund.calculate` has no handler — it is
local agent work — so v1 is one root span, six client spans and **five** handlers, twelve in total.
No Phase 06 code or test asserted otherwise, so nothing was broken by it.

## What Phase 07 added

Two packages, exactly as PRD section 13 names them.

### `packages/contract-schema`

The versioned DSL of PRD section 10, with no dependency on a graph, a database or SigNoz — because
`flightrules contract validate` has to run in a CI job that has none of them. TypeScript types, a
published draft 2020-12 JSON Schema, safe YAML loading, static validation returning
`{path, code, message}`, cross-rule contradiction detection, canonical serialisation, a SHA-256
content hash, and a `flightrules-contract` command with PRD FR-012 exit codes.

The `matches` operator is an RE2-compatible Thompson NFA, not a JavaScript `RegExp`.

### `packages/contract-engine`

The deterministic run evaluator, storage-independent because persistence is Phase 09. `Map`-based
indexes, the six selector operators, all eleven rule types, evidence carrying both span IDs and
canonical node positions, stable violation identifiers, PRD section 11.11's evaluation order, and
canonical evaluation JSON whose hash structurally cannot reach the completion timestamp.

**The exit gate is proven live**: the committed contract at
`contracts/demo-commerce/refund-agent/production/contract.yaml` passes the approved release and
fails the canary with three critical zero-tolerance violations naming the missing fraud check, the
missing policy check and the duplicate refund. No LLM participates in any decision.

## Important discoveries

New source-lock entries this session: **SL-046 to SL-049**.

| ID | Finding |
|---|---|
| SL-046 | A non-string tag in Query Builder `selectFields` returns `null` unless its `dataType` is declared. The call **succeeds** — no error, no warning, every other column correct — so an attribute vanishes silently and per-column. Both `bool` and `number` are affected. Found because the evaluator reported insufficient evidence for the absent attribute instead of passing the rule. |
| SL-047 | `yaml@2.9.0` resolves `!!binary` to a `Buffer` and `!!timestamp` to a `Date` with **no error and no warning**, and `customTags: []` does not prevent it. An unresolvable tag is only a warning. So the tag defence must walk the document AST, not read the options or the diagnostics. |
| SL-048 | `ajv@8.20.0`'s default export cannot compile a draft 2020-12 schema; `ajv/dist/2020.js` can. |
| SL-049 | `[]a]` is a two-member character class in RE2 and an empty class in JavaScript. FlightRules follows RE2, as PRD section 10.3 requires. |

## Defects found and fixed

All three were found by tests or a runtime probe, not by inspection.

1. **A telemetry attribute key of `__proto__` replaced a normalised record's prototype** (Phase 06
   code). An array value invoked the inherited setter, after which `evidence.length` returned `2` and
   `evidence[0]` returned a value no span emitted. `Object.prototype` was untouched, so nothing
   global broke, but any consumer reading without `Object.hasOwn` saw phantom data. Reproduced at
   runtime before changing anything, then fixed with `Object.create(null)`; the attribute is now kept
   as ordinary data. Every Phase 06 test still passes unmodified — this was a latent hardening gap
   that Phase 07 newly depends on, not a Phase 06 gate failure.
2. **`canonicalContract` depended on its caller having sorted the input.** True for a parsed
   contract, but Phase 08's proposal generator and Phase 09's database rows are producers that do not
   go through the YAML validator, and either would have hashed one policy two ways — which reads as a
   policy change and forces a spurious re-approval. Canonicalisation now sorts its own input.
3. **Ancestry undecidability was scoped too broadly**, conflating a chain truncated by unexported
   spans with one that legitimately ends at a second parentless root. A detached side effect could
   have escaped the rule by being detached.

## Unresolved limitations

1. **The Phase 04 aborted server span is still unresolved, by design.** In the v2 trace the first
   payment attempt's handler span is never exported. Phase 07 gives it a correct **evaluation
   outcome** — `insufficient_evidence` with reason `unobservable_subtree` — rather than fixing the
   cause. The duplicate-refund finding, whose evidence lives in the two exported client spans, still
   fails the release. Carried forward as a Phase 16 investigation item.
2. **Sibling temporal ordering is not expressible in P0.** In the real traces every step is a child
   of `refund.request`, so `fraud.check` is a *sibling* of `payment.refund`, not an ancestor. The demo
   emits no `explicit_predecessor` edges, and PRD section 11.3 forbids `inferred_time_order` from
   satisfying a critical causal rule — SL-044 leaves timestamps at millisecond resolution, exactly
   the scale where it would matter. `required_ancestry` is implemented in full and exercised on the
   real parent-child pairs the traces do contain. The exit gate does not need ordering.
3. **Release-scoped rules are `deferred`, not evaluated.** PRD section 11.11 assigns them to the
   aggregation after run results are stored, which is Phase 11. Each still contributes its measured
   metric sample, so Phase 11 aggregates rather than re-reading every trace.
4. **`approved_routes` needs the approved families' canonical graphs to report similarity.** Without
   them it still decides exact identity and violates correctly, and says similarity was unmeasurable
   rather than implying a number. Phase 08 supplies the graphs.
5. **Nothing from Phase 07 is persisted.** The evaluator is deliberately storage-independent.
6. **The capability snapshot is exposed but not persisted** (Phase 05 limitation, unchanged; needs
   the Phase 09 database layer).
7. **`signoz_update_*` wrappers are not implemented**, and dashboard/alert read-back verification is
   untested. Both are Phase 10 scope by PRD assignment.
8. **Span links and explicit predecessors are modelled but never populated** — the demo emits
   neither.
9. **Metrics and logs are declared but not emitted** (Phase 04 limitation, unchanged). Acceptance
   scope item 6 stays `IN PROGRESS`. The evaluator now exists, so the instruments have something to
   count; emitting them is Phase 09 work.
10. **Node timestamps are millisecond-accurate** (SL-044). Excluded from the fingerprint, so
    determinism is unaffected, but Phase 08 latency percentiles inherit the resolution.

---

## Next phase: 08 — Baseline mining and contract proposal

PRD section: line 3128. Read it in full, together with section 11.8 (baseline route families,
line 1596), 11.9 (similarity, line 1617), FR-007 and FR-008.

### Entry criteria — all SATISFIED

| Criterion | Evidence |
|---|---|
| Phase 07 merged and green | `12e133b`; `make verify` exit 0 |
| Deterministic canonical graphs and stable fingerprints | `packages/trace-graph`, proven live in Phases 06 and 07 |
| A validated contract format exists | `packages/contract-schema`; 19 documents validate |
| The evaluator can consume a proposed contract | `packages/contract-engine`; exit gate proven live |
| Route fingerprints group exactly | PRD section 11.8 P0 grouping is exact by fingerprint |
| Real fixtures available for both releases | `packages/test-fixtures/traces/` |
| MCP client can fetch traces in bounded batches | `packages/signoz-mcp`, `SigNozOperations` |

### Scope

Branch `phase/08-baseline-mining`. Create `packages/baseline-miner`. PRD Phase 08 lists twelve
tasks: trace selection, bounded batch fetching, excluding incomplete traces **with reasons**, exact
fingerprint grouping, route statistics, representative trace selection, marking rare families,
approve and exclude actions, rule proposal from approved families, an evidence basis attached to
every proposal, draft YAML generation, and preserving the baseline version and normaliser hash.

The exit gate: a user can turn a set of v1 traces into an approved contract without hand-writing the
initial policy. **No rule may be activated automatically** — PRD Phase 08's test list says so
explicitly, and PRD FR-018 puts activation behind human approval.

### Facts that will matter

- The generated contract must pass `packages/contract-schema` validation, so the proposer should
  build a `TrajectoryContract` and serialise it rather than emitting YAML text directly. Note that
  `canonicalContract` now sorts its own input, so a proposer does not need to.
- `packages/contract-engine` exports `ApprovedRoute` (`{fingerprint, canonical}`), which is the shape
  the miner should produce for `approved_routes` rules and for similarity reporting.
- `isBaselineEligible(graph)` in `@flightrules/trace-graph` already encodes "only a `complete` trace
  may contribute to a baseline" (PRD section 16.6, FR-007).
- **Declare `dataType` for every non-string tag** in any new `selectFields` (SL-046). A boolean or
  numeric tag requested without it returns `null` on a successful call.
- `packages/test-fixtures/src/spans.ts` builds span rows for topologies the demo does not emit;
  `approvedRefundRows({remove, add, replace})` is the quickest way to make a route variant.
- The demo agent runs at `http://localhost:4100`; `make demo-v1` and `make demo-v2` produce fresh
  traces. Integration tests need a run within the last six hours.
- Source `.env` before any integration test or script: `set -a && . ./.env && set +a`.
- New packages must be added to `tsconfig.build.json` references.
- Biome forbids `console.*` except `error` and `warn`; scripts use `process.stdout.write`.
- Run `make contract-validate` after touching any contract document; it is part of `make verify`.
- The known-good route is: `refund.request` → `policy.retrieve`, `order.lookup`, `fraud.check`,
  `refund.calculate`, `payment.refund`, `customer.notify`. Five of the six have a `.handler` server
  span; `refund.calculate` does not. The unsafe route drops policy and fraud and emits
  `payment.refund` twice at retry 0 and 1.
- The v1 route fingerprint is
  `43070aa4af4f6c2c912a8d7bcc724f1d199e0425dc8ad7256b528eec195cb037`; v2 is
  `22ffa0c0e578ef70a32a34aae7830f40aeef027aae28e66006601e80f99c7466`. Their weighted Jaccard
  similarity under the demo contract's critical-node weighting is 0.572815.
