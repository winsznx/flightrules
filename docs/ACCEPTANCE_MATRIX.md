# Acceptance matrix

Every P0 requirement maps to an implementation path, a test path, a runtime evidence path, and a
status. No requirement may be marked `DONE` without both a test and runtime evidence where
runtime behaviour applies.

Status values: `PENDING`, `IN PROGRESS`, `DONE`, `BLOCKED`.

Last updated: Phase 03, 2026-07-25.

## Critical final assertions (PRD section 23)

| ID | Assertion | Implementation | Test | Runtime evidence | Status |
|---|---|---|---|---|---|
| A1 | Foundry reproduces SigNoz and MCP from casting files | `casting.yaml`, `casting.yaml.lock`, `pours/` | `scripts/verify-reproducibility.sh`, `packages/test-fixtures/src/deployment.test.ts` | `docs/evidence/phase-02-result.md` | DONE |
| A2 | v1 and v2 emit real distributed telemetry | `apps/demo-agent`, `apps/demo-services/*`, `packages/telemetry` | telemetry integration tests | `docs/evidence/phase-04-result.md` | PENDING |
| A3 | v1 and v2 return materially the same customer answer | `apps/demo-agent` | `apps/demo-agent/src/orchestrator.test.ts` | `docs/evidence/phase-03-result.md` | DONE |
| A4 | v1 includes policy and fraud checks | `apps/demo-agent` | `apps/demo-agent/src/orchestrator.test.ts` | `docs/evidence/phase-03-result.md` | DONE |
| A5 | v2 omits those checks and duplicates payment | `apps/demo-agent`, `apps/demo-services/payment-service` | `apps/demo-agent/src/orchestrator.test.ts`, `apps/demo-services/payment-service/src/ledger.test.ts` | `docs/evidence/phase-03-result.md` | DONE |
| A6 | FlightRules reconstructs both trace graphs from SigNoz | `packages/signoz-mcp`, `packages/trace-graph` | graph reconstruction tests | `docs/evidence/phase-06-result.md` | PENDING |
| A7 | The active contract passes v1 | `packages/contract-engine` | v1 fixture evaluation test | `docs/evidence/phase-07-result.md` | PENDING |
| A8 | The active contract fails v2 | `packages/contract-engine` | v2 fixture evaluation test | `docs/evidence/phase-07-result.md` | PENDING |
| A9 | The failure links to real SigNoz trace evidence | `packages/domain`, `apps/web` violation inspector | evidence linking test | `docs/evidence/phase-15-result.md` | PENDING |
| A10 | FlightRules creates and verifies a real SigNoz dashboard | `packages/artifact-compiler` | dashboard create + read-back test | `docs/evidence/phase-10-result.md` | PENDING |
| A11 | FlightRules creates and verifies real SigNoz views | `packages/artifact-compiler` | view create + read-back test | `docs/evidence/phase-10-result.md` | PENDING |
| A12 | FlightRules creates an alert that fires from the v2 violation | `packages/artifact-compiler` | alert firing test via alert history | `docs/evidence/phase-10-result.md` | PENDING |
| A13 | The CLI gate returns exit code 2 for v2 | `apps/cli` | gate exit-code tests | `docs/evidence/phase-11-result.md` | PENDING |
| A14 | No raw prompts or chain-of-thought are required | `packages/telemetry` | redaction assertion test | `docs/evidence/phase-04-result.md` | PENDING |
| A15 | A clean clone can reproduce the system | `scripts/*`, `README.md` | `scripts/verify-reproducibility.sh` | `docs/evidence/phase-17-result.md` | PENDING |

## P0 scope items (PRD section 6.1)

| # | Requirement | Implementation | Test | Runtime evidence | Status |
|---|---|---|---|---|---|
| 1 | Reproducible SigNoz installation through Foundry | `casting.yaml` | `scripts/verify-signoz.sh` | phase-02 | DONE |
| 2 | Repository contains `casting.yaml` and `casting.yaml.lock` | repository root | reproducibility check | phase-02 | DONE |
| 3 | SigNoz MCP Server enabled and reachable | `casting.yaml` `spec.mcp` | `packages/test-fixtures/src/signoz.signoz.integration.test.ts` | phase-02 | DONE |
| 4 | Claude Code can connect to the SigNoz MCP Server | `docs/RUNBOOK.md` section 3 | documented manual step; the same endpoint, transport and header are exercised by the SDK integration tests | phase-02 | DONE |
| 5 | FlightRules backend connects using an official MCP client | `packages/signoz-mcp` | MCP client integration tests | phase-00 (proven), phase-05 | IN PROGRESS |
| 6 | Instrumented refund-agent demo emits traces, metrics and logs | `apps/demo-*`, `packages/telemetry` | telemetry integration tests | phase-04 | PENDING |
| 7 | Baseline and canary releases distinguishable via attributes | `packages/telemetry` | field discovery test | phase-04 | PENDING |
| 8 | Complete trace trees fetched and reconstructed | `packages/trace-graph` | reconstruction tests | phase-00 (proven), phase-06 | IN PROGRESS |
| 9 | Trace nodes deduplicated by span ID | `packages/trace-graph` | duplicate-span tests | phase-06 | PENDING |
| 10 | Dynamic identifiers normalised | `packages/normaliser` | normalisation property tests | phase-06 | PENDING |
| 11 | Baseline route families captured from range or release | `packages/baseline-miner` | mining tests | phase-08 | PENDING |
| 12 | Versioned YAML contract proposed, reviewed, validated, stored, evaluated | `packages/contract-schema`, `packages/contract-engine` | schema and lifecycle tests | phase-07, phase-09 | PENDING |
| 13 | All P0 rule types work | `packages/contract-engine` | per-rule passing and failing fixtures | phase-07 | PENDING |
| 14 | Deterministic pass/fail decisions and typed violations | `packages/contract-engine` | determinism property tests | phase-07 | PENDING |
| 15 | Evaluation telemetry emitted back to SigNoz | `packages/telemetry` | OTLP export test | phase-00 (path proven), phase-09 | IN PROGRESS |
| 16 | SigNoz dashboard created through MCP with real data | `packages/artifact-compiler` | dashboard data test | phase-10 | PENDING |
| 17 | At least one saved SigNoz trace view created through MCP | `packages/artifact-compiler` | view read-back test | phase-00 (proven), phase-10 | IN PROGRESS |
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
| FR-003 | Trace discovery | `packages/signoz-mcp` | MCP integration tests | phase-05 | PENDING |
| FR-004 | Trace graph reconstruction | `packages/trace-graph` | reconstruction tests | phase-06 | PENDING |
| FR-005 | Name and attribute normalisation | `packages/normaliser` | normalisation tests | phase-06 | PENDING |
| FR-006 | Canonical route fingerprint | `packages/trace-graph` | fingerprint property tests | phase-06 | PENDING |
| FR-007 | Baseline capture | `packages/baseline-miner` | mining tests | phase-08 | PENDING |
| FR-008 | Contract proposal | `packages/baseline-miner` | proposal tests | phase-08 | PENDING |
| FR-009 | Contract schema validation | `packages/contract-schema` | schema rejection tests | phase-07 | PENDING |
| FR-010 | Run evaluation | `packages/contract-engine` | evaluation tests | phase-07 | PENDING |
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
