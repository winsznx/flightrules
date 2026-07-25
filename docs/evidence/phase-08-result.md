# Phase 08 result — Baseline mining and contract proposal

Branch: `phase/08-baseline-mining`
Date: 2026-07-25

## What was built

One package, exactly as PRD section 13 names it.

### `packages/baseline-miner`

Storage-independent, because PRD sections 14.7 and 14.8 belong to Phase 09. The miner produces the
values those rows will hold and returns them.

```text
selection.ts   PRD section 8.7's controls, validated, plus the selection hash and the derived
               baseline and family identifiers
retrieve.ts    field-type verification, bounded batch discovery with truncation detection,
               complete span-tree fetching, per-row type re-checking
eligibility.ts one typed exclusion reason per way a trace can fail to qualify
dataset.ts     trace-level and run-level deduplication, with counts that must close
families.ts    exact fingerprint grouping, per-family statistics, representative selection,
               rare marking
aggregate.ts   the cross-family aggregation rule proposal reads: label presence, cardinality,
               edges, retries, budgets, attribute agreement
decisions.ts   PRD section 8.8's four review actions as pure state transitions
propose.ts     rule proposal with an evidence basis on every rule
emit.ts        deterministic draft YAML with a proven parser round trip
document.ts    the one implementation of the validated-to-document conversion both use
statistics.ts  integer statistics, nearest-rank percentiles, exact ratios
safety.ts      sanitisation and bounds for telemetry-derived text
mine.ts        the trace selection job, and the live MCP `TraceSource`
```

No model participates in any decision. Family existence, membership, frequency, required-versus-optional
classification, cardinality, retries, ordering, budgets, approval status, thresholds and activation are
all decided by code over canonical graphs.

## The twelve PRD tasks

| # | Task | Where | Proven by |
|---|---|---|---|
| 1 | Trace selection job | `mine.ts` `mineBaseline`, `selection.ts` | `mine.test.ts`, `selection.test.ts`, live mining of 34 runs |
| 2 | Fetch complete traces in bounded batches | `retrieve.ts` `discoverRuns`, `fetchTraces` | `retrieve.test.ts` page walk and limit clamping; live run with `batchSize: 2` and `batchSize: 200` producing one fingerprint |
| 3 | Exclude incomplete traces with reasons | `eligibility.ts`, `EXCLUSION_REASONS` | `eligibility.test.ts` — one case per reason, all fifteen |
| 4 | Group exact route fingerprints | `families.ts` `mineRouteFamilies` | `families.test.ts`; live 34 runs → 1 family |
| 5 | Calculate route statistics | `statistics.ts`, `families.ts`, `aggregate.ts` | `statistics.test.ts` boundaries, `aggregate.test.ts` |
| 6 | Select representative traces | `families.ts` `selectRepresentatives` | `families.test.ts`; live representatives recorded |
| 7 | Mark rare families | `families.ts` | `families.test.ts` at, below and above the threshold |
| 8 | Approve and exclude actions | `decisions.ts` | `decisions.test.ts` — every transition and every rejection |
| 9 | Propose rules from approved families | `propose.ts` | `propose.test.ts`; 28 rules from live telemetry |
| 10 | Evidence basis on every proposal | `propose.ts` `RuleEvidenceBasis` | `propose.test.ts` asserts every rule carries one |
| 11 | Generate draft YAML | `emit.ts` | `emit.test.ts` round trip and byte stability; `make contract-validate` validates the generated document |
| 12 | Preserve baseline version and normaliser hash | `mine.ts`, `model.ts` | `mine.test.ts`; `eligibility.test.ts` rejects a foreign normaliser |

## Runtime validation

Reproduce with:

```bash
set -a && . ./.env && set +a
DEMO_RUNS=25 make demo-v1
make demo-v2
make mine-demo-baseline
```

The complete output is committed at `docs/evidence/phase-08/mining-run.log`, and the contract it
generated at `docs/evidence/phase-08/mined-contract.yaml`.

### Field types, confirmed by the server

```text
verified   17  agent.data_domain, agent.idempotency.present, agent.release.id, agent.retry.number,
               agent.run.id, agent.side_effect, agent.step.category, duration_nano,
               gen_ai.operation.name, gen_ai.tool.name, has_error, kind_string, name,
               parent_span_id, span_id, status_code_string, trace_id
unverified  5  deployment.environment.name, gen_ai.usage.input_tokens,
               gen_ai.usage.output_tokens, service.name, timestamp
mismatched  0
```

Every one of the five unverified fields is absent from the catalogue for a reason SL-051 records, and
each is declared `string`, which is the server's own default resolution. The two typed tags the
evaluator depends on — `agent.idempotency.present` (bool) and `agent.retry.number` (number) — are
confirmed by SigNoz itself, which is what closes SL-046 by discovery rather than by assumption.

Declaring `agent.idempotency.present` as a number is refused before any query runs, which the live
integration test asserts by making the SL-046 mistake deliberately.

### The mined baseline

```text
baseline id      bl-cf3f1e336ce4de3a1ea727a856ba827a
selection hash   cf3f1e336ce4de3a1ea727a856ba827a316249e24a5b893818850e889e39cec8
status           pending_review
normaliser       1.0.0 (57dee0d05549eebd8ec0e851e567de12eb5fd86a759b53f2a67d287da3cc313f)
window           2026-07-25T09:53:45.451Z .. 2026-07-25T15:53:45.451Z

tracesDiscovered 34      eligibleRuns   34      routeFamilies  1
tracesRetrieved  34      excludedTraces  0      rareFamilies   0
duplicateTraces   0      duplicateRuns   0
excludedByReason []
retrieval        pages 1, batchSize 200, maxTraces 1000, truncated false
```

`eligibleRuns + excludedTraces === tracesDiscovered` and the per-reason totals sum to
`excludedTraces`. Both are asserted in code, not only in tests.

### The route family

```text
fingerprint    43070aa4af4f6c2c912a8d7bcc724f1d199e0425dc8ad7256b528eec195cb037
family id      rf-f28dae5aeaa81d66c2df4e6f35cb57a9
occurrences    34 (1.000000)   rare=false
nodes / edges  12 / 11
duration ms    count 34, min 4, max 95, median 6, p75 37, p90 49, p95 83, p99 95,
               mean 696/34 = 20.470588
tokens         input null, output null
tools          calculate_refund, check_fraud, issue_refund, lookup_order, notify_customer,
               retrieve_policy
services       flightrules-demo-agent, flightrules-fraud-service,
               flightrules-notification-service, flightrules-order-service,
               flightrules-payment-service, flightrules-policy-service
side effects   external, none, read, write
warnings       none
representatives 03bb200b93672f970077b72184e08a2f, 7309f08bf366d73abf8b247f55b82032,
                edb1a80074f00ca8b92c5a40c4f20c12
```

The fingerprint is the one the Phase 07 contract already approves, so neither is a stale constant — a
live integration test asserts that equality against the committed document.

The duration spread is real: the first run of a batch pays the connection and JIT cost of the demo
services, so the maximum is fifteen times the median. That is exactly why the run-scoped latency budget
is derived from the observed maximum with a margin rather than from a percentile.

### The proposal

```text
status         draft
content hash   46b1d9edc0225748345514466d9e6e260db5dc03fe75a4b41f23ac1977d5258d
sample size    34
rules          28
zero tolerance  9
```

| Severity | Type | Count |
|---|---|---|
| critical | `required_span` | 3 (`policy.retrieve`, `order.lookup`, `fraud.check`) |
| critical | `cardinality` | 4 (`payment.refund` and `customer.notify`, each as client and handler) |
| critical | `attribute_constraint` | 2 (`agent.idempotency.present` on both refund spans) |
| high | `required_span` | 3 (`refund.calculate`, `payment.refund`, `customer.notify`) |
| high | `required_edge` | 5 (one per remote handler) |
| high | `required_ancestry` | 4 (each side effect under the workflow root) |
| high | `allowed_values` | 3 (`gen_ai.tool.name`, `service.name`, `agent.data_domain`) |
| high | `retry_budget` | 1 |
| high | `approved_routes` | 1 |
| medium | `numeric_budget` | 2 (`run.duration_ms` at run and release scope) |

Nine rule types, from nine distinct evidence bases. The two the mined baseline has no evidence for are
`forbidden_span` and `forbidden_path`: neither can be proposed from observation, because naming a
domain the agent never touched would be an invention rather than a finding.

Disclosures on the proposal:

```text
BUDGET_NOT_PROPOSED [gen_ai.usage.input_tokens]   ATTRIBUTE_NOT_EMITTED, 0 of 34 runs
BUDGET_NOT_PROPOSED [gen_ai.usage.output_tokens]  ATTRIBUTE_NOT_EMITTED, 0 of 34 runs
FIELD_TYPE_UNVERIFIED                             5 fields the catalogue does not list
```

The refund agent makes no model call, so no token budget is proposed and both metrics are named. An
absent metric is never converted into a bound of zero.

### The generated contract, validated and evaluated

```text
Phase 07 validator   valid, 28 rules, hash 46b1d9ed...
Round trip           identical
Document size        24,865 bytes, 505 lines
```

`make contract-validate` now validates 20 documents, the twentieth being the contract the miner
generated — through the published `flightrules-contract` CLI, not through an in-process import.

```text
refund-agent-v1  trace 8a4dcb1763ec7967995e02e1fb3d5603
  fingerprint 43070aa4af4f6c2c912a8d7bcc724f1d199e0425dc8ad7256b528eec195cb037
  status pass   quality complete   similarity 1.000000
  28 rules: 27 passed, 1 deferred, 0 violations

refund-agent-v2  trace 13bfd0ede8706b6db9ee3a8469ee4670
  fingerprint 22ffa0c0e578ef70a32a34aae7830f40aeef027aae28e66006601e80f99c7466
  status fail   quality complete   similarity 0.619047
  28 rules: 18 passed, 8 violated, 1 insufficient, 1 deferred
  10 violations, 3 critical, 3 zero-tolerance

  [critical/zt] REQUIRED_SPAN_MISSING              require-policy-retrieve
  [critical/zt] REQUIRED_SPAN_MISSING              require-fraud-check
  [critical/zt] CARDINALITY_ABOVE_MAX              single-payment-refund-write
  [high]        REQUIRED_SPAN_TOO_MANY             require-payment-refund
  [high]        REQUIRED_SPAN_MISSING              require-refund-calculate
  [high]        RETRY_BUDGET_PER_TOOL_EXCEEDED     retries-bounded
  [high]        RETRY_BUDGET_RUN_TOTAL_EXCEEDED    retries-bounded
  [high]        RETRY_BUDGET_SIDE_EFFECT_EXCEEDED  retries-bounded
  [high]        ROUTE_NOT_APPROVED                 route-approved-family (0.619047 < 0.92)
  [medium]      NUMERIC_BUDGET_EXCEEDED            budget-run-duration-ms (813 > 143)

  (insufficient_evidence/unobservable_subtree) answered-payment-refund-payment-refund-handler
  (deferred) budget-release-duration-ms
```

**The Phase 08 exit gate is proven**: a set of v1 traces became an approved contract with no policy
hand-written, and that contract passes a freshly executed known-good run and fails the canary on the
missing policy check, the missing fraud check and the duplicate refund.

The similarity figure is 0.619047 rather than the 0.572815 Phase 07 reports, because PRD section 11.9
weights critical nodes and the generated contract marks more labels critical than the hand-written one.
Both numbers are correct for their own contract.

### Repeated mining over the same window

```text
baseline id identical   true
content hash identical  true
emitted YAML identical  true
```

## Determinism

Proven at four levels rather than asserted.

| Claim | How |
|---|---|
| Mining is independent of retrieval order | A 100-run property test over permutations of six runs asserts byte-identical families |
| Mining is independent of identifiers and timestamps | Two datasets whose trace, span and run identifiers and timestamps all differ produce identical fingerprints, nodes, edges and duration statistics |
| A family identifier does not depend on first-seen order | Two datasets discovering the same two families in opposite orders map fingerprint to identifier identically |
| The proposal is byte-identical for reversed input | `emit.test.ts`, and the same claim against the live dataset |
| Repeated live mining is byte-identical | The runtime validation above, over one fixed window |
| No non-integer number reaches a statistic | Every percentile is asserted to be a value the dataset contains; ratios render as `^[01]\.\d{6}$` |

## Statistics

Nearest-rank percentiles, `ceil(p × n)` clamped into `[1, n]`, one-indexed into the ascending sample.
Every reported percentile is therefore an observed value, and no interpolation and no division are
involved. Ratios are exact fractions with a truncated six-place decimal rendering, so a share below the
whole never reads as the whole.

Boundaries asserted: one sample at every percentile; two samples where the median is the lower value
rather than their average; odd and even sample counts; twenty ascending samples where p95 is rank 19;
rank zero clamped to the first observation; rank above the count clamped to the last; a percentile over
an empty sample refused; an explicit zero kept as an observation; a negative sample refused; a
non-integer refused; a sum outside the safe integer range refused.

## Defects found and fixed

Both were found by a test, not by inspection.

### 1. The proposal generator double-prefixed a route fingerprint

`proposeApprovedRoutes` built the `ApprovedRoutesRule` with `sha256:`-prefixed fingerprints and
`ruleDocument` prefixed them again, so the generated document carried `sha256:sha256:<hex>` and the
Phase 07 validator rejected it with `INVALID_FORMAT`. Caught the first time the proposal was generated
end to end.

The fix is not just to remove one prefix. The rule now holds the **validated** form — bare hexadecimal,
which is what the evaluator compares against — and the `sha256:` prefix is added once, by the document
renderer, for a human reader. A test asserts every fingerprint on a proposed rule is bare.

### 2. A rule identifier was derived from the raw label while its selector was derived from the sanitised one

`ruleIdentifier` hashed and slugged the canonical label as emitted, while `labelSelector` sanitised it
first. For an ordinary label the two agree. For a label carrying a control character they do not, and
worse: two labels that sanitise to the same selector value would have produced two rules with different
identifiers governing the same spans, one of them silently redundant and the pair capable of
contradicting each other.

Both now derive from one sanitised name, resolved once per mining run by `resolveLabelNames`. Where two
labels collide, **neither** gets a rule and both are disclosed as `LABEL_NOT_EXPRESSIBLE` — a selector
can only say `name: X`, so a rule for either would also govern the other, and refusing is the only
answer that is not wrong.

## Tests

```text
make test               862 passed, 0 failed, 0 skipped   (38 files)
make test-integration    91 passed, 0 failed, 0 skipped   ( 6 files)
                        ---
                        953 tests passed
```

Integration breakdown: 8 database, 83 SigNoz.

Phase 08 added **279** tests: 263 unit and property, 16 live SigNoz integration.

| File | Tests | Covers |
|---|---|---|
| `statistics.test.ts` | 27 | ratios, nearest-rank percentiles, distributions, margins, refusals, 4 properties |
| `safety.test.ts` | 20 | sanitisation, identifier generation, ordering, 3 properties |
| `selection.test.ts` | 15 | control validation, selection hashing, derived identifiers |
| `eligibility.test.ts` | 22 | one case per exclusion reason, plus the vocabulary itself |
| `dataset.test.ts` | 10 | deduplication, reconciliation, order independence |
| `families.test.ts` | 25 | grouping, statistics, representatives, rare marking, 1 property, adversarial names |
| `decisions.test.ts` | 11 | every review action and every rejection |
| `aggregate.test.ts` | 22 | presence classes, unobservable scoping, retries, budgets, attribute agreement |
| `propose.test.ts` | 43 | every proposed rule kind, the cardinality policy, refusals, adversarial labels, evaluation against both real traces |
| `emit.test.ts` | 14 | round trip, byte stability, injection, redaction, no anchors or tags |
| `retrieve.test.ts` | 31 | field-type verification, per-row type re-checking, paging, truncation |
| `mine.test.ts` | 17 | the job, progress states, blocking states, disclosures, counts |
| `performance.test.ts` | 6 | mining and proposal budgets |
| `mining.signoz.integration.test.ts` | 16 | the live path end to end |

The unit files total 263; adding the 16 live integration tests gives the 279 above.

### Property-test configuration

Eight properties, `fast-check` 4.9.0:

```text
safety      never throws and never emits a forbidden code point        500 runs
safety      every generated identifier satisfies the DSL grammar       500 runs
safety      distinct labels get distinct identifiers                   200 runs
statistics  a distribution is independent of sample order              300 runs
statistics  every percentile is a value the dataset contains           300 runs
statistics  percentiles are monotonic and bounded by the extremes      300 runs
statistics  a share never renders outside [0,1] and never as a float   300 runs
families    mining is invariant under any permutation of the runs      100 runs
```

### Adversarial coverage

| Input | Where it is driven |
|---|---|
| `__proto__`, `constructor`, `prototype`, `toString`, `valueOf`, `hasOwnProperty` | span name, service name, tool name, data domain, attribute key — through mining, aggregation, proposal and emission |
| `__proto__` with an array value | the Phase 07 defect's shape, re-driven through the whole Phase 08 path |
| Control character in a span name | sanitised out; the label becomes inexpressible and is disclosed |
| `U+202E` bidirectional override, `U+200B` zero width | removed before any contract value or comment |
| Newline injected into a span name | cannot open a second top-level key; the document still declares exactly four |
| Astral characters at a truncation boundary | bounded by code point, so no lone surrogate |
| A 50,000-character span name | bounded to the DSL's string limit |
| A label with no grammar-valid characters | still yields a valid, unique rule identifier |
| An idempotency key hash, an order identifier, an authorization header | asserted absent from the emitted document |
| A release identifier containing a quote | the filter refuses it rather than escaping it |
| 500 distinct route families, 1,000 runs, a 1,000-span run, 420 distinct labels | mined within budget, or refused with a typed reason |

## Performance

Measured on the pinned environment; the budgets are deliberately generous so a regression fails rather
than a slower machine.

| Workload | Budget | Measured |
|---|---|---|
| Mine the seeded demo dataset (20 runs) | 1 s | ~40 ms |
| Mine 1,000 runs of one route | 10 s | ~1.1 s |
| Mine 500 distinct route families | 10 s | ~0.9 s |
| Mine one 1,000-span run | 2 s | ~0.2 s |
| Propose and emit for the demo dataset | 1 s | ~30 ms |
| A proposal above the rule maximum | refused | `TOO_MANY_RULES` |

Mining is linear in both the run count and the family count: grouping is by fingerprint through a
`Map`, and family statistics are computed once per family from its canonical graph rather than once per
run.

## Discovered and recorded

New source-lock entries: **SL-050** and **SL-051**.

| ID | Finding |
|---|---|
| SL-050 | `nextCursor` is empty exactly when a Query Builder page is **not full**, and a non-empty opaque token when it is — including when the limit happens to equal the total row count. This is the only truncation signal the pinned server offers. Offset paging under `order: timestamp asc` was verified to produce disjoint pages that concatenate exactly to the unpaged result. |
| SL-051 | `signoz_get_field_keys` with no `searchText` returns the whole trace field catalogue in one response (40 keys, `complete: true`) with a `fieldDataType` per field — so the server can confirm the type a request should declare, which closes SL-046 by discovery. But it omits `timestamp`, omits every resource attribute, reports custom span attributes as `attribute` where `selectFields` needs `tag`, and reports two keys with an empty type. |

ADR-0007 records the fifteen decisions behind the miner, including the cardinality outlier policy, the
per-subtree unobservability scoping, the remote-handler edge rule and the never-propose-a-rule-the-
baseline-violates constraint.

## Known limitations

1. **The proposal is deliberately larger than a hand-written contract.** It proposes a rule for every
   step the evidence supports — 28 rules and 9 zero-tolerance identifiers against the demo, where the
   Phase 07 contract has 15 and 4. That is the safe direction for a draft a human reviews, but a reviewer
   is expected to prune. `order.lookup` becoming a critical zero-tolerance prerequisite is the clearest
   example: every approved run did look the order up before refunding, so the evidence is real, and
   whether skipping it should fail a release is a judgement the miner does not make.
2. **`forbidden_span` and `forbidden_path` are never proposed.** Neither can be derived from
   observation: naming a data domain the agent never touched would be an invention. PRD FR-008's
   "sensitive domain observations" is served instead by an `allowed_values` allowlist over the domains
   that were observed, which forbids the rest without naming it.
3. **Sibling temporal ordering is still not expressible**, unchanged from Phase 07. The proposal
   therefore contains no "fraud before refund" rule, only "fraud present" and "refund descends from the
   workflow root".
4. **Nothing is persisted.** PRD sections 14.7 and 14.8 are Phase 09. `selectionHash` and the derived
   identifiers exist so a repeated job is recognisable when persistence arrives.
5. **The proposal API is not exposed over HTTP.** PRD section 15.5's endpoints are Phase 09.
6. **The rare-route threshold classifies but does not filter.** A rare family is marked and disclosed,
   never discarded — PRD section 8.8 offers approve, reject, mark optional and exclude as a fixture
   error, and deciding for the reviewer is not among them.
7. **A dataset larger than 5,000 traces is refused rather than sampled.** Sampling would make every
   support ratio describe a subset the caller did not choose. The bound is a constant, not a
   configuration.
8. **Release-scoped budgets remain `deferred`** at run scope, unchanged from Phase 07, until the
   Phase 11 aggregation.

## Mandatory phase report

```text
PHASE: 08 — Baseline mining and contract proposal
STATUS: PASS
BRANCH: phase/08-baseline-mining
COMMITS: see docs/evidence/phase-08-commits.md
SOURCES VERIFIED: 51 source-lock entries, 2 new (SL-050, SL-051); PRD Phase 08, sections 8.7,
  8.8, 11.6-11.9, 14.7, 14.8, 15.5, 16.6, 18.1-18.3, 20.2, 22.1-22.3, FR-007, FR-008, FR-009,
  FR-018; live probes of signoz_get_field_keys and signoz_execute_builder_query against
  signoz-mcp-server v0.9.0
IMPLEMENTED: packages/baseline-miner — trace selection job, bounded batch retrieval with
  field-type verification and truncation detection, fifteen typed exclusion reasons, exact
  fingerprint grouping, integer statistics with nearest-rank percentiles, representative
  selection, rare marking, four review actions, rule proposal across nine rule types with an
  evidence basis on every rule, deterministic draft YAML with a proven parser round trip,
  preserved baseline and normaliser identity; scripts/mine-demo-baseline.mjs;
  make mine-demo-baseline
TESTS RUN: make verify, make signoz-verify, make contract-validate, make test,
  make test-integration, make demo-v1, make demo-v2, make mine-demo-baseline
TEST RESULT: 862 unit passed, 91 integration passed, 953 total, 0 failed, 0 skipped;
  20 contract documents valid; make verify exit 0; make signoz-verify exit 0
RUNTIME VALIDATION: 34 fresh refund-agent-v1 runs retrieved through the MCP Query Builder with
  every non-string tag's dataType confirmed against the live field catalogue; 34 eligible, 0
  excluded, 1 route family at fingerprint 43070aa4... which the committed Phase 07 contract
  already approves; a human approval recorded; a 28-rule draft proposal generated, accepted by
  the Phase 07 validator through the published CLI, round-tripping to content hash 46b1d9ed...;
  a freshly executed v1 run passes it with 0 violations; the v2 canary fails it with 10
  violations including 3 critical zero-tolerance ones naming the missing policy check, the
  missing fraud check and the duplicate refund; the aborted payment handler reports
  insufficient_evidence/unobservable_subtree rather than a skipped step; repeated mining over
  the same window produces a byte-identical baseline identifier, content hash and YAML
EVIDENCE: docs/evidence/phase-08-plan.md, docs/evidence/phase-08-result.md,
  docs/evidence/phase-08-commits.md, docs/evidence/phase-08/mining-run.log,
  docs/evidence/phase-08/mined-contract.yaml, docs/adr/0007-baseline-mining-and-proposal-safety.md,
  docs/research/source-lock.md (SL-050, SL-051)
KNOWN LIMITATIONS: eight, listed above; none blocks the exit gate. The proposal is deliberately
  broader than a hand-written contract and expects review; forbidden_span and forbidden_path
  cannot be derived from observation; sibling ordering is still not expressible; nothing is
  persisted and no HTTP API is exposed, both Phase 09 by PRD assignment.
NEXT PHASE ENTRY CRITERIA: SATISFIED
```
