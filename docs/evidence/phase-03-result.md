# Phase 03 result — Deterministic demo system

Branch: `phase/03-demo-system`
Date: 2026-07-25

## Objective and entry criteria

PRD Phase 03: build a real distributed refund-agent topology that can produce approved and unsafe
routes, **before telemetry is added**. Entry criteria satisfied: Phase 02 `PASS` and merged, the
SigNoz stack deployed and verified, `main` green.

## What was built

```text
apps/demo-services/policy-service        refund policy by order value band
apps/demo-services/order-service         fixed order dataset
apps/demo-services/fraud-service         deterministic risk scoring
apps/demo-services/payment-service       refund ledger with idempotency
apps/demo-services/notification-service  the customer-facing message
apps/demo-agent                          orchestrator, provider interface, typed clients
Dockerfile.demo                          one pinned multi-stage build for all six containers
compose.app.yaml                         six services, health-gated, dependency-ordered
scripts/run-demo-v1.sh, run-demo-v2.sh, reset-demo.sh
packages/domain/src/trace.ts             side-effect, edge-type, severity and status vocabulary
```

No OpenTelemetry anywhere. That is Phase 04, and the exit gate for this phase is explicitly that
the topology produces the two routes *before* telemetry exists.

### The two routes

| | `refund-agent-v1` (approved) | `refund-agent-v2` (unsafe) |
|---|---|---|
| Route | `policy.retrieve → order.lookup → fraud.check → refund.calculate → payment.refund → customer.notify` | `order.lookup → payment.refund → payment.refund → customer.notify` |
| Payment attempts | 1 | 2 |
| Idempotency key on retry | n/a | regenerated |
| Ledger entries per run | 1 | 2 |
| Customer message | identical | identical |

### How the duplicate side effect is real

This is the part the PRD singles out as most likely to look artificial, so it is worth being
precise about what actually happens.

1. The agent calls `POST /payments/refund` with an 800 ms `AbortController` deadline.
2. The payment service **commits the ledger entry first**, then — under
   `fault: "slow_first_attempt"` on attempt 1 — holds the response for 2,500 ms.
3. The agent's deadline expires. `fetch` aborts. The client raises `ServiceTimeoutError`. Money has
   already moved, and the agent has no way to know that.
4. The agent retries with a **regenerated** idempotency key.
5. The payment service has never seen that key, so it writes a second entry.

The timeout is a real aborted HTTP request, not a thrown fixture. The duplicate is a real second
row in the service's own ledger, queryable at `GET /payments/ledger/run/:runId` independently of
any telemetry. `v1` sends a stable key derived from the run and order and injects no fault, so it
writes exactly once.

## Commands run and results

| Command | Exit | Result |
|---|---|---|
| `pnpm run typecheck` | 0 | clean across 11 workspace projects |
| `make test` | 0 | **137 unit tests passed** |
| `make test-integration` | 0 | **40 integration tests passed** |
| `make verify` | 0 | complete suite green |
| `docker compose up -d --build --wait` | 0 | all seven containers Healthy |
| `bash scripts/run-demo-v1.sh` | 0 | approved route, 1 payment attempt |
| `bash scripts/run-demo-v2.sh` | 0 | unsafe route, 2 payment attempts, 1 timeout |
| `DEMO_RUNS=20 bash scripts/run-demo-v1.sh` | 0 | 20 completed runs |
| `bash scripts/reset-demo.sh` | 0 | ledger and notifications cleared |

Total: **177 tests passed, 0 failed, 0 skipped** (137 unit, 8 database integration, 32 SigNoz
integration).

## Runtime validation against the containerised topology

### v1, live

```text
release: refund-agent-v1 | attempts: 1 | scenario: approved-refund
route:   policy.retrieve -> order.lookup -> fraud.check -> refund.calculate -> payment.refund -> customer.notify
message: Your refund of 48.20 USD has been issued and will appear on your original payment method within 3-5 business days.
ledger:  refundCount 1, duplicate false
```

### v2, live

```text
release: refund-agent-v2 | attempts: 2 | scenario: unsafe-duplicate-refund
route:   order.lookup(ok,a1) -> payment.refund(timeout,a1) -> payment.refund(ok,a2) -> customer.notify(ok,a1)
message: Your refund of 48.20 USD has been issued and will appear on your original payment method within 3-5 business days.
ledger:  refundCount 2, duplicate true
         rfnd_6e00fee880324ebb8921  attempt 1  keyHash sha256:47ee7bc2…
         rfnd_88ca6cf9fea54221b482  attempt 2  keyHash sha256:3dc06554…
```

The two messages are byte-identical. The two routes are not. Two different refunds were issued
against one order, with two different idempotency key hashes.

### Baseline seeding

```text
20 v1 runs   -> 20 ledger entries, 0 duplicate side effects
+1 v2 run    -> 22 ledger entries, 1 duplicate side effect
                run run_0c41af1ddabd418286da  order ord-98271  count 2
```

## Failures discovered and how they were resolved

### 1. Duplicate detection counted across the ledger's lifetime, not per run

The first implementation grouped ledger entries by `orderId` alone. Seeding 20 legitimate baseline
runs against the same order produced 20 entries for `ord-98271`, and the service reported that as
a duplicated side effect.

This was caught by actually running the baseline seed rather than by a test, because every test
until then used a single run. It would have made the release gate fire on the approved release —
a false violation on every seeded baseline, which is worse than missing the real one.

Resolution: `LedgerEntry` now carries `runId`, and `duplicatedSideEffects()` groups by
`(runId, orderId)`. The unsafe behaviour is "this refund was issued twice", not "this order has
been refunded before". Two regression tests were added: five approved runs against one order
report zero duplicates, and one unsafe run among approved runs reports exactly one, matched to
that run's identifier. Re-verified live: 20 v1 runs → 0 duplicates, +1 v2 run → 1 duplicate.

### 2. `apps/demo-services/*` were outside the Vitest unit project

The include pattern was `apps/*/src/**/*.test.ts`, which does not match the nested
`apps/demo-services/<name>/src/`. Forty-seven passing tests were being collected as zero. Fixed by
adding the nested pattern; the count moved from 70 to 117 immediately.

Worth recording because the suite reported green the whole time it was silently running nothing.

### 3. Fastify reply typing in the demo-mode guard

The `denyOutsideDemoMode` helper was typed via `Parameters<…>` indirection, which resolved to
`never` under `exactOptionalPropertyTypes`. Replaced with an explicit `FastifyReply` parameter and
return type.

## Determinism

Every input to a run is fixed: the order dataset is a literal map, the fraud score is a SHA-256 of
the order and customer, the policy is a pure function of the value band, and the customer message
is a pure function of the amount and currency. Repeated runs of the same release produce the same
route, asserted by test. Only the run identifier, the refund identifiers and the timestamps differ.

The `slow_first_attempt` fault is triggered by an explicit field on the request, not by load or
timing luck, so the v2 timeout happens on every run rather than most of them.

## Provider interface

`ScriptedProvider` is the canonical automated demo and needs no API key; `RUNTIME_MODE` defaults to
`scripted-demo` and every test uses it. `createProvider("anthropic" | "openai")` **throws** with a
message explaining what is required. Returning a plausible plan without calling the provider would
be a fabricated integration, and the PRD's rule against replacing a required integration with a
mock cuts both ways: a mock that pretends to be the real provider is worse than an honest failure.

Token usage is deliberately `undefined` in scripted mode. The PRD permits bounded deterministic
fixture values or absent fields, clearly labelled; inventing plausible token counts would be
fabricated telemetry.

## Demo mode enforcement

Every mutation route — `/agent/refund`, `/agent/seed`, `/payments/reset`,
`/notifications/reset` — returns HTTP 403 `DEMO_DISABLED` when `DEMO_MODE` is not `true`. Tested in
both directions on the payment and notification services and on the agent.

## Privacy

The raw idempotency key is never stored, returned or logged. The ledger holds a salted one-way
hash; the public ledger endpoint exposes `idempotencyKeyPresent` and the hash prefix only. Two
tests assert that a key value passed in does not appear in the serialised ledger or the HTTP
response body.

## Known limitations

1. The payment ledger is in-process memory. Correct for a deterministic demo, and it makes reset
   trivial; it means a container restart clears it. Persistence is not a P0 requirement, and the
   PRD stores authoritative evidence in SigNoz.
2. Live provider adapters throw rather than call Anthropic or OpenAI. `live-provider-demo` is a P1
   item and is not required for product correctness.
3. `docs/DEMO_SCRIPT.md` does not exist yet; it is a Phase 17 deliverable.
4. No telemetry is emitted. That is the correct state for this phase's exit gate and is the whole
   subject of Phase 04.
5. The high-value order `ord-98271-hv` exercises the alternate policy band but is not part of the
   canonical demo path.

---

```text
PHASE: 03 Deterministic demo system
STATUS: PASS
BRANCH: phase/03-demo-system
COMMITS: <filled at commit>
SOURCES VERIFIED: no new external technical claims; the phase uses only Fastify 5.10.0 and Zod 4.4.3, both already pinned and recorded in SL-034
IMPLEMENTED: five demo services (policy, order, fraud, payment with an idempotency ledger, notification); the refund-agent orchestrator with a provider interface and runtime-validated typed clients; refund-agent-v1 approved route and refund-agent-v2 unsafe route returning a materially identical customer answer; a real timeout-and-retry path producing a genuine duplicate ledger write; demo-mode-restricted reset endpoints; run and request identifiers; a shared pinned Dockerfile and six health-gated Compose services; run-demo-v1, run-demo-v2 and reset-demo scripts; the domain trace vocabulary
TESTS RUN: pnpm run typecheck; make test; make test-integration; make verify; docker compose up -d --build --wait; scripts/run-demo-v1.sh; scripts/run-demo-v2.sh; DEMO_RUNS=20 scripts/run-demo-v1.sh; scripts/reset-demo.sh
TEST RESULT: passed 177, failed 0, skipped 0 (137 unit, 8 database integration, 32 SigNoz integration). Three defects were found and fixed during the phase: duplicate detection scoped to the order rather than the run, demo-service tests silently not being collected, and a Fastify reply type resolving to never.
RUNTIME VALIDATION: all seven containers built and reached Healthy. v1 ran the six-step approved route with one payment attempt and one ledger entry. v2 ran the four-step unsafe route, genuinely timed out on the first payment attempt after the service had already committed the write, retried with a regenerated idempotency key, and produced two distinct refund identifiers with two distinct key hashes against one order. Both releases returned a byte-identical customer message. Twenty seeded v1 runs produced twenty ledger entries and zero duplicate side effects; appending one v2 run produced exactly one, attributed to that run's identifier. Reset returned the ledger and notification store to empty.
EVIDENCE: docs/evidence/phase-03-plan.md; docs/evidence/phase-03-result.md
KNOWN LIMITATIONS: five, listed above. None blocks Phase 04.
NEXT PHASE ENTRY CRITERIA: SATISFIED
```
