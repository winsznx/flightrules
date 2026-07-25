# FlightRules handoff — after Phase 10

Written: 2026-07-25. `main` is green and the working tree is clean.

This replaces the previous handoff. Verify every claim below against the repository before relying
on it. The previous handoff was verified in full at the start of this session; every figure it
reported reproduced exactly, and no regression was found.

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
| 10 SigNoz artifact compiler | PASS | `5f4de3e` | `7a10eff` |
| 11–17 | NOT STARTED | — | — |

## Verified state

```text
make verify              exit 0
make signoz-verify       exit 0
make contract-validate   exit 0, 20 contract documents valid
make db-migrate          applied: 0004
make test                961 passed, 0 failed, 0 skipped   (44 files)
make test-integration    209 passed, 0 failed, 0 skipped   (13 files)
                         ---
                         1,170 tests passed
```

Integration breakdown: 102 database, 107 SigNoz. All fail rather than skip when their dependency is
absent.

## What Phase 10 added

`packages/artifact-compiler` — pure, deterministic compilation of an active contract into ten
managed artefacts, their spec hashes, the sync plan and the read-back comparison.

`apps/worker/src/artifact-sync.ts` — the MCP conversation and the persistence. Lists before writing,
writes, reads back by identifier, compares the material fields, records the verdict. No algorithm.

The `signoz_sync` job handler, `POST /api/contracts/:id/sync-signoz`,
`POST /api/setup/signoz/sync-artifacts`, an extended `GET /api/setup/signoz/artifacts`, migration
`0004`, and the update, delete and notification-channel operations in `packages/signoz-mcp`.

**The exit gate is proven live**: ten resources created through MCP and each verified by read-back;
a second identical sync creating and updating nothing; a hand-deleted resource recreated; a
hand-replaced resource adopted and restored; an unowned name reported as a conflict and left
untouched; a superseded artefact reported stale; the register surviving a restart; and a real
canary evaluation (14 runs, 140 violations, 42 zero-tolerance) driving the violation-rate and
duplicate-side-effect alerts to `firing`, with alert history recording the transition at value 80.

Reproduce with `DEMO_RUNS=25 make demo-v1 && DEMO_RUNS=8 make demo-v2`, then
`pnpm exec vitest run --project integration-signoz packages/test-fixtures/src/phase-10.signoz.integration.test.ts`.
The captured state is `docs/evidence/phase-10/live-state.txt`.

## Defects found and fixed

Four were inherited; four were found by the live integration test in Phase 10's own code before it
passed. All eight are detailed in `docs/evidence/phase-10-result.md`.

The inherited ones matter most, because two acceptance-matrix rows asserted behaviour that did not
exist:

1. **No `flight_rules.*` metric had ever reached SigNoz.** `bootstrapFromEnv` never opened a metric
   pipeline, so both applications recorded into the API's no-op meter (SL-053). Six FR-014 panels
   and all four FR-015 alerts depend on those metrics.
2. **`flight_rules.duplicate_side_effects` was declared and never recorded.**
3. **PRD section 17.3's evaluator spans were declared and never created.**
4. **The acceptance matrix over-claimed 1 and 2.** Corrected, and now true.

## Important discoveries

New source-lock entries this session: **SL-053 … SL-059**.

| ID | Finding |
|---|---|
| SL-053 | `metrics.getMeter` returns a no-op meter until a global `MeterProvider` exists; `bootstrapFromEnv` never created one. |
| SL-054 | FlightRules counters arrive **cumulative**; histograms explode into `.bucket/.count/.sum/.min/.max`. A counter panel must use `increase`, never `sum`. |
| SL-055 | `signoz_create_notification_channel` performs a **real test delivery** and reports its outcome in a non-standard envelope. |
| SL-056 | List tools return the identifier under `id`, `uuid` or `ruleId` **depending on the resource type**, and a dashboard's list item has `name` while its get response nests `data.title`. Assuming `id` duplicates every dashboard and alert on the second sync. |
| SL-057 | **`signoz_update_view` corrupts the stored query** and then breaks `signoz_list_views` for the entire tenant, whatever body it is given. `signoz_update_dashboard` and `signoz_update_alert` are fine. |
| SL-058 | Delete responses have three different shapes, none of them the single-resource envelope. |
| SL-059 | A dashboard widget missing a required field is accepted "best-effort" with a warning, and the server assigns its own `query.id`. |

## Judgement calls to preserve

ADR-0009 holds the full set. The ones a later phase could undo by accident:

1. **Compilation is pure; the MCP conversation is not.** `packages/artifact-compiler` must never
   perform I/O or read a clock, or determinism — and therefore idempotency — is lost.
2. **Ownership is the register, not the name.** A managed name FlightRules has not recorded belongs
   to whoever made it. Never overwrite it.
3. **`signoz_update_view` must never be called.** It breaks every saved view in the tenant.
4. **A read-back compares declared material fields, never whole resources.** SigNoz normalises
   `tag` → `attribute`, assigns widget query IDs, and populates timestamps.
5. **The register is written in its own transaction, before the commit function**, so a verification
   failure still leaves the evidence behind.
6. **Delivery is reported, never assumed.** `deliveryVerified` comes from the server's own test.
7. **Stale artefacts are reported, not deleted.**
8. **A saved view's resource identifier changes when its specification changes**, because
   replacement is delete-then-create.

## Unresolved limitations

1. **`GET /api/releases/:id/gate` is not registered** — Phase 11.
2. **`GET /api/releases/:id/diff` is not registered** — Phase 14.
3. **Alert recovery is not yet evidenced.** Firing is proven from alert history; the canary keeps
   violating, so the rate alert has not crossed back below its recovery target. `recoveryTarget` is
   configured and `signoz_get_alert_history` reports recovery transitions.
4. **Notification delivery is not verified.** The default webhook destination is local and nothing
   listens on it; SigNoz's own test-notification failure is recorded rather than hidden.
5. **Panel 8, "Token usage baseline versus canary", is an honest empty series** — the demo agent
   emits no `gen_ai.usage.*` attribute, which the contract proposal already discloses.
6. **Logs are structured but not exported over OTLP.** `@opentelemetry/exporter-logs-otlp-http` is
   already a dependency of `packages/telemetry`; wiring it is a small, separate change. This is why
   P0 scope item 6 is `IN PROGRESS` rather than `DONE`.
7. **No authentication.** PRD section 6.1 scopes P0 to local mode.
8. **A project-wide sync walks one page of up to 100 agents**, disclosed in the response.
9. **Release-scoped budgets remain `deferred`** at run scope until the Phase 11 aggregation.
10. **The Phase 04 aborted server span is still unresolved, by design.** Phase 16 item.
11. **Sibling temporal ordering is still not expressible in P0.**
12. **Span links and explicit predecessors are modelled but never populated.**
13. **Node timestamps are millisecond-accurate** (SL-044).

---

## Next phase: 11 — Release evaluation, CLI, and GitHub gate

PRD section: line 3239. Read it in full, together with FR-011, FR-012, PRD section 10.5 (the gate
definition), PRD section 15.7, and PRD section 19's exit-code-bearing error codes.

### Entry criteria — all SATISFIED

| Criterion | Evidence |
|---|---|
| Phase 10 merged and green | `7a10eff`; `make verify` exit 0 on `main` |
| Run evaluation is proven live | 14 canary runs, 140 violations, 42 zero-tolerance, persisted and retrievable |
| Violations resolve to trace evidence | `GET /api/violations/:id/evidence`, proven in Phase 09 |
| A contract carries a gate definition | `packages/contract-schema` `ContractGate`, parsed and validated since Phase 07 |
| The job system runs five job types | `apps/worker`, lease and retry proven |
| The operational surface a gate reads against exists | ten verified SigNoz artefacts, three alerts firing |
| `flight_rules.release_gate.decisions` is declared | `packages/telemetry` `METRIC_SPECS`, `recordGateDecision` ready and not yet called |

### Scope

Branch `phase/11-release-gate`. PRD section 13 names `apps/cli`; Phase 11 owns it, the release
aggregation in `packages/contract-engine`, `GET /api/releases/:releaseId/gate`, and
`.github/workflows/release-gate.yml`.

PRD Phase 11 lists ten tasks: release evaluation aggregation, minimum-run and timeout logic,
zero-tolerance rules, regression calculations, six CLI commands, JSON output mode, documented exit
codes, a GitHub Actions workflow, an evidence artifact on failure, and a PR or job summary.

The exit gate: **a release pipeline can fail because of trajectory evidence from SigNoz.**

### Facts that will matter

- The required exit codes are fixed by the PRD's own tests: `0` for a passing v1, `2` for the
  violating v2, `3` for too few runs, `4` for SigNoz unavailable, `5` for invalid config. "No
  internal error returns pass" is a test, not an aspiration — PRD section 20.1 forbids it.
- **Release-scoped budgets are still `deferred` at run scope.** Phase 07 left the aggregation to
  this phase; the run evaluations carry the measurements it needs.
- `recordGateDecision` exists on `FlightRulesMetrics` and has never been called. Panel 1 of the
  managed dashboard, "Release decisions over time", currently reads `flight_rules.evaluations`;
  once gate decisions are emitted, consider whether it should read
  `flight_rules.release_gate.decisions` instead — that is a contract change to the compiled
  artefact and will change its `spec_hash`, so it will re-sync.
- `flight_rules.release_gate` is a declared span name (PRD section 17.3) and is still unemitted.
  Use `withFlightRulesSpan` from `packages/telemetry`.
- New packages and apps must be added to `tsconfig.build.json` references, and a package both
  applications import must come before them in that list.
- A new app that a test imports needs an `exports` entry in its `package.json`, a `tsconfig.json`
  reference **and** a workspace dependency in the consuming package, or vitest resolves nothing.
- Biome forbids `console.*` except `error` and `warn`; a CLI writes with `process.stdout.write`.
- Source `.env` before any integration test or script: `set -a && . ./.env && set +a`.
- Integration tests need a demo run within the last six hours.
- `make api` and `make worker` run the two applications; both refuse to start against a database
  missing a migration they were built for.
- The Phase 09 and Phase 10 integration tests both `drop schema public cascade`. Whichever runs
  last owns the database afterwards, so re-seed demo state before recording anything.
