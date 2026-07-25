# Acceptance matrix

Every P0 requirement maps to an implementation path, a test path, a runtime evidence path, and a
status. No requirement may be marked `DONE` without both a test and runtime evidence where
runtime behaviour applies.

Status values: `PENDING`, `IN PROGRESS`, `DONE`, `BLOCKED`.

Last updated: Phase 11, 2026-07-25.

## Critical final assertions (PRD section 23)

| ID | Assertion | Implementation | Test | Runtime evidence | Status |
|---|---|---|---|---|---|
| A1 | Foundry reproduces SigNoz and MCP from casting files | `casting.yaml`, `casting.yaml.lock`, `pours/` | `scripts/verify-reproducibility.sh`, `packages/test-fixtures/src/deployment.test.ts` | `docs/evidence/phase-02-result.md` | DONE |
| A2 | v1 and v2 emit real distributed telemetry | `apps/demo-agent`, `apps/demo-services/*`, `packages/telemetry` | `packages/telemetry/src/telemetry.test.ts` | `docs/evidence/phase-04-result.md` — v1 retrieved from SigNoz as 12 spans over 6 services, v2 as 8 spans over 4 services | DONE |
| A3 | v1 and v2 return materially the same customer answer | `apps/demo-agent` | `apps/demo-agent/src/orchestrator.test.ts` | `docs/evidence/phase-03-result.md` | DONE |
| A4 | v1 includes policy and fraud checks | `apps/demo-agent` | `apps/demo-agent/src/orchestrator.test.ts` | `docs/evidence/phase-03-result.md` | DONE |
| A5 | v2 omits those checks and duplicates payment | `apps/demo-agent`, `apps/demo-services/payment-service` | `apps/demo-agent/src/orchestrator.test.ts`, `apps/demo-services/payment-service/src/ledger.test.ts` | `docs/evidence/phase-03-result.md` | DONE |
| A6 | FlightRules reconstructs both trace graphs from SigNoz | `packages/signoz-mcp`, `packages/trace-graph` | `packages/trace-graph/src/graph.test.ts`, `graph.signoz.integration.test.ts` | `docs/evidence/phase-06-result.md` — both live traces reconstructed; a live v1 run fingerprints identically to the captured fixture | DONE |
| A7 | The active contract passes v1 | `packages/contract-engine` | `packages/contract-engine/src/evaluate.test.ts`, `evaluate.signoz.integration.test.ts` | `docs/evidence/phase-07-result.md` — the committed contract evaluated against a live v1 trace: pass, 13 rules passed, 2 deferred, 0 violations | DONE |
| A8 | The active contract fails v2 | `packages/contract-engine` | `packages/contract-engine/src/evaluate.test.ts`, `evaluate.signoz.integration.test.ts` | `docs/evidence/phase-07-result.md` — live v2 trace: fail, 6 violations, 3 critical and zero-tolerance, naming the missing fraud check, the missing policy check and the duplicate refund | DONE |
| A9 | The failure links to real SigNoz trace evidence | `packages/domain`, `apps/web` violation inspector | evidence linking test | `docs/evidence/phase-15-result.md` | PENDING |
| A10 | FlightRules creates and verifies a real SigNoz dashboard | `packages/artifact-compiler`, `apps/worker/src/artifact-sync.ts` | `compile.test.ts` dashboard suite, `phase-10.signoz.integration.test.ts` create + read-back | `docs/evidence/phase-10-result.md` — `Contract Health` created through MCP, read back, its ten PRD panel titles field-compared | DONE |
| A11 | FlightRules creates and verifies real SigNoz views | `packages/artifact-compiler` | `compile.test.ts` view suite, `phase-10.signoz.integration.test.ts` | `docs/evidence/phase-10-result.md` — FR-013's four views created, read back, field-compared, and returning real evaluated canary runs | DONE |
| A12 | FlightRules creates an alert that fires from the v2 violation | `packages/artifact-compiler`, `apps/worker` | `compile.test.ts` alert suite, `phase-10.signoz.integration.test.ts` | `docs/evidence/phase-10-result.md` — a 140-violation canary evaluation drove `Violation Rate Alert` and `Duplicate Side Effect Alert` to `firing`; alert history records the transition at value 80 | DONE |
| A13 | The CLI gate returns exit code 2 for v2 | `apps/cli`, `packages/contract-engine/src/release.ts` | `exit-codes.test.ts` (every decision and every error code), `cli.test.ts` (every exit code end to end), `gate.integration.test.ts`, `phase-11.signoz.integration.test.ts` | `docs/evidence/phase-11-result.md` — the live canary: 8 runs, 80 violations, 24 zero-tolerance, `flightrules gate check` exit `2`; the approved release exit `0` over 106 runs | DONE |
| A14 | No raw prompts or chain-of-thought are required | `packages/telemetry` | `packages/telemetry/src/telemetry.test.ts` forbidden-attribute redactor tests | `docs/evidence/phase-04-result.md` — both traces evaluated end to end with no prompt or reasoning attribute present | DONE |
| A15 | A clean clone can reproduce the system | `scripts/*`, `README.md` | `scripts/verify-reproducibility.sh` | `docs/evidence/phase-17-result.md` | PENDING |

## P0 scope items (PRD section 6.1)

| # | Requirement | Implementation | Test | Runtime evidence | Status |
|---|---|---|---|---|---|
| 1 | Reproducible SigNoz installation through Foundry | `casting.yaml` | `scripts/verify-signoz.sh` | phase-02 | DONE |
| 2 | Repository contains `casting.yaml` and `casting.yaml.lock` | repository root | reproducibility check | phase-02 | DONE |
| 3 | SigNoz MCP Server enabled and reachable | `casting.yaml` `spec.mcp` | `packages/test-fixtures/src/signoz.signoz.integration.test.ts` | phase-02 | DONE |
| 4 | Claude Code can connect to the SigNoz MCP Server | `docs/RUNBOOK.md` section 3 | documented manual step; the same endpoint, transport and header are exercised by the SDK integration tests | phase-02 | DONE |
| 5 | FlightRules backend connects using an official MCP client | `packages/signoz-mcp` | `packages/signoz-mcp/src/mcp-client.signoz.integration.test.ts` | phase-05 — 21 integration tests against the pinned v0.9.0 server | DONE |
| 6 | Instrumented refund-agent demo emits traces, metrics and logs | `apps/demo-*`, `packages/telemetry` | `packages/telemetry/src/telemetry.test.ts`, `packages/telemetry/src/instruments.ts` | phase-04 traces; phase-10 — fifteen `flight_rules.*` metric series confirmed present in SigNoz by `signoz_list_metrics` after a real worker evaluation. Both applications write structured JSON logs to stdout; **logs are not yet exported over OTLP** | IN PROGRESS |
| 7 | Baseline and canary releases distinguishable via attributes | `packages/telemetry` | `packages/telemetry/src/telemetry.test.ts` | phase-04 — `agent.release.id` retrieved as `refund-agent-v1` and `refund-agent-v2` from the two live traces | DONE |
| 8 | Complete trace trees fetched and reconstructed | `packages/trace-graph` | `packages/trace-graph/src/graph.test.ts` | phase-06 — 12-span and 8-span traces reconstructed from live SigNoz | DONE |
| 9 | Trace nodes deduplicated by span ID | `packages/trace-graph` | duplicate, conflicting-duplicate and completeness tests | phase-06 | DONE |
| 10 | Dynamic identifiers normalised | `packages/normaliser` | `packages/normaliser/src/normalise.test.ts` including idempotence and volatile-ID invariance properties | phase-06 | DONE |
| 11 | Baseline route families captured from range or release | `packages/baseline-miner` | `families.test.ts`, `dataset.test.ts`, `mine.test.ts`, `mining.signoz.integration.test.ts` | phase-08 — 34 live `refund-agent-v1` runs mined into one family at fingerprint `43070aa4...`, which the committed contract already approves | DONE |
| 12 | Versioned YAML contract proposed, reviewed, validated, stored, evaluated | `packages/baseline-miner`, `packages/contract-schema`, `packages/contract-engine`, `packages/db`, `apps/api` | `propose.test.ts`, `emit.test.ts`, `decisions.test.ts`, `validate.test.ts`, `lifecycle.integration.test.ts`, `api.integration.test.ts` | phase-09 — a 28-rule draft proposed from 76 live runs through the job system, stored with every rule's evidence basis, approved and activated through the API, and evaluated against both releases | DONE |
| 13 | All P0 rule types work | `packages/contract-engine` | `packages/contract-engine/src/rules.test.ts` — all eleven types with passing, violating and empty-evidence cases; a test asserts the fixture set covers `RULE_TYPES` exactly | phase-07 | DONE |
| 14 | Deterministic pass/fail decisions and typed violations | `packages/contract-engine` | `evaluate.test.ts` — byte-equality across repeated runs, span order, attribute order, rule order and contract key order, plus seven 300-run properties | phase-07 | DONE |
| 15 | Evaluation telemetry emitted back to SigNoz | `packages/telemetry`, `apps/worker` | `packages/telemetry/src/telemetry.test.ts`, `packages/contract-engine/src/side-effects.test.ts` | phase-10 — **corrected**: the Phase 09 claim was false, because no meter provider existed (SL-053) and duplicate side effects were never recorded. Both fixed and verified live: `signoz_list_metrics` returns fifteen `flight_rules.*` series and three managed alerts fire from them | DONE |
| 16 | SigNoz dashboard created through MCP with real data | `packages/artifact-compiler` | `compile.test.ts`, `phase-10.signoz.integration.test.ts` | phase-10 — ten panels; six read fifteen live `flight_rules.*` metric series, three read the agent's own traces, one lists live violating runs. Panel 8 is an honest empty series because the demo emits no token attribute | DONE |
| 17 | At least one saved SigNoz trace view created through MCP | `packages/artifact-compiler`, `apps/worker/src/artifact-sync.ts` | `phase-10.signoz.integration.test.ts` | phase-10 — four views created, read back, field-compared, idempotent on re-sync, recreated after a manual delete, restored after a manual replacement | DONE |
| 18 | At least one SigNoz alert created through MCP and proven to fire | `packages/artifact-compiler` | `phase-10.signoz.integration.test.ts`, alert-history capture | phase-10 — four alerts created and verified; three firing on real canary data. Recovery is not yet evidenced (phase-10 limitation 2) | DONE |
| 19 | Release comparison shows baseline versus canary topology diff | `packages/trace-graph`, `apps/web` | diff tests | phase-14 | PENDING |
| 20 | Violation inspector links to the original SigNoz trace | `apps/web` | inspector route tests | phase-15 | PENDING |
| 21 | CLI or GitHub Action gate exits non-zero when thresholds fail | `apps/cli`, `.github/workflows/release-gate.yml`, `packages/contract-engine/src/release.ts`, `apps/api/src/routes/gate.ts` | `exit-codes.test.ts`, `release.test.ts` (35), `cli.test.ts` (49), `gate.integration.test.ts` (17), `release-gate-workflow.test.ts` (14), `phase-11.signoz.integration.test.ts` (8) | phase-11 — live: `refund-agent-v1` exit `0` over 106 evaluated runs; `refund-agent-v2` exit `2` with 80 violations and 24 zero-tolerance; the same decision served after an API restart | DONE |
| 22 | Seeded v1 passes and seeded v2 fails | end to end | e2e scenario | phase-17 | PENDING |
| 23 | UI uses `design.md` without changing product copy or route purposes | `apps/web`, `packages/ui` | route and copy tests | phase-12 | PENDING |
| 24 | Unit, property, integration, e2e, security and reproducibility tests pass | whole repository | `make verify` | phase-16, phase-17 | PENDING |
| 25 | README, architecture, runbook, demo script and submission docs complete | `docs/*`, `README.md` | docs link check | phase-17 | PENDING |

## Functional requirements (PRD section 9)

| FR | Description | Implementation | Test | Evidence | Status |
|---|---|---|---|---|---|
| FR-001 | Project creation | `apps/api`, `packages/db` | `api.integration.test.ts` — duplicate slug rejected, server-side validation, persisted, listed | phase-09 | DONE |
| FR-002 | Agent registration | `apps/api`, `packages/db` | `api.integration.test.ts` — field discovery against the connected tenant, preview query, registration refused without a release discriminator | phase-09 | DONE |
| FR-003 | Trace discovery | `packages/signoz-mcp` | `mcp-client.signoz.integration.test.ts` | phase-05 — both demo traces retrieved with custom attributes and webUrl preserved | DONE |
| FR-004 | Trace graph reconstruction | `packages/trace-graph` | reconstruction, orphan, cycle and duplicate tests | phase-06 | DONE |
| FR-005 | Name and attribute normalisation | `packages/normaliser` | `normalise.test.ts` | phase-06 | DONE |
| FR-006 | Canonical route fingerprint | `packages/trace-graph` | order, key-order and volatile-ID property tests plus sensitivity tests | phase-06 — a live run and the captured fixture share one fingerprint | DONE |
| FR-007 | Baseline capture | `packages/baseline-miner` | `mine.test.ts`, `families.test.ts`, `eligibility.test.ts`, `decisions.test.ts`, `mining.signoz.integration.test.ts` | phase-08 — minimum-run and truncation blocking, fifteen typed exclusion reasons, exact family grouping, frequency, representatives, rare marking, four review actions, all proven live | DONE |
| FR-008 | Contract proposal | `packages/baseline-miner` | `propose.test.ts`, `aggregate.test.ts`, `emit.test.ts`, `mining.signoz.integration.test.ts` | phase-08 — nine rule types proposed from nine evidence bases, every rule carrying its basis and confidence; nothing activated | DONE |
| FR-009 | Contract schema validation | `packages/contract-schema` | `validate.test.ts`, `yaml.test.ts` — every rejection reason asserted with its exact path and code | phase-07 | DONE |
| FR-010 | Run evaluation | `packages/contract-engine` | `rules.test.ts`, `evaluate.test.ts`, `evaluate.signoz.integration.test.ts` | phase-07 — both live traces evaluated end to end | DONE |
| FR-011 | Release evaluation | `packages/contract-engine/src/release.ts`, `packages/db/src/repositories/gate.ts` | `release.test.ts` — every count and rate against hand-computed rationals, deferred release rules resolved, regression measured with and without a baseline, order independence, repeated aggregation byte-identical | phase-11 — 106 live runs aggregated into one decision; the canary's 2 593.75 % latency regression measured against the mined baseline's own family statistics | DONE |
| FR-012 | Release gate | `apps/cli`, `apps/api/src/routes/gate.ts`, `packages/contract-engine/src/exit-codes.ts` | `exit-codes.test.ts`, `cli.test.ts`, `gate.integration.test.ts`, `phase-11.signoz.integration.test.ts` | phase-11 — all five exit codes exercised; minimum runs, violation and unknown-route percentages, zero-tolerance rules, latency and token regression, telemetry timeout and the explicit `insufficient_data` code all proven | DONE |
| FR-013 | SigNoz saved-view compiler | `packages/artifact-compiler` | `compile.test.ts`, `phase-10.signoz.integration.test.ts` | phase-10 — all four PRD views, created and verified. `signoz_update_view` is unusable in the pinned version (SL-057), so replacement is delete-then-create | DONE |
| FR-014 | SigNoz dashboard compiler | `packages/artifact-compiler` | `compile.test.ts` dashboard suite | phase-10 — one managed dashboard, ten panels with the PRD's exact titles and order | DONE |
| FR-015 | SigNoz alert compiler | `packages/artifact-compiler` | `compile.test.ts` alert suite, live firing | phase-10 — four alerts; the notification channel is created and its name verified by list before every alert write | DONE |
| FR-016 | Violation telemetry | `packages/telemetry`, `apps/worker` | `telemetry.test.ts`, `side-effects.test.ts`, live evaluation | phase-10 — **corrected**: Phase 09 recorded metrics into a no-op meter and never exported one (SL-053), and never recorded duplicate side effects at all. Both fixed; fifteen `flight_rules.*` metrics and the PRD section 17.3 evaluator spans are now in SigNoz. Logs are still not exported over OTLP | DONE |
| FR-017 | Evidence linking | `packages/db`, `apps/api` | `api.integration.test.ts`, live `GET /api/violations/:id/evidence` | phase-09 | DONE |
| FR-018 | Contract lifecycle | `apps/api`, `packages/db` | `lifecycle.integration.test.ts`, `api.integration.test.ts` — every transition, every refusal, one active per agent and environment enforced by a partial unique index | phase-09 | DONE |
| FR-019 | Audit history | `apps/api`, `packages/db` | `api.integration.test.ts`, `lifecycle.integration.test.ts` — an audit row per lifecycle event, written by the transaction that made the change | phase-09 | DONE |
| FR-020 | Demo reset | `apps/api`, `scripts/reset-demo.sh` | `api.integration.test.ts` — reset, reseed, demo-mode guard | phase-03, phase-09 | IN PROGRESS |

## Routes (PRD section 8)

| Route | Purpose | Implementation | Test | Status |
|---|---|---|---|---|
| `/` | Public landing | `apps/web` | route test | PENDING |
| `/setup` | Connect FlightRules to SigNoz | `apps/web` | route test | PENDING |
| `/projects` | Projects list | `apps/web` | route test | PENDING |
| `/projects/[projectId]/overview` | Project trajectory health | `apps/web` | route test | PENDING |
| `/projects/[projectId]/agents` | Agents list | `apps/web` | route test | PENDING |
| `/projects/[projectId]/agents/[agentId]` | Agent detail | `apps/web` | route test | PENDING |
| `/projects/[projectId]/agents/[agentId]/baselines/new` | Baseline capture | `apps/web` | route test | PENDING |
| `/projects/[projectId]/agents/[agentId]/routes/[routeFamilyId]` | Route family detail | `apps/web` | route test | PENDING |
| `/projects/[projectId]/agents/[agentId]/contracts/[contractId]` | Contract Studio | `apps/web` | route test | PENDING |
| `/projects/[projectId]/agents/[agentId]/releases` | Releases list | `apps/web` | route test | PENDING |
| `/projects/[projectId]/agents/[agentId]/releases/[releaseId]` | Release Diff | `apps/web` | route test | PENDING |
| `/projects/[projectId]/violations/[violationId]` | Violation Inspector | `apps/web` | route test | PENDING |
| `/projects/[projectId]/integrations/signoz` | SigNoz integration | `apps/web` | route test | PENDING |
| `/demo` | Demo | `apps/web` | route test | PENDING |

## Phase 00 exit-gate chain

The PRD requires each link of the central chain to have a credible, verified implementation path
before Phase 01 begins.

| Link | Status | Evidence |
|---|---|---|
| OpenTelemetry emits the required trace structure | VERIFIED | 5-span trace emitted, in-memory assertion of names and parent linkage |
| SigNoz ingests it | VERIFIED | OTLP/HTTP POST returned HTTP 200; spans queryable |
| FlightRules can retrieve complete trace evidence | VERIFIED | `signoz_execute_builder_query` returned all 5 spans with custom attributes |
| FlightRules can reconstruct trajectories | VERIFIED | `span_id`, `parent_span_id`, `name`, `kind`, duration and service all present |
| Deterministic contracts can be evaluated | VERIFIED BY CONSTRUCTION | pure local computation over the retrieved graph; no external capability required |
| Result telemetry can be written back to SigNoz | VERIFIED | same OTLP path proven above |
| Required SigNoz operational artefacts can be created and read back | VERIFIED | saved view created, read back, field-compared, listed, deleted |
| A CLI or CI release gate can return a deterministic non-zero exit code | VERIFIED BY CONSTRUCTION | Node process exit codes; no external capability required |
