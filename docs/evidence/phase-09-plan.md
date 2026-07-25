# Phase 09 plan — Application core, API, jobs, and persistence

Branch: `phase/09-application-core`
Date: 2026-07-25
PRD section: line 3164, together with section 12.3 (application boundaries), section 14 (data model),
section 15 (API surface), section 17 (telemetry), section 18 (security), section 19 (error model),
section 20.1 (reliability), and FR-001, FR-002, FR-007, FR-010, FR-016, FR-017, FR-018, FR-019,
FR-020.

## Entry criteria — verified before this branch was created

| Criterion | How it was verified | Result |
|---|---|---|
| Phase 08 merged and `main` green | `git log`, working tree clean at `34bf0f8` | PASS |
| `make verify` | run on `main` | exit 0 — 862 unit tests, 38 files, 20 contract documents valid |
| `make signoz-verify` | run against the live stack | exit 0 |
| `DEMO_RUNS=25 make demo-v1`, `make demo-v2` | run against the live stack | exit 0 |
| `make test-integration` | run against live PostgreSQL and SigNoz | exit 0 — 91 tests, 6 files |
| `make mine-demo-baseline` | fresh live mining run | exit 0 — 53 eligible v1 runs, 1 family at `43070aa4…`, repeated mining byte-identical, generated contract accepted by the Phase 07 validator, fresh v1 pass with 0 violations, canary fail with 10 violations and 3 critical zero-tolerance findings |
| ADR-0007 matches the implementation | read against `packages/baseline-miner` | PASS |
| SL-050, SL-051 present and specific | `docs/research/source-lock.md` | PASS |
| Acceptance matrix reflects Phases 00–08 | read | PASS |
| No Phase 09 branch or partial implementation | `git branch -a` | PASS |

Total on entry: **953 tests** (862 unit + 91 integration), 0 failed, 0 skipped.

## Objective

Expose stable product APIs and persist the full lifecycle, so that **all product state survives
process restarts and can be driven without the UI**.

## Architecture boundary

```text
apps/api        HTTP transport, request validation, error envelope, request IDs, audit writes
apps/worker     job claiming, lease renewal, job execution, progress events, result commit
packages/db     migrations, connection lifecycle, repositories, canonical row mapping
packages/*      deterministic domain logic (unchanged by this phase)
```

Rules held for the whole phase:

- A domain package never imports a Fastify request, a `postgres` tagged template, or a raw MCP
  payload. The direction is always application -> package.
- No deterministic algorithm is reimplemented inside an application. `mineBaseline`,
  `proposeContract`, `evaluateRun`, `parseContract`, `canonicalContract` and `buildTraceGraph` are
  called, never copied.
- Every value crossing a boundary is validated by a runtime schema (`zod` for HTTP, explicit row
  decoders for SQL, the existing MCP schemas for SigNoz).
- Every jsonb payload is written through one canonical serialiser so a stored hash is reproducible
  and never depends on database key ordering.

## The sixteen tables

Three exist already (migration `0001`). Thirteen are added by migration `0003`. Migrations `0001`
and `0002` are never edited.

| # | Table | PRD | Migration | Purpose | Key | Lifecycle column |
|---|---|---|---|---|---|---|
| 1 | `projects` | 14.1 | 0001 | FR-001 project record | `slug` unique | — |
| 2 | `signoz_connections` | 14.2 | 0001 | connection profile, capability snapshot | `name` unique | `status` |
| 3 | `audit_events` | 14.16 | 0001 | FR-019 audit history | append-only | — |
| 4 | `agents` | 14.3 | 0003 | FR-002 agent registration | `(project_id, agent_key)` unique | — |
| 5 | `releases` | 14.4 | 0003 | observed release identity | `(agent_id, release_key, environment)` unique | — |
| 6 | `trace_runs` | 14.5 | 0003 | one observed run | `(agent_id, trace_id)` unique | `status`, `quality_status` |
| 7 | `trace_graphs` | 14.6 | 0003 | canonical graph and fingerprint | `(trace_run_id, normaliser_version)` unique | — |
| 8 | `baseline_versions` | 14.7 | 0003 | FR-007 mined baseline | `(agent_id, selection_hash)` unique | `status` |
| 9 | `route_families` | 14.8 | 0003 | mined family plus review decision | `(baseline_version_id, fingerprint)` unique | `status` |
| 10 | `contracts` | 14.9 | 0003 | FR-018 contract lifecycle | one `active` per `(agent_id, environment)` | `status` |
| 11 | `contract_rules` | 14.10 | 0003 | per-rule projection with evidence basis | `(contract_id, rule_key)` unique | — |
| 12 | `evaluations` | 14.11 | 0003 | FR-010/FR-011 evaluation header | `(contract_id, release_id, scope, idempotency_key)` unique | `status` |
| 13 | `run_evaluations` | 14.12 | 0003 | per-run result | `(evaluation_id, trace_run_id)` unique | `status` |
| 14 | `violations` | 14.13 | 0003 | FR-017 typed violation and evidence | `(run_evaluation_id, violation_key)` unique | — |
| 15 | `signoz_artifacts` | 14.14 | 0003 | managed SigNoz resource register | `(project_id, managed_name)` unique | `status` |
| 16 | `jobs` | 14.15 | 0003 | job identity, idempotency, lease, progress | `(job_type, idempotency_key)` unique | `status` |

No seventeenth table is created. Progress events live on the `jobs` row as an append-only
`progress_json` array guarded by a monotonic `progress_index`, because PRD section 14 fixes the P0
table set at sixteen and section 15.10 requires only that the events be retrievable per job.

## The two applications

| | `apps/api` | `apps/worker` |
|---|---|---|
| PRD | 12.3 "API" | 12.3 "Worker" |
| Entrypoint | `apps/api/src/index.ts` | `apps/worker/src/index.ts` |
| Local command | `pnpm --filter @flightrules/api dev` | `pnpm --filter @flightrules/worker dev` |
| Production command | `node dist/index.js` | `node dist/index.js` |
| Config boundary | one validated `ApiConfig` from `@flightrules/config` | one validated `WorkerConfig` |
| Health | `GET /health/live` | process liveness through the lease heartbeat |
| Readiness | `GET /health/ready` — database reachable **and** every migration applied | claims no work until the schema check passes |
| Dependencies | `GET /health/dependencies` — database and SigNoz, SigNoz degraded never fails readiness | SigNoz required only for the job types that need it |
| Shutdown | stop accepting, drain in-flight requests, close the pool, bounded timeout | stop claiming, finish or release the current lease, bounded timeout |
| Logging | structured JSON, request id, redacted | structured JSON, job id, redacted |
| Telemetry | `flight_rules.*` spans and metrics through `@flightrules/telemetry` | same |

Neither application runs migrations at startup. `make db-migrate` owns that, and the API refuses
readiness against a schema older than the one it was built for.

## API inventory

`✔` implemented in Phase 09. `→ NN` deferred to the phase the PRD assigns the capability to; the
route is not registered until then, so a caller receives `404` rather than a false success.

| Method | Route | Phase | Effect | Audit event |
|---|---|---|---|---|
| GET | `/health/live` | ✔ | process liveness | — |
| GET | `/health/ready` | ✔ | database + schema version | — |
| GET | `/health/dependencies` | ✔ | database, SigNoz | — |
| POST | `/api/setup/signoz/verify` | ✔ | connect, discover capabilities, store snapshot | `signoz.connection.verified` |
| GET | `/api/setup/signoz/capabilities` | ✔ | stored capability snapshot | — |
| POST | `/api/setup/signoz/discover-fields` | ✔ | live field catalogue | — |
| GET | `/api/setup/signoz/artifacts` | ✔ | managed artefact register | — |
| POST | `/api/setup/signoz/sync-artifacts` | → 10 | artefact compilation | — |
| GET | `/api/projects` | ✔ | cursor list | — |
| POST | `/api/projects` | ✔ | FR-001 create | `project.created` |
| GET | `/api/projects/:projectId` | ✔ | detail | — |
| PATCH | `/api/projects/:projectId` | ✔ | update | `project.updated` |
| DELETE | `/api/projects/:projectId` | ✔ | delete, explicit confirmation required | `project.deleted` |
| GET | `/api/projects/:projectId/agents` | ✔ | cursor list | — |
| POST | `/api/projects/:projectId/agents` | ✔ | FR-002 register | `agent.created` |
| GET | `/api/agents/:agentId` | ✔ | detail | — |
| PATCH | `/api/agents/:agentId` | ✔ | update | `agent.updated` |
| POST | `/api/agents/:agentId/preview-traces` | ✔ | FR-002 preview query through MCP | — |
| POST | `/api/agents/:agentId/baselines` | ✔ | enqueue `baseline_mining`, idempotent on `selectionHash` | `baseline.requested` |
| GET | `/api/agents/:agentId/baselines` | ✔ | cursor list | — |
| GET | `/api/baselines/:baselineId` | ✔ | detail with families | — |
| POST | `/api/baselines/:baselineId/route-families/:familyId/approve` | ✔ | FR-007 decision | `route_family.approved` |
| POST | `/api/baselines/:baselineId/route-families/:familyId/exclude` | ✔ | FR-007 decision | `route_family.excluded` |
| POST | `/api/baselines/:baselineId/propose-contract` | ✔ | enqueue `contract_proposal` | `contract.proposal.requested` |
| GET | `/api/agents/:agentId/contracts` | ✔ | cursor list | — |
| POST | `/api/agents/:agentId/contracts` | ✔ | create from YAML, `draft` | `contract.created` |
| GET | `/api/contracts/:contractId` | ✔ | detail with rules | — |
| PUT | `/api/contracts/:contractId` | ✔ | replace a `draft` only | `contract.updated` |
| POST | `/api/contracts/:contractId/validate` | ✔ | revalidate, may set `invalid` | `contract.validated` |
| POST | `/api/contracts/:contractId/approve` | ✔ | FR-018 `draft -> approved` | `contract.approved` |
| POST | `/api/contracts/:contractId/activate` | ✔ | FR-018 `approved -> active`, supersede prior | `contract.activated` |
| GET | `/api/contracts/:contractId/export` | ✔ | YAML export | — |
| POST | `/api/contracts/:contractId/sync-signoz` | → 10 | artefact compilation | — |
| POST | `/api/agents/:agentId/evaluations` | ✔ | enqueue `evaluation` | `evaluation.requested` |
| GET | `/api/evaluations/:evaluationId` | ✔ | detail with run results | — |
| GET | `/api/agents/:agentId/releases` | ✔ | cursor list | — |
| GET | `/api/releases/:releaseId` | ✔ | detail | — |
| POST | `/api/releases/:releaseId/re-evaluate` | ✔ | enqueue `evaluation` for the release | `evaluation.requested` |
| GET | `/api/releases/:releaseId/diff` | → 14 | Release Diff | — |
| GET | `/api/releases/:releaseId/gate` | → 11 | release gate | — |
| GET | `/api/projects/:projectId/violations` | ✔ | cursor list | — |
| GET | `/api/violations/:violationId` | ✔ | detail | — |
| GET | `/api/violations/:violationId/evidence` | ✔ | FR-017 evidence bundle | — |
| POST | `/api/demo/reset` | ✔ | FR-020 reset, `DEMO_MODE` only | `demo.reset` |
| POST | `/api/demo/run/v1` | ✔ | enqueue `demo_run`, `DEMO_MODE` only | `demo.run.requested` |
| POST | `/api/demo/run/v2` | ✔ | enqueue `demo_run`, `DEMO_MODE` only | `demo.run.requested` |
| POST | `/api/demo/capture-baseline` | ✔ | enqueue `baseline_mining` for the demo agent | `baseline.requested` |
| POST | `/api/demo/evaluate-v2` | ✔ | enqueue `evaluation` for the canary | `evaluation.requested` |
| GET | `/api/demo/status` | ✔ | demo state | — |
| GET | `/api/jobs/:jobId` | ✔ | job state | — |
| GET | `/api/jobs/:jobId/events` | ✔ | progress events | — |
| GET | `/api/openapi.json` | ✔ | PRD Phase 09 task 11, generated from the route schemas | — |

## Job inventory

| Job type | Entity | Idempotency key | Stages | Commit |
|---|---|---|---|---|
| `baseline_mining` | `agent` | `selectionHash` (PRD 18.2, 20.1) | `MINING_STAGES` | `baseline_versions` + `route_families` + `trace_runs` + `trace_graphs` in one transaction |
| `contract_proposal` | `baseline_version` | sha256 of baseline id, approved fingerprints and proposal options | `proposing_contract_rules` | `contracts` + `contract_rules` in one transaction |
| `evaluation` | `contract` | sha256 of contract id, release id, scope and window | `discovering_traces`, `fetching_span_trees`, `normalising_routes`, `evaluating_runs` | `evaluations` + `run_evaluations` + `violations` + `trace_runs` + `trace_graphs` in one transaction |
| `demo_run` | `agent` | caller-supplied run key | `running_demo` | `releases` touched; traces land in SigNoz |

The stage vocabulary is imported from `@flightrules/baseline-miner` (`MINING_STAGES`) and extended
only where a job genuinely has a stage mining does not. No value is copied by hand.

## Lifecycle state machines

```text
job          queued -> claimed -> running -> succeeded
                              \-> failed(retryable) -> queued
                              \-> failed(terminal)
                              \-> cancelled
baseline     dataset_truncated | insufficient_runs | pending_review -> approved
route family pending -> approved | rejected | optional | excluded_fixture_error
contract     draft -> approved -> active -> superseded
             draft -> invalid -> draft
evaluation   queued -> running -> pass | fail | error | insufficient_data
```

Every transition goes through one guarded update that names both the expected current state and the
next state, so an illegal transition is rejected by the database rather than by a read-then-write
race.

## Idempotency and concurrency

- `jobs` carries `unique (job_type, idempotency_key)`. A repeated submission returns the existing
  job. A submission whose canonical input differs under the same key is a typed conflict.
- Claiming uses `update ... where id = (select id from jobs ... for update skip locked limit 1)`,
  which is the documented PostgreSQL row-lock semantics and is verified by a runtime test with two
  real connections.
- A claim writes `lease_owner` and `lease_expires_at`. A worker renews the lease while running. An
  expired lease is reclaimable, and the reclaim increments `attempt`.
- Result commit and the transition to `succeeded` happen in **one** transaction, so a crash after
  producing output but before marking success leaves nothing partially committed.
- Progress writes are guarded by `where progress_index < :next`, so a stage can never regress and a
  duplicate stage write is a no-op.

## Tests

| Group | File | Covers |
|---|---|---|
| migration | `packages/db/src/migrator.integration.test.ts` | clean database, upgrade from Phase 08, repeated invocation, rollback and reapply, all sixteen tables, constraints, indexes |
| schema integrity | `packages/db/src/schema.integration.test.ts` | required columns, foreign keys, unique and check constraints, cascade behaviour, immutable fields, timestamps |
| repositories | `packages/db/src/repositories/*.integration.test.ts` | create, read, update, forbidden update, list and paginate, duplicates, foreign-key failure, rollback, canonical round trip, hash preservation |
| jobs | `packages/db/src/repositories/jobs.integration.test.ts` | submit, claim, progress, succeed, fail, retry, cancel, duplicate submission, concurrent duplicate submission, stale lease recovery, maximum attempts, atomic output commit, idempotent replay |
| API | `apps/api/src/**/*.test.ts` | every route, valid and invalid requests, not found, conflict, illegal transition, pagination, idempotency, dependency failure, response schema, redaction, body-size limit |
| application | `apps/api/src/config.test.ts`, `apps/worker/src/config.test.ts` | configuration validation, startup, readiness, health, graceful shutdown, structured logging |
| worker | `apps/worker/src/**/*.test.ts` | handler dispatch, progress ordering, failure classification, cancellation, shutdown |
| integration | `apps/api/src/api.integration.test.ts`, `apps/worker/src/worker.integration.test.ts` | API to database, worker to database, submit -> claim -> mine -> persist -> retrieve, repeated submission, partial failure leaves nothing, restart preserves state, two workers do not duplicate |
| live | `apps/worker/src/worker.signoz.integration.test.ts` | a real mining job through the API against live SigNoz, persisted baseline, families, contract and rules, retrieved through the API, generated contract still accepted by the Phase 07 validator |

## Evidence

- `docs/evidence/phase-09-plan.md` (this file)
- `docs/evidence/phase-09-result.md`
- `docs/evidence/phase-09-commits.md`
- `docs/evidence/phase-09/` — schema inventory, constraint and index inventory, live run logs
- `docs/adr/0008-application-core-persistence-and-jobs.md`
- source-lock additions for anything newly verified against PostgreSQL 16 or the pinned SigNoz
- `docs/ACCEPTANCE_MATRIX.md`, `CHANGELOG.md`, `docs/RUNBOOK.md`

## Known deferrals, with the PRD assignment that justifies each

| Deferred | PRD phase |
|---|---|
| `POST /api/setup/signoz/sync-artifacts`, `POST /api/contracts/:contractId/sync-signoz` | Phase 10 SigNoz artifact compiler |
| `GET /api/releases/:releaseId/gate`, release-scoped budget aggregation | Phase 11 release evaluation, CLI, and GitHub gate |
| `GET /api/releases/:releaseId/diff` | Phase 14 Release Diff |
| every `apps/web` route | Phases 12–15 |
