# ADR-0004 — Telemetry attribute conventions and the PRD/OpenTelemetry name conflict

- Status: Accepted
- Date: 2026-07-25
- Phase: 00
- Related: SL-029, SL-030, SL-031, SL-032

## Context

PRD section 17.1 lists expected standard fields and immediately requires: "Claude must verify
exact released names and stability before implementation." PRD principle 3 requires standard
attributes where standards exist and clearly namespaced custom attributes where they do not.

The installed `@opentelemetry/semantic-conventions@1.43.0` package was enumerated directly.

## Findings

**1. Every `gen_ai.*` attribute is experimental.** The stable entry point exports 659 symbols,
of which **zero** are `gen_ai.*`. All 60 GenAI attributes — including
`gen_ai.operation.name`, `gen_ai.workflow.name`, `gen_ai.agent.name`, `gen_ai.tool.name`,
`gen_ai.tool.type`, `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`, every one of
which the PRD lists — are exported only from `@opentelemetry/semantic-conventions/incubating`.

`deployment.environment.name` and `service.instance.id`, also listed by the PRD as expected
standard fields, are likewise experimental. Only `service.name`, `service.version` and
`error.type` are stable.

**2. `vcs.commit.sha` is not a released OpenTelemetry attribute.** PRD section 17.2 lists it as
a required demo attribute. The released VCS registry contains `vcs.ref.head.revision`,
`vcs.ref.head.name`, `vcs.repository.ref.revision` and related names — but no `vcs.commit.sha`.

**3. GenAI metric names exist but do not fit.** The released GenAI instruments are
`gen_ai.client.operation.duration`, `gen_ai.client.token.usage`, `gen_ai.server.request.duration`
and four siblings, all experimental. None describes contract evaluation or release gating.

## Decision 1 — Use experimental GenAI attributes, but declare them experimental and never let a critical rule depend on one alone

The PRD requires these attribute names and the demo topology is an AI agent workflow, so using
them is correct. Pretending they are stable would not be.

Therefore:

- They are imported from `@opentelemetry/semantic-conventions/incubating`, so the import path
  itself states the stability at every call site.
- Every one is marked **experimental** in `docs/research/otel-attributes.md`.
- **No `critical`-severity contract rule may depend solely on the presence of an experimental
  attribute.** If an experimental attribute a rule needs is absent from every span in an
  otherwise complete trace, the run evaluates to `INSUFFICIENT_EVIDENCE`, not to a violation.
  This is enforced in the evaluator, not left to contract authors: a rule whose only selector
  is an experimental attribute is flagged at contract-validation time.
- The compatibility page surfaces the semantic-conventions version so a judge can see exactly
  which registry the attribute names came from.

The rationale is the PRD's own risk register (section 28, "MCP schema changes" and the trace
completeness risk) plus the explicit requirement that "a trace with insufficient causal evidence
must return `INSUFFICIENT_EVIDENCE` ... It must not be treated as a behavioural violation." A
convention rename must degrade to insufficient evidence, never to a false failed release.

## Decision 2 — Emit both `vcs.ref.head.revision` and `vcs.commit.sha`

Two authorities point in different directions. The PRD is authoritative for product
requirements, and it names `vcs.commit.sha`. The PRD is also authoritative in requiring released
standard names where they exist, and the released name is `vcs.ref.head.revision`.

Resolution: emit **both**, with the same value.

- `vcs.ref.head.revision` — the released OpenTelemetry convention, so the telemetry is portable
  and queryable by any standards-aware tool.
- `vcs.commit.sha` — the PRD-named attribute, so contract selectors and the demo behave exactly
  as the PRD specifies.

Neither authority is weakened, no capability is faked, and the cost is one extra low-cardinality
string per release. Both are recorded in the attribute register with their differing stability.

## Decision 3 — FlightRules' own telemetry uses `flight_rules.*` exclusively

PRD section 17.3 and 17.4 fix the span and metric names. No released convention describes
trajectory contract evaluation, so the namespace is FlightRules' own. GenAI metric instruments
are not reused for evaluator metrics — they mean something else.

## Decision 4 — Privacy is enforced by test, not by convention

PRD section 17.6 forbids `gen_ai.input.messages`, `gen_ai.output.messages`,
`gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, raw prompts, raw tool results and
chain-of-thought on the default product path.

Because these attribute names exist in the registry and are trivially available, "we do not emit
them" is enforced as an assertion: a redaction test drains an in-memory exporter after a full
scripted demo run and fails if any exported span carries any forbidden key, and if any span
attribute value matches the registered secret patterns. The full list of forbidden keys is in
the attribute register.

The raw idempotency key is never emitted. Only a keyed one-way hash
(`agent.idempotency.key_hash`) is, and only as a span attribute — never as a metric label.

## Decision 5 — High-cardinality attributes are structurally excluded from metric labels

`agent.run.id`, `agent.idempotency.key_hash`, `flight_rules.evaluation.id` and
`flight_rules.route.fingerprint` are marked **high** cardinality in the register. Metric
instruments declare their dimension sets in code, and a unit test cross-references those
declarations against the register and fails if any **high** attribute appears. In
`external-agent` mode the release dimension is bounded by an allowlist with an `other` fallback
so an unbounded release stream cannot explode cardinality.

## Consequences

- Positive: the product's telemetry claims match what the installed conventions actually say.
- Positive: a future semantic-convention rename produces `INSUFFICIENT_EVIDENCE` and a visible
  compatibility warning, not a silently wrong release decision.
- Negative: one duplicated VCS attribute. Documented, low cardinality, and cheaper than either
  contradicting the PRD or shipping a non-standard name alone.
- Negative: the "no critical rule on an experimental attribute alone" constraint restricts what
  a mined contract may propose at `critical` severity. The baseline miner therefore proposes
  such rules at `high` severity with an explicit note, and a human may promote them.
