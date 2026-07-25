# ADR-0006 — Contract DSL, evaluator determinism, and the insufficient-evidence boundary

- Status: Accepted
- Date: 2026-07-25
- Phase: 07
- Supersedes: none
- Related: ADR-0001 (stack and version policy), ADR-0004 (telemetry attribute conventions)

## Context

PRD section 10 defines a versioned YAML contract DSL with eleven rule types. PRD section 11.12
requires byte-equivalent canonical evaluation output for the same graph, contract, normaliser
version and evaluator version. The operating contract's determinism boundary forbids an LLM from
deciding whether a rule passed, and forbids treating missing evidence as proof of absence.

Contract documents are semi-trusted: one can arrive in a pull request. Telemetry is untrusted:
span names, service names, tool names and attribute keys all come from instrumented code
FlightRules does not own.

## Decisions

### 1. Two packages, split by what they need

`packages/contract-schema` holds the DSL: types, the published JSON Schema, safe YAML loading,
validation, canonical serialisation, the content hash and the validation command. It depends on no
graph, no database and no SigNoz, because `flightrules contract validate` must run in a CI job that
has none of those.

`packages/contract-engine` holds the run evaluator. It takes a `TraceGraph` and a validated
contract and returns a result; it never reads or writes storage, because persistence is Phase 09.

### 2. Unknown fields are rejected, never dropped

A contract that says `cardinaltiy:` must fail validation. Silently ignoring the typo would leave the
author believing a bound was enforced when no rule constrains anything — the worst possible failure
mode for a safety contract, because it is invisible and it reads as a pass.

### 3. Validation returns a sorted list of `{path, code, message}`

Not a thrown exception, and not prose. An invalid contract is the *expected* answer to "is this
contract valid": the command prints every error, the API returns them as a field list, and Contract
Studio shows them beside the editor. All three need the exact path. Errors are sorted so two runs
over one document produce byte-identical output.

### 4. The `matches` operator is a Thompson NFA, not a JavaScript `RegExp`

PRD section 10.3 requires RE2 compatibility or a package with denial-of-service protection.

A static screen for "nested quantifiers" is insufficient — `(a|a)*b` has no nested quantifier and
still backtracks catastrophically. A native RE2 binding would add a compiled dependency for one
operator.

So `packages/contract-schema/src/regex.ts` compiles an RE2-compatible subset to a Thompson NFA and
simulates it over a set of states, advancing once per input character. Matching is O(pattern × input)
by construction; there is no backtracking to trigger. Backreferences and lookaround are absent, as
in RE2 — they are exactly the features that make linear-time simulation impossible. A 2,000-run
property test asserts agreement with `RegExp` across the supported subset, so "RE2-compatible" is
tested rather than asserted. The one deliberate divergence is recorded as SL-049.

### 5. YAML safety is enforced by walking the document, not by parser options

`yaml@2.9.0` resolves `!!binary` to a `Buffer` and `!!timestamp` to a `Date` with **no error and no
warning**, and `customTags: []` does not prevent it (SL-047). So the defence cannot be an option or
a diagnostic check. `loadContractDocument` rejects any node carrying an explicit tag, an anchor or an
alias, bounds nesting depth before the parser's own stack limit is reached, and audits the converted
value for non-plain prototypes and unsafe numerics.

Anchors and aliases are refused outright rather than bounded. A contract has no legitimate use for
one, and "none" is more auditable than "not too many".

### 6. Thresholds are exact rationals, never floating point

`minSimilarity: 0.92` in YAML becomes the nearest binary double, which is not 92/100. Comparing a
similarity ratio against it would make a release decision depend on rounding.

`Number.prototype.toString` returns the shortest decimal that round-trips — a behaviour the language
specifies — so it recovers the digits the author wrote. Those become an integer numerator and a
power-of-ten denominator, and the evaluator compares by cross-multiplication. The similarity score
itself is carried as a numerator, a denominator and a fixed-precision decimal **string**. A test
asserts that no non-integer number appears anywhere in the canonical evaluation output.

### 7. A similarity score never decides pass or fail

`approved_routes` passes only on an exact fingerprint match. `minSimilarity` classifies the
failure — `ROUTE_DRIFTED` for a changed member of a known family, `ROUTE_NOT_APPROVED` for a
materially different route — but both are violations. Putting a fuzzy threshold on the critical path
is precisely what the determinism boundary excludes.

### 8. Insufficient evidence is scoped structurally and locally

This is the decision with the most consequence, so it is stated precisely.

- Trace quality `inconsistent` — duplicate records that contradict each other — means **no rule is
  evaluated at all**. Choosing between two conflicting accounts of one span is a guess.
- Trace quality `incomplete` — orphans, a synthetic root, a span-limit truncation — means an
  **absence claim** cannot be sound, so absence-based rules report insufficient evidence.
- A `client_span_without_server_span` warning marks **one span's** subtree as unobservable. Only
  rules anchored on that span are undecidable.
- An orphan's ancestry is unknown, so a missing required ancestor proves nothing. A span that is
  merely *parentless* has known, empty ancestry — a step running under a second root really did run
  outside the required workflow.
- For `attribute_constraint`, absence is handled per operator: `exists` → violation, `equals`/`in`/
  `matches` → insufficient evidence, `not_equals`/`not_in` → pass.
- Within one rule, a **proven violation outranks an undecidable case**.

The scoping has to be local, not global. The canary trace carries a
`client_span_without_server_span` warning for its aborted first payment attempt. A global rule would
turn the genuinely missing fraud check into "insufficient evidence" and destroy the release gate.
The local rule keeps the missing fraud check a proven violation while the rule that actually needs
the unexported span reports insufficient evidence.

### 9. A rule that could not be decided does not pass the run

Any violation fails the run. Otherwise an undecidable rule makes the run `insufficient_data`, not a
pass. A contract that could not be checked has not been satisfied.

SL-046 is the concrete justification. A boolean tag requested without its `dataType` returns `null`
with no error, so an entire attribute silently vanishes from a successful query. A rule that
defaulted absence to a pass would have reported a green release built on a query that returned
nothing. The evaluator reported insufficient evidence instead, which is how the defect was found.

### 10. Every index is a `Map`, and normalised attribute records have no prototype

Span names, service names, tool names and attribute keys are telemetry-derived. A plain object keyed
by them lets a span called `toString` resolve through `Object.prototype`.

Phase 06 had already hardened its alias lookup after a span named `toString` crashed the tokeniser.
Phase 07 found the remaining instance with a runtime reproduction: a span attribute key `__proto__`
carrying an array value **replaced the prototype** of the normalised attribute record, after which
`record.length` and `record[0]` returned values no span ever emitted. The records are now built with
`Object.create(null)`, and the attribute is preserved as ordinary data. The evaluator reads through
`Object.hasOwn` regardless, so the defence holds at both ends.

### 11. Canonicalisation sorts its own input

`canonicalContract` sorts rules, approved routes and zero-tolerance identifiers itself, even though
validation already does. A canonical form that depended on its caller having tidied the input would
hash one policy two ways depending on which producer built it — and Phase 08's proposal generator
and Phase 09's database rows are both producers that do not go through the YAML validator. That
failure would look like a policy change and force a spurious re-approval.

### 12. Canonical ordering has exactly one implementation

The evaluator attaches evidence by canonical node index, but `CanonicalGraph` carries no span IDs by
design — the fingerprint must not depend on identifiers. Rather than reimplement the sibling ordering
in the engine, Phase 07 exposes `canonicalOrdering` from `@flightrules/trace-graph` and both callers
share it. Two copies of that traversal would agree until one of them was changed, and then attach
evidence to the wrong node.

### 13. Runtime metadata is excluded structurally, not by convention

`completedAt` and `durationMs` live in an `EvaluationRuntime` object that the canonical serialiser
cannot reach. PRD section 11.12 excludes them from byte-equivalence; making the exclusion structural
means there is no way to hash them by accident.

The trace identifier **is** inside the canonical region. Two runs of one route are two different
runs, and an evaluation is a statement about one of them. Excluding it would make two distinct
evaluations hash identically. Route-level stability is proven separately by the fingerprint, which
excludes identifiers by design.

### 14. Violation identifiers are derived from canonical evidence, not span IDs

A violation's identifier hashes the rule, the code, the canonical node positions and the canonical
labels — deliberately not the span IDs, the summary or the observed value. So the same structural
finding in two runs of one route carries the same identifier and can be reported as recurring, while
two different findings from one rule stay distinct. A property test asserts uniqueness within one
evaluation; a unit test asserts stability across two runs with entirely different identifiers.

## Consequences

- A contract can be validated in CI with no database, no SigNoz and no graph.
- The evaluator is storage-independent, so Phase 09 can persist results without changing it.
- Release-scoped rules are `deferred` at run scope and still contribute their measured samples, so
  Phase 11 aggregates rather than re-reading every trace.
- The published JSON Schema is structural only and is kept honest by a parity test. A document it
  accepts may still be rejected by the validator, and the schema says so.
- Sibling temporal ordering is not expressible in P0. The demo emits no explicit predecessor edges,
  and PRD section 11.3 forbids `inferred_time_order` from satisfying a critical causal rule. The
  exit gate does not need it: it requires the evaluator to catch **missing** fraud, **missing**
  policy and a **duplicated** refund, which presence and cardinality decide from evidence that
  exists.

## Alternatives rejected

| Alternative | Why not |
|---|---|
| `js-yaml` | No alias-count bound, so no amplification protection. |
| Native `re2` binding | A compiled dependency for one operator, and a build step on every platform. |
| Static ReDoS screening plus `RegExp` | Incomplete: alternation ambiguity backtracks with no nested quantifier. |
| `ajv` as the authoritative validator | Cannot express FR-009's cross-field checks, and its JSON Pointer paths are less precise than the DSL's own. |
| One package for schema and engine | Forces the CI validation path to depend on the graph layer. |
| Global insufficient-evidence scoping | Destroys the release gate: the canary's aborted payment span would suppress its missing fraud check. |
| Absence defaults to a pass | An uninstrumented service would satisfy a critical safety rule by saying nothing. SL-046 shows this is reachable from a query defect, not just from bad instrumentation. |
| Similarity threshold decides pass or fail | Puts a fuzzy score on the critical path, against the determinism boundary. |
