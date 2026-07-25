# Phase 08 plan — Baseline mining and contract proposal

Branch: `phase/08-baseline-mining`
Date: 2026-07-25
PRD sections: Phase 08 (line 3128), plus 8.7, 8.8, 11.6–11.9, 14.7, 14.8, 15.5, 16.6, FR-007,
FR-008, FR-009, FR-018, 18.1–18.3, 20.2, 22.1–22.3, 23, and the high-cardinality risk response.

## Entry criteria, verified independently

Every row was re-checked against the repository and the running stack. Nothing below is taken from
`docs/evidence/HANDOFF.md`.

| Criterion | Check | Result |
|---|---|---|
| Working tree clean | `git status --porcelain` | Empty |
| `main` at the reported commit | `git rev-parse HEAD` | `e583ba6b3b1a009cf3f8e33a82ab2a65528fbe71` |
| Every reported phase commit exists and is reachable from `main` | `git merge-base --is-ancestor` for all ten | All reachable |
| No Phase 08 branch or partial work | `git branch --all` | Only `main` and `phase/00`–`phase/07` before this branch |
| Phase 07 merged and green | `make verify` | Exit 0 |
| Contract documents valid | `make contract-validate` (inside `make verify`) | 19 documents valid |
| Unit and property suite | `make test` | 599 passed, 0 failed, 0 skipped, 25 files |
| Live SigNoz stack healthy | `make signoz-verify` | Exit 0, every surface including a real OTLP 200 |
| Demo reproducible | `make demo-v1`, `make demo-v2` | Both exit 0 |
| Integration suite | `make test-integration` | 75 passed, 0 failed, 0 skipped, 5 files |
| Source-lock entries SL-046 to SL-049 present and consistent with the files they cite | Read each entry and each named file | Consistent |
| ADR-0006 matches the implemented determinism boundary | Read the ADR against `rule-context.ts`, `canonical.ts`, `graph-index.ts`, `regex.ts`, `yaml.ts` | Matches, including the local insufficient-evidence scoping and the single `canonicalOrdering` implementation |
| Acceptance matrix reflects Phases 00–07 | Read `docs/ACCEPTANCE_MATRIX.md` | Accurate; scope items 6, 12, 15, 17 correctly held at `IN PROGRESS` |

### Phase 07 exit-gate behaviour, re-proven live

Fresh `make demo-v1` and `make demo-v2` runs, retrieved through the Phase 05 MCP client and
evaluated against the committed production contract:

```text
refund-agent-v1  trace af7e3c01e60dcb1661d8ac51cf258e91
  fingerprint 43070aa4af4f6c2c912a8d7bcc724f1d199e0425dc8ad7256b528eec195cb037
  status pass   quality complete   similarity 1.000000
  13 passed, 2 deferred, 0 violations

refund-agent-v2  trace e7d2a11dd2fd137d64ec98a37bde079b
  fingerprint 22ffa0c0e578ef70a32a34aae7830f40aeef027aae28e66006601e80f99c7466
  status fail   quality complete   similarity 0.572815
  6 passed, 6 violations, 1 insufficient, 2 deferred, 3 critical zero-tolerance

  [critical/zt] REQUIRED_SPAN_MISSING          require-fraud-check
  [critical/zt] REQUIRED_SPAN_MISSING          require-policy-check
  [critical/zt] CARDINALITY_ABOVE_MAX          single-refund-write
  [high]        RETRY_BUDGET_SIDE_EFFECT_EXCEEDED  bounded-retries
  [high]        ROUTE_NOT_APPROVED             approved-route-family (0.572815 < 0.92)
  [medium]      NUMERIC_BUDGET_EXCEEDED        run-latency-budget (822 > 500)
  (insufficient_evidence/unobservable_subtree) refund-handler-follows-refund-call
```

Identical to the reported state except the measured run duration, which the contract's
`run.duration_ms` budget permits to vary between runs. Every fingerprint, code, severity and count
matches. The handoff is accepted.

## Scope

One package, exactly as PRD section 13 names it.

```text
packages/baseline-miner
```

Storage-independent. PRD Phase 09 owns `baseline_versions`, `route_families` and `contracts`; the
miner produces the values those rows will hold and returns them. Building persistence here would
put Phase 09 work behind a Phase 08 gate and would have to be rewritten once the schema exists.

No LLM participates in any decision. Family existence, membership, frequency, required-versus-
optional classification, cardinality, retries, ordering, budgets, approval status, thresholds and
activation are all decided by code over canonical graphs.

## The twelve PRD tasks, mapped

| # | PRD task | Implementation | Tests | Runtime validation | Evidence | Acceptance |
|---|---|---|---|---|---|---|
| 1 | Implement trace selection job | `src/mine.ts` `mineBaseline`, `src/selection.ts` `MiningSelection` | `mine.test.ts` selection bounds, minimum-run block, progress states | live mine of ≥20 fresh v1 runs | phase-08-result "The mining job" | scope 11, FR-007 |
| 2 | Fetch complete traces in bounded batches | `src/retrieve.ts` `SigNozTraceSource` | `retrieve.test.ts` against a fake `SigNozOperations`; batch size, page walk, truncation | live retrieval, page counts recorded | "Retrieval" | FR-007 |
| 3 | Exclude incomplete traces with reasons | `src/eligibility.ts`, `EXCLUSION_REASONS` | `eligibility.test.ts` one case per reason | live: every excluded trace carries a reason | "Eligibility" | FR-007 |
| 4 | Group exact route fingerprints | `src/families.ts` `mineRouteFamilies` | `families.test.ts` grouping, stable IDs, order independence | fresh v1 runs collapse to one family | "Route families" | scope 11, FR-006 |
| 5 | Calculate route statistics | `src/statistics.ts`, `src/families.ts` | `statistics.test.ts` boundaries, `families.test.ts` per-family stats | live distributions recorded | "Statistics" | FR-007 |
| 6 | Select representative traces | `src/families.ts` `selectRepresentatives` | `families.test.ts` deterministic choice, count bound | live representative trace IDs recorded | "Route families" | FR-007 |
| 7 | Mark rare families | `src/families.ts` rare threshold | `families.test.ts` at, below and above the threshold | live: rare-family count recorded | "Route families" | FR-007 |
| 8 | Implement approve and exclude actions | `src/decisions.ts` | `decisions.test.ts` every transition and every rejection | live: v1 family approved before proposal | "Decisions" | FR-007 |
| 9 | Propose rules from approved families | `src/propose.ts` | `propose.test.ts` per rule kind, `proposal.test.ts` round trip | live proposal validated and evaluated | "Proposal" | FR-008 |
| 10 | Attach evidence basis to every proposal | `src/propose.ts` `ProposedRule.evidence` | `propose.test.ts` asserts every proposed rule carries a non-empty basis | live proposal inventory recorded | "Proposal" | FR-008 |
| 11 | Generate draft YAML | `src/emit.ts` `emitContractYaml` | `emit.test.ts` parser round trip, byte stability, injection fixtures | live YAML validated by the Phase 07 CLI | "Draft YAML" | FR-008, FR-009 |
| 12 | Preserve baseline version and normaliser hash | `src/model.ts` `BaselineVersion`, `src/mine.ts` | `mine.test.ts` mixed-normaliser rejection | live: normaliser version and config hash recorded | "Baseline identity" | FR-007 |

## Design decisions

### Grouping is exact, and family identity comes from the fingerprint

PRD section 11.8: "P0 grouping is exact by fingerprint." So there is no clustering algorithm, no
seed and no distance threshold on the mining path. A family's identifier is derived from the
baseline's own identity and the fingerprint, never from first-seen order, so shuffling the input
cannot renumber the families.

`similarity` from `@flightrules/trace-graph` is used only where the PRD assigns it — nearest-family
selection and display. It never decides membership.

### Statistics are integers, and percentiles are nearest-rank

Every statistic is computed from integers: occurrence counts, retry numbers, durations in whole
milliseconds, token counts. Percentiles use the nearest-rank definition — `ceil(p × n)` clamped
into `[1, n]`, one-indexed into the ascending sample — so every reported percentile is an actually
observed value and no interpolation, and therefore no float, enters the output. Ratios are carried
as `{numerator, denominator, decimal}` with the decimal rendered by integer division to six places,
the same construction Phase 07 uses for similarity. A test asserts that no non-integer number
appears anywhere in the canonical mining output.

### Required versus optional is decided by support, and unobservable is neither

A canonical label is classified per PRD FR-008 "steps present in all approved families":

```text
always        present in every eligible run of every approved family
required      support ratio >= requiredSupport (default 1/1)
optional      0 < support < requiredSupport
rare          support < rareThreshold
unobservable  absent only in runs where the absence sits inside a subtree the trace marks
              unobservable — never proposed as required, and disclosed instead
```

A label that is absent from a run whose graph flagged the containing client span
`client_span_without_server_span` does not count as an observed absence. The scoping is per subtree,
exactly as ADR-0006 decision 8 established for evaluation; the alternative would let one aborted
request in one run demote a genuinely universal prerequisite to optional.

### Cardinality recommendations refuse to encode an outlier

PRD FR-008 asks for "maximum observed cardinality with configurable safety margin". Taken literally
that encodes an accidental duplicate side effect as permitted, which is the exact fault the product
exists to catch. So the recommendation is:

```text
base = nearest-rank p95 of the per-run occurrence counts
if observedMax > base   recommendedMax = base, outlierPresent = true,
                        requiresHumanConfirmation = true
otherwise               recommendedMax = observedMax + safetyMargin
```

With twenty identical runs `p95 == max == 1` and the recommendation is `1 + margin`. With one run in
thirty that issued two refunds, `p95 == 1`, `max == 2`, and the recommendation stays at 1 while the
outlier is disclosed and flagged for human confirmation. The margin defaults to 0 for a `write` or
`external` label and is configurable.

Every proposal carries `observedRange`, `recommendedRange`, `support`, `outliers`, `sampleSize` and
`requiresHumanConfirmation` so the reviewer sees the recommendation and the evidence separately.

### Budgets are proposed only from trustworthy observations

A budget is proposed when, and only when, the metric was actually observed. Otherwise the miner
returns a typed reason and no rule:

```text
ATTRIBUTE_NOT_EMITTED       no eligible run reported the metric
INSUFFICIENT_OBSERVATIONS   fewer runs reported it than the configured minimum
SAMPLE_SIZE_TOO_SMALL       the eligible run count is below the percentile's minimum sample
ATTRIBUTE_QUERY_UNTRUSTED   the retrieval could not confirm the field's type (SL-046)
```

The refund agent makes no model call, so a token budget is expected to come back
`ATTRIBUTE_NOT_EMITTED` and to be disclosed rather than proposed as zero. Missing telemetry is never
converted into a zero bound.

### The Query Builder typing trap is closed by discovery, not by assumption

SL-046: a non-string tag requested without `dataType` returns `null` on a **successful** call, per
column, with no error and no warning. Phase 08 retrieves far more attributes than Phase 07 did, so
the defence is made explicit rather than left to a hand-maintained list.

Before any mining query runs, `verifyFieldTypes` calls `signoz_get_field_keys` and compares the
declared `dataType` of every requested field against the type SigNoz reports. Probed live today:

```text
agent.idempotency.present   context=attribute  dataType=bool
agent.retry.number          context=attribute  dataType=number
agent.side_effect           context=attribute  dataType=string
duration_nano               context=span       dataType=number
trace_id                    context=span       dataType=string
timestamp                   absent from the catalogue entirely
```

`timestamp` is a real column that the field catalogue does not list, so "absent from the catalogue"
cannot be an error — it is recorded as `unverified` and permitted only for the built-in span columns
FlightRules declares as `string`. A **mismatch** is a hard failure: the retrieval returns
`ATTRIBUTE_QUERY_UNTRUSTED` and mining does not proceed on a dataset whose typing is not understood.
Returned values are then re-checked against the declared type per row, so a shape change between
discovery and query is caught rather than absorbed.

### Truncation is detected from `nextCursor`, not guessed

Probed live: `nextCursor` is `""` when the returned row count is below the requested limit, and a
non-empty opaque cursor when the page is full. So a full page means "there may be more" and an empty
cursor means "there is definitively no more". Offset paging with `order: timestamp asc` was verified
to produce non-overlapping pages that concatenate exactly to the unpaged result.

The miner walks pages until the cursor is empty or the configured `maxTraces` is reached. Reaching
`maxTraces` with a non-empty cursor is **truncation**: recorded as such, and the baseline is marked
`truncated` and refuses to produce a normal proposal. A dataset known to be incomplete cannot found
a policy.

### Everything is keyed through `Map` or a null-prototype record

Canonical labels, service names, tool names, data domains and attribute keys are all telemetry-
derived. Phase 07 found that a `__proto__` attribute key with an array value replaced a record's
prototype. Phase 08 introduces many more telemetry-keyed indexes — grouping keys, label statistics,
tool sets, proposal identifiers — so every one of them is a `Map` or a `Set`, and adversarial tests
cover `__proto__`, `constructor`, `prototype`, `toString`, `valueOf` and `hasOwnProperty` as span
names, service names, tool names, data domains and attribute keys through the whole mining and
proposal path.

Generated rule identifiers are derived from a sanitised, length-bounded slug of the canonical label
plus a stable index, and are asserted to satisfy the DSL's identifier grammar. A label that
sanitises to nothing still yields a valid, unique identifier.

### Canonical ordering is not reimplemented

The miner uses `canonicalOrdering`, `canonicaliseGraph`, `fingerprintGraph`, `featuresOf` and
`similarity` from `@flightrules/trace-graph`. There is no second traversal anywhere in this package.
ADR-0006 decision 12 gives the reason: a second copy agrees until one is changed, and then attaches
statistics to the wrong canonical node while still passing small tests.

### The proposal is a `TrajectoryContract`, and it goes through the public parser

`proposeContract` builds a `TrajectoryContract` value and validates it with
`validateContractValue`. `emitContractYaml` then serialises it and the result is re-read with
`parseContract`, and the two content hashes are asserted equal. So the generated YAML is proven to
be a document the Phase 07 validator accepts and that means the same thing after a round trip —
rather than a document that merely looks right.

Nothing the miner produces is activated. The proposal's status is `draft`, the only state PRD FR-018
assigns before human approval, and the type has no transition out of it. Approval and activation are
Phase 09 API work.

### Redaction

Proposals and evidence carry canonical labels, service names, tool names, data domains, side-effect
classifications, counts, statistics, fingerprints, trace IDs and span IDs. They never carry raw
prompts, tool arguments, tool results, `agent.idempotency.key_hash`, order or customer identifiers,
headers or any attribute outside the allowlist. Every string that reaches a proposal is bounded in
length and stripped of control characters; the allowlist is asserted by a test that feeds a span
carrying a secret-shaped attribute through mining and asserts the serialised proposal does not
contain it.

## Test plan

Beyond the PRD's list, and in the repository's existing three-project split.

- **Determinism**: input order, span IDs, trace IDs, run IDs, timestamps, object key order, repeated
  mining, both `Map` iteration orders. Property tests over permuted datasets assert byte-identical
  mining output and byte-identical proposal YAML.
- **Families**: one dominant family, several valid families, a rare family, identical fingerprints
  from different traces, similar but distinct routes, same route with different timings, different
  retries, a missing optional node, a missing required candidate, an extra side effect, a local-only
  step, a remote handler step.
- **Eligibility**: one case per exclusion reason, plus zero eligible traces, plus a truncated result
  set, plus counts that must reconcile exactly.
- **Statistics**: one sample, two samples, odd and even counts, exact percentile boundaries, one
  below and one above a threshold, a duration outlier, a retry outlier, an absent attribute, an
  explicit zero, a boolean `false`, a numeric zero, and a Query Builder `null` caused by an omitted
  `dataType`.
- **Proposal**: schema-valid output, validator round trip, canonical serialisation, `draft` by
  default, stable rule identifiers, stable family references, excluded-trace disclosure,
  insufficient-evidence disclosure, several approved families, no token rule when tokens are absent,
  no silent default for an unknown metric.
- **Adversarial**: prototype-shaped names in every telemetry-derived position, Unicode confusables,
  control characters, a 10,000-character span name, 5,000 distinct families, a 10,000-span deep
  trace, duplicate canonical nodes, and a cyclic input that graph validation admits.
- **Performance**: the seeded demo dataset, 1,000 identical-route traces, 500 distinct families, the
  maximum supported dataset, and the maximum proposal size, with budgets derived from PRD 20.2.
- **Live**: mine ≥20 fresh v1 runs from SigNoz; assert one family; assert the family fingerprint
  equals the fingerprint the contract already carries; generate the proposal; validate it through
  the Phase 07 CLI; evaluate a fresh v1 trace against the generated proposal and require a pass;
  evaluate the v2 trace against the generated proposal and require the three critical findings;
  mine the same dataset twice and require byte equality.

## Exit gate

A user can turn a set of v1 traces into an approved contract without hand-writing the initial
policy: the miner produces a `draft` proposal from real v1 telemetry, the Phase 07 validator accepts
it, the Phase 07 evaluator passes a fresh v1 run against it and fails the v2 canary on the missing
policy check, the missing fraud check and the duplicate refund — with no LLM involved and nothing
activated automatically.
