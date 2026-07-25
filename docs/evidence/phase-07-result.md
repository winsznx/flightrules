# Phase 07 result — Contract schema and deterministic evaluator

Branch: `phase/07-contract-engine`
Date: 2026-07-25

## What was built

```text
packages/contract-schema/src/types.ts        the versioned DSL as TypeScript types
packages/contract-schema/schema/*.json       the published draft 2020-12 JSON Schema
packages/contract-schema/src/regex.ts        RE2-compatible Thompson NFA, no backtracking
packages/contract-schema/src/yaml.ts         safe YAML loading with construction and resource bounds
packages/contract-schema/src/errors.ts       {path, code, message} with a deterministic sort
packages/contract-schema/src/validate.ts     static validation, including cross-rule contradictions
packages/contract-schema/src/canonical.ts    canonical serialisation and SHA-256 content hash
packages/contract-schema/src/parse.ts        the single entry point, returning a typed union
packages/contract-schema/src/cli-run.ts      the validation command's logic, streams injected
packages/contract-schema/src/cli.ts          the executable wrapper

packages/contract-engine/src/graph-index.ts  Map-based query indexes over one trace graph
packages/contract-engine/src/selector.ts     the six selector operators, compiled once per run
packages/contract-engine/src/rules-structure.ts  presence, absence, cardinality, ancestry, paths
packages/contract-engine/src/rules-values.ts     values, retries, routes, budgets
packages/contract-engine/src/rule-context.ts     shared state, exact-rational similarity
packages/contract-engine/src/evidence.ts     evidence references and stable violation identity
packages/contract-engine/src/result.ts       the output vocabulary
packages/contract-engine/src/evaluate.ts     orchestration in PRD section 11.11 order
packages/contract-engine/src/canonical.ts    canonical evaluation JSON and its hash
packages/contract-engine/src/version.ts      the evaluator version

contracts/demo-commerce/refund-agent/production/contract.yaml   the active contract, 15 rules
packages/contract-engine/fixtures/contracts/*.yaml              18 per-rule fixture contracts
packages/test-fixtures/src/spans.ts          span-row builder for topologies the demo never emits
scripts/validate-contracts.sh                validates every committed contract; wired into make verify
docs/adr/0006-contract-dsl-and-determinism-boundary.md
```

## The eleven rule types

PRD section 10.4 shows twelve examples of eleven distinct `type` values — the latency budget and the
token budget are both `numeric_budget`. All eleven are implemented, and a test enumerates the fixture
directory and asserts that the set of types found equals `RULE_TYPES` exactly, so a missing
implementation cannot pass unnoticed.

| # | `type` | Passing fixture | Violating fixture | Empty-evidence behaviour |
|---|---|---|---|---|
| 1 | `required_span` | live v1 | live v2 (`REQUIRED_SPAN_MISSING`), built (`REQUIRED_SPAN_TOO_MANY`) | `trace_incomplete` |
| 2 | `required_ancestry` | live v1 and v2 | built, refund under a second root | `trace_incomplete` for an orphan |
| 3 | `required_edge` | live v1 | built, handler absent with no gap to explain it | `unobservable_subtree` on live v2 |
| 4 | `forbidden_span` | live v1 and v2 | built, admin-domain write | `trace_incomplete` |
| 5 | `forbidden_path` | live v1 and v2 | built, path to admin with no approval on it | `trace_incomplete` |
| 6 | `cardinality` | live v1 | live v2 (`CARDINALITY_ABOVE_MAX`), built (`CARDINALITY_BELOW_MIN`) | `trace_incomplete` |
| 7 | `allowed_values` | live v1 and v2 | built, unknown tool and unknown service | `attribute_not_emitted` |
| 8 | `attribute_constraint` | live v1 and v2 | built, flag present and false | `attribute_not_emitted`, per operator |
| 9 | `retry_budget` | live v1 | live v2 (side effect), built (per tool, run total) | `attribute_not_emitted`, `side_effect_unclassified` |
| 10 | `approved_routes` | live v1 | live v2 (`ROUTE_NOT_APPROVED` and `ROUTE_DRIFTED`) | violation with similarity unavailable |
| 11 | `numeric_budget` | live v1 | live v2, latency | `metric_not_emitted` on both live traces |

"live" means the trace was fetched from the running SigNoz deployment during the test run. "built"
means `packages/test-fixtures/src/spans.ts` constructed a topology the demo legitimately never
produces — there is no admin write, no unknown tool and no cycle in a healthy refund.

## The exit gate, proven against live telemetry

`make demo-v1` and `make demo-v2`, then the traces fetched back through the Phase 05 MCP client and
evaluated against the committed production contract.

| Assertion | Result |
|---|---|
| The active contract passes the approved release | **Pass**, 13 rules passed, 2 deferred, 0 violations |
| The active contract fails the canary | **Fail**, 6 violations, 3 critical, 3 zero-tolerance |
| Missing fraud check detected | `require-fraud-check` → `REQUIRED_SPAN_MISSING`, critical |
| Missing policy check detected | `require-policy-check` → `REQUIRED_SPAN_MISSING`, critical |
| Duplicate refund detected | `single-refund-write` → `CARDINALITY_ABOVE_MAX`, observed 2, critical |
| No LLM involved in any decision | No model call exists in either package |
| Violations link to real span IDs from the fetched trace | The duplicate-refund evidence names both live `payment.refund` span IDs |
| The contract's committed fingerprint is the one the engine computes today | Asserted against a freshly computed fingerprint |

The canary's full finding set:

```text
[critical/zero-tolerance] REQUIRED_SPAN_MISSING              fraud.check is required at least 1 time(s) but occurred 0 time(s).
[critical/zero-tolerance] REQUIRED_SPAN_MISSING              policy.retrieve is required at least 1 time(s) but occurred 0 time(s).
[critical/zero-tolerance] CARDINALITY_ABOVE_MAX              payment.refund, agent.side_effect = write occurred 2 times; the contract permits at most 1 per run.
[high]                    RETRY_BUDGET_SIDE_EFFECT_EXCEEDED  The side-effecting step issue_refund was retried 1 time(s); at most 0 are permitted.
[high]                    ROUTE_NOT_APPROVED                 The route is not approved and is materially different: similarity 0.572815 is below the 0.92 threshold.
[medium]                  NUMERIC_BUDGET_EXCEEDED            run.duration_ms (max) was 826, exceeding the budget of 500.
```

Every summary line above was written by the evaluator from the observed numbers. None came from a
model.

## The aborted server span, handled as the handoff required

The canary's first payment attempt times out, and Fastify 5.10.0 never exports a server span for it.
Phase 06 records this as a `client_span_without_server_span` trace-quality warning that does not
downgrade the trace.

Phase 07's `refund-handler-follows-refund-call` rule requires every `payment.refund` call to have a
`payment.refund.handler` child. On the live canary it reports:

```text
insufficient_evidence   refund-handler-follows-refund-call   unobservable_subtree
```

Not a violation. The call demonstrably happened; only the evidence of its completion is absent, and
reporting an aborted request as a skipped step would be false. Meanwhile the duplicate-refund
finding, whose evidence lives entirely in the two exported client spans, still fails the release.

This required the insufficient-evidence scope to be **local**. A global rule — "this trace has an
unobservable subtree, so no absence can be proven" — would have turned the genuinely missing fraud
check into insufficient evidence and destroyed the exit gate. Two live integration tests and four
unit tests hold the distinction in place.

## Insufficient evidence, proven live

The demo agent makes no model call, so no span carries `gen_ai.usage.output_tokens`. A run-scoped
token budget evaluated against the live v1 trace returns:

```text
insufficient_evidence   output-token-budget   metric_not_emitted
```

and the run status is `insufficient_data`, not `pass`. This is why the *production* contract's token
budget is release-scoped: a rule that can never be decided against the agent it governs is a
contract-authoring error, not a finding, and leaving it run-scoped made the active contract unable
to pass its own baseline. The insufficient-evidence path is proven by a dedicated fixture contract
instead, in both the unit and the live suites.

## Determinism

| Property | How it is proven |
|---|---|
| Repeated evaluation is byte-identical | Same graph twice, serialised output compared |
| Span arrival order is irrelevant | Reversed and rotated row order, plus a 300-run property test over generated traces |
| Attribute key order is irrelevant | Every row's keys reversed |
| Rule declaration order is irrelevant | Contract rules reversed after validation |
| Contract key order is irrelevant | Document reformatted, comments stripped |
| Completion time is excluded | Two runs, timestamps four years apart, identical hash |
| No floating point anywhere in the output | Canonical JSON walked; every number asserted integral |
| A violation identifier survives a new run of the same route | Two runs, different trace, span and run IDs, identical violation IDs |
| A changed contract changes the hash | One threshold loosened |
| Locale cannot affect ordering | Every comparison is an explicit code-unit comparison |

## Performance

Measured on the supported local environment, median of repeated runs. PRD section 20.2's relevant
target is 250 ms p95 for a 100-span trace.

| Scenario | Median |
|---|---|
| Demo canary, 8 spans, 15 rules | **0.28 ms** |
| Demo approved release, 12 spans, 15 rules | **0.23 ms** |
| 1,000-span trace, 15 rules | **15.6 ms** |
| 10,000-span trace, 15 rules | **191 ms** |
| 1,000-span trace, **500 rules** (the DSL ceiling) | **15.3 ms** |
| 10,000-deep chain, 15 rules | **116 ms** |
| `GraphIndex` build alone, 1,000 spans | 6.65 ms |
| `parseContract` on the 15-rule contract | 1.52 ms |

Two figures matter beyond the budget. Going from 1,000 to 10,000 spans costs 12x, not 100x, so the
evaluator is not quadratic. And 500 rules cost the same as 15 on the same trace — the indexes are
built once and every selector resolves through a map, so rule count is nearly free. Both are
asserted as budgets, because Phase 06's quadratic canonical path was only ever caught by one.

## Defects found and fixed

All four were found by tests or by a runtime probe, not by inspection.

### 1. A telemetry attribute key of `__proto__` replaced a record's prototype (Phase 06 code)

`normaliseAttributes` built its two records as plain objects and assigned into them. A span carrying
an attribute key `__proto__` with an **array** value invoked the inherited setter and replaced the
record's prototype, after which `evidence.length` returned `2` and `evidence[0]` returned `"a"` —
values no span ever emitted. `Object.prototype` itself was untouched, so nothing global broke, but
any consumer reading the record without `Object.hasOwn` saw phantom data. Reproduced directly before
changing anything:

```text
evidence own keys:  [ 'name' ]
prototype is Array: true
evidence.length ->  2   | evidence[0] -> a
```

Fixed with `Object.create(null)` for both records. The attribute is now preserved as ordinary data,
which is better evidence fidelity as well as safe. The evaluator reads through `Object.hasOwn`
regardless, so the defence holds at both ends. This is Phase 06 code changed during Phase 07: it was
not a Phase 06 gate failure — every Phase 06 test still passes unmodified — but Phase 07 reads these
records on the critical path and could not be correct without it. Recorded here rather than edited
into the Phase 06 evidence.

### 2. A non-string tag silently returned `null` from a hand-written query

The first live integration run reported `insufficient_data` for v1 where the fixture reported `pass`.
The cause was the query, not the evaluator: `agent.idempotency.present` was requested without
`dataType: "bool"`, and the Query Builder returned the column as `null` — a success, with no error
and no warning. Probing established the general rule for both boolean and numeric tags (SL-046).

The important part is how it surfaced. The evaluator reported `insufficient_evidence` for the absent
attribute rather than passing the rule, so a query returning nothing produced "I cannot confirm this"
instead of a green release. Had absence defaulted to a pass, this would have been an invisible false
negative on a critical safety rule.

### 3. `canonicalContract` depended on its caller having sorted the input

Found by the rule-order determinism test. Canonicalisation mapped `spec.rules` in array order,
relying on validation having sorted them. For a parsed contract that holds — but Phase 08's proposal
generator and Phase 09's database rows are both producers that do not go through the YAML validator,
and either would have hashed one policy two ways. Fixed by sorting inside `canonicalContract`, which
is what "canonical" has to mean.

### 4. Ancestry undecidability was scoped too broadly

Found by the test asserting that a refund under a second root is a violation. The check was "does
the parent chain reach the chosen root", which conflated a chain *truncated* by unexported spans with
one that legitimately ends at a second parentless span. The first has unknown ancestry; the second has
known, empty ancestry. Narrowed to test whether the top of the chain is flagged as an orphan, so a
detached side effect can no longer escape the rule by being detached.

## Discovered and recorded

New source-lock entries: **SL-046 to SL-049**.

| ID | Finding |
|---|---|
| SL-046 | A non-string tag in Query Builder `selectFields` returns `null` unless its `dataType` is declared. The call succeeds with no error, no warning and every other column correct, so an attribute vanishes silently and per-column. |
| SL-047 | `yaml@2.9.0` resolves `!!binary` to a `Buffer` and `!!timestamp` to a `Date` with **no error and no warning**, and `customTags: []` does not prevent it. An unresolvable tag is only a warning. So the tag defence must walk the document, not read the options or the diagnostics. |
| SL-048 | `ajv@8.20.0`'s default export cannot compile a draft 2020-12 schema; `ajv/dist/2020.js` can. Used as a devDependency for the schema parity test only. |
| SL-049 | `[]a]` is a two-member character class in RE2 and an empty class in JavaScript. FlightRules follows RE2, as PRD section 10.3 requires, and asserts the divergence. |

## Tests

```text
make verify                          exit 0
make signoz-verify                   exit 0
make contract-validate               exit 0, 19 contract documents valid
make test                            599 passed, 0 failed, 0 skipped   (25 files)
make test-integration                 75 passed, 0 failed, 0 skipped   ( 5 files)
                                     ---
                                     674 tests passed
```

Phase 07 added **282 unit tests and 8 integration tests** to the 384 that existed at the end of
Phase 06.

Breakdown of the new unit tests:

```text
packages/contract-schema/src/yaml.test.ts        28   YAML security model
packages/contract-schema/src/regex.test.ts       72   syntax, rejection, ReDoS timing, 5,000 property runs
packages/contract-schema/src/validate.test.ts    59   acceptance, rejection paths, contradictions, hashing, schema parity
packages/contract-schema/src/cli-run.test.ts     11   exit codes and output modes
packages/contract-engine/src/rules.test.ts       66   the eleven rule types
packages/contract-engine/src/evaluate.test.ts    38   exit gate, order, determinism, adversarial, prototype safety
packages/contract-engine/src/performance.test.ts  8   budgets
```

Property-test run counts: 2,000 runs for regex/`RegExp` agreement, 2,000 for regex totality, 1,000
for regex determinism, 1,000 for validation totality, 500 for validation determinism, 500 for the
apiVersion invariant, and 300 runs each across seven evaluator properties.

Integration tests are all against the live stack and fail rather than skip when it is absent.

## Malformed-contract rejection

Every case below is asserted with its exact path and code. A representative selection:

```text
apiVersion                          UNKNOWN_API_VERSION       flightrules.dev/v2
kind                                UNKNOWN_KIND              Policy
extra                               UNKNOWN_FIELD             an unknown top-level field
spec.rules[0].cardinaltiy           UNKNOWN_FIELD             a typo, rejected rather than dropped
spec.rules[0].cardinality           REQUIRED                  the same typo's consequence
spec.rules[0].type                  UNKNOWN_RULE_TYPE         required_thing
metadata.version                    REQUIRED / INVALID_FORMAT missing, or "v1"
metadata.createdAt                  INVALID_FORMAT            25/07/2026
metadata.id                         INVALID_IDENTIFIER        "Sample Contract"
spec.rules[0].id                    INVALID_IDENTIFIER        __proto__
spec.rules[0].cardinality.max       INVALID_RANGE             max must be >= min
spec.rules[1].id                    DUPLICATE_RULE_ID         points at the later declaration
spec.rules[0].selector              EMPTY_SELECTOR            a selector constraining nothing
spec.rules[0].values                LIST_EMPTY / DUPLICATE_VALUE
spec.rules                          LIST_TOO_LONG             501 rules
spec.approvedRoutes[0]              INVALID_FORMAT            not a SHA-256 digest
spec.rules[0].fingerprints          UNKNOWN_ROUTE_REFERENCE   a family the contract never declares
spec.gate.zeroToleranceRuleIds      UNKNOWN_RULE_REFERENCE    a rule that does not exist
spec.gate.maxViolationPercent       INVALID_RANGE / INVALID_NUMBER  101, or 0.12345678
spec.gate.minCompletedRuns          INVALID_NUMBER            beyond exact integer range
spec.rules[0].selector.namePattern  INVALID_PATTERN           (?:a)
spec.rules[0].selector.namePattern  STRING_TOO_LONG           a 300-character pattern
spec.rules[0].value                 UNKNOWN_FIELD             a value supplied to "exists"
spec.rules[0].aggregation           INVALID_ENUM              a percentile at run scope
spec.rules[0].metric                INVALID_ENUM              a metric FlightRules cannot compute
spec.budgets                        UNKNOWN_FIELD             a budget that would never be enforced
$document                           YAML_ALIAS_FORBIDDEN      an alias bomb, and a single alias
$document                           YAML_TAG_FORBIDDEN        !!python/object, !!binary, !!timestamp
$document                           YAML_DUPLICATE_KEY        a repeated key
$document                           YAML_TOO_DEEP             nesting past the depth bound
$document                           SOURCE_TOO_LARGE          past 256 KiB
$document                           INVALID_NUMBER            .inf, .nan, 99999999999999999999999
```

Statically detected contradictions: a span both required and forbidden; two cardinality windows on
one selector that cannot both hold; an attribute constrained to a value its own allowlist excludes;
a self-referential ancestry rule; a retry budget whose per-tool allowance can never be reached.

The duplicate-key guard caught a real typo of mine while I was writing
`fixtures/contracts/approved-routes.yaml`, which is the most direct evidence it works.

## Adversarial coverage

Duplicate spans that agree; duplicate spans that contradict; cycles; broken parent references;
orphans; a root-only trace; partial traces; the same tool called from different services; the same
span name in different services; dynamic route identifiers normalised out of a span name; unknown
tools; unknown services; absent custom attributes; a malformed retry number (an object where a
number belongs); exact-boundary and excessive cardinality; multiple runs against one order ID; a
timed-out client span with no server span; a 100-span padded canary; and prototype-shaped names —
`toString`, `constructor`, `__proto__`, `valueOf`, `hasOwnProperty` — as span names, service names,
tool names, operation names, data domains, attribute keys and rule identifiers. A contract selecting
on an attribute literally named `toString` matches the span's real value and not
`Object.prototype.toString`.

## Known limitations

1. **Sibling temporal ordering is not expressible in P0.** In the real traces every step is a child
   of `refund.request`, so `fraud.check` is a sibling of `payment.refund`, not an ancestor. The demo
   emits no `explicit_predecessor` edges, and PRD section 11.3 forbids `inferred_time_order` from
   satisfying a critical causal rule — SL-044 leaves timestamps at millisecond resolution, which is
   exactly the scale at which sibling ordering would matter. `required_ancestry` is implemented in
   full and exercised on the real parent-child pairs the traces do contain. The exit gate does not
   need ordering: it requires the evaluator to catch **missing** fraud, **missing** policy and a
   **duplicated** refund.
2. **Release-scoped rules are deferred, not evaluated.** PRD section 11.11 assigns them to the
   aggregation after run results are stored, which is Phase 11. Each still contributes its measured
   sample.
3. **The aborted payment handler span remains unexported.** Unchanged from Phase 04 and Phase 06.
   Phase 07 gives it a correct evaluation outcome — `insufficient_evidence` with reason
   `unobservable_subtree` — rather than fixing the cause. Still a Phase 16 investigation item.
4. **`approved_routes` needs the approved families' canonical graphs to report similarity.** Without
   them it still decides exact identity and violates correctly, and says that similarity was
   unmeasurable rather than implying a number. Phase 08 supplies the graphs.
5. **Nothing is persisted.** The evaluator is deliberately storage-independent; PRD assigns
   persistence to Phase 09.
6. **Metrics and logs are still declared but not emitted.** Unchanged. Acceptance scope item 6
   remains `IN PROGRESS`.

## Mandatory phase report

```text
PHASE: 07 — Contract schema and deterministic evaluator
STATUS: PASS
BRANCH: phase/07-contract-engine
COMMITS: see docs/evidence/phase-07-commits.md
SOURCES VERIFIED: 4 new source-lock entries (SL-046 to SL-049), all tier 1 runtime:
  - live signoz_execute_builder_query dataType probes, 5 variants
  - installed yaml@2.9.0, 12 behaviours exercised directly
  - installed ajv@8.20.0, both entry points
  - installed V8 RegExp, cross-checked against the RE2 syntax reference
  Files: docs/research/source-lock.md, docs/adr/0006-contract-dsl-and-determinism-boundary.md
IMPLEMENTED:
  - packages/contract-schema: DSL types, published JSON Schema, RE2-compatible NFA matcher,
    safe YAML loading, static validation with exact paths, cross-rule contradiction detection,
    canonical serialisation, SHA-256 content hash, validation command
  - packages/contract-engine: Map-based graph indexes, six selector operators, all eleven rule
    types, evidence references, stable violation identity, PRD 11.11 evaluation order,
    canonical evaluation JSON and hash, evaluator versioning
  - contracts/demo-commerce/refund-agent/production/contract.yaml, 15 rules, all eleven types
  - 18 per-rule fixture contracts, span-row builder, scripts/validate-contracts.sh
  - 4 defects fixed, one of them in Phase 06 code with a runtime reproduction
TESTS RUN:
  make verify
  make signoz-verify
  make contract-validate
  make test
  make test-integration
  make demo-v1 / make demo-v2
TEST RESULT: 674 passed, 0 failed, 0 skipped (599 unit, 75 integration)
RUNTIME VALIDATION:
  - Both releases emitted, fetched from live SigNoz, evaluated against the committed contract
  - v1: pass, 13 rules passed, 2 deferred, 0 violations
  - v2: fail, 6 violations, 3 critical, 3 zero-tolerance, including the missing fraud check,
    the missing policy check and the duplicate refund
  - Duplicate-refund evidence names both live payment.refund span IDs
  - The aborted payment handler reports insufficient_evidence / unobservable_subtree, not a violation
  - A run-scoped token budget reports insufficient_evidence / metric_not_emitted on both live traces
  - The contract's committed route fingerprint equals a freshly computed one
  - Live evaluation completes in under 250 ms
EVIDENCE:
  docs/evidence/phase-07-plan.md
  docs/evidence/phase-07-result.md
  docs/research/source-lock.md (SL-046 to SL-049)
  docs/adr/0006-contract-dsl-and-determinism-boundary.md
  docs/ACCEPTANCE_MATRIX.md
  CHANGELOG.md
KNOWN LIMITATIONS: 6, listed above. None blocks the phase; items 2, 4 and 5 are PRD phase
  assignments, item 3 is carried from Phase 04, items 1 and 6 are evidence limitations of the demo
  that are recorded rather than worked around.
NEXT PHASE ENTRY CRITERIA: SATISFIED
```
