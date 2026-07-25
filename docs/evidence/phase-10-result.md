# Phase 10 result — SigNoz artifact compiler

```text
PHASE: 10 — SigNoz artifact compiler
STATUS: PASS
BRANCH: phase/10-signoz-artifact-compiler
COMMITS: see docs/evidence/phase-10-commits.md
SOURCES VERIFIED: 9 live MCP resource documents and 22 live tool input schemas, captured at
                  docs/evidence/phase-10/mcp-write-schemas.json; 7 new source-lock entries
                  (SL-053 … SL-059) in docs/research/source-lock.md
IMPLEMENTED:      packages/artifact-compiler (names, queries, views, dashboard, alerts, channels,
                  compile, plan, verify); apps/worker/src/artifact-sync.ts; the signoz_sync job
                  handler; POST /api/contracts/:id/sync-signoz; POST /api/setup/signoz/sync-artifacts;
                  an extended GET /api/setup/signoz/artifacts; migration 0004; update, delete and
                  notification-channel operations in packages/signoz-mcp; three inherited telemetry
                  defects fixed
TESTS RUN:        make verify; make signoz-verify; make contract-validate; make test;
                  make test-integration
TEST RESULT:      961 unit passed, 209 integration passed, 1,170 total, 0 failed, 0 skipped
RUNTIME VALIDATION: see "Runtime validation" below
EVIDENCE:         docs/evidence/phase-10-plan.md, docs/evidence/phase-10/live-state.txt,
                  docs/evidence/phase-10/mcp-write-schemas.json, docs/adr/0009-…md
KNOWN LIMITATIONS: see "Known limitations" below
NEXT PHASE ENTRY CRITERIA: SATISFIED
```

---

## What was built

Ten managed artefacts per agent, compiled from the active contract and verified by read-back.

| # | Type | Managed name | PRD |
|---|---|---|---|
| 1 | notification_channel | `FlightRules / <project> / Notifications` | FR-015 |
| 2–5 | saved_view | `… / Violating Runs`, `… / Duplicate Side Effects`, `… / Unknown Routes`, `… / Release Comparison` | FR-013, 16.8 |
| 6 | dashboard | `… / Contract Health`, ten panels with the PRD's exact titles | FR-014, 16.8 |
| 7–10 | alert | `… / Violation Rate Alert`, `… / Duplicate Side Effect Alert`, `… / Release Evaluation Error Alert`, `… / No Evaluation Data Alert` | FR-015, 16.8 |

Compilation is pure and deterministic; the MCP conversation and the persistence are separate. See
ADR-0009 for the reasoning.

---

## Defects found in inherited work, and fixed

| # | Defect | How it was found | Fix |
|---|---|---|---|
| 1 | **No FlightRules metric had ever reached SigNoz.** `bootstrapFromEnv` never opened a metric pipeline, so both applications ran with the API's no-op meter and every `flight_rules.*` recording was silently discarded (SL-053). | `signoz_list_metrics searchText=flight_rules` returned `[]` against a stack holding ten hours of demo telemetry. | `BootstrapOptions.metrics`, set by the API and the worker. Fifteen `flight_rules.*` metrics are now present in SigNoz (`live-state.txt`). |
| 2 | **`flight_rules.duplicate_side_effects` was declared and never recorded.** FR-014 panel 5 and the FR-015 duplicate alert would both have been empty. | No call site for `recordDuplicateSideEffect` anywhere. | A deterministic classifier in `packages/contract-engine` (`sideEffectingRuleIds`, `countDuplicateSideEffects`), recorded by the evaluation handler. The duplicate-side-effect alert now fires from real canary data. |
| 3 | **PRD section 17.3's evaluator spans were declared and never created.** | `signoz_get_field_keys signal=traces searchText=flight` returned `{}`. | The worker emits `flight_rules.evaluate_release` and `flight_rules.evaluate_run`; the sync emits `flight_rules.compile_signoz_artifacts`. |
| 4 | **The acceptance matrix over-claimed both.** Row 15 and FR-016 said the worker's metrics were "exported over OTLP" and that duplicate-side-effect metrics were recorded. Neither was true. | Defects 1 and 2. | Corrected in `docs/ACCEPTANCE_MATRIX.md`, and now true. |

Defects found **by the live integration test**, in Phase 10's own code, before it passed:

| # | Defect | Consequence had it shipped |
|---|---|---|
| 5 | List tools return the identifier under `id`, `uuid` or `ruleId` depending on the resource type (SL-056). A single `id` lookup found no identifier for a dashboard or an alert. | Every sync would have created a **second** dashboard and four more alerts. The test caught two managed dashboards of the same name. |
| 6 | `signoz_delete_view` returns `{"status":"success"}` with no `data`, which the single-resource schema rejects (SL-058). | A saved-view replacement was reported as `ARTIFACT_CREATE_FAILED` although the delete had succeeded. |
| 7 | A register row whose remote resource was replaced behind our back left a stale identifier. | The sync failed instead of adopting and restoring the resource. |
| 8 | The register write was inside the commit transaction, so a verification failure rolled it back. | A failed sync left no record of *which* artefact failed and why. Now written in its own transaction first. |

---

## Runtime validation

Everything below was observed against the running pinned stack (SigNoz v0.134.0, MCP v0.9.0), not
against fixtures. The consolidated capture is `docs/evidence/phase-10/live-state.txt`.

### First sync

`POST /api/contracts/019f9ac0-fdbc-72fb-8bf1-453e94362565/sync-signoz` → job
`019f9aef-06e1-72b3-b960-827e73155df6` → `succeeded`, `created: 10`, `updated: 0`, `unchanged: 0`,
`conflicts: 0`, every artefact `status: synced` with a resource identifier, a spec hash and a
`verification.status: verified`. Plan hash `5af32e8b00a1a66031a650946b9183753a3daf850f88109547f74f19e9280317`.

### The full state machine, in one live run

`packages/test-fixtures/src/phase-10.signoz.integration.test.ts`, 18 tests, all passing against the
live stack, driving a real API, a real worker and the real MCP server:

1. first sync creates and verifies all ten artefacts
2. the notification channel's delivery outcome is recorded, not assumed
3. every artefact persists an identifier, a spec hash, a verification and its contract scope
4. a repeated identical request returns the same job
5. a second identical sync creates none and updates none — ten `unchanged`
6. SigNoz holds exactly four managed views, no duplicates
7. a resource deleted by hand is recreated
8. a resource replaced by hand is adopted and restored
9. a resource of a managed name FlightRules does not own returns a `conflict` and is left untouched
10. a superseded artefact is reported `stale`, not deleted
11. a draft contract is refused with `STATE_TRANSITION_INVALID`
12. an unknown contract returns `NOT_FOUND`
13. the project route queues one job per agent holding an active contract
14. no raw MCP payload, no `searchContext`, no API key appears in any response
15. the register survives an application restart
16. the dashboard holds the ten PRD panel titles in order
17. all four alerts read back with their thresholds and queries intact
18. the capability snapshot reports every required write tool present

### Panels and views return real data

The "Violating Runs" filter, executed against live data, returns evaluated canary runs with typed
values — not nulls (SL-046 closed):

```json
{"agent.release.id":"refund-agent-v2","flight_rules.violation.count":10,
 "flight_rules.duplicate_side_effect.count":1,"flight_rules.route.approved":false,
 "flight_rules.evaluated.trace_id":"be24d0773f0a5fa776edb9efdc8cc72a"}
```

The same rows satisfy the Duplicate Side Effects view (`count > 0`), the Unknown Routes view
(`route.approved = false`), the Release Comparison view, and FR-014 panel 10. Fifteen
`flight_rules.*` metric series back panels 1–6; the agent's own traces back panels 7–9.

### Alerts fire from the canonical unsafe canary

A real worker evaluation of `refund-agent-v2` — 14 runs, 140 violations, 42 zero-tolerance — drove
the managed alerts to a firing state within two evaluation cycles:

```text
21:51:50  Violation Rate Alert=inactive   Duplicate Side Effect Alert=inactive
21:52:10  Violation Rate Alert=firing     Duplicate Side Effect Alert=firing
```

Alert history for `019f9aef-08ee-77e0-abe5-85d62b848480`:

```json
{"state":"firing","stateChanged":true,"unixMilli":1785012666492,"value":80,
 "labels":[{"severity":"critical"},{"threshold.name":"critical"}]}
```

Three of the four managed alerts are firing on real data at capture time; the fourth
(`Release Evaluation Error Alert`) is correctly `inactive`, because no evaluation errored.

---

## Commands run

```text
make verify                exit 0
make signoz-verify         exit 0   (SigNoz v0.134.0, MCP v0.9.0, OTLP 200)
make contract-validate     exit 0   (20 documents)
make db-migrate            applied: 0004
make test                  961 passed, 0 failed, 0 skipped   (44 files)
make test-integration      209 passed, 0 failed, 0 skipped   (13 files)
                           ---
                           1,170 tests passed
DEMO_RUNS=25 make demo-v1  exit 0
DEMO_RUNS=8  make demo-v2  exit 0
```

Phase 10 added 66 unit tests (54 compiler, 12 side-effect classifier) and 18 live integration tests.

---

## Known limitations

1. **`signoz_update_view` is unusable in the pinned version** (SL-057). A saved view is replaced by
   delete-then-create, so its resource identifier changes whenever its specification changes.
2. **Alert *recovery* has not been observed.** The firing transition is proven from alert history;
   the canary keeps producing violations, so the rate alert has not yet crossed back below its
   recovery target. The hysteresis is configured (`recoveryTarget`) and the history endpoint reports
   recovery transitions, but this run does not evidence one.
3. **Notification delivery is not verified.** The default destination is a local webhook that
   nothing is listening on; SigNoz's own test notification fails and that failure is recorded.
   Set `FLIGHTRULES_ALERT_WEBHOOK_URL` to a routable destination to make delivery real.
4. **Panel 8, "Token usage baseline versus canary", has no data**, because the demo agent emits no
   `gen_ai.usage.*` attribute. The panel filters on `gen_ai.usage.input_tokens EXISTS`, so it shows
   an honest empty series rather than a fabricated zero — the same disclosure the contract proposal
   makes (`BUDGET_NOT_PROPOSED [gen_ai.usage.input_tokens]`).
5. **Metrics and logs remain incomplete in the acceptance matrix.** Metrics are now emitted,
   ingested, queried, displayed and tested. **Logs are still not exported over OTLP** — both
   applications write structured JSON to stdout. That is unchanged from Phase 09 and is not Phase
   10 scope.
6. **A project-wide sync walks one page of up to 100 agents.** Beyond that the per-contract route is
   the right tool; the bound is disclosed in the response rather than silently truncating.
7. **Stale artefacts are reported, never deleted.** Removing a superseded resource is a deliberate
   operator action, not a side effect of a sync.

---

## Next phase: 11 — Release evaluation, CLI, and GitHub gate

Entry criteria are satisfied: run evaluation is proven live, violations and their evidence are
persisted and retrievable, the job system runs a fourth job type, and the operational surface a gate
decision would be read against now exists and is verified.
