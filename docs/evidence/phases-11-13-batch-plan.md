# Batch plan — Phases 11, 12 and 13

Orchestration aid only. Each phase keeps its own plan, branch, evidence, commits, merge,
acceptance-matrix update, changelog entry, result block and handoff state. No code from a later
phase enters an earlier phase's branch.

Written: 2026-07-25. Baseline verified on `main` at `ee97de6` before this document was written.

---

## Verified entry state (independently reproduced, not copied)

| Command | Result |
|---|---|
| `git status --porcelain` | clean |
| `git rev-parse HEAD` | `ee97de6943577ca58a8a5abc35689acc8b0373e0` |
| reported Phase 10 commits `5f4de3e 3945df0 7a10eff e2e4192 ee97de6` | all present and reachable from `main` |
| phase/11, phase/12, phase/13 branches | absent — no partial implementation exists |
| `make verify` | exit 0 |
| `make signoz-verify` | exit 0 — SigNoz v0.134.0, MCP v0.9.0, collector v0.144.6, OTLP POST 200 |
| `make contract-validate` | exit 0 — 20 contract documents valid |
| `make test` | 961 passed, 0 failed, 0 skipped (44 files) |
| `make test-integration` | 209 passed, 0 failed, 0 skipped (13 files) |
| total | **1,170 passed** |
| `SL-053` … `SL-059` | present in `docs/research/source-lock.md` (59 entries total) |
| ADR-0009 | matches the implementation: pure compiler, register-based ownership, no `signoz_update_view`, material-field read-back |
| migrations | `0001` … `0004` applied |

The Phase 10 SigNoz integration suite (18 live tests) reran green as part of `make test-integration`.
It is the artefact-sync verification: it purges, creates all ten managed artefacts, verifies each by
read-back, re-syncs to prove zero duplicates, recreates a hand-deleted resource, restores a
hand-replaced one, reports an unowned name as a conflict, and proves the register survives an
application restart.

Because that suite ends by `drop schema public cascade`, the application database holds no demo
state at the start of Phase 11. Re-seeding it is Phase 11's first live task and is the reason
`scripts/seed-demo.sh` (PRD section 13, never written) is created in Phase 11.

---

## Dependencies between the three phases

```text
Phase 11  release aggregation + GET /api/releases/:releaseId/gate + apps/cli + release-gate.yml
             |
             |  Phase 12 needs no Phase 11 code, but the project overview and releases list
             |  render gate decisions, so Phase 11's route must exist first.
             v
Phase 12  apps/web shell, design tokens from design.md, every PRD section 8 route
             |
             |  Phase 13 replaces Phase 12's baseline and Contract Studio route bodies with
             |  the full interactive workflow. It never re-lays the shell.
             v
Phase 13  baseline capture workflow, route-family review, Contract Studio
```

Nothing in Phase 12 or 13 may weaken Phase 10's read-back rule, Phase 11's exit-code contract, or
the determinism boundary.

---

## Phase 11 — Release evaluation, CLI, and GitHub gate

Branch: `phase/11-release-gate`. PRD section: line 3239. Also FR-011, FR-012, PRD 10.5, 15.7, 19,
20.1, 12.3 (CLI boundary), 13 (`apps/cli`).

### Entry criteria

| Criterion | Evidence |
|---|---|
| Phase 10 merged and green | `7a10eff`; `make verify` exit 0 on `main` |
| Run evaluation proven live | Phase 10 live canary, persisted and retrievable |
| Violations resolve to trace evidence | `GET /api/violations/:id/evidence` |
| Contract carries a gate definition | `ContractGate`, parsed since Phase 07 |
| Job system runs five job types | `apps/worker` |
| `recordGateDecision` declared | `packages/telemetry` `METRIC_SPECS` |

### Scope

1. `packages/contract-engine/src/release.ts` — pure, deterministic release aggregation.
2. `packages/db` — `listReleaseRunRecords`, release-scoped evaluation lookup.
3. `GET /api/releases/:releaseId/gate` in `apps/api`.
4. `apps/cli` — six commands, JSON mode, exit-code contract.
5. `.github/workflows/release-gate.yml`.
6. `scripts/seed-demo.sh` and `make demo-full`, so the live gate is reproducible.
7. ADR-0010 recording the aggregation and exit-code judgement calls.

### Aggregation inputs (FR-011)

evaluated run count · passed and failed run count · violation rate · unknown route rate ·
duplicate side-effect rate · missing prerequisite rate · latency change from baseline ·
token change from baseline · retry change from baseline · gate decision.

### Gate thresholds (FR-012, PRD 10.5)

`minCompletedRuns` · `evaluationTimeoutSeconds` · `maxViolationPercent` ·
`maxUnknownRoutePercent` · `maxLatencyRegressionPercent` · `maxTokenRegressionPercent` ·
`zeroToleranceRuleIds`.

### Exit codes (FR-012, fixed by the PRD)

```text
0  pass
2  contract violation
3  insufficient data
4  integration or evaluation error
5  invalid configuration
```

### CLI commands (PRD Phase 11 task 5, verbatim)

```text
flightrules config verify
flightrules contract validate <path>
flightrules baseline capture
flightrules release evaluate
flightrules gate check
flightrules evidence export
```

### Tests

Unit: aggregation over zero runs, below minimum, all passing, one non-zero-tolerance violation,
one zero-tolerance violation, multiple severities, only deferred, mixed pass and insufficient,
stale window, truncated retrieval, superseded contract, duplicate evaluation records, repeated
aggregation byte-equality, exit-code mapping for every outcome, JSON schema, redaction.

Integration (db): gate route over persisted evaluations, restarted API serving the same gate,
concurrent aggregation, changed active contract.

Integration (SigNoz): the live exit gate below.

### Live exit gate

fresh known-good runs → evaluate → aggregate → gate passes (exit 0) → unsafe canary → evaluate →
aggregate → gate fails (exit 2) → API route returns the matching decision → the
GitHub-Actions-compatible command produces the same result → trace and violation identifiers
preserved in evidence.

### Evidence

`docs/evidence/phase-11-plan.md`, `phase-11-result.md`, `phase-11-commits.md`,
`docs/evidence/phase-11/` (live state, CLI inventory, gate JSON), `docs/adr/0010-*.md`.

### Deployment and video impact

Adds the failing-gate moment of the recording and `make demo-full`. Adds `make gate` /
`flightrules gate check` to the command sheet.

---

## Phase 12 — UI foundation and `design.md` integration

Branch: `phase/12-ui-foundation`. PRD section: line 3283. Also PRD section 8 in full, 12.3 (Web),
20.3, 20.4, 22.4.

### Entry criteria (PRD)

- `design.md` exists — present at the repository root, 18 581 bytes
- design assets referenced by it are present — verified before implementation
- product API is stable enough for UI work — Phase 09 + Phase 11 routes, OpenAPI generated

### Scope (PRD tasks 1–10)

1. Parse `design.md`; write `docs/adr/0011-design-token-mapping.md`.
2. Design tokens from the supplied values only.
3. Asset loading and validation; a missing asset fails the build or raises an explicit
   development error.
4. `packages/ui` — app shell, navigation, page headers, tables, cards, forms, dialogs, toasts,
   skeletons, empty states.
5. `apps/web` — every route in PRD section 8:
   `/`, `/setup`, `/projects`, `/projects/[projectId]/overview`,
   `/projects/[projectId]/agents`, `/projects/[projectId]/agents/[agentId]`,
   `/projects/[projectId]/agents/[agentId]/baselines/new`,
   `/projects/[projectId]/agents/[agentId]/routes/[routeFamilyId]`,
   `/projects/[projectId]/agents/[agentId]/contracts/[contractId]`,
   `/projects/[projectId]/agents/[agentId]/releases`,
   `/projects/[projectId]/agents/[agentId]/releases/[releaseId]`,
   `/projects/[projectId]/violations/[violationId]`,
   `/projects/[projectId]/integrations/signoz`, `/demo`.
6. Responsive layout.
7. Accessible focus, keyboard and screen-reader behaviour.
8. Graph table fallback.
9. Stable test selectors.
10. Loading, empty, error, degraded and success states.

### Constraints

No generic bento grid, no invented gradients or glassmorphism, no fake metrics, no fake trace
graphs in authenticated routes, UI copy from the PRD only. No direct SigNoz credentials or MCP
calls from the browser (PRD 12.3).

### Tests

Route smoke tests, accessibility scan, keyboard navigation, responsive rendering, missing-asset
failure, no undefined colour or font token, every displayed metric traced to API data.

### Exit gate

The full route shell matches `design.md`, keeps the PRD's content hierarchy, and has no
placeholder copy.

### Deployment and video impact

Adds `make web` and the browser walk-through that carries most of the recording.

---

## Phase 13 — Baseline and Contract Studio UI

Branch: `phase/13-contract-studio`. PRD section: line 3331. Also PRD 8.7, 8.8, 8.9, FR-007,
FR-008, FR-009, FR-018, FR-019.

### Entry criteria

Phase 12 merged and `main` green; the baseline, route-family, contract and job APIs of Phase 09
and the sync API of Phase 10 all reachable from the web application.

### Scope (PRD tasks 1–11)

baseline selection form · job progress UI · rejected-trace summary · route-family list ·
canonical route graph · approve and exclude actions · proposed-rule review · YAML editor with
schema errors · graph-based rule controls · contract validation, approval, activation, export and
SigNoz sync flows · activation blocked for invalid or unsaved changes.

### Tests

End-to-end baseline capture from seeded traces · route approval persists · exclusion records an
audit event · invalid YAML cannot be approved · a graph rule edit changes the YAML predictably ·
a YAML edit changes the graph rule state predictably · contract activation triggers artifact sync ·
reload preserves state.

### Exit gate

A new user can move from v1 traces to an active contract entirely through the UI.

### Deployment and video impact

Completes the demo narrative: capture a baseline, review route families, approve a contract,
activate it, sync SigNoz — all in the browser — then fail the canary at the gate.

---

## Shared rules for all three phases

- No placeholder route, hard-coded pass, fabricated trace, seeded SigNoz table, fake alert
  history, edited job result, skipped test or weakened threshold.
- Every external input and output validated at runtime: CLI arguments, environment, API request
  and response, database record, MCP result, workflow input, persisted JSON.
- No credential, API key, authorization header, raw prompt, chain-of-thought, tool argument, tool
  result, raw MCP payload or internal stack trace in any output. Redaction tests accompany every
  new output surface.
- Per phase: unit tests, database integration tests, SigNoz integration tests, API or CLI
  integration tests, all previous regressions, the full verification target, exact counts reported.
