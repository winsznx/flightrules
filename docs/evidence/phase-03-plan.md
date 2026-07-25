# Phase 03 plan — Deterministic demo system

Branch: `phase/03-demo-system`
Date: 2026-07-25

## Objective (PRD section 21, Phase 03)

Build a real distributed refund-agent topology that can produce approved and unsafe routes.

## Entry criteria check

| Criterion | Status |
|---|---|
| Phase 02 status `PASS`, merged | Satisfied |
| SigNoz deployed and verified | Satisfied |
| `main` green | Satisfied |

## Scope boundary

**No OpenTelemetry in this phase.** The PRD exit gate is that the topology reliably creates one
safe route and one unsafe route *before telemetry is added*. Instrumentation is Phase 04.

## Tasks (PRD Phase 03 list)

1. Policy service. 2. Order service. 3. Fraud service. 4. Payment service with an idempotency
ledger. 5. Notification service. 6. Demo agent orchestrator. 7. Provider interface
(scripted, anthropic optional, openai optional). 8. `refund-agent-v1` approved route.
9. `refund-agent-v2` unsafe route. 10. Materially identical customer answer from both.
11. Deterministic fault injection for payment timeout and duplicate write. 12. Reset endpoints
restricted to demo mode. 13. Request and run identifiers. 14. Compose services and health checks.

## The duplicate side effect must be real

PRD section 28 names this as the risk most likely to look artificial. The response is a real
timeout-and-retry path, not a counter:

1. The payment service commits the ledger write **first**.
2. Under the injected fault it then holds the response past the caller's deadline.
3. The caller's `AbortController` fires. Money has moved; the caller cannot know it.
4. The unsafe release retries with a regenerated idempotency key.
5. The service cannot recognise the retry and writes a second entry.

Evidence lives in the payment service's own ledger, queryable independently of telemetry.

## Verification plan

| Check | Expected |
|---|---|
| Each service unit-tested | every service has behavioural tests |
| v1 calls every required service once | asserted on the recorded route |
| v2 skips policy and fraud | asserted |
| v2 calls payment twice | asserted, with the first attempt recorded as a timeout |
| Payment service records the duplicate | two ledger entries, two distinct key hashes |
| Customer responses equivalent | byte-identical message asserted |
| Reset returns a known state | ledger and notifications empty |
| No LLM API key required | scripted provider is the default and the only one tests use |
