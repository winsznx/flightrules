# OpenTelemetry attribute register

Every attribute FlightRules or its demo emits is registered here with its type, source,
stability, cardinality risk, privacy classification, an example, and the package that owns it.

Stability values are taken from the installed `@opentelemetry/semantic-conventions@1.43.0`
package, not from memory:

- **stable** — exported from `@opentelemetry/semantic-conventions`.
- **experimental** — exported only from `@opentelemetry/semantic-conventions/incubating`.
- **flightrules** — no released convention exists; FlightRules owns the name.

Cardinality risk is judged against metric label sets. Attributes marked **high** must never
become metric dimensions (PRD section 17.4).

Privacy classification:

- **safe** — structural or enumerated metadata, no user or business content.
- **pseudonymous** — a one-way hash of a value that is never stored in the clear.
- **forbidden** — must never be emitted on the default product path.

---

## 1. Resource attributes

| Attribute | Type | Source | Stability | Cardinality | Privacy | Example | Owning package |
|---|---|---|---|---|---|---|---|
| `service.name` | string | OTel | stable | low | safe | `payment-service` | `packages/telemetry` |
| `service.version` | string | OTel | stable | low | safe | `1.4.0` | `packages/telemetry` |
| `service.instance.id` | string | OTel | experimental | medium | safe | `payment-service-0` | `packages/telemetry` |
| `deployment.environment.name` | string | OTel | experimental | low | safe | `production` | `packages/telemetry` |
| `vcs.ref.head.revision` | string | OTel | experimental | low | safe | `9a3c1f2…` | `packages/telemetry` |
| `vcs.commit.sha` | string | PRD 17.2 | flightrules | low | safe | `9a3c1f2…` | `packages/telemetry` |

`vcs.commit.sha` is not a released OpenTelemetry attribute (SL-031). The released name is
`vcs.ref.head.revision`. Both are emitted with the same value: the released convention because
PRD principle 3 and section 17.1 require standard names where they exist, and the PRD-named
attribute because section 17.2 lists it as a required demo attribute. See ADR-0004.

## 2. GenAI attributes

Every attribute in this section is **experimental**. None is used as the sole evidence for a
critical contract rule.

| Attribute | Type | Source | Stability | Cardinality | Privacy | Example | Owning package |
|---|---|---|---|---|---|---|---|
| `gen_ai.operation.name` | string | OTel | experimental | low | safe | `execute_tool` | `packages/telemetry` |
| `gen_ai.workflow.name` | string | OTel | experimental | low | safe | `refund-workflow` | `packages/telemetry` |
| `gen_ai.agent.name` | string | OTel | experimental | low | safe | `refund-agent` | `packages/telemetry` |
| `gen_ai.tool.name` | string | OTel | experimental | low | safe | `issue_refund` | `apps/demo-agent` |
| `gen_ai.tool.type` | string | OTel | experimental | low | safe | `function` | `apps/demo-agent` |
| `gen_ai.provider.name` | string | OTel | experimental | low | safe | `anthropic` | `apps/demo-agent` |
| `gen_ai.request.model` | string | OTel | experimental | low | safe | `claude-sonnet-5` | `apps/demo-agent` |
| `gen_ai.response.model` | string | OTel | experimental | low | safe | `claude-sonnet-5` | `apps/demo-agent` |
| `gen_ai.usage.input_tokens` | int | OTel | experimental | n/a (value) | safe | `812` | `apps/demo-agent` |
| `gen_ai.usage.output_tokens` | int | OTel | experimental | n/a (value) | safe | `144` | `apps/demo-agent` |
| `error.type` | string | OTel | stable | low | safe | `timeout` | `packages/telemetry` |

### Forbidden GenAI attributes

These exist in the released registry but are **never** emitted on the default product path
(PRD section 17.6). The demo proves trajectory enforcement works without them.

`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`,
`gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.tool.definitions`,
`gen_ai.prompt`, `gen_ai.completion`, `gen_ai.retrieval.documents`,
`gen_ai.retrieval.query.text`, `gen_ai.evaluation.explanation`.

A redaction test asserts that no span exported by the demo carries any of these keys.

## 3. Demo agent attributes (`agent.*`)

PRD section 17.2 reserves `agent.*` for application-specific agent metadata where no stable
standard exists.

| Attribute | Type | Source | Stability | Cardinality | Privacy | Example | Owning package |
|---|---|---|---|---|---|---|---|
| `agent.release.id` | string | PRD 17.2 | flightrules | low | safe | `refund-agent-v2` | `apps/demo-agent` |
| `agent.run.id` | string | PRD 17.2 | flightrules | **high** | safe | `run_01JAB…` | `apps/demo-agent` |
| `agent.step.category` | string | PRD 17.2 | flightrules | low | safe | `policy` | `apps/demo-agent` |
| `agent.side_effect` | string | PRD 17.2 | flightrules | low | safe | `write` | `apps/demo-*` |
| `agent.data_domain` | string | PRD 17.2 | flightrules | low | safe | `payments` | `apps/demo-*` |
| `agent.retry.number` | int | PRD 17.2 | flightrules | low | safe | `1` | `apps/demo-*` |
| `agent.idempotency.present` | bool | PRD 17.2 | flightrules | low | safe | `true` | `apps/demo-services/payment-service` |
| `agent.idempotency.key_hash` | string | PRD 17.2 | flightrules | **high** | pseudonymous | `sha256:3f9a…` | `apps/demo-services/payment-service` |
| `agent.contract.id` | string | PRD 17.2 | flightrules | low | safe | `refund-agent-production` | `apps/demo-agent` |
| `agent.scenario` | string | PRD 17.2 | flightrules | low | safe | `unsafe-duplicate-refund` | `apps/demo-agent` |

`agent.side_effect` is constrained to `none`, `read`, `write`, `external`, `unknown`
(PRD section 11.2).

`agent.idempotency.key_hash` is a keyed one-way hash. The raw idempotency key is never emitted,
never logged, and never stored (PRD section 17.2).

`agent.run.id` and `agent.idempotency.key_hash` are span attributes only. Neither may appear in
a metric label set.

## 4. FlightRules evaluator attributes (`flight_rules.*`)

| Attribute | Type | Source | Stability | Cardinality | Privacy | Example | Owning package |
|---|---|---|---|---|---|---|---|
| `flight_rules.project.id` | string | PRD 17.3 | flightrules | low | safe | `demo-commerce` | `packages/telemetry` |
| `flight_rules.agent.id` | string | PRD 17.3 | flightrules | low | safe | `refund-agent` | `packages/telemetry` |
| `flight_rules.contract.id` | string | PRD 17.3 | flightrules | low | safe | `refund-agent-production` | `packages/telemetry` |
| `flight_rules.contract.version` | string | PRD 17.3 | flightrules | low | safe | `1.0.0` | `packages/telemetry` |
| `flight_rules.release.id` | string | PRD 17.3 | flightrules | low | safe | `refund-agent-v2` | `packages/telemetry` |
| `flight_rules.evaluation.id` | string | PRD 17.3 | flightrules | **high** | safe | `019f97…` | `packages/telemetry` |
| `flight_rules.evaluation.status` | string | PRD 17.3 | flightrules | low | safe | `fail` | `packages/telemetry` |
| `flight_rules.violation.count` | int | PRD 17.3 | flightrules | n/a (value) | safe | `3` | `packages/telemetry` |
| `flight_rules.route.fingerprint` | string | PRD 17.3 | flightrules | **high** | safe | `sha256:1c2b…` | `packages/telemetry` |
| `flight_rules.route.similarity` | double | PRD 17.3 | flightrules | n/a (value) | safe | `0.71` | `packages/telemetry` |
| `flight_rules.gate.decision` | string | PRD 17.3 | flightrules | low | safe | `fail` | `packages/telemetry` |
| `flight_rules.rule.id` | string | derived | flightrules | low | safe | `require-fraud-check` | `packages/telemetry` |
| `flight_rules.rule.type` | string | derived | flightrules | low | safe | `required_span` | `packages/telemetry` |
| `flight_rules.violation.severity` | string | derived | flightrules | low | safe | `critical` | `packages/telemetry` |
| `flight_rules.artifact.type` | string | derived | flightrules | low | safe | `dashboard` | `packages/telemetry` |
| `flight_rules.normaliser.version` | string | derived | flightrules | low | safe | `1` | `packages/telemetry` |
| `flight_rules.evaluator.version` | string | derived | flightrules | low | safe | `1` | `packages/telemetry` |

## 5. Spans emitted by FlightRules

Names are fixed by PRD section 17.3.

| Span name | Emitted by | Required attributes |
|---|---|---|
| `flight_rules.fetch_traces` | worker | project, agent, release |
| `flight_rules.reconstruct_trace` | worker | project, agent, route fingerprint |
| `flight_rules.normalise_graph` | worker | project, agent, normaliser version |
| `flight_rules.mine_baseline` | worker | project, agent |
| `flight_rules.propose_contract` | worker | project, agent, contract id |
| `flight_rules.evaluate_run` | worker | project, agent, contract id and version, evaluation id, status, violation count, route fingerprint, route similarity |
| `flight_rules.evaluate_release` | worker | project, agent, contract, release, evaluation id, status, violation count |
| `flight_rules.compile_signoz_artifacts` | worker | project, agent, artifact type |
| `flight_rules.release_gate` | worker, CLI | project, agent, contract, release, gate decision |

## 6. Metrics emitted by FlightRules

Instrument names follow PRD section 17.4. Every dimension below is low cardinality; no
identifier from section 3 or 4 marked **high** is used as a metric label.

| Instrument | Kind | Unit | Dimensions |
|---|---|---|---|
| `flight_rules.evaluations` | counter | `{evaluation}` | project, agent, release, status, scope |
| `flight_rules.evaluation.duration` | histogram | `ms` | project, agent, scope |
| `flight_rules.violations` | counter | `{violation}` | project, agent, release, rule type, severity |
| `flight_rules.unknown_routes` | counter | `{run}` | project, agent, release |
| `flight_rules.duplicate_side_effects` | counter | `{occurrence}` | project, agent, release |
| `flight_rules.release_gate.decisions` | counter | `{decision}` | project, agent, release, decision |
| `flight_rules.trace_fetch.failures` | counter | `{failure}` | project, agent, error type |
| `flight_rules.signoz_artifact_sync` | counter | `{sync}` | project, agent, artifact type, status |
| `flight_rules.route.similarity` | histogram | `1` | project, agent, release |

`release` is bounded in the demo (two values). In `external-agent` mode the release dimension
is subject to a configurable allowlist and falls back to `other` beyond it, so an unbounded
release stream cannot explode metric cardinality.

## 7. Log fields

PRD section 17.5. Structured JSON in all non-development environments.

`timestamp`, `level`, `service.name`, `message`, `request_id`, `trace_id`, `span_id`, `job_id`,
`evaluation_id`, `error.code`.

Redaction removes any field whose key matches the secret patterns (`*key*`, `*token*`,
`*secret*`, `*password*`, `authorization`) before serialisation, and the SigNoz API key value
is registered with the log redactor at startup so it cannot leak through an interpolated string.

## 8. Metric label safety rules

Forbidden as metric labels, without exception: trace IDs, span IDs, route fingerprints,
evaluation IDs, run IDs, idempotency key hashes, full error messages, user identifiers, raw
prompts, URLs containing dynamic segments.

A unit test enumerates every metric instrument's declared dimension set and fails if any
attribute registered as **high** cardinality appears in it.
