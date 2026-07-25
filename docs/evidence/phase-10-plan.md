# Phase 10 plan — SigNoz artifact compiler

Branch `phase/10-signoz-artifact-compiler`. Entry state verified against `main` at `81a517c`.

---

## 1. Entry verification (completed before any file changed)

| Check | Result |
|---|---|
| Working tree clean, `main` contains `222c7c0`, `f8e3215`, `81a517c` | PASS |
| `make verify` | exit 0 |
| `make signoz-verify` | exit 0 — SigNoz v0.134.0, MCP v0.9.0, OTLP ingestion 200 |
| `make contract-validate` | exit 0, 20 documents valid |
| `make test` | 895 passed, 0 failed, 0 skipped (42 files) |
| `make test-integration` | 191 passed, 0 failed, 0 skipped (12 files) |
| Total | **1,086 passed** — matches the reported handoff exactly |
| Migrations applied | `0001`, `0002`, `0003` |
| API start | `/health/ready` → `"ready"`, `schema.compatible: true` |
| Worker start | `worker ready`, lease 120 s |
| Persisted Phase 09 flow after restart | 80 trace runs, 80 canonical graphs, 1 route family at `43070aa4…`, 28-rule contract `refund-agent-local` 0.1.0 **active** at content hash `aeab8779…`, 40 violations, all served by a freshly started API |
| Phase 10 work already present | none — `signoz_artifacts` empty, no `packages/artifact-compiler`, sync routes unregistered |

All seven Phase 10 entry criteria in `docs/evidence/HANDOFF.md` re-verified: Phase 09 merged and
green; a contract can be activated; the artefact register exists with `spec_hash`,
`remote_snapshot_json` and `unique (project_id, managed_name)`; `createAndVerify` / `assertVerified`
/ `deepEquals` / `readPath` exist; the capability snapshot is persisted; violation telemetry is
recorded by the evaluation handler; the job system runs with lease and retry.

**No regression found. Phase 10 proceeds on its own branch.**

---

## 2. Grounding performed before design (PRD Phase 10 task 1)

Every write shape below was read from the **live** pinned MCP server (v0.9.0), not recalled. The
captured resource instructions and the complete input schemas of all 22 write/read tools are
committed at `docs/evidence/phase-10/mcp-write-schemas.json`.

Findings that changed the design:

| # | Finding | Consequence |
|---|---|---|
| 1 | `signoz_create_view`, `signoz_create_dashboard`, `signoz_create_alert`, `signoz_create_notification_channel` all take **flat** arguments (SL-023 confirmed for all four). | Specs are spread into tool arguments. |
| 2 | `signoz_update_view` takes `{id, view}` and `signoz_update_dashboard` takes `{id, dashboard}` — **nested**. `signoz_update_alert` and `signoz_update_notification_channel` are **flat with `id`**. Create is flat everywhere; update is not. | Update argument shape is per tool, taken from the discovered schema, never assumed. |
| 3 | Every update tool is a **full replacement**. | Fetch → strip server-populated fields → merge → submit complete object → re-fetch → compare. |
| 4 | A saved view's query uses `compositeQuery.queries[].spec` with wire order `order: [{key:{name},direction}]` and `having: {expression: ""}`. A **dashboard widget** uses `query.builder.queryData[]` with editor order `orderBy: [{columnName, order}]` and `having: []`. The two shapes are not interchangeable. | Views and dashboards have separate builders; a shared one would be wrong for one of them. |
| 5 | Alerts are `schemaVersion: v2alpha1`, `condition.thresholds.spec[]`, `evaluation.{kind,spec}`, and require **at least one existing notification channel name** even when `usePolicy` is true. | The channel is compiled and created first, and its name verified by list before any alert write. |
| 6 | `flight_rules.*` metrics were **absent from SigNoz entirely**. | Defect 1 below. Fixed and re-proven live before any dashboard was designed. |
| 7 | FlightRules metrics land as **cumulative** sums, and histograms explode into `.bucket/.count/.sum/.min/.max`. | Counter panels use `increase`/`rate` time aggregation, never `sum` of a cumulative series; the duration panel reads `flight_rules.evaluation.duration.bucket` with `p95` space aggregation. |
| 8 | Trace attributes `agent.idempotency.present` is **bool** and `agent.retry.number` is **number** in the live field catalogue. | Every generated query carries the correct `fieldDataType`, closing SL-046 (a query that omits it returns `null`, which is not zero and not false). |
| 9 | No `flight_rules.*` **trace attribute** exists — PRD section 17.3's evaluator spans are declared but never emitted. | Defect 3 below. "Violating runs" and "Latest violating traces" are not honestly buildable without them. |

---

## 3. Defects found in inherited work, fixed in this phase

| # | Defect | Evidence | Fix |
|---|---|---|---|
| 1 | `bootstrapFromEnv` never enabled metrics, so the API and the worker ran with the API's **no-op meter**. Every `flight_rules.*` instrument was silently discarded and no FlightRules metric had ever reached SigNoz. `sdk.ts` even documents "The API and the worker both enable it" — the wiring was missing. | `signoz_list_metrics searchText=flight_rules` returned `[]` against a stack holding 10 hours of demo telemetry. | `BootstrapOptions.metrics`, set by both applications. Re-proven live: after a real worker evaluation, `flight_rules.evaluations`, `.violations`, `.unknown_routes`, `.evaluation.duration.*`, `.route.similarity.*` and `.signoz_artifact_sync` are all present in SigNoz. |
| 2 | `flight_rules.duplicate_side_effects` is declared in `METRIC_SPECS` but **never recorded**. FR-014 panel 5 and the FR-015 duplicate-side-effect alert would both have been decorative empty artefacts. | No call site for `recordDuplicateSideEffect` anywhere in `apps/worker`. | A deterministic classifier in `packages/contract-engine` identifies duplication violations against side-effecting rules; the evaluation handler records the metric. |
| 3 | PRD section 17.3's evaluator spans are declared in `SPAN_NAMES` but no code creates them. | `signoz_get_field_keys signal=traces searchText=flight` returned `{}`. | The worker emits `flight_rules.evaluate_release` and `flight_rules.evaluate_run`; the compiler emits `flight_rules.compile_signoz_artifacts`. |
| 4 | The acceptance matrix claims (row 15, FR-016) that the worker's evaluation metrics are "exported over OTLP" and that duplicate-side-effect metrics are recorded. Neither was true. | Defects 1 and 2. | Both claims corrected in `docs/ACCEPTANCE_MATRIX.md`, and now true. |

Defects 1–3 are inside the Phase 10 exit gate — a dashboard panel with no data is exactly the
"decorative copy" the gate forbids — so they are fixed here rather than deferred.

---

## 4. Artifact inventory

Managed names follow PRD section 16.8 exactly: `FlightRules / <project> / <agent> / <Label>`, where
`<project>` is the project slug and `<agent>` the agent key. The notification channel is
project-scoped because a channel is not per agent.

| # | Type | Managed name | PRD |
|---|---|---|---|
| 1 | notification_channel | `FlightRules / <project> / Notifications` | FR-015 (channel verification) |
| 2 | saved_view | `FlightRules / <project> / <agent> / Violating Runs` | FR-013, 16.8 |
| 3 | saved_view | `FlightRules / <project> / <agent> / Duplicate Side Effects` | FR-013, 16.8 |
| 4 | saved_view | `FlightRules / <project> / <agent> / Unknown Routes` | FR-013, 16.8 |
| 5 | saved_view | `FlightRules / <project> / <agent> / Release Comparison` | FR-013 |
| 6 | dashboard | `FlightRules / <project> / <agent> / Contract Health` | FR-014, 16.8 |
| 7 | alert | `FlightRules / <project> / <agent> / Violation Rate Alert` | FR-015, 16.8 |
| 8 | alert | `FlightRules / <project> / <agent> / Duplicate Side Effect Alert` | FR-015 |
| 9 | alert | `FlightRules / <project> / <agent> / Release Evaluation Error Alert` | FR-015 |
| 10 | alert | `FlightRules / <project> / <agent> / No Evaluation Data Alert` | FR-015 |

Nothing outside this list is created. The ten FR-014 dashboard panels use the PRD's exact titles.

---

## 5. Traceability

| Requirement | Compiler module | MCP operation | API route | Database record | Test | Runtime proof |
|---|---|---|---|---|---|---|
| FR-013 saved views | `views.ts` | `signoz_create_view` / `signoz_update_view` / `signoz_get_view` / `signoz_list_views` | `POST /api/contracts/:id/sync-signoz` | `signoz_artifacts` rows, `artifact_type='saved_view'` | `views.test.ts`, `artifacts.signoz.integration.test.ts` | four views created, read back, field-compared |
| FR-014 dashboard | `dashboard.ts` | `signoz_create_dashboard` / `signoz_update_dashboard` / `signoz_get_dashboard` / `signoz_list_dashboards` | same | `artifact_type='dashboard'` | `dashboard.test.ts` | ten panels each returning rows after the seeded demo |
| FR-015 alerts | `alerts.ts` | `signoz_create_alert` / `signoz_update_alert` / `signoz_get_alert` / `signoz_get_alert_history` | same | `artifact_type='alert'` | `alerts.test.ts` | alert history shows a real firing transition after the canary evaluation |
| FR-015 channel verification | `channels.ts` | `signoz_list_notification_channels` / `signoz_create_notification_channel` / `signoz_get_notification_channel` | same | `artifact_type='notification_channel'` | `channels.test.ts` | channel listed by name before every alert write |
| FR-016 telemetry | — | — | — | — | `telemetry.test.ts` | `flight_rules.*` metrics and spans present in SigNoz |
| 16.5 read-before-write | `verify.ts` + `signoz-mcp/verify.ts` | list → create/update → get → compare | both routes | `verification_json`, `remote_snapshot_json` | `verify.test.ts` | every write followed by a read-back |
| 16.8 managed names | `names.ts` | — | — | `managed_name` | `names.test.ts` | names match the PRD template byte for byte |
| Task 10 update without duplicate creation | `plan.ts` | update path | both routes | `spec_hash` | `plan.test.ts`, idempotency integration | second identical sync creates none and updates none |
| Task 11 drift detection | `verify.ts` | get | `GET /api/setup/signoz/artifacts` | `status='drifted'` | `drift.test.ts` | a manually edited remote resource is reported as drifted |
| Task 12 sync telemetry | `apps/worker` | — | — | — | `telemetry.test.ts` | `flight_rules.signoz_artifact_sync` present in SigNoz |

---

## 6. Route inventory

| Method | Path | Request | Response | Lifecycle effect | Idempotency | Error codes | Transaction | Test |
|---|---|---|---|---|---|---|---|---|
| POST | `/api/setup/signoz/sync-artifacts` | `{projectId, agentId?}` | `202` job envelope | queues a `signoz_sync` job for every agent of the project holding an active contract | `sha256` over project, agent set and each active contract's content hash — a repeat returns the same job | `NOT_FOUND`, `VALIDATION_FAILED`, `CONTRACT_CONFLICT`, `JOB_ALREADY_RUNNING`, `MCP_UNAVAILABLE` | one transaction submits the job and writes the audit row | `api.integration.test.ts` |
| POST | `/api/contracts/:contractId/sync-signoz` | `{}` | `202` job envelope | queues a `signoz_sync` job for one contract | `sha256` over contract id and content hash | `NOT_FOUND`, `VALIDATION_FAILED`, `STATE_TRANSITION_INVALID`, `JOB_ALREADY_RUNNING` | same | `api.integration.test.ts` |
| GET | `/api/setup/signoz/artifacts` | `?projectId` | artefact register, extended with verification, operation and drift | read-only | n/a | `NOT_FOUND` | none | `api.integration.test.ts` |

A contract that is neither `approved` nor `active` is refused with `STATE_TRANSITION_INVALID`. No
raw MCP payload is returned by any route; the register returns a redacted remote snapshot only.

---

## 7. Persistence

Forward-only migration `0004_signoz_artifact_sync.sql`. `0001`, `0002` and `0003` are untouched.

- `jobs.job_type` gains `signoz_sync`.
- `signoz_artifacts.status` gains `conflict`.
- `signoz_artifacts` gains `contract_id`, `last_operation`, `sync_attempt`, `verification_json`,
  `last_error_json`, and an index on `contract_id`.

Everything else Phase 10 needs already exists in `0003`. `spec_hash` decides "unchanged" without
asking SigNoz; `remote_snapshot_json` makes drift decidable; `unique (project_id, managed_name)`
makes a duplicate create impossible even under a concurrent sync.

---

## 8. Determinism boundary

`compileArtifacts` is a pure function of the project, the agent, the active contract, its rules and
the artifact target configuration. It performs no I/O, reads no clock and reads no database order:
artefacts are emitted in a fixed declaration order and every hash is taken over the canonical
serialisation already used by `packages/db`. Identical inputs produce byte-identical desired specs
and therefore identical `spec_hash` values. No LLM is involved in compilation, comparison or
verification.
