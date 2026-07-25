# Phase 09 result — Application core, API, jobs, and persistence

Branch: `phase/09-application-core`
Date: 2026-07-25

## What was built

Two applications and one grown package, exactly as PRD section 13 names them.

```text
apps/api        Fastify. Every Phase 09 route of PRD section 15, the typed error envelope,
                request identifiers, structured logs, cursor pagination, generated OpenAPI.
apps/worker     The job runner: claim, lease, progress, atomic commit, retry classification,
                cancellation, lease recovery, graceful shutdown, and four job handlers.
packages/db     Migration 0003 (thirteen tables), ten repositories, canonical JSON, the
                cursor, the schema-compatibility check, and the shared job input contract.
packages/telemetry  Metric emission (PRD section 17.4, FR-016), previously declared only.
packages/domain     Three additional error codes; see ADR-0008 decision 10.
```

Nothing deterministic was reimplemented. Mining is `mineBaseline`, proposal is `proposeContract`,
evaluation is `evaluateRun`, validation is `parseContract`, canonicalisation is
`canonicaliseGraph` and `canonicalContract`. The applications fetch, persist and expose.

## The twelve PRD tasks

| # | Task | Where | Proven by |
|---|---|---|---|
| 1 | All P0 tables and migrations | `packages/db/migrations/0003_application_core.sql` | `schema.integration.test.ts` — all sixteen present, constraints and indexes asserted by name |
| 2 | Projects and agents | `repositories/projects.ts`, `agents.ts`, `routes/core.ts` | `api.integration.test.ts` — FR-001 duplicate slug, FR-002 missing release discriminator |
| 3 | SigNoz connection setup | `routes/core.ts`, `apps/api/src/signoz.ts` | live: capability snapshot stored, `api_key_secret_reference = env:SIGNOZ_API_KEY` |
| 4 | Jobs with idempotency | `repositories/jobs.ts`, `apps/worker/src/runner.ts` | `jobs.integration.test.ts` — 24 assertions including concurrent duplicate submission |
| 5 | Baselines and route decisions | `repositories/baselines.ts`, `routes/lifecycle.ts` | live: 76 runs mined into one approved family |
| 6 | Contract lifecycle | `repositories/contracts.ts`, `routes/lifecycle.ts` | `lifecycle.integration.test.ts` + live activation |
| 7 | Evaluations and violations | `repositories/evaluations.ts`, `apps/worker/src/handlers.ts` | live: v1 pass 0 violations, v2 fail 40 violations |
| 8 | Audit events | `repositories/audit.ts` | live: 13 events across 11 types, one per lifecycle transition |
| 9 | Progress events | `jobs.progress_json`, `WORKER_STAGES` | `jobs.integration.test.ts` monotonic guard; live: 5 mining stages recorded in order |
| 10 | Typed error envelope | `apps/api/src/http.ts` | `config.test.ts` — every code has a status; `api.integration.test.ts` — the envelope shape |
| 11 | API documentation generated from source | `apps/api/src/registry.ts` | `api.integration.test.ts` — every registered route appears, no more and no fewer |
| 12 | Request IDs and tracing | `apps/api/src/app.ts` | `api.integration.test.ts` — echoed header, bounded caller-supplied value |

## The sixteen tables

Three from migration `0001`, thirteen from `0003`. `0001` and `0002` were not edited.

```text
0001  projects  signoz_connections  audit_events
0003  agents  releases  jobs  trace_runs  trace_graphs  baseline_versions  route_families
      contracts  contract_rules  evaluations  run_evaluations  violations  signoz_artifacts
```

Full column, constraint and index inventory: `docs/evidence/phase-09/schema-inventory.md`.

## The two applications

| | `apps/api` | `apps/worker` |
|---|---|---|
| Entrypoint | `src/index.ts` | `src/index.ts` |
| Local / production | `pnpm --filter @flightrules/api dev` / `node dist/index.js` | `pnpm --filter @flightrules/worker dev` / `node dist/index.js` |
| Config boundary | `loadApiConfig` | `loadWorkerConfig` |
| Readiness | database answers **and** every migration applied | schema check before the first claim |
| Shutdown | drain in-flight, close pool, bounded timeout | finish the active job, then close |
| Refuses to start on | invalid config, missing migration | invalid config, missing migration, heartbeat ≥ lease |

Neither migrates at startup. `make db-migrate` owns that.

## Runtime validation

Reproduce with:

```bash
set -a && . ./.env && set +a
make up && make db-migrate
DEMO_RUNS=25 make demo-v1 && make demo-v2
pnpm exec vitest run --project integration-signoz \
  packages/test-fixtures/src/phase-09.signoz.integration.test.ts
```

The full persisted state after that run is committed at `docs/evidence/phase-09/live-state.txt`.

### The chain, end to end, with nothing simulated

```text
POST /api/setup/signoz/verify   -> capability snapshot stored, satisfied = true
POST /api/agents/:id/baselines  -> job accepted; a repeated identical request returned the same
                                   job id and created = false
worker claims                   -> mineBaseline over the live MCP Query Builder path
                                   stages: discovering_traces, fetching_span_trees,
                                           normalising_routes, grouping_route_families,
                                           proposing_contract_rules
commit                          -> baseline bl-cf6572c61a7a36b5f789198d0f8f1511
                                   selection hash cf6572c6...9b5c, 76 eligible runs, 1 family,
                                   truncated = false, 80 trace_runs and 80 trace_graphs
POST .../route-families/:id/approve -> family approved, baseline status approved
POST .../propose-contract       -> job accepted
worker claims                   -> re-mines the stored selection, asserts the identity and the
                                   family fingerprints still match, proposes, emits YAML,
                                   re-parses it through the Phase 07 validator
commit                          -> contract refund-agent-local 0.1.0, status draft, source mined,
                                   28 rules, 9 zero-tolerance, every rule carrying its evidence
POST /api/contracts/:id/approve -> approved
POST /api/contracts/:id/activate-> active
POST /api/agents/:id/evaluations (refund-agent-v1) -> pass, 5 runs, 0 violations
POST /api/agents/:id/evaluations (refund-agent-v2) -> fail, 4 runs, 40 violations,
                                                      12 zero-tolerance
GET  /api/violations/:id/evidence -> trace id, span ids, contract id and version, rule key,
                                     evaluator version
restart                          -> a new API over the same database serves the baseline, the
                                    active contract and every evaluation unchanged
```

### The route family

```text
fingerprint  43070aa4af4f6c2c912a8d7bcc724f1d199e0425dc8ad7256b528eec195cb037
```

This is the same fingerprint Phase 06 recorded, Phase 07's committed contract approves and Phase 08
mined. Persistence did not change it, which is the point of the canonical round trip.

### The canary's violations, as stored

```text
CARDINALITY_ABOVE_MAX              critical  zero-tolerance   4
REQUIRED_SPAN_MISSING              critical  zero-tolerance   8
REQUIRED_SPAN_MISSING              high                       4
REQUIRED_SPAN_TOO_MANY             high                       4
RETRY_BUDGET_PER_TOOL_EXCEEDED     high                       4
RETRY_BUDGET_RUN_TOTAL_EXCEEDED    high                       4
RETRY_BUDGET_SIDE_EFFECT_EXCEEDED  high                       4
ROUTE_NOT_APPROVED                 high                       4
NUMERIC_BUDGET_EXCEEDED            medium                     4
```

Ten violations per canary run over four runs, three of them critical and zero-tolerance per run:
the missing policy check, the missing fraud check and the duplicate refund. Identical to what
Phase 08 reported before anything was persisted.

### Audit history (FR-019)

```text
signoz.connection.verified 1   baseline.requested 1   baseline.created 1
route_family.approved 1        contract.proposal.requested 1
contract.created 1             contract.approved 1    contract.activated 1
evaluation.requested 2         evaluation.completed 2  demo.reset 1
```

Every audit row is written by the transaction that made the change, which an integration test
proves by rolling one back.

## Commands run

```text
make verify              exit 0
make test-integration    exit 0
make db-migrate          applied: 0003
make signoz-verify       exit 0   (on entry)
DEMO_RUNS=25 make demo-v1, make demo-v2   exit 0
```

## Test result

```text
make test              894 passed, 0 failed, 0 skipped   (42 files)
make test-integration  191 passed, 0 failed, 0 skipped   (12 files)
                       ---
                       1,085 tests passed
```

Integration breakdown: 102 database, 89 SigNoz. Phase 09 added **132** tests: 32 unit, 100
integration (94 database, 6 live SigNoz).

Contract documents validated by `make contract-validate`: 20, unchanged.

## Concurrency, idempotency and recovery evidence

| Property | Test | Result |
|---|---|---|
| Two workers never run one job | `jobs.integration.test.ts`, `runner.integration.test.ts` | exactly one claim; the other returns idle, not an error |
| Two workers share a queue | `runner.integration.test.ts` | two jobs, two workers, both executed once |
| Concurrent duplicate submission | `jobs.integration.test.ts`, `api.integration.test.ts` | one row, one job id, `created` true exactly once |
| Same key, different input | `jobs.integration.test.ts` | typed conflict, not a silent reuse |
| Repeat after terminal success | `jobs.integration.test.ts` | returns the finished job; no second computation |
| Output commits with success | `jobs.integration.test.ts`, `runner.integration.test.ts` | a crash after producing output leaves nothing |
| Lost lease cannot complete | `jobs.integration.test.ts` | refused; the job stays running for its real owner |
| Stale lease recovery | `jobs.integration.test.ts` | requeued while attempts remain, failed terminally after |
| Maximum attempts | `jobs.integration.test.ts`, `runner.integration.test.ts` | stops at the ceiling and is no longer claimable |
| Progress monotonicity | `jobs.integration.test.ts` | a replayed stage is a no-op, not a regression |
| Cancellation during execution | `runner.integration.test.ts` | transitions to cancelled, no partial commit |
| Shutdown with work in flight | `runner.integration.test.ts` | the active job finishes; nothing further is claimed |
| Restart preserves state | `api.integration.test.ts`, live | a new server over the same database serves everything |

## Performance measured on the supported local environment

| Operation | Measurement |
|---|---|
| `make db-migrate` from an empty database | under 1 s (three migrations) |
| Database integration suite (102 tests, six schema rebuilds) | ~11 s |
| Live end-to-end gate (mine 76 runs, propose, activate, evaluate twice) | ~14 s |
| Job submission (API, including the idempotency read) | within the 500 ms p95 target |
| Job claim | one statement; the partial index `jobs_claimable_idx` covers its predicate |

PRD section 20.2's targets are targets until measured under load; these are the figures observed.

## Redaction and security evidence

- The SigNoz API key never reaches the database: `signoz_connections.api_key_secret_reference`
  holds `env:SIGNOZ_API_KEY`, asserted both in the API integration test and live.
- An unexpected error's message never reaches a stored job failure. A test throws a connection
  string and asserts the stored failure says only "The job failed with an unexpected error."
- Pino redaction covers `authorization`, `signoz-api-key`, `x-api-key`, `cookie`, `set-cookie`,
  `apiKey`, `password`, `databaseUrl`, `DATABASE_URL`, `SIGNOZ_API_KEY`.
- Every response passes through `redact` before serialisation.
- Body size is bounded by `MAX_REQUEST_BODY_BYTES` and an over-limit body returns the typed
  envelope, not Fastify's default shape.
- Every query is parameterised; no SQL is built by concatenating untrusted input. The one
  caller-influenced string that is not a bound parameter is the SigNoz preview filter, whose values
  are length-bounded by the request schema and quote-escaped.
- A caller-supplied `x-request-id` is accepted only when it matches `[A-Za-z0-9._-]{1,128}`.
- Demo mutation routes return `DEMO_DISABLED` with HTTP 403 unless `DEMO_MODE=true`.
- Page size is capped at 100; an invalid or foreign cursor is refused.

## Defects found and fixed during the phase

1. **`postgres` types a pool and a transaction as unrelated interfaces.** `TransactionSql` does not
   extend `Sql`; both extend `ISql`. Repository functions initially took `Sql` and could not be
   called inside `sql.begin`, which would have forced a duplicate query per repository. Fixed by
   taking `Db = ISql` everywhere a repository is called and reserving `Sql` for the pool.
2. **A `logger: false | {…}` union changed the whole Fastify server type.** Fastify selects its
   HTTP/2 overload when the logger option is a union, and every `FastifyReply` in the file then
   failed to match. Fixed by always passing an options object and using `level: "silent"`.
3. **A `jsonb` round trip reorders object keys**, so a canonical graph read from a row would not
   serialise to the bytes its stored fingerprint was taken over. Found by writing the round-trip
   assertion first. Fixed by `readCanonicalGraph`, and asserted by byte equality rather than by
   structural equality.

## Known limitations

1. **`POST /api/setup/signoz/sync-artifacts` and `POST /api/contracts/:id/sync-signoz` are not
   registered.** PRD Phase 10 owns artefact compilation. The `signoz_artifacts` table and its reads
   exist, because PRD section 16.5 requires a list before a create.
2. **`GET /api/releases/:id/gate` is not registered** — PRD Phase 11.
3. **`GET /api/releases/:id/diff` is not registered** — PRD Phase 14.
4. **A contract proposal re-mines its selection** rather than reading stored runs, because PRD
   section 14.5 stores canonical evidence and refetches raw traces. If a trace ages out of SigNoz
   between mining and proposal the job fails with `TRACE_INCOMPLETE` rather than proposing from a
   different dataset. ADR-0008 decision 8.
5. **Release-scoped budgets remain `deferred`** at run scope (Phase 07 limitation, unchanged) until
   the Phase 11 aggregation.
6. **Logs are structured but are not exported to SigNoz over OTLP.** They are written as structured
   JSON to stdout with the fields PRD section 17.5 requires; the OTLP log exporter is available in
   `packages/telemetry`'s dependencies and wiring it is a small, separate change.
7. **No authentication.** PRD section 6.1 scopes P0 to local mode; PRD section 15 defines no
   authentication surface. `DEPLOYMENT_MODE=hosted` still activates the SigNoz URL control.
8. **A demo run job is not idempotent by default**, because a demo run genuinely produces new
   telemetry each time. The caller may supply a `runKey` to make one; without it the request time is
   used, which makes each submission a distinct job rather than a silent no-op.
9. **`make demo-reset` and `POST /api/demo/reset` are separate.** The endpoint clears FlightRules
   application data for the demo project and reseeds it; the script also resets the demo services.

## Source-lock additions

**SL-052** — `postgres@3.4.9` types `Sql` and `TransactionSql` as siblings, not parent and child.

## Acceptance matrix changes

- FR-001, FR-002, FR-016, FR-017, FR-018, FR-019 → DONE
- FR-020 → IN PROGRESS (the API surface exists; the full demo reveal is Phase 17)
- P0 scope item 6 → DONE (metrics now emitted)
- P0 scope item 12 → DONE (storage landed)
- P0 scope item 15 → DONE (evaluation telemetry emitted)

## Commit hashes

Recorded in `docs/evidence/phase-09-commits.md` after the merge.

---

```text
PHASE: 09 — Application core, API, jobs, and persistence
STATUS: PASS
BRANCH: phase/09-application-core
COMMITS: see docs/evidence/phase-09-commits.md
SOURCES VERIFIED: 9 — docs/PRD.md sections 12.3, 13, 14, 15, 17, 18, 19, 20.1; ADR-0006; ADR-0007;
  docs/research/source-lock.md SL-044, SL-046, SL-050, SL-051; postgres@3.4.9 installed types;
  PostgreSQL 16 runtime behaviour probed directly; zod 4.4.3 `toJSONSchema` probed directly;
  Fastify 5.10.0 installed types
IMPLEMENTED: migration 0003 with the thirteen remaining P0 tables; ten repositories; canonical JSON
  and canonical-graph read restoration; cursor pagination; schema-compatibility check; apps/api with
  every Phase 09 route, the typed error envelope, request identifiers, structured redacted logging
  and a generated OpenAPI document; apps/worker with race-safe claiming, leases, monotonic progress,
  atomic result commit, retry classification, cancellation, lease recovery and graceful shutdown;
  four job handlers calling the existing deterministic packages; metric emission
TESTS RUN: make verify; make test-integration; the live SigNoz gate
TEST RESULT: 894 unit passed, 191 integration passed, 0 failed, 0 skipped (1,085 total)
RUNTIME VALIDATION: against the live stack — SigNoz verified through MCP; 76 known-good runs mined
  into one route family at 43070aa4…; baseline, families, 80 trace runs and 80 canonical graphs
  persisted transactionally; a human approval recorded; a 28-rule draft contract proposed, accepted
  by the Phase 07 validator and stored with every rule's evidence basis; approved and activated;
  a fresh v1 evaluation passed with 0 violations; the canary failed with 40 violations including
  12 zero-tolerance; every violation resolvable to its trace evidence through the API; a repeated
  identical submission returned the same job; a restarted API served all of it unchanged
EVIDENCE: docs/evidence/phase-09-plan.md, docs/evidence/phase-09-result.md,
  docs/evidence/phase-09/schema-inventory.md, docs/evidence/phase-09/live-state.txt,
  docs/adr/0008-application-core-persistence-and-jobs.md
KNOWN LIMITATIONS: nine, listed above; every one is a PRD phase assignment or a stated boundary
NEXT PHASE ENTRY CRITERIA: SATISFIED
```
