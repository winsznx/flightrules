# Acceptance matrix

Every P0 requirement maps to an implementation path, a test path, a runtime evidence path, and a
status. No requirement may be marked `DONE` without both a test and runtime evidence where
runtime behaviour applies.

Status values: `PENDING`, `IN PROGRESS`, `DONE`, `BLOCKED`.

Last updated: Phase 08, 2026-07-25.

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
| A10 | FlightRules creates and verifies a real SigNoz dashboard | `packages/artifact-compiler` | dashboard create + read-back test | `docs/evidence/phase-10-result.md` | PENDING |
| A11 | FlightRules creates and verifies real SigNoz views | `packages/artifact-compiler` | view create + read-back test | `docs/evidence/phase-10-result.md` | PENDING |
| A12 | FlightRules creates an alert that fires from the v2 violation | `packages/artifact-compiler` | alert firing test via alert history | `docs/evidence/phase-10-result.md` | PENDING |
| A13 | The CLI gate returns exit code 2 for v2 | `apps/cli` | gate exit-code tests | `docs/evidence/phase-11-result.md` | PENDING |
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
| 6 | Instrumented refund-agent demo emits traces, metrics and logs | `apps/demo-*`, `packages/telemetry` | `packages/telemetry/src/telemetry.test.ts` | phase-04 — traces emitted and retrieved; metric instruments declared but not yet emitted, logs land with the API in phase-09 | IN PROGRESS |
| 7 | Baseline and canary releases distinguishable via attributes | `packages/telemetry` | `packages/telemetry/src/telemetry.test.ts` | phase-04 — `agent.release.id` retrieved as `refund-agent-v1` and `refund-agent-v2` from the two live traces | DONE |
| 8 | Complete trace trees fetched and reconstructed | `packages/trace-graph` | `packages/trace-graph/src/graph.test.ts` | phase-06 — 12-span and 8-span traces reconstructed from live SigNoz | DONE |
| 9 | Trace nodes deduplicated by span ID | `packages/trace-graph` | duplicate, conflicting-duplicate and completeness tests | phase-06 | DONE |
| 10 | Dynamic identifiers normalised | `packages/normaliser` | `packages/normaliser/src/normalise.test.ts` including idempotence and volatile-ID invariance properties | phase-06 | DONE |
| 11 | Baseline route families captured from range or release | `packages/baseline-miner` | `families.test.ts`, `dataset.test.ts`, `mine.test.ts`, `mining.signoz.integration.test.ts` | phase-08 — 34 live `refund-agent-v1` runs mined into one family at fingerprint `43070aa4...`, which the committed contract already approves | DONE |
| 12 | Versioned YAML contract proposed, reviewed, validated, stored, evaluated | `packages/baseline-miner`, `packages/contract-schema`, `packages/contract-engine` | `propose.test.ts`, `emit.test.ts`, `decisions.test.ts`, `validate.test.ts`, `cli-run.test.ts` | phase-08 — a 28-rule draft proposed from live telemetry, reviewed through the four route-family actions, validated by the published CLI, evaluated against both releases; storage is phase-09 | IN PROGRESS |
| 13 | All P0 rule types work | `packages/contract-engine` | `packages/contract-engine/src/rules.test.ts` — all eleven types with passing, violating and empty-evidence cases; a test asserts the fixture set covers `RULE_TYPES` exactly | phase-07 | DONE |
| 14 | Deterministic pass/fail decisions and typed violations | `packages/contract-engine` | `evaluate.test.ts` — byte-equality across repeated runs, span order, attribute order, rule order and contract key order, plus seven 300-run properties | phase-07 | DONE |
| 15 | Evaluation telemetry emitted back to SigNoz | `packages/telemetry` | OTLP export test | phase-00 (path proven), phase-09 | IN PROGRESS |
| 16 | SigNoz dashboard created through MCP with real data | `packages/artifact-compiler` | dashboard data test | phase-10 | PENDING |
| 17 | At least one saved SigNoz trace view created through MCP | `packages/signoz-mcp` verify helper, `packages/artifact-compiler` | create-read-verify integration test | phase-05 (view created, read back, field-compared, deleted), phase-10 | IN PROGRESS |
| 18 | At least one SigNoz alert created through MCP and proven to fire | `packages/artifact-compiler` | alert firing test | phase-10 | PENDING |
| 19 | Release comparison shows baseline versus canary topology diff | `packages/trace-graph`, `apps/web` | diff tests | phase-14 | PENDING |
| 20 | Violation inspector links to the original SigNoz trace | `apps/web` | inspector route tests | phase-15 | PENDING |
| 21 | CLI or GitHub Action gate exits non-zero when thresholds fail | `apps/cli`, `.github/workflows/release-gate.yml` | exit-code tests | phase-11 | PENDING |
| 22 | Seeded v1 passes and seeded v2 fails | end to end | e2e scenario | phase-17 | PENDING |
| 23 | UI uses `design.md` without changing product copy or route purposes | `apps/web`, `packages/ui` | route and copy tests | phase-12 | PENDING |
| 24 | Unit, property, integration, e2e, security and reproducibility tests pass | whole repository | `make verify` | phase-16, phase-17 | PENDING |
| 25 | README, architecture, runbook, demo script and submission docs complete | `docs/*`, `README.md` | docs link check | phase-17 | PENDING |

## Functional requirements (PRD section 9)

| FR | Description | Implementation | Test | Evidence | Status |
|---|---|---|---|---|---|
| FR-001 | Project creation | `apps/api` | API tests | phase-09 | PENDING |
| FR-002 | Agent registration | `apps/api` | API tests | phase-09 | PENDING |
| FR-003 | Trace discovery | `packages/signoz-mcp` | `mcp-client.signoz.integration.test.ts` | phase-05 — both demo traces retrieved with custom attributes and webUrl preserved | DONE |
| FR-004 | Trace graph reconstruction | `packages/trace-graph` | reconstruction, orphan, cycle and duplicate tests | phase-06 | DONE |
| FR-005 | Name and attribute normalisation | `packages/normaliser` | `normalise.test.ts` | phase-06 | DONE |
| FR-006 | Canonical route fingerprint | `packages/trace-graph` | order, key-order and volatile-ID property tests plus sensitivity tests | phase-06 — a live run and the captured fixture share one fingerprint | DONE |
| FR-007 | Baseline capture | `packages/baseline-miner` | `mine.test.ts`, `families.test.ts`, `eligibility.test.ts`, `decisions.test.ts`, `mining.signoz.integration.test.ts` | phase-08 — minimum-run and truncation blocking, fifteen typed exclusion reasons, exact family grouping, frequency, representatives, rare marking, four review actions, all proven live | DONE |
| FR-008 | Contract proposal | `packages/baseline-miner` | `propose.test.ts`, `aggregate.test.ts`, `emit.test.ts`, `mining.signoz.integration.test.ts` | phase-08 — nine rule types proposed from nine evidence bases, every rule carrying its basis and confidence; nothing activated | DONE |
| FR-009 | Contract schema validation | `packages/contract-schema` | `validate.test.ts`, `yaml.test.ts` — every rejection reason asserted with its exact path and code | phase-07 | DONE |
| FR-010 | Run evaluation | `packages/contract-engine` | `rules.test.ts`, `evaluate.test.ts`, `evaluate.signoz.integration.test.ts` | phase-07 — both live traces evaluated end to end | DONE |
| FR-011 | Release evaluation | `packages/contract-engine` | aggregation tests | phase-11 | PENDING |
| FR-012 | Release gate | `apps/cli` | exit-code tests | phase-11 | PENDING |
| FR-013 | SigNoz saved-view compiler | `packages/artifact-compiler` | view read-back tests | phase-10 | PENDING |
| FR-014 | SigNoz dashboard compiler | `packages/artifact-compiler` | dashboard tests | phase-10 | PENDING |
| FR-015 | SigNoz alert compiler | `packages/artifact-compiler` | alert tests | phase-10 | PENDING |
| FR-016 | Violation telemetry | `packages/telemetry` | telemetry tests | phase-09 | PENDING |
| FR-017 | Evidence linking | `packages/domain` | evidence tests | phase-09 | PENDING |
| FR-018 | Contract lifecycle | `apps/api` | lifecycle tests | phase-09 | PENDING |
| FR-019 | Audit history | `apps/api` | audit tests | phase-09 | PENDING |
| FR-020 | Demo reset | `apps/api`, `scripts/reset-demo.sh` | reset tests | phase-03, phase-09 | PENDING |

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
