# Phase 11 plan — Release evaluation, CLI, and GitHub gate

Branch: `phase/11-release-gate`. Base: `a48f261` on `main`.

PRD sections read in full before writing anything: Phase 11 (line 3239), FR-011, FR-012,
10.5 (gate definition), 11.11 (evaluation order), 12.3 (CLI boundary), 13 (repository structure),
15.7 (evaluations and releases), 19 (error model), 20.1 (reliability), 22 (test strategy).

## Objective

Turn canary telemetry into a machine-enforceable release decision. The exit gate: **a release
pipeline can fail because of trajectory evidence from SigNoz.**

## What already exists

- Run evaluation, its canonical result and its stable violation identities (Phase 07).
- `MetricSample`, declared in Phase 07 "for release-level aggregation in Phase 11", and already
  produced by every `numeric_budget` rule, including the release-scoped ones that defer.
- `ContractGate`, parsed and validated since Phase 07, carrying every PRD 10.5 threshold as an
  exact rational.
- Persisted evaluations, run evaluations, violations, releases and trace runs (Phase 09).
- `recordGateDecision` on `FlightRulesMetrics` and `SPAN_NAMES.releaseGate`, both declared and
  never called.

## What Phase 11 adds

### 1. `packages/contract-engine/src/release.ts` — pure aggregation

`aggregateRelease(input): ReleaseEvaluation`. No I/O, no clock read: the caller supplies
`nowMs` and the aggregation window, exactly as `evaluateRun` already does. Byte-identical output
for identical input, proven by a repeated-aggregation test and a key-order property.

Inputs:

| Field | Source |
|---|---|
| `contract` | the active contract document |
| `runs` | persisted `RunEvaluation` values plus `durationMs` and `retryCount` from persisted evidence |
| `baseline` | approved route-family statistics of the contract's baseline version, or `null` |
| `retrieval` | whether trace retrieval was complete or truncated |
| `window`, `nowMs`, `freshnessSeconds` | staleness and timeout |
| `contractState` | `active` or `superseded`, so a stale contract cannot silently gate |

Outputs (FR-011): evaluated run count, passed and failed run count, violation rate, unknown route
rate, duplicate side-effect rate, missing prerequisite rate, latency change from baseline, token
change from baseline, retry change from baseline, and the gate decision.

Every rate is an exact rational (numerator, denominator, six-decimal string), the same shape
`SimilarityScore` already uses, so a displayed percentage can never drift from its counts.

### 2. Deferred release-scoped rules are resolved here

PRD 11.11: "Release-level numeric budgets are evaluated after run-level results are stored."
Release-scoped `numeric_budget` and `cardinality` rules deferred at run scope are decided from the
samples every run already contributed.

A release-scoped budget whose metric **no run of the release reports at all** is `not_measured`,
listed in the response's disclosures, and does not become a pass. A budget whose metric **some but
not all** runs report is `insufficient_evidence` and makes the release `insufficient_data`. The
distinction is the same one the baseline miner already draws with `BUDGET_NOT_PROPOSED` and the
Phase 10 dashboard draws with panel 8's honest empty series.

### 3. Decision precedence, fixed and tested

```text
error > fail > insufficient_data > pass
```

`error` first because an evaluation that could not complete leaves the violation counts incomplete,
and PRD 20.1 forbids a pass after an internal error. `fail` before `insufficient_data` because a
proven zero-tolerance violation in three runs is stronger evidence than the absence of a twentieth
run, and reporting `insufficient_data` there would be the silent downgrade the operating contract
forbids.

### 4. `GET /api/releases/:releaseId/gate`

Reads the most recent completed release-scoped evaluation for the release, aggregates it and
returns the decision, its findings, its measurements and its evidence references. Idempotent:
repeated calls over unchanged data return the identical body apart from `retrievedAt`. Never
returns a raw database row or a raw MCP payload. Emits `flight_rules.release_gate` and
`flight_rules.release_gate.decisions`.

### 5. `apps/cli` — six commands

```text
flightrules config verify
flightrules contract validate <path>
flightrules baseline capture
flightrules release evaluate
flightrules gate check
flightrules evidence export
```

Human output on stdout by default, `--json` for a stable machine-readable document, diagnostics on
stderr. No spinner, no colour by default, no dynamic decoration. `process.stdout.write`, because
Biome forbids `console.*` except `error` and `warn`.

### 6. Exit codes

```text
0  pass
2  contract violation
3  insufficient data
4  integration or evaluation error
5  invalid configuration
```

One table, exported from the CLI, asserted by a test that maps every `ErrorCode` and every gate
decision to its code, and documented in the README and the runbook. `1` is reserved for an
unhandled crash the process did not classify; a test asserts no code path returns `0` for anything
but `pass`.

### 7. `.github/workflows/release-gate.yml`

Clean checkout, pinned Node and pnpm, `pnpm install --frozen-lockfile`, PostgreSQL service,
migrations, API and worker started from the built output, seeded demo runs, evaluation, then
`flightrules gate check --json`. The step fails with the CLI's own exit code. The gate document is
uploaded as an artifact on failure and summarised into `$GITHUB_STEP_SUMMARY`. No secret is echoed;
a redaction test covers the summary writer. The same command is reproducible locally through
`make gate`.

### 8. `scripts/seed-demo.sh` and `make demo-full`

PRD section 13 names `scripts/seed-demo.sh`; it was never written. The Phase 11 live exit gate
needs a reproducible path from an empty database to an active contract, so it is written here:
project, agent, baseline mining from live v1 telemetry, contract proposal, approval, activation and
SigNoz sync, each through the real API. It fabricates nothing.

## Tests

### Unit

- zero runs; below minimum sample count; all passing
- one non-zero-tolerance violation; one zero-tolerance violation; multiple severities
- only deferred evaluations; mixed pass and insufficient evidence
- stale aggregation; truncated retrieval; superseded contract; changed active contract
- duplicate evaluation records; repeated aggregation is byte-identical
- every rate against hand-computed rationals
- release-scoped budget resolved, not measured, and partially measured
- latency, token and retry change with and without a baseline
- exit code for every decision and every error code
- JSON output validates against its declared schema
- no output carries a credential, a header, a raw payload or a stack trace

### Integration — database

- the gate route over persisted evaluations
- a restarted API serves the same gate decision
- concurrent aggregation of one release
- a superseded contract is refused
- pagination and filtering on the evaluations the gate reads

### Integration — SigNoz (the live exit gate)

1. emit fresh known-good `refund-agent-v1` runs
2. evaluate them against the active contract
3. aggregate the release; prove the gate passes and the CLI exits `0`
4. emit the unsafe `refund-agent-v2` canary
5. evaluate it
6. aggregate again; prove the gate fails and the CLI exits `2`
7. prove `GET /api/releases/:releaseId/gate` returns the matching decision
8. prove the GitHub-Actions-compatible command produces the same result
9. preserve representative trace and violation identifiers in the evidence file

## Files

```text
packages/contract-engine/src/release.ts             new
packages/contract-engine/src/release.test.ts        new
packages/contract-engine/src/release-decision.ts    new
packages/db/src/repositories/releases.ts            extended
apps/api/src/routes/gate.ts                         new
apps/cli/**                                         new
.github/workflows/release-gate.yml                  new
scripts/seed-demo.sh                                new
Makefile                                            demo-full, gate, cli targets
docs/adr/0010-release-aggregation-and-exit-codes.md new
```

## Out of scope

`GET /api/releases/:releaseId/diff` (Phase 14), any UI (Phases 12–15), alert recovery evidence
(Phase 16), OTLP log export (Phase 16).
