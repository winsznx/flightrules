# Phase 04 plan — OpenTelemetry instrumentation

Branch: `phase/04-telemetry` · Date: 2026-07-25

## Objective (PRD section 21, Phase 04)

Emit complete traces, metrics and logs from the demo and FlightRules services into SigNoz.

## Entry criteria

Phase 03 `PASS` and merged; SigNoz deployed, bootstrapped and verified; `main` green.

## Approach

- Attribute names are **imported** from the installed `@opentelemetry/semantic-conventions`
  packages, never written as literals, so the import path states each name's stability.
- Every `gen_ai.*` attribute comes from `/incubating` because none is stable (SL-030).
- `vcs.ref.head.revision` and `vcs.commit.sha` are both emitted (ADR-0004).
- Forbidden prompt and tool-content keys are stripped by a span processor, not merely avoided.
- Metric instruments declare their dimension sets as data so a test can prove no high-cardinality
  attribute is used as a label.

## Verification plan

| Check | Expected |
|---|---|
| v1 appears as one complete distributed trace | all six services in one trace |
| v2 appears as one complete distributed trace | policy and fraud services absent |
| All services appear under expected names | `flightrules-*` |
| Release and environment queryable | selectable as tag fields |
| Tool names and operations queryable | `gen_ai.tool.name` selectable |
| No raw prompts, tool arguments, tool results or idempotency keys | redaction test, both directions |
| Automated test inspects exported spans through an in-memory exporter | redaction test |
| Integration test confirms telemetry in SigNoz through MCP | live retrieval of both traces |
