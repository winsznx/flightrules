# Phase 11 result — Release evaluation, CLI, and GitHub gate

```text
PHASE: 11 — Release evaluation, CLI, and GitHub gate
STATUS: PASS
BRANCH: phase/11-release-gate
COMMITS: see docs/evidence/phase-11-commits.md
SOURCES VERIFIED: PRD Phase 11 (line 3239), FR-011, FR-012, PRD 10.5, 11.11, 12.3, 13, 15.7, 19,
                  20.1, 22; the pinned runtime for every claim below (SigNoz v0.134.0, MCP v0.9.0,
                  Node 24.14.1, PostgreSQL 16). No new external capability was required, so no new
                  source-lock entry was needed.
IMPLEMENTED:      packages/contract-engine/src/release.ts (pure release aggregation);
                  packages/contract-engine/src/exit-codes.ts (the FR-012 table);
                  packages/trace-graph/src/measure.ts (retryCountOf);
                  packages/db/src/repositories/gate.ts (the gate's reads);
                  GET /api/releases/:releaseId/gate; apps/cli (six commands, JSON mode, exit codes);
                  .github/workflows/release-gate.yml; scripts/seed-demo.sh; scripts/demo-full.sh;
                  make cli/demo-seed/demo-full/gate/gate-json/evidence; ADR-0010; one inherited
                  redaction defect fixed
TESTS RUN:        make verify; make test; make test-integration;
                  pnpm exec vitest run --project integration-signoz
                  packages/test-fixtures/src/phase-11.signoz.integration.test.ts
TEST RESULT:      1,090 unit passed (50 files); 234 integration passed (15 files); 1,324 total;
                  0 failed, 0 skipped
RUNTIME VALIDATION: see "Runtime validation" below
EVIDENCE:         docs/evidence/phase-11-plan.md, docs/evidence/phase-11/live-state.txt,
                  docs/evidence/phase-11/cli-inventory.md,
                  docs/evidence/phase-11/baseline-gate.json,
                  docs/evidence/phase-11/canary-gate.json, docs/adr/0010-…md
KNOWN LIMITATIONS: see "Known limitations" below
NEXT PHASE ENTRY CRITERIA: SATISFIED
```

---

## The exit gate, proven live

**A release pipeline can fail because of trajectory evidence from SigNoz.**

Everything below was observed against the running pinned stack, from an empty application database,
using only the product's own API and CLI. The consolidated capture is
`docs/evidence/phase-11/live-state.txt`.

| Step | Result |
|---|---|
| 25 known-good `refund-agent-v1` runs emitted | real OTLP telemetry through the demo topology |
| project, agent, baseline, contract, artefacts seeded through the API | `make demo-seed` |
| baseline mined from live SigNoz traces | `bl-b24f8f29ddf321376481eef95257407a`, one route family at `43070aa4…`, 106 runs |
| contract proposed, validated, approved, activated | `019f9b46-8158-70c8-a618-12db57d733e0`, content hash `42c4e1a3…` |
| ten managed SigNoz artefacts | `{"total": 10, "synced": 10, "drifted": 0, "failed": 0, "conflict": 0}` |
| `flightrules release evaluate --release refund-agent-v1` | 106 runs, 0 violations, status `pass` |
| **`flightrules gate check --release refund-agent-v1`** | **`PASS`, exit `0`** |
| 8 unsafe `refund-agent-v2` runs emitted | real telemetry |
| `flightrules release evaluate --release refund-agent-v2` | 8 runs, 80 violations, 24 zero-tolerance, 8 duplicate side effects, status `fail` |
| **`flightrules gate check --release refund-agent-v2`** | **`FAIL`, exit `2`** |
| the same gate after killing and restarting the API | identical `decisionHash`, still exit `2` |
| `GET /api/releases/:id/gate` | the same decision the CLI printed, `exitCode: 2` |

### What the canary was caught doing

```text
violation rate           100.000000%   (limit 0.5%)
unknown route rate       100.000000%   (limit 1%)
latency change          2593.750000%   (32 ms -> 862 ms, limit 20%)
zero-tolerance rules     require-fraud-check, require-policy-retrieve, single-payment-refund-write
findings                 ZERO_TOLERANCE_VIOLATION, VIOLATION_RATE_EXCEEDED,
                         UNKNOWN_ROUTE_RATE_EXCEEDED, LATENCY_REGRESSION_EXCEEDED,
                         RELEASE_BUDGET_EXCEEDED, MIN_RUNS_NOT_MET
representative traces    010b8d74e8ba968c4a8a194679ab7fb7, 2735b2599b9cde94b459481140d9b2de,
                         74b622b27307b575afe32150f37eb45f, b4c6e6be146a9f03cf9e2e63c2c13e32,
                         b9bff0ced7d10b5a58d8da6d58e369af
decision hash            6e398ff8a320c58f94cd7e45b469a96fbafcc61fad629d7542b1677848a123be
```

The canary produced **both** `MIN_RUNS_NOT_MET` (8 runs against a minimum of 20) and
`ZERO_TOLERANCE_VIOLATION`, and the decision is `fail`, exit `2`. That is the precedence rule of
ADR-0010 working on real data: a proven violation is not downgraded to "not enough evidence".

The approved release's decision hash is
`6d91e3869aa93ff4d20f21fe0c50720d8083f835d9dee0fb88fb3c02bcfef420`.

---

## Live integration suite

`packages/test-fixtures/src/phase-11.signoz.integration.test.ts`, 8 tests, all passing against the
live stack. It builds its own project from an empty schema, mines its own contract from live
`refund-agent-v1` traces, and then asserts:

1. the approved release passes with exit code `0` over at least the minimum runs
2. the unsafe canary fails with exit code `2`, naming the zero-tolerance rules it broke
3. unknown routes and missing prerequisites are counted separately
4. the latency regression is measured against the mined baseline's own family statistics
5. reading the gate twice returns the identical decision hash
6. a completely new API over the same database returns the identical decision hash
7. a release nothing has evaluated is a typed refusal, never an empty pass
8. no credential, no raw MCP payload and no database column name appears in the response

---

## Defect found in inherited work, and fixed

**The domain redactor destroyed FlightRules' own token measurements.**

`SECRET_KEY_PATTERNS` contains `/token/i`. That matched `maxTokenRegressionPercent` and `tokens`, so
the live gate returned:

```json
"gate": { "maxTokenRegressionPercent": "[redacted]" },
"changes": { "tokens": "[redacted]" }
```

A security control was silently corrupting part of a release decision. It was found by running the
gate against live data — no unit test could have caught it, because every test that exercised the
redactor used credential-shaped keys.

"token" is both a credential noun and this product's unit of LLM usage. The fix is an exact-name
allowlist of the twelve measurement keys FlightRules itself emits, rather than a cleverer pattern:
"token followed by a plural" would also admit `access_tokens`, and the cost of getting a redaction
rule subtly wrong is a leaked credential. Tests assert that `accessToken`, `refresh_token`,
`bearerToken`, `id_token`, `session_token`, `token` and `API_TOKEN` still redact.

This also means every earlier surface that carried token statistics — the baseline miner's
distributions, the Phase 10 dashboard's token panel — was redacting them. Those are now correct too.

## Second defect, in the Phase 10 recovery procedure

The runbook documented `make signoz-purge` then `make signoz-sync` as the recovery for a rebuilt
database. It did not work: the `signoz_sync` job is idempotent on the contract's content, so the
request after a purge returned the *previous* job's cached conflict result and nothing was ever
recreated. Deleting the remote resources alone therefore left the deployment permanently unsyncable.

`make signoz-purge` now also clears the project's register rows and its completed sync jobs. Proven
live: `cleared 10 register row(s) and 1 sync job(s)`, then a sync creating and verifying all ten.

---

## Tests

Phase 11 added **129 unit tests** and **25 integration tests**:

| Suite | Count | What it covers |
|---|---|---|
| `packages/contract-engine/src/release.test.ts` | 35 | zero runs, below the minimum, all passing, one non-zero-tolerance violation, one zero-tolerance violation, multiple severities, only deferred, mixed pass and insufficient, stale, truncated, superseded contract, mismatched contract version, duplicate records, repeated aggregation, order independence, every rate against hand-computed rationals, release rules resolved / not measured / partially measured, regression with and without a baseline |
| `packages/contract-engine/src/exit-codes.test.ts` | 9 | the literal table, every decision, every error code, nothing but a pass returns `0`, `1` reserved |
| `apps/cli/src/cli.test.ts` | 49 | argument parsing and rejection, all six commands, every exit code, non-JSON responses, schema drift, API/CLI exit-code disagreement, stream discipline, the GitHub summary, redaction |
| `packages/test-fixtures/src/release-gate-workflow.test.ts` | 14 | lockfile install, pinned toolchain, real dependencies, exit `2` asserted specifically, no swallowed failure, no secret, no `.env` upload, pinned action versions, local reproduction path |
| `packages/trace-graph/src/measure.test.ts` | 5 | attempt index versus retry count |
| `packages/baseline-miner/src/percentile-parity.test.ts` | 3 | the miner and the gate compute a percentile identically, including a 300-run property |
| `packages/domain/src/redaction.test.ts` | +14 | the token fix, in both directions |
| `apps/api/src/gate.integration.test.ts` | 17 | the route over a real database, restart, concurrency, staleness, truncation, history, filtering, no raw row |
| `packages/test-fixtures/src/phase-11.signoz.integration.test.ts` | 8 | the live exit gate |

```text
make verify              exit 0
make test                1,090 passed, 0 failed, 0 skipped   (50 files)
make test-integration    234 passed, 0 failed, 0 skipped     (15 files)
                         ---
                         1,324 tests passed
```

---

## Known limitations

1. **The GitHub workflow has not been executed on GitHub.** Its shape is asserted by 14 tests and
   every command in it is the command `make demo-full` runs locally, which reproduced the required
   `0` then `2`. The behavioural claim rests on the local run and the live integration suite; the
   workflow's own run history will exist once the branch is pushed.
2. **Token regression is disclosed rather than measured** for the demo agent, which makes no model
   call and therefore emits no `gen_ai.usage.*` attribute. The gate reports
   `TOKEN_REGRESSION_NOT_MEASURED` rather than treating the absence as a pass.
3. **Retry change is disclosed rather than measured** on the demo baseline, whose approved family
   carries no retries, so there is no non-zero baseline to compare against.
4. **`evaluationTimeoutSeconds` bounds the evaluation that already ran**, not a live wait. The CLI's
   `--timeout` bounds the wait; the contract's timeout is applied to the recorded duration of the
   evaluation the gate reads. Both are enforced; they are different clocks.
5. **A project-wide gate does not exist.** The gate is per release, which is what FR-012 specifies.
6. **Alert recovery is still not evidenced** (inherited from Phase 10, a Phase 16 item).
7. **Logs are still not exported over OTLP** (inherited, a Phase 16 item).

---

## Next phase: 12 — UI foundation and `design.md` integration

Entry criteria: `design.md` exists at the repository root; the product API is stable and
self-describing through `GET /api/openapi.json`; every route PRD section 8 requires data for now
exists, including the gate.
