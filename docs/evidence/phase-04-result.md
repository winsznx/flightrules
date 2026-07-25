# Phase 04 result — OpenTelemetry instrumentation

Branch: `phase/04-telemetry`
Date: 2026-07-25

## What was built

```text
packages/telemetry/src/attributes.ts   every attribute name, imported from the installed conventions
packages/telemetry/src/sdk.ts          provider, OTLP export, forbidden-attribute redactor
packages/telemetry/src/fastify.ts      explicit server spans with incoming context extraction
packages/telemetry/src/bootstrap.ts    per-service startup from the environment
packages/telemetry/src/metrics.ts      declared instruments and their permitted dimension sets
apps/demo-agent/src/instrumentation.ts run span, step spans, outbound context propagation
```

Every demo service and the agent now emit spans. `compose.app.yaml` points each container at the
Foundry-deployed collector via `host.docker.internal:4318`.

## Runtime validation — complete distributed traces retrieved from SigNoz

Both traces below were emitted by the containerised topology, ingested by the Foundry-deployed
collector, and read back through the SigNoz MCP Server with `signoz_execute_builder_query`.

### v1, trace `964a5a69cdaaf72f34463adfe9246e21` — 12 spans, 6 services

```text
refund.request            flightrules-demo-agent           ROOT   se=none      rel=refund-agent-v1
policy.retrieve           flightrules-demo-agent           child  se=read      retry=0
policy.retrieve.handler   flightrules-policy-service       child  se=read
order.lookup              flightrules-demo-agent           child  se=read      retry=0
order.lookup.handler      flightrules-order-service        child  se=read
fraud.check               flightrules-demo-agent           child  se=read      retry=0
fraud.check.handler       flightrules-fraud-service        child  se=read
refund.calculate          flightrules-demo-agent           child  se=none      retry=0
payment.refund            flightrules-demo-agent           child  se=write     retry=0
payment.refund.handler    flightrules-payment-service      child  se=write     retry=0
customer.notify           flightrules-demo-agent           child  se=external  retry=0
customer.notify.handler   flightrules-notification-service child  se=external

tools: calculate_refund, check_fraud, issue_refund, lookup_order, notify_customer, retrieve_policy
```

### v2, trace `4cfbba79d5aff4729fb34e0d6e461c48` — 8 spans, 4 services

```text
refund.request            flightrules-demo-agent           ROOT   se=none      rel=refund-agent-v2
order.lookup              flightrules-demo-agent           child  se=read      retry=0
order.lookup.handler      flightrules-order-service        child  se=read
payment.refund            flightrules-demo-agent           child  se=write     retry=0
payment.refund            flightrules-demo-agent           child  se=write     retry=1
payment.refund.handler    flightrules-payment-service      child  se=write     retry=1
customer.notify           flightrules-demo-agent           child  se=external  retry=0
customer.notify.handler   flightrules-notification-service child  se=external

tools: issue_refund, lookup_order, notify_customer
```

The regression is visible in the telemetry itself, without reading any application state:

- `flightrules-policy-service` and `flightrules-fraud-service` are **absent from v2's service set**.
- Two `payment.refund` spans carry `agent.side_effect=write` with `agent.retry.number` 0 and 1.
- The tool set shrinks from six tools to three.

Release, run, side effect, data domain, retry number, step category, scenario and
`gen_ai.tool.name` were all retrievable as selected fields, so every attribute a contract rule
needs is queryable.

## Commands run and results

| Command | Exit | Result |
|---|---|---|
| `pnpm run typecheck` | 0 | clean |
| `make test` | 0 | **153 unit tests passed** |
| `make test-integration` | 0 | **40 integration tests passed** |
| `make verify` | 0 | complete suite green |
| `docker compose up -d --build --wait` | 0 | seven containers Healthy |

Total: **193 tests passed, 0 failed, 0 skipped**.

## Failures discovered and how they were resolved

### 1. HTTP auto-instrumentation cannot work under ESM here

The first implementation called `registerInstrumentations` from a bootstrap function invoked at
the top of each service entrypoint. No service span appeared. `signoz_list_services` showed only
`flightrules-demo-agent` had trace activity.

Cause: under ESM every static import in a module is evaluated before any statement in that
module's body. By the time `bootstrapFromEnv()` runs, `./app.js` has already loaded Fastify, which
has already loaded `node:http`. The patch has nothing left to patch.

Resolution: explicit server spans via `registerServiceSpans`, a Fastify hook pair that extracts
incoming trace context with `propagation.extract` and starts a `SERVER` span carrying the step's
contract-relevant attributes. Working around the ordering problem with a `--import` preload or
loader hooks would add a moving part to the reproducibility path for no benefit — these are our
services, and an explicit span is both deterministic and able to carry attributes auto-
instrumentation would never know to add. Verified: all six services now appear in v1's trace.

### 2. The verification script, not the product, was reporting zero spans

After the fix the traces still appeared empty. The cause was in the checking script:
`signoz_execute_builder_query` returns its payload as text content with **no**
`structuredContent` for these queries, and the script read `structuredContent` only. The Phase 00
proof had used `structuredContent ?? JSON.parse(textOf(res))`; the newer script dropped the
fallback.

Recorded because it was very nearly misdiagnosed as an instrumentation failure. The MCP client
built in Phase 05 must handle both response shapes, and its tests must cover the text-only case.

### 3. `payment.refund.handler` for the timed-out attempt is not exported

**Not resolved. Documented as a limitation.**

In v2 the agent makes two payment calls but only one `payment.refund.handler` server span appears,
for attempt 2. The attempt-1 handler span is started and never ended, so it is never exported:
the client aborts while the handler is still inside its injected delay, so `onResponse` never
fires. An `onRequestAbort` hook was added and did **not** fix it — the hook does not fire for a
handler already in flight in Fastify 5.10.0.

Impact assessed rather than assumed:

- **Duplicate side-effect detection is unaffected.** It is driven by the two client-side
  `payment.refund` spans, both `agent.side_effect=write`, with `agent.retry.number` 0 and 1. Both
  are present in the trace.
- **Required-prerequisite detection is unaffected.** It depends on the policy and fraud spans,
  which are absent from v2 for the right reason.
- What is lost is the payment service's own server-side record of the aborted attempt. That
  evidence remains available out of band in the service's ledger, which records both writes.

This is a genuine property of aborted requests, not an artefact of the demo, and it is exactly the
kind of incomplete-trace condition the PRD requires FlightRules to handle explicitly rather than
paper over. Phase 06 must treat a client span with no matching server span as a trace-quality
warning, not as evidence of absence. Carried forward as a Phase 06 requirement and a Phase 16
investigation item.

## Privacy

The `ForbiddenAttributeRedactor` runs first in the processor chain and strips every key in
`FORBIDDEN_TELEMETRY_KEYS` at span start and span end. Tested in both directions: a span carrying
all eleven forbidden keys exports with none of them and with its safe attributes intact, and a
span with none is passed through untouched with an empty removal list.

The payment service annotates its span with `agent.idempotency.present` and the salted
`agent.idempotency.key_hash`. The raw key never leaves the service.

Token usage is absent in scripted mode rather than invented.

## Metric cardinality

`METRIC_SPECS` declares all nine instruments with their permitted dimension sets as data, and a
test cross-references every dimension against the high-cardinality register. `agent.run.id`,
`agent.idempotency.key_hash`, `flight_rules.evaluation.id` and `flight_rules.route.fingerprint`
are span attributes only. A second test asserts no dimension name matches `trace|span|fingerprint|
evaluation.id|run.id`.

## Known limitations

1. The timed-out attempt's server span is not exported. See finding 3 above; detection is
   unaffected and the condition is carried into Phase 06 as an explicit requirement.
2. Metrics and logs are declared but not yet emitted. `METRIC_SPECS` defines the instruments and
   their dimensions, and the cardinality safety test runs against them, but no meter is wired up
   because there is nothing to count until the evaluator exists in Phase 07. Pino log correlation
   lands with the API in Phase 09.
3. Containers reach the collector via `host.docker.internal`, which works on Docker Desktop. A
   Linux CI host needs the `host-gateway` extra host, which is configured, but this has not been
   exercised on Linux.
4. Only the agent and demo services are instrumented. FlightRules' own `flight_rules.*` spans are
   defined in `SPAN_NAMES` and emitted from Phase 07 onward.

---

```text
PHASE: 04 OpenTelemetry instrumentation
STATUS: PASS
BRANCH: phase/04-telemetry
COMMITS: 4d392b06b0e3e2e0c6650cd2e861083afc5e2df7 (phase), a4101caab8e91e19c6adcb389c985c0ded35effa (merge to main)
SOURCES VERIFIED: SL-029 to SL-032 re-confirmed against the installed packages at runtime; attribute names are imported from @opentelemetry/semantic-conventions and its /incubating entry point rather than written as literals, so the stability of every name is verified by construction
IMPLEMENTED: packages/telemetry with the attribute register in code, OTLP trace export, a forbidden-attribute redacting span processor, explicit Fastify server-span instrumentation with incoming context extraction, per-service bootstrap, and declared metric instruments with permitted dimension sets; agent run spans and per-step tool spans; outbound W3C trace context propagation; OTLP configuration for all six demo containers
TESTS RUN: pnpm run typecheck; make test; make test-integration; make verify; docker compose up -d --build --wait; live v1 and v2 runs; MCP retrieval of both traces
TEST RESULT: passed 193, failed 0, skipped 0 (153 unit, 8 database integration, 32 SigNoz integration). Two defects were found and fixed (ESM ordering defeating HTTP auto-instrumentation, and a verification script that read only structuredContent). One defect was found, attempted, and left unresolved with its impact assessed and documented.
RUNTIME VALIDATION: the v1 run produced a complete 12-span distributed trace spanning all six services, retrieved from SigNoz through signoz_execute_builder_query with release, run, side-effect, data-domain, retry-number, step-category and gen_ai.tool.name all present as selected fields. The v2 run produced an 8-span trace over four services, with flightrules-policy-service and flightrules-fraud-service absent and two payment.refund spans carrying agent.side_effect=write at agent.retry.number 0 and 1. The behavioural regression is visible in the telemetry alone.
EVIDENCE: docs/evidence/phase-04-plan.md; docs/evidence/phase-04-result.md
KNOWN LIMITATIONS: four, listed above. Limitation 1 is carried into Phase 06 as an explicit trace-quality requirement. None blocks Phase 05.
NEXT PHASE ENTRY CRITERIA: SATISFIED
```
