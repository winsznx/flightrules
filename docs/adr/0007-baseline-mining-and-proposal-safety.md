# ADR-0007 — Baseline mining determinism and the proposal safety policy

- Status: Accepted
- Date: 2026-07-25
- Phase: 08
- Supersedes: none
- Related: ADR-0004 (telemetry attribute conventions), ADR-0006 (contract DSL and determinism boundary)

## Context

PRD Phase 08 turns known-good SigNoz traces into route families and a reviewable contract proposal.
PRD FR-007 and FR-008 define what must be mined and what must be proposed; PRD section 11.8 fixes P0
grouping as exact by fingerprint; PRD FR-018 puts approval and activation behind a human.

The determinism boundary of ADR-0006 extends here unchanged: no model decides which family exists,
which runs belong to it, whether a step is required, what a bound should be, or whether a proposal
becomes active.

Two properties make this phase harder than it looks. First, a proposal is a *safety* artefact derived
from observation, and the naive derivation — permit everything observed — encodes an accidental
duplicate side effect as policy, which is the exact fault the product exists to catch. Second, the
retrieval path can lose evidence silently: SL-046 showed a typed column returning `null` on a
successful call, and SL-050 shows the only truncation signal the pinned server offers.

## Decisions

### 1. One package, storage-independent

`packages/baseline-miner` produces the values PRD sections 14.7 and 14.8 will store and returns them.
Persistence is Phase 09 by PRD assignment, and building it here would put Phase 09 work behind a
Phase 08 gate and have to be rewritten once the schema exists.

### 2. Grouping is exact, and family identity is content-derived

PRD section 11.8: "P0 grouping is exact by fingerprint." So there is no clustering algorithm, no
distance threshold and no seed anywhere on the mining path. `similarity` from
`@flightrules/trace-graph` is used only where PRD section 11.9 assigns it — nearest-family selection
and display — and never decides membership.

A family's identifier is a digest of the baseline identity and the fingerprint, and the baseline
identity is a digest of the selection. So shuffling the input cannot renumber the families, and mining
one window twice produces one baseline identity — which is also the idempotency key PRD section 20.1
requires of a long-running job.

Exact grouping has a consequence worth stating: every run in a family has a byte-identical canonical
graph. Per-family topology is therefore a constant of the family, and the only variation between its
runs lives in the dimensions the fingerprint excludes — duration, tokens, timestamps. The variation
that rule proposal needs is across the **union** of the approved families, which is why aggregation is
a separate step from family statistics.

### 3. Every statistic is an integer or an exact fraction

Counts, attempt indexes, whole milliseconds and token counts are all integers, so no floating-point
value reaches the output. Percentiles use the **nearest-rank** definition — `ceil(p × n)` clamped into
`[1, n]`, one-indexed into the ascending sample — so every reported percentile is a value some run
actually produced, and no interpolation, and therefore no division, is involved. Ratios are carried as
`{numerator, denominator, decimal}` with the decimal rendered by integer division to six places and
**truncated**, so a share below the whole never reads as the whole. A mean is the one statistic that is
genuinely not an observed value, so it is reported as an exact fraction rather than a rounded number.

`distributionOf` refuses a non-integer, a negative and a sum outside the safe integer range rather than
reporting a silently wrong statistic. The sum is accumulated as a `bigint` before being narrowed, so
the refusal is exact rather than approximate.

### 4. A cardinality bound refuses to encode an outlier

PRD FR-008 asks for "maximum observed cardinality with configurable safety margin". Taken literally
that permits an accidental duplicate refund. So:

```text
base = nearest-rank p95 of the per-run occurrence counts
if observedMax > base   recommendedMax = base, the outlier is disclosed,
                        requiresHumanConfirmation = true
otherwise               recommendedMax = observedMax + safetyMargin
```

With twenty identical runs `p95 == max == 1` and the recommendation is `1 + margin`. With one run in
twenty-one that issued two refunds, `p95 == 1` and `max == 2`: the recommendation stays at 1, the
outlier is named, and the reviewer is told the bound is not simply the observation. The margin defaults
to 0.

Every proposal carries `observedRange`, `recommendedRange`, `support`, `outliers`, `sampleSize` and
`requiresHumanConfirmation`, so the reviewer sees the recommendation and the evidence separately.

### 5. A retried side effect is never widened by a margin

`retry_budget.sideEffectMax` is the observed maximum and nothing more, whatever
`retrySafetyMargin` is set to. A proposal that permitted a retried write because a margin was
configured would defeat the rule's purpose.

### 6. A rule is never proposed that the baseline itself violates

A step is proposed as `required_span` only when its per-run minimum is at least one — that is, when
every observable approved run performed it. A step present in some runs and provably absent in others
is proposed as a `cardinality` bound with `min: 0` and disclosed as optional, with its support ratio,
for the reviewer to promote.

`requiredSupport` therefore classifies rather than decides. A threshold below 1 changes what the
reviewer is told; it never makes the miner propose a rule its own evidence contradicts.

### 7. A remote handler is required through the edge from its caller

A label every one of whose occurrences is a `Server` span under a `Client` span is a handler: it exists
because the caller made a request, and its absence is evidence about the transport rather than about
the agent's decisions. Phase 04's aborted payment attempt is the concrete case — the client span exists
and the handler span was never exported — so a `required_span` on the handler label would report a
skipped step for a telemetry gap.

So handlers get `required_edge` from their caller instead, which is the rule Phase 07 already reports as
`insufficient_evidence` in exactly that case. The proposal generated from live telemetry reproduces the
shape a human wrote by hand in the Phase 07 demo contract.

### 8. An absence inside an unobservable subtree is not an absence

ADR-0006 decision 8 scoped insufficient evidence per subtree for evaluation. Mining needs the same rule
at label granularity: a step absent from a run is counted as absent **unless** one of the parent labels
that step was observed under in some other approved family is flagged
`client_span_without_server_span` in that run. Such a run is removed from the label's denominator
rather than counted as a run in which the step did not happen.

The scoping has to be per subtree, not per run. A run that lost one handler span still proves the
absence of a step that would have run elsewhere in it, and treating the whole run as uncertain would
demote a genuinely universal prerequisite to optional on the strength of one aborted request.

### 9. Absent telemetry is never a bound of zero

A budget is proposed only when the metric was observed. Otherwise the miner returns a typed reason —
`ATTRIBUTE_NOT_EMITTED`, `INSUFFICIENT_OBSERVATIONS`, `SAMPLE_SIZE_TOO_SMALL`,
`ATTRIBUTE_QUERY_UNTRUSTED` — and discloses it. The refund agent makes no model call, so the token
budgets come back `ATTRIBUTE_NOT_EMITTED` against the live demo and are disclosed rather than proposed
as zero. A run-scoped budget on a metric nothing emits would report insufficient evidence on every run,
which makes the whole run `insufficient_data` and the contract unable to pass its own baseline.

### 10. Field types are confirmed by discovery, not by a maintained list

SL-046: a non-string tag requested without its `dataType` returns `null` on a **successful** call, per
column, with no diagnostic. SL-051: the field catalogue reports a `fieldDataType` per field, so the
server can confirm what a request should declare.

`verifyFieldTypes` runs before any mining query and refuses a **mismatch** outright. An **absence** from
the catalogue cannot be an error — `timestamp` and every resource attribute are genuinely absent — so it
is recorded as `unverified` and permitted under two conditions that together make `null` unambiguous: a
span or resource field must be declared `string`, the server's own default resolution; and a *tag*
absent from the catalogue was emitted by no span in the window, so `null` means "not emitted". Returned
values are then re-checked per row against the declared type, so a shape change between discovery and
query is caught rather than absorbed.

### 11. A truncated dataset cannot found a baseline

SL-050 establishes the only truncation signal available. Reaching the selection's `maxTraces` while
SigNoz still offers a continuation sets the baseline's status to `dataset_truncated`, and both review
and proposal are then refused. A dataset that omitted runs nobody looked at may contain enough runs and
still misrepresent the release.

Truncation outranks the run count for the same reason.

### 12. Counts must close, or mining fails

`eligible + excluded === discovered`, the per-reason totals must sum to `excluded`, and
`retrieved + unfetchable + duplicates === discovered`. All three are asserted in code, not only in
tests. A mining run that has lost a trace has lost it from the denominator of every support ratio,
which changes which rules are proposed as required — and failing loudly is the only response that
cannot produce a confidently wrong contract.

Deduplication is by **run** identifier, never by an order identifier, a customer identifier or a
fingerprint. Many valid runs legitimately refund one order, and collapsing them would understate the run
count and hide a duplicate side effect that spanned two runs. A trace discovered but unfetchable is
counted as `TRACE_FETCH_FAILED` rather than dropped, because a fetch failure is a materially different
fact from an ineligible trace.

### 13. Telemetry-derived text is sanitised once, and an inexpressible label is refused

Canonical labels, service names, tool names and data domains reach rule identifiers, selector values,
generated YAML and evidence. They are NFC-normalised, stripped of control, bidirectional and zero-width
characters, and bounded by **code point** so a truncation cannot split a surrogate pair. The
bidirectional controls are the reason this is not simply a control-character check: `U+202E` reorders
the rendering of everything after it, so a span name carrying one can make a generated rule read as
something other than what it enforces.

A selector can only say `name: X`, so two canonical labels that sanitise to the same text are
indistinguishable to the DSL. Both are refused and disclosed as `LABEL_NOT_EXPRESSIBLE` rather than
given a rule that would also govern the other. Rule identifiers are derived from the same sanitised name
as the selector, so an identifier always describes the spans its rule actually selects.

Every index keyed by telemetry is a `Map` or a `Set`. Phase 07 found a `__proto__` attribute key
replacing a record's prototype; Phase 08 introduces many more telemetry-keyed indexes, and adversarial
tests drive `__proto__`, `constructor`, `prototype`, `toString`, `valueOf` and `hasOwnProperty` through
the whole mining and proposal path as span names, service names, tool names, data domains and attribute
keys.

### 14. The proposal goes through the public parser, and its state is `draft`

`proposeContract` builds a document, validates it with `validateContractValue`, and returns the
**validated** rules with the evidence re-attached by identifier. Keeping the pre-validation values would
leave two descriptions of one rule that could quietly disagree — validation normalises a selector, sorts
a value list and strips a fingerprint prefix.

`emitContractYaml` then serialises that contract, re-reads the text with `parseContract`, and asserts the
two content hashes are equal. So the emitted YAML is proven to be a document the Phase 07 validator
accepts and that still means the same thing after a round trip.

`aliasDuplicateObjects: false` is load-bearing: two rules sharing a structurally identical selector would
otherwise be emitted as an anchor and an alias, and `loadContractDocument` rejects both (SL-047).

The proposal's status is `draft`, the only state PRD FR-018 assigns before human approval, and the type
admits no transition out of it. Nothing in this package activates anything.

### 15. Evidence is allowlisted, not redacted

`PROPOSAL_ATTRIBUTES` is the closed set of evidence attributes the proposal path may read — currently
`agent.idempotency.present` alone. A denylist would admit every attribute a future service adds. A test
feeds spans carrying an idempotency key hash, an order identifier and an authorization header through
mining and asserts none of those values appears in the emitted document.

## Consequences

- The miner can be exercised against captured fixtures through the `TraceSource` interface, while the
  live path is a real implementation of the same contract rather than a separate code path.
- A proposal is deliberately conservative and larger than a hand-written contract: it proposes a rule for
  every step the evidence supports, and leaves pruning to the reviewer. Against the live demo that is 28
  rules and 9 zero-tolerance identifiers, where the hand-written Phase 07 contract has 15 and 4.
- The generated contract's `approved_routes` rule marks more labels critical than the hand-written one,
  so the weighted-Jaccard similarity of the canary against it is 0.619047 rather than the 0.572815
  Phase 07 reports. Both are correct: PRD section 11.9's weighting depends on which nodes the contract
  treats as critical.
- Release-scoped budgets are still `deferred` at run scope, as Phase 07 established, so the proposal's
  release latency budget contributes a sample rather than a verdict until Phase 11.

## Alternatives rejected

| Alternative | Why not |
|---|---|
| Cluster similar routes into one family | PRD section 11.8 fixes P0 grouping as exact; a threshold on similarity would put a fuzzy score on the path that decides what a contract governs. |
| Set the cardinality maximum to the observed maximum | Encodes an accidental duplicate side effect as permitted policy. |
| Propose a required rule at a support threshold below 1 | Produces a contract the baseline itself fails, which reads as a broken release on the first evaluation. |
| Treat a run with any unobservable subtree as wholly uncertain | Demotes a genuinely universal prerequisite to optional on the strength of one aborted request. |
| Default an unemitted metric to a bound of zero | Turns missing telemetry into a rule no run can satisfy. |
| Maintain a hand-written list of field types | SL-046 degrades silently and per-column; a list drifts and nothing notices. Discovery asks the server. |
| Mine from a truncated dataset and note it | The omitted runs are exactly the ones nobody looked at, so every support ratio is unsound. |
| Deduplicate by order identifier | Many valid runs refund one order; collapsing them hides a duplicate side effect across runs. |
| Emit YAML text directly | A hand-built string cannot be proven to be a document the validator accepts and that round-trips to the same meaning. |
