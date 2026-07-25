# ADR-0010 — Release aggregation, the gate decision, and the exit-code contract

- Status: accepted
- Date: 2026-07-25
- Phase: 11
- Extends: ADR-0006 (contract DSL and determinism boundary), ADR-0008 (persistence and jobs)

## Context

PRD FR-011 requires a release evaluation that aggregates completed run evaluations; FR-012 requires
a gate over that aggregation with five fixed exit codes; PRD section 11.11 requires release-scoped
rules to be decided "after run-level results are stored"; and PRD section 20.1 requires that the
gate "never returns pass after an internal error".

The decision has to be reproducible from persisted evidence alone. A CI system will act on it, a
reviewer will be shown it days later, and an evidence file will be attached to a pull request.

## Decisions

### 1. Aggregation is pure; the route that serves it is a read

`aggregateRelease` in `packages/contract-engine` performs no I/O and reads no clock. `nowMs`, the
aggregation window, the retrieval state and the contract's lifecycle status all arrive as inputs,
exactly as `evaluateRun` already takes its clock.

`GET /api/releases/:releaseId/gate` runs no job, fetches no trace and writes no row. It loads the
release's newest completed evaluation and hands the stored evidence to the aggregation.

Two consequences are tested rather than asserted: the route is idempotent apart from
`retrievedAt`, and a restarted API over the same database returns the identical `decisionHash`.

### 2. Decision precedence is `error > fail > insufficient_data > pass`

`error` first, because an evaluation that could not complete leaves the violation counts incomplete
and a pass would be the false green PRD section 20.1 forbids.

`fail` before `insufficient_data` is the load-bearing choice. A proven zero-tolerance violation in
three runs is stronger evidence than the absence of a twentieth run; reporting "insufficient data"
there would downgrade the exact finding the product exists to surface. The live canary demonstrates
it: eight runs against a minimum of twenty produce both `MIN_RUNS_NOT_MET` and
`ZERO_TOLERANCE_VIOLATION`, and the decision is `fail`, exit `2`.

### 3. A check whose evidence is structurally absent is disclosed, not passed and not failed

A release-scoped budget that **no run of the release reports at all** is `not_measured` and appears
in `disclosures`. A budget that **some but not all** runs report is `insufficient_evidence` and
makes the release `insufficient_data`.

The distinction matters because the demo agent makes no model call, so no span carries
`gen_ai.usage.*`. Without it, a token budget would make every release undecidable and the gate
would be useless; with a naive "no samples means pass", a contract could be satisfied by an agent
that simply stopped emitting the metric. Disclosing is the third answer, and it is the same one the
baseline miner already gives with `BUDGET_NOT_PROPOSED` and the Phase 10 dashboard gives with its
honest empty token panel.

### 4. Rates are exact fractions; thresholds are compared without division

Every rate carries its numerator, its denominator and two six-decimal renderings produced by integer
division. A threshold comparison is a cross-multiplication against the author's decimal held as an
exact fraction, never a floating-point division — the same rule Phase 07 applied to
`minSimilarity`, for the same reason: a release decision must not depend on how a double rounds.

`maxViolationPercent: 0.5` therefore means "0.5 per cent of evaluated runs may fail", and one
failing run in exactly two hundred is *not* over it.

### 5. The violation rate counts failing runs, not violations

FR-011 lists "passed and failed run count" and then "violation rate", so the rate is over runs.
Counting violations instead would make a single run with forty findings look worse than forty runs
with one each, which inverts the signal a canary gate needs.

Total violations, critical violations, zero-tolerance violations and a per-severity breakdown are
all reported separately.

### 6. Regression is measured against approved families only, count-weighted

The baseline reference is built from the route families a reviewer **approved** on the contract's
baseline version. A rejected or fixture-excluded family is not sanctioned behaviour, so measuring
drift against it would compare the release to something nobody approved.

Each family carries its own percentile, so the baseline figure is the count-weighted mean of the
family percentiles, truncated to an integer. The maximum would understate every regression; the
unweighted mean would let a family seen twice outvote one seen a hundred times.

When there is no approved baseline, every change is `measured: false` and `BASELINE_UNAVAILABLE` is
disclosed. Nothing is assumed to be zero.

### 7. Retries come from the stored canonical graph, not from a new evaluator field

FR-011 wants "retry change from baseline". `MetricSample` covers duration and tokens only, and
extending it would change every stored evaluation's hash and break the Phase 07 determinism
goldens. `retryCountOf` reads `retryNumber` from the persisted canonical graph instead — the same
evidence, no change to completed-phase output.

`retryNumber` is an *attempt index*: `0` is the first attempt. The run's retry count is the sum of
the positive indices, so counting spans that carry the attribute would report every first attempt as
a retry.

### 8. The exit-code table lives in the engine, not the CLI

`EXIT_CODES` and `exitCodeForDecision` are exported from `packages/contract-engine`, so the API, the
CLI, the workflow and the tests all derive the same number from the same decision. The CLI asserts
that the server's `exitCode` field agrees with its own mapping and refuses to report a decision when
they disagree — a schema drift that silently changed a pipeline's result would otherwise be
invisible.

`1` is reserved for an unclassified crash, which is what Node returns for an uncaught exception. A
test asserts no classified path returns it, and that no error code maps to `0`.

### 9. `release evaluate` exits `0` for a completed evaluation that found violations

Deciding is `gate check`'s job. Conflating the two would make "the evaluation ran" and "the release
is safe" the same exit code, and a pipeline that ran `release evaluate` alone would report green on
a canary that skipped every check.

### 10. The workflow asserts exit code `2` specifically, not merely non-zero

`.github/workflows/release-gate.yml` inverts the canary step deliberately and checks the exact code.
A `0` would mean the product's central claim is false; any other non-zero code would mean it failed
for the wrong reason. Both fail the job. The evidence upload runs `if: always()` and cannot change
the result, because the gate steps have already decided it.

## Consequences

- A gate decision can be recomputed from the database alone, so an evidence file is replayable.
- A release cannot pass on truncated retrieval, a stale window, an incomplete evaluation, a
  superseded contract, or run results produced against a different contract version.
- A contract whose only failing check is one nobody can measure passes, and says so in writing.
- Adding a metric the gate can measure means adding a `MetricSample` producer, not a new column.

## Defect found while implementing this

The domain redactor's `/token/i` pattern matched `maxTokenRegressionPercent` and `tokens`, so the
live gate returned `"maxTokenRegressionPercent": "[redacted]"` — a security control silently
destroying part of a release decision. "token" is both a credential noun and this product's unit of
LLM usage. The fix is an exact-name allowlist of the measurement keys FlightRules itself emits,
rather than a looser pattern that would also admit `access_tokens`. Tests assert that
credential-shaped keys still redact.
