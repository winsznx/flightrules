# FlightRules handoff — after Phase 09

Written: 2026-07-25. `main` is green and the working tree is clean.

This replaces the previous handoff. Verify every claim below against the repository before relying
on it. The previous handoff was verified in full at the start of this session and needed no
corrections; every figure it reported reproduced.

---

## Phase status

| Phase | Status | Phase commit | Merge commit |
|---|---|---|---|
| 00 Source lock and feasibility proof | PASS | `ba600b8` | `1f87df2` |
| 01 Repository foundation and CI | PASS | `9e093da` | `d9052ff` |
| 02 SigNoz deployment through Foundry | PASS | `bb50031` | `3b878ab` |
| 03 Deterministic demo system | PASS | `9a37a88` | `fa172fe` |
| 04 OpenTelemetry instrumentation | PASS | `4d392b0` | `a4101ca` |
| 05 SigNoz MCP client and capability layer | PASS | `074a35a` | `9eda536` |
| 06 Trace graph and normalisation engine | PASS | `7b8e2aa` | `5949148` |
| 07 Contract schema and deterministic evaluator | PASS | `ca4225b` | `12e133b` |
| 08 Baseline mining and contract proposal | PASS | `7706e79` | `494fd8a` |
| 09 Application core, API, jobs, and persistence | PASS | `222c7c0` | `f8e3215` |
| 10–17 | NOT STARTED | — | — |

## Verified state

Every command below was run against the live stack on `main` after the Phase 09 merge.

```text
make verify              exit 0
make signoz-verify       exit 0
make contract-validate   exit 0, 20 contract documents valid
make db-migrate          applied: 0003
make test                895 passed, 0 failed, 0 skipped   (42 files)
make test-integration    191 passed, 0 failed, 0 skipped   (12 files)
                         ---
                         1,086 tests passed
make demo-v1             exit 0 (DEMO_RUNS=25 seeds a batch)
make demo-v2             exit 0
make mine-demo-baseline  exit 0
```

Integration breakdown: 102 database, 89 SigNoz. All fail rather than skip when their dependency is
absent.

## What Phase 09 added

Two applications and one grown package, exactly as PRD section 13 names them.

### `apps/api`

Every Phase 09 route of PRD section 15. The typed error envelope with an exhaustive code-to-status
map. Bounded, echoed request identifiers. Structured logging with declared redaction. Cursor
pagination over the UUIDv7 key. A body-size limit that produces the typed envelope rather than
Fastify's default shape. An OpenAPI document generated from the same route declarations that
register the handlers and validate their responses.

### `apps/worker`

Race-safe claiming (`for update skip locked`), heartbeat leases with recovery, monotonic progress
events, and result commit inside the transaction that marks the job succeeded. Four handlers:
`baseline_mining`, `contract_proposal`, `evaluation`, `demo_run`. None contains a deterministic
algorithm; each calls the existing package.

### `packages/db`

Migration `0003` completing PRD section 14's sixteen tables, ten repositories, canonical JSON,
canonical-graph restoration on read, the cursor, the schema-compatibility check, and the shared job
input contract.

**The exit gate is proven live**: 76 fresh `refund-agent-v1` runs mined through the job system into
one route family at the fingerprint every earlier phase recorded, persisted transactionally with 80
trace runs and 80 canonical graphs; a human approval recorded through the API; a 28-rule draft
contract proposed, accepted by the Phase 07 validator and stored with every rule's evidence basis;
approved and activated; a fresh v1 evaluation passing with 0 violations and the canary failing with
40 violations including 12 zero-tolerance; every violation resolvable to its trace evidence through
the API; a repeated identical submission returning the same job; and a restarted API serving all of
it unchanged.

Reproduce with `DEMO_RUNS=25 make demo-v1 && make demo-v2` then
`pnpm exec vitest run --project integration-signoz packages/test-fixtures/src/phase-09.signoz.integration.test.ts`.
The persisted state is committed at `docs/evidence/phase-09/live-state.txt`.

## Important discoveries

New source-lock entry this session: **SL-052**.

| ID | Finding |
|---|---|
| SL-052 | `postgres@3.4.9` types `Sql` and `TransactionSql` as **siblings**, both extending `ISql`; neither extends the other. A repository function typed to take `Sql` cannot be called with the handle `sql.begin` provides. Every FlightRules repository therefore takes `ISql`, re-exported as `Db`, and `Sql` is reserved for the pool. The same entry records three probed behaviours: `sql(columnsArray)` renders an identifier list in both `select` and `returning`; a nested `` sql`…` `` fragment interpolates; and `sql.json(value)` needs an explicit `::jsonb` cast when it is an operand of `||`. |

## Defects found and fixed

All three were found by writing the assertion before the implementation.

1. **A `jsonb` round trip reorders object keys**, so a canonical graph read from a row would not
   serialise to the bytes its stored fingerprint was taken over. `readCanonicalGraph` restores
   lexicographic attribute order, and the test asserts byte equality of the serialised form.
2. **`postgres` types a pool and a transaction as unrelated interfaces** (SL-052). Without the
   `Db = ISql` split, every repository would have needed a second copy of each query.
3. **A `logger: false | {…}` union changes the whole Fastify server type**, because Fastify then
   selects its HTTP/2 overload. Always pass an options object and use `level: "silent"`.

## Judgement calls to preserve

ADR-0008 holds the full set. The ones a later phase could undo by accident:

1. **Sixteen tables, and no seventeenth.** Progress events live on the `jobs` row as an append-only
   array guarded by a monotonic index, because PRD section 14 fixes the P0 table set.
2. **A ratio is stored as its counts, and a check constraint ties the decimal to them.** A row whose
   displayed share disagrees with its own counts cannot be written.
3. **A canonical graph is re-canonicalised on read.** Do not remove `readCanonicalGraph`; the
   fingerprint depends on attribute key order.
4. **`selectionHash` is the baseline job's identity**, recomputed at the API edge by calling
   `resolveSelection` and `selectionHash` rather than hashing a shape of its own.
5. **A handler never writes its job's outcome.** It returns a commit function the runner runs inside
   the transaction that marks success.
6. **A contract proposal re-mines** rather than reading stored runs, and fails with
   `TRACE_INCOMPLETE` if the dataset changed. PRD section 14.5 stores canonical evidence and
   refetches raw traces.
7. **One active contract per agent and environment**, enforced by a partial unique index as well as
   by the transaction.
8. **Routes the PRD assigns to a later phase are not registered**, so a caller gets `404` rather
   than a stub that appears to work.

## Unresolved limitations

1. **`POST /api/setup/signoz/sync-artifacts` and `POST /api/contracts/:id/sync-signoz` are not
   registered** — Phase 10. The `signoz_artifacts` table and its reads exist because PRD section
   16.5 requires a list before a create.
2. **`GET /api/releases/:id/gate` is not registered** — Phase 11.
3. **`GET /api/releases/:id/diff` is not registered** — Phase 14.
4. **Logs are structured but not exported over OTLP.** Both applications write JSON to stdout with
   the fields PRD section 17.5 requires. `@opentelemetry/exporter-logs-otlp-http` is already a
   dependency of `packages/telemetry`; wiring it is a small, separate change.
5. **No authentication.** PRD section 6.1 scopes P0 to local mode and PRD section 15 defines no
   authentication surface. `DEPLOYMENT_MODE=hosted` still activates the SigNoz URL control.
6. **A `demo_run` job is not idempotent without a caller-supplied `runKey`**, because a demo run
   genuinely produces new telemetry each time.
7. **Release-scoped budgets remain `deferred`** at run scope until the Phase 11 aggregation
   (Phase 07 limitation, unchanged).
8. **The Phase 04 aborted server span is still unresolved, by design.** Phase 16 investigation item.
9. **Sibling temporal ordering is still not expressible in P0** (Phase 07 limitation, unchanged).
10. **Span links and explicit predecessors are modelled but never populated** — the demo emits
    neither.
11. **Node timestamps are millisecond-accurate** (SL-044), so mined latency percentiles and stored
    run durations inherit that resolution.
12. **`signoz_update_*` wrappers are not implemented**, and dashboard and alert read-back
    verification is untested. Both are Phase 10 scope by PRD assignment.

---

## Next phase: 10 — SigNoz artifact compiler

PRD section: line 3201. Read it in full, together with section 16 (the SigNoz integration
specification, especially 16.4 read-before-write and 16.8 managed resource names), FR-013, FR-014,
FR-015, FR-016, and PRD section 17.4.

### Entry criteria — all SATISFIED

| Criterion | Evidence |
|---|---|
| Phase 09 merged and green | `f8e3215`; `make verify` exit 0 on `main` |
| A contract can be activated | `POST /api/contracts/:id/activate`, proven live |
| An artefact register exists | `signoz_artifacts`, with `spec_hash`, `remote_snapshot_json` and `unique (project_id, managed_name)` |
| A verified MCP write helper exists | `packages/signoz-mcp` `createAndVerify`, `assertVerified`, `deepEquals`, `readPath` |
| The MCP capability snapshot is persisted | `signoz_connections.capabilities_json`, written by `POST /api/setup/signoz/verify` |
| Violation telemetry is emitted | `packages/telemetry` `FlightRulesMetrics`, recorded by the evaluation handler |
| A job system exists to run a sync | `apps/worker`, four handlers, lease and retry proven |

### Scope

Branch `phase/10-signoz-artifact-compiler`. PRD section 13 names `packages/artifact-compiler`;
Phase 10 owns it plus the two API routes deferred from Phase 09.

PRD Phase 10 lists twelve tasks: read the MCP resource instructions, deterministic managed names,
compile rules into saved views, create the dashboard, create the alerts, verify notification channel
names, read every resource back, compare remote to desired, store IDs and snapshots and spec hashes,
update without duplicate creation, drift detection, artifact-sync telemetry.

The exit gate: **a contract activation produces working, verified SigNoz views, a dashboard and
alerts rather than decorative copies inside FlightRules.**

### Facts that will matter

- **Operating contract rule 13 bites here**: every MCP write is followed by a read-back that
  validates the fields that matter. `createAndVerify` already exists; use it rather than trusting a
  successful call.
- **MCP create tools take flat arguments**, not a nested resource object (SL-023). **MCP update
  tools replace the whole resource**: fetch, strip server-populated fields, modify, submit the
  complete object.
- **An unmatched SigNoz API path returns the SPA shell with HTTP 200** (SL-012). Never treat a 200
  from a direct HTTP call as success; assert on the body. The MCP path is the supported one.
- `signoz_artifacts.spec_hash` is what makes "a second identical sync creates none and updates none"
  decidable without asking SigNoz; `remote_snapshot_json` is what makes drift detectable.
- `upsertArtifact` is already idempotent on `(project_id, managed_name)` and coalesces the resource
  id and web URL, so a re-sync that produces no remote change does not lose them.
- Metric `flight_rules.signoz_artifact_sync` is declared with dimensions
  `project.slug, agent.key, artifact.type, status`, and `FlightRulesMetrics.recordArtifactSync`
  already emits it.
- Every alert must be driven through a real firing state, and a recovery state where the installed
  SigNoz version supports it (operating contract rule 15). Seed the canary first:
  `make demo-v2` then evaluate it, which now writes real violations and real violation telemetry.
- New packages and apps must be added to `tsconfig.build.json` references, and a package that both
  applications import must come before them in that list.
- Biome forbids `console.*` except `error` and `warn`; scripts use `process.stdout.write`.
- Source `.env` before any integration test or script: `set -a && . ./.env && set +a`.
- Integration tests need a demo run within the last six hours. `DEMO_RUNS=25 make demo-v1` seeds a
  batch through the agent's `/agent/seed` endpoint.
- The v1 route fingerprint is
  `43070aa4af4f6c2c912a8d7bcc724f1d199e0425dc8ad7256b528eec195cb037`; v2 is
  `22ffa0c0e578ef70a32a34aae7830f40aeef027aae28e66006601e80f99c7466`.
- `make api` and `make worker` run the two applications; both refuse to start against a database
  missing a migration they were built for.
