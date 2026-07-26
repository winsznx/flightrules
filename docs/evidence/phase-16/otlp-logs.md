# Phase 16 — OTLP log export, proven against the running SigNoz

Closes the handoff's unresolved limitation 1: *"Logs are not exported over OTLP … the Violation
Inspector's log panel is always `empty`. This is the single largest honest gap in the evidence
chain."*

Run 2026-07-26 against SigNoz v0.134.0, collector v0.144.6, MCP server v0.9.0.

---

## The part that was not obvious

The Violation Inspector correlates logs **strictly by the trace identifier the evaluator recorded**
(`apps/api/src/routes/violation-evidence.ts`), and that identifier belongs to a **demo run**, not to
FlightRules.

So exporting the API's and the worker's logs would have closed nothing. The only processes inside a
failing refund trace are `flightrules-demo-agent` and the five demo services. If they do not export,
the panel stays empty for every real violation no matter how much FlightRules itself logs.

That is why `registerServiceSpans` in `packages/telemetry/src/fastify.ts` now emits one correlated
record per instrumented request, and why the payment service writes the ledger line the demo reveal
turns to — after the commit and before the injected delay, so a timed-out first attempt still
records the refund it really wrote.

## What was built

| Where | What |
|---|---|
| `packages/telemetry/src/logs.ts` | `startLogPipeline` — `LoggerProvider` + `BatchLogRecordProcessor` + `OTLPLogExporter` to `/v1/logs`. `createStructuredLogger` writes one JSON line to stdout **and** emits one correlated record. `createOtlpLogStream` is a pino destination, so Fastify keeps its serialisers, redact paths and request-identifier plumbing. |
| `packages/telemetry/src/sdk.ts` | `logs` option on `startTelemetry`, flushed and shut down with the rest. |
| `packages/telemetry/src/bootstrap.ts` | on by default — every process this starts already writes structured logs, and a process whose logs stop at stdout contributes nothing to a violation's evidence. |
| `packages/telemetry/src/fastify.ts` | one correlated record per instrumented demo-service request, emitted with the request's own span context because `onResponse` runs outside the context `onRequest` established. |
| `apps/demo-services/payment-service/src/app.ts` | the refund ledger line, carrying the **salted hash** of the idempotency key and never the key. |
| `apps/worker/src/index.ts`, `apps/api/src/index.ts` | wired to the shared logger and the pino destination. |

Correlation is never passed in. `Logger.emit` reads the active context, so a line written inside a
span is correlated without the call site knowing anything about tracing — a call site that had to
pass a trace ID would eventually forget.

## Live proof

`GET /api/violations/:id/logs` for the duplicate-refund violation of a real `refund-agent-v2` run:

```text
state: ok | traceId: e5223e4acdcac7ebaf20470fae497199 | logs: 5

2026-07-26T05:34:41.283Z INFO flightrules-notification-service  customer step customer.notify.handler completed with 200
2026-07-26T05:34:41.279Z INFO flightrules-payment-service       refund committed to the payment ledger
2026-07-26T05:34:41.279Z INFO flightrules-payment-service       payment step payment.refund.handler completed with 200
2026-07-26T05:34:40.475Z INFO flightrules-payment-service       refund committed to the payment ledger
2026-07-26T05:34:40.471Z INFO flightrules-order-service         order step order.lookup.handler completed with 200
```

**Two `refund committed to the payment ledger` lines in one trace.** The duplicate side effect, in
the payment service's own words, next to the trace that proves it.

`make verify-telemetry`, which re-runs this against the live deployment:

```text
Exported logs
  ok    5 log record(s) correlate to trace e5223e4acdcac7ebaf20470fae497199
  ok    every returned record carries the trace identifier
  ok    service names present: flightrules-notification-service, flightrules-order-service, flightrules-payment-service
  ok    5 record(s) also carry a span identifier
  ok    no prompt, tool-argument or tool-result key appears in any record
  ok    no credential appears in any log body
```

The raw record, read straight back out of SigNoz through `signoz_search_logs`:

```json
{
  "body": "refund committed to the payment ledger",
  "trace_id": "29ca77f332bb467fe3a2c7f19845f892",
  "span_id": "40dd7d72fb5269a8",
  "severity_text": "INFO",
  "resources_string": { "service.name": "flightrules-payment-service" },
  "attributes_string": {
    "idempotency_key_hash": "sha256:e75ad13033866021afc23f49ada975da",
    "order_id": "ord-98271",
    "refund_id": "rfnd_09ef08f4fd4a49a0b311",
    "run_id": "run_112e7666533340f98efc"
  },
  "attributes_number": { "amount_cents": 4820, "attempt": 2, "refunds_for_run": 2 }
}
```

`refunds_for_run: 2` on attempt 2, with a **different** `idempotency_key_hash` from attempt 1 —
which is exactly why the retry duplicated rather than deduplicated.

## A second defect the live proof exposed

The first end-to-end read returned the right bodies with **no timestamp and no service name**. A log
row is not shaped like a span row: `data.timestamp` is nanoseconds as a *number*, not the ISO string
the row carries alongside `data`, and `service.name` is a *resource* attribute under
`resources_string` rather than a flat column. `apps/api/src/signoz.ts` now reads both from where a
log row keeps them.

This is the reason the verification is a live query rather than a unit test: a mock shaped like the
implementation would have agreed with the bug.

## Privacy

Log attributes and bodies pass through the same forbidden-key register the span redactor uses, plus
the secret-value redactor, **before any processor sees them** — so no exporter can observe an
unredacted record.

- a forbidden GenAI key is **dropped**, not redacted: a `[redacted]` value would still record that
  the product collected a prompt;
- a secret-shaped key keeps its name and loses its value;
- a registered secret is replaced wherever it appears inside a string, not only under a suspicious
  key;
- token *measurements* survive, because a release decision needs them.

Twelve tests in `packages/telemetry/src/logs.test.ts`, against a real `LoggerProvider` and a real
in-memory exporter rather than a spy. The correlation test registers the AsyncLocalStorage context
manager exactly as `startTelemetry` does, because without it the API's default context manager is a
no-op and `context.with` never propagates — which is what made the first version of that test fail.

## Remaining limitation

The API's own pino lines reach SigNoz but carry **no** trace ID. Under ESM every static import is
evaluated before any statement in the module body, so by the time `bootstrapFromEnv` runs Fastify
has already loaded `node:http` and the HTTP instrumentation has nothing left to patch — the same
constraint documented in `packages/telemetry/src/fastify.ts`. FlightRules' own request logs are
therefore searchable by service and time but not joinable to a trace.

This does not affect the Violation Inspector, which correlates on demo traces. Fixing it needs a
`--import` preload, which adds a moving part to the reproducibility path; it is recorded here rather
than worked around.
