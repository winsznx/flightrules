# Phase 07 plan — Contract schema and deterministic evaluator

Branch: `phase/07-contract-engine`
Date: 2026-07-25
PRD sections: Phase 07, plus 10.1–10.6, 11.11, 11.12, FR-009, FR-010, 19, 20.2.

## Entry criteria, verified independently

Every row was re-checked against the repository and the running stack rather than taken from the
Phase 06 handoff.

| Criterion | Check | Result |
|---|---|---|
| Working tree clean | `git status --porcelain` | Empty |
| Reported phase commits exist and are reachable from `main` | `git merge-base --is-ancestor` for all ten | All reachable |
| No Phase 07 branch or partial work | `git branch --all` | Absent before this branch |
| Phase 06 merged and green | `make verify` | Exit 0 |
| Live SigNoz stack healthy | `make signoz-verify` | Exit 0, all surfaces |
| Demo runs reproducible | `make demo-v1`, `make demo-v2` | Both exit 0 |
| Full suite passing | `make test`, `make test-integration` | 317 unit + 67 integration = 384, 0 failed, 0 skipped |
| Source-lock entries SL-040 to SL-045 present and consistent with the code they cite | Read each entry and its named file | Consistent |
| Acceptance matrix reflects Phases 00–06 | Read `docs/ACCEPTANCE_MATRIX.md` | Accurate, including scope item 6 held at `IN PROGRESS` |
| Deterministic canonical graphs exist | `packages/trace-graph` | Present |
| Route fingerprints stable across runs | Live integration test | A v1 run executed today fingerprints identically to the committed fixture |
| Error codes and severities defined | `packages/domain/src/errors.ts`, `trace.ts` | `CONTRACT_INVALID`, `EVALUATION_FAILED`, `EVALUATION_STATUSES`, `SEVERITIES` all present |

### Live trace topology, re-confirmed

Fetched through the Phase 05 MCP client, not read from the handoff.

```text
refund-agent-v1   12 spans   6 services   quality complete
refund-agent-v2    8 spans   4 services   policy-service and fraud-service absent
                             two Client write spans named payment.refund, retry 0 and retry 1
                             one payment.refund.handler, at retry 1 only
```

The retry-0 handler is absent. That is the Phase 04 aborted-server-span limitation, carried
forward unchanged.

### One handoff inaccuracy, corrected here

`docs/evidence/HANDOFF.md` describes the known-good route as six steps "each with a `.handler`
server span". `refund.calculate` has no handler: it is local agent work, so v1 is one root span,
six client spans and **five** handlers. This does not affect any Phase 06 result, and no Phase 06
code or test asserts otherwise. Corrected in the Phase 07 handoff rather than edited into the
Phase 06 evidence.

## Scope

Two packages, exactly as PRD section 13 names them.

```text
packages/contract-schema   the versioned DSL: types, JSON Schema, safe YAML, validation,
                           canonical JSON, content hash, CLI validation command
packages/contract-engine   the deterministic run evaluator: indexes, selectors, eleven rule
                           evaluators, evidence, canonical evaluation JSON
```

The split is not cosmetic. A contract must be validatable in CI with no graph, no database and no
SigNoz — that is what `flightrules contract validate` has to do in Phase 11 — and the evaluator
must be storage-independent because persistence is Phase 09 by PRD assignment.

## The eleven rule types

PRD section 10.4 shows twelve examples of **eleven** distinct `type` values: the latency budget and
the token budget are both `numeric_budget`, differing only in `metric`.

| # | `type` | PRD heading |
|---|---|---|
| 1 | `required_span` | Required span |
| 2 | `required_ancestry` | Required ancestry |
| 3 | `required_edge` | Required direct child |
| 4 | `forbidden_span` | Forbidden span |
| 5 | `forbidden_path` | Forbidden path |
| 6 | `cardinality` | Cardinality |
| 7 | `allowed_values` | Allowed tools |
| 8 | `attribute_constraint` | Attribute constraint |
| 9 | `retry_budget` | Retry budget |
| 10 | `approved_routes` | Approved routes |
| 11 | `numeric_budget` | Latency budget, Token budget |

## YAML security model, verified against the installed parser

`yaml@2.9.0` (ISC) is added to `packages/contract-schema`. Every claim below was established by
running the installed package, not from its documentation.

| Attack | Observed default behaviour | FlightRules response |
|---|---|---|
| Alias amplification (billion laughs) | `ReferenceError: Excessive alias count indicates a resource exhaustion attack` | Bounded already; we go further and set `maxAliasCount: 0`, which yields `Alias resolution is disabled` for **any** alias |
| `!!python/object:os.system` | Parses to a plain string, emitting only a `TAG_RESOLVE_FAILED` **warning** | Rejected by AST tag inspection |
| `!!binary` | Parses to a Node `Buffer` with **no error and no warning** | Rejected by AST tag inspection |
| `!!timestamp` | Parses to a `Date` with **no error and no warning** | Rejected by AST tag inspection |
| `__proto__` as a map key | Becomes an own property; the global prototype is **not** polluted | Still read through `Object.hasOwn` and `Map` only |
| Deep flow nesting | `YAMLParseError: Maximum call stack size exceeded` — caught, but the threshold depends on available stack | Depth bounded explicitly before that point, so rejection is deterministic |
| Duplicate map keys | `YAMLParseError: Map keys must be unique` by default | Kept, and asserted |
| Multiple documents | Rejected by `parse` | Kept, and asserted |
| Tab indentation | Rejected | Kept, and asserted |
| `.inf`, `.nan` | Parse to `Infinity` and `NaN` | Rejected as unsafe numerics |
| `99999999999999999999999` | Parses to `1e+23`, silently losing precision | Rejected where an integer is required |

The decisive finding is that `customTags: []`, `schema: "core"` and the warning list are **all
insufficient**: two of the three dangerous tags produce no diagnostic at all. Only walking the
document AST and rejecting any node that carries an explicit tag, an anchor or an alias covers all
three uniformly. Recorded as a source-lock entry.

## `matches` without a ReDoS exposure

PRD section 10.3 requires the `matches` operator to be "RE2-compatible or use a package with
denial-of-service protection", with length-limited patterns.

A static "no nested quantifiers" screen is not sufficient — alternation ambiguity such as
`(a|a)*b` backtracks catastrophically without any nested quantifier — and adding a native RE2
binding introduces a compiled dependency for one operator.

So `packages/contract-schema/src/regex.ts` implements a small **NFA-simulation matcher** over an
RE2-compatible subset: literals, `.`, character classes with ranges and negation, groups,
alternation, `*`, `+`, `?`, bounded `{m,n}`, and the `^`/`$` anchors. Backreferences and lookaround
are absent, exactly as in RE2, and the simulation advances a *set* of states once per input
character, so matching is O(pattern × input) with no backtracking possible by construction.

A property test compares it against `RegExp` on generated pattern/input pairs drawn from the
supported subset, so "RE2-compatible" is a tested claim rather than an assertion.

## Determinism model

PRD section 11.12 requires byte-equivalent canonical evaluation JSON for the same graph, contract,
normaliser version and evaluator version, excluding runtime metadata such as completion time.

- Every collection is sorted by an explicit total order before serialisation.
- Every object literal is written with its keys in a fixed order; nothing relies on insertion order.
- Rule results are emitted in the PRD section 11.11 evaluation order, then by rule ID, so
  reordering rule declarations cannot change the output.
- Similarity thresholds are compared as **exact integer cross-multiplications** over the feature
  weights, never as floating-point comparisons.
- No `Date.now()`, no random value and no UUID appears anywhere inside the hashed region.
- Completion timestamp and wall-clock duration are carried outside the canonical region and are
  excluded from the evaluation hash.

## Insufficient evidence, and what it must not swallow

PRD FR-010 requires an `insufficient_data` status, and the operating contract forbids treating
missing evidence as proof of absence unless trace completeness allows that conclusion.

The rule is structural and local, not global:

- A trace whose quality is `inconsistent` cannot be judged at all. The whole evaluation is
  `insufficient_data`.
- A trace whose quality is `incomplete` — orphans, a synthetic root, a span-limit truncation —
  cannot prove the **absence** of anything, so absence-based rules report insufficient evidence.
- A `client_span_without_server_span` warning marks one specific client span's subtree as
  unobservable. Only rules **anchored on that span** are undecidable: `required_edge` and
  `required_ancestry` whose `from`/`ancestor` selector matches a flagged span and whose target is
  absent. It does **not** make unrelated absences undecidable.

That last point is why v2 still fails. The v2 trace does carry a
`client_span_without_server_span` warning, for the aborted retry-0 payment call. A global rule
would turn the missing `fraud.check` into "insufficient evidence" and destroy the exit gate. The
local rule keeps `fraud.check` a proven violation while `required_edge payment.refund ->
payment.refund.handler` correctly reports insufficient evidence — which is exactly the behaviour
the Phase 06 handoff requires and the honest description of an aborted request.

A rule that finds a violation is never downgraded by an unrelated evidence gap: within one rule,
a proven violation outranks an undecidable case.

## Evidence the demo can and cannot supply

Two rules are deliberately evaluated against fixtures rather than the live demo, because the demo
does not emit the evidence they need. This is recorded rather than worked around.

- **Token budget.** The demo has no model call, so it emits no `gen_ai.usage.*` attribute. A
  `numeric_budget` on `gen_ai.usage.output_tokens` therefore returns **insufficient evidence**
  against both live traces. That is the correct answer, and it is used as the phase's live
  insufficient-evidence proof.
- **Temporal ordering of siblings.** In the real v1 trace every step is a child of
  `refund.request`, so `fraud.check` is a *sibling* of `payment.refund`, not an ancestor. PRD
  section 11.3 forbids `inferred_time_order` from satisfying a critical causal rule, and Phase 06
  deliberately does not compute those edges because SL-044 leaves timestamps at millisecond
  resolution. So "fraud before refund" is not expressible as causal ancestry from this telemetry.
  The PRD exit gate does not require it: it requires the evaluator to catch **missing** fraud,
  **missing** policy and a **duplicated** refund, which `required_span` and `cardinality` decide
  from evidence that genuinely exists. `required_ancestry` is implemented in full and exercised on
  the real parent-child pairs the traces do contain, plus dedicated fixtures.

## Test plan

Beyond the PRD's list:

- every rule type: valid contract fixture, passing trace, violating trace, stable violation ID,
  stable evidence reference, empty-evidence behaviour, equivalent-input ordering
- adversarial graphs: duplicate spans, reordered spans, missing parents, orphans, broken parent
  references, cycles, partial traces, repeated tools, same tool from different services, same span
  name in different services, dynamic route identifiers, unknown tools, unknown services, absent
  and malformed custom attributes, wrong-typed retry numbers, exact-boundary and excessive
  cardinality, multiple runs for one order, timed-out client without server span
- prototype-shaped names: `toString`, `constructor`, `__proto__`, `valueOf`, `hasOwnProperty`
  as span names, service names, tool names, attribute keys, rule IDs and contract keys
- contract rejection: every listed rejection reason with an exact error path
- determinism: rule order, contract key order, span order, repeated evaluation, byte equality
- performance: demo trace, 1,000-span and 10,000-span synthetic traces, a contract carrying all
  eleven rule types, the maximum permitted rule count, with asserted budgets derived from PRD
  section 20.2
- live: v1 passes the demo contract and v2 fails its critical rules, both fetched from SigNoz

## Exit gate

The evaluator catches missing fraud, missing policy and the duplicate refund on the real v2 trace,
with no LLM involved in any decision, and v1 passes the same contract.
