# Phase 16 plan — hardening, performance, and adversarial validation

Branch `phase/16-hardening`, cut from `main` at `9eac28d`.

PRD line 3431. Objective: *break the product before submission and fix every P0 weakness*.

Exit gate: **no unresolved critical or high security issue, no failing P0 test, and no unverified
installation step remains.**

---

## Entry verification (done before this plan was written)

Every claim in `docs/evidence/HANDOFF.md` was re-checked against the repository and the running
stack rather than trusted.

| Check | Result |
|---|---|
| working tree clean, `main` at `9eac28d` | yes |
| `5560214` reachable from `main` | yes |
| Phase 13/14/15 merge commits `faf2d26`, `d14f4fb`, `42ff820` reachable | yes |
| no `phase/16-*` or `phase/17-*` branch existed | confirmed |
| built worker: idle poll timer **not** `unref`ed | confirmed, `apps/worker/dist/runner.js:232` |
| built worker: lease heartbeat and shutdown timeout **are** `unref`ed | confirmed, `runner.js:135`, `index.js:70` |
| `make verify` | exit 0 |
| `make test` | **1,159 passed**, 0 failed, 0 skipped, 54 files |
| `make test-integration` | **243 passed**, 0 failed, 0 skipped, 15 files, 672 s |
| `make test-e2e` | **68 passed, 4 skipped**, 72 total across 4 projects |
| `make signoz-verify` | exit 0 |
| `make contract-validate` | exit 0, 20 documents |
| `make demo-full` | exit 0 — approved `refund-agent-v1` **exit 0**, unsafe `refund-agent-v2` **exit 2** |
| managed artefacts | `{"total":10,"synced":10,"drifted":0,"failed":0,"conflict":0}` |

Two operational notes, both already documented and both reproduced exactly as the handoff
predicted:

- the integration suites drop the schema, so `make demo-full` must follow them;
- a demo re-seed after that reports **ten conflicts** unless `make signoz-purge` runs first,
  because the SigNoz resources outlive the register rows. Purge then re-seed produced
  `synced: 10, conflict: 0`.

The four skipped browser tests are `phase-14-release-diff.spec.ts:171` (evidence download) and
`:226` (re-evaluation), each skipped on the `narrow` and `mobile` projects by an explicit
`test.skip(project.name !== "desktop")`. They are not disabled tests: both run at the desktop
viewport. Task 15 confirms this rather than assuming it.

### Defects found during entry verification, before any Phase 16 work

| # | Defect | Severity | Task |
|---|---|---|---|
| E1 | `make scan-deps` fails 100 % of the time. `pnpm@10.33.0`'s `audit` cannot read the npm advisory response, which Cloudflare intermittently returns gzip-encoded without a `content-encoding` header. The declared dependency-vulnerability gate has therefore never run, and the `security` job of `.github/workflows/ci.yml` calls it — so the first real GitHub Actions run would fail. | **P0** | 2 |
| E2 | `make db-migrate` does not source `.env`, unlike `make api` / `make worker` / `make test-integration`. `README.md` and `docs/RUNBOOK.md` both document it as a bare step, so a fresh machine following the README exactly gets `DATABASE_URL is not set.` and exit 5. | **P0** | 16 |
| E3 | `.env.example` sets one `OTEL_SERVICE_NAME=flightrules-api`, and `apps/worker/src/config.ts:130` reads the same variable. The worker therefore labels its own logs, spans and metrics `flightrules-api`. Every worker-emitted signal is attributed to the API service. | **P1** | 13, logs |
| E4 | SL-062's stated cause is incomplete. The metric dimensions are not "present with empty values" by SigNoz's doing: `packages/telemetry/src/instruments.ts` emits `project.slug` / `agent.key` / `release.key`, while `apps/api/src/routes/violation-evidence.ts` groups by `flight_rules.project.id` / `flight_rules.agent.id`. The names never matched. | **P0** | 13 |

---

## Task map

Each task lists where the work lands, how it is exercised, what proves it, and what would fail it.

### 1. Threat-model review

| | |
|---|---|
| Location | `docs/THREAT_MODEL.md` (new — PRD section 26 requires it and it does not exist) |
| Command | review against `docs/PRD.md` section 18, the source lock, and the code paths named per threat |
| Tests | each threat's control cites a named test or a runtime artefact |
| Runtime validation | threats whose control is runtime-observable cite Phase 16 evidence produced by tasks 2–16 |
| Evidence | `docs/THREAT_MODEL.md`, `docs/evidence/phase-16/` |
| Matrix | `SEC-*` |
| Pass | all 28 required threat classes present; each has asset, attack path, control, residual risk, verification, status. **No threat marked resolved without a test or runtime evidence.** |

### 2. Dependency and secret scans

| | |
|---|---|
| Location | `scripts/audit-dependencies.mjs` (new, replaces the broken `pnpm audit`), `package.json`, `.github/workflows/ci.yml` |
| Command | `make scan-deps`, `make scan-secrets`, `make scan-licences`, `gitleaks detect`, Dockerfile and workflow review |
| Tests | `scripts/audit-dependencies.test.ts` — advisory matching, severity gating, gzip sniffing |
| Runtime validation | each scanner run against this tree; findings recorded with tool version, command, severity, disposition |
| Evidence | `docs/evidence/phase-16/security-scans.md` |
| Matrix | `SEC-SCAN-*` |
| Pass | every scanner **runs** and exits 0; no unresolved critical or high finding. E1 fixed. |

### 3. Fuzz contract parsing

| | |
|---|---|
| Location | `packages/contract-schema/src/fuzz.test.ts` (new) |
| Command | `pnpm run test` |
| Tests | `fast-check` properties plus a pinned corpus: malformed YAML, explicit tags, anchors, aliases, alias bombs, depth, width, huge scalars, oversized files, duplicate rule IDs, unknown fields, unknown versions, invalid selector types, contradictory rules, numeric overflow, negative budgets, `NaN`, `Infinity`, unsafe Unicode, control characters, `__proto__`, `constructor`, `prototype`, `toString`, very long identifiers |
| Runtime validation | n/a — the parser is inside the determinism boundary |
| Evidence | `docs/evidence/phase-16/fuzz-contract.md` |
| Matrix | `FR-009` |
| Pass | no crash, no unhandled rejection, no prototype pollution, no accepted invalid document, and the same input always produces the same diagnostics |

### 4. Fuzz graph parsing and selector evaluation

| | |
|---|---|
| Location | `packages/trace-graph/src/fuzz.test.ts`, `packages/contract-engine/src/fuzz.test.ts` (new) |
| Command | `pnpm run test` |
| Tests | graph construction, canonical ordering, node/edge indexing, ancestor/descendant lookup, selector matching, evidence attachment, route fingerprinting, similarity — against missing parents, orphans, cycles, duplicate span IDs, self-edges, disconnected graphs, hostile names and attribute keys, invalid attribute types, extreme depth and breadth, empty and huge graphs, reordering, and semantically identical graphs with different IDs |
| Runtime validation | n/a |
| Evidence | `docs/evidence/phase-16/fuzz-graph.md` |
| Matrix | `FR-004`, `FR-006`, `FR-010` |
| Pass | no crash, no prototype-chain access, identical fingerprints for reordered input, bounded execution |

### 5 and 14. Large traces and performance targets

| | |
|---|---|
| Location | `packages/contract-engine/src/performance.test.ts` (extend), `scripts/measure-performance.mjs` (new) |
| Command | `node scripts/measure-performance.mjs` |
| Tests | 10,000-span canonicalisation; deep, wide, repeated-tool, many-service and many-family traces; maximum rule count; maximum baseline dataset; large evidence output; large release aggregation |
| Runtime validation | PRD section 20.2 targets measured with repetitions, median, p95, max, memory, warm and cold, on recorded hardware. API p95 measured against the running API. |
| Evidence | `docs/evidence/phase-16/performance.md` |
| Matrix | `QA-PERF-*` |
| Pass | every PRD 20.2 target met. **A budget is never loosened to fit an implementation.** |

### 6. Malformed MCP responses

| | |
|---|---|
| Location | `packages/signoz-mcp/src/malformed.test.ts` (new) |
| Command | `pnpm run test` |
| Tests | missing `structuredContent`; JSON only in text; multiple content entries; malformed JSON; fenced JSON; SPA shell with HTTP 200 (SL-012); missing resource ID; ID under `id` / `uuid` / `ruleId` (SL-056); changed field type; missing field; extra field; empty response; timeout; transport failure; MCP-declared error; partial pagination; repeated cursor; duplicated rows; invalid field catalogue; `null` from omitted `dataType` (SL-051); saved-view list failure; broken `signoz_update_view` (SL-057) |
| Runtime validation | the delete-and-recreate saved-view workaround still exercised live by `make signoz-sync` |
| Evidence | `docs/evidence/phase-16/mcp-malformed.md` |
| Matrix | `FR-013`–`FR-015` |
| Pass | **no malformed response is ever interpreted as a verified resource** |

### 7. Duplicate resource creation races

| | |
|---|---|
| Location | `packages/artifact-compiler/src/race.integration.test.ts` (new) |
| Command | `pnpm run test:integration:db` |
| Tests | two identical sync requests; two API processes; two workers; response lost after remote creation; commit failure after remote creation; retry after partial failure; resource deleted remotely; renamed remotely; unmanaged name conflict; stale resource from a superseded contract |
| Runtime validation | live `make signoz-sync` twice; register reconciliation read back from SigNoz |
| Evidence | `docs/evidence/phase-16/artifact-races.md` |
| Matrix | `FR-013`–`FR-015`, `QA-REL-*` |
| Pass | no duplicate managed artefact; unmanaged artefacts untouched; retries idempotent; conflicts stable and visible; every successful write read back |

### 8. Worker restarts

| | |
|---|---|
| Location | `apps/worker/src/runner.integration.test.ts` (extend), `apps/api/src/routes/core.ts` (queue-depth check) |
| Command | `pnpm run test:integration:db` |
| Tests | idle survival; work after long idle; graceful shutdown idle and busy; forced termination while processing; lease expiry; stale job recovery; restart after claim; restart after output persisted but before success; multiple workers; no duplicate committed output |
| Runtime validation | a real built worker left idle, then given work; API queue-depth endpoint observed while a job is deliberately left queued |
| Evidence | `docs/evidence/phase-16/worker-lifecycle.md` |
| Matrix | `QA-REL-*` |
| Pass | idle poll timer still not `unref`ed; no duplicate committed output; queued-beyond-threshold is detectable in production |

### 9. SigNoz temporary outage

| | |
|---|---|
| Location | `apps/api/src/outage.integration.test.ts`, `apps/worker/src/outage.integration.test.ts` (new) |
| Command | `pnpm run test:integration:db` |
| Tests | outage before a job starts; during retrieval; during pagination; during artefact creation; between creation and read-back; during alert verification; MCP down; OTLP exporter down; recovery; repeat after recovery |
| Runtime validation | the live MCP container stopped and restarted, with the product observed across the whole window |
| Evidence | `docs/evidence/phase-16/signoz-outage.md` |
| Matrix | `QA-REL-*`, `FR-012` |
| Pass | no false success; no unverified contract activated; no truncated baseline committed; previous verified artefact state preserved; failure visible; persisted violation evidence intact |

### 10 and 11. Incomplete telemetry and missing attributes

| | |
|---|---|
| Location | `packages/contract-engine/src/incomplete.test.ts`, `packages/contract-engine/src/missing-attributes.test.ts` (new) |
| Command | `pnpm run test` |
| Tests | missing root, child or handler; sampled trace; locally unobservable subtree; globally incomplete trace; malformed parent; cross-trace link; missing service, operation, release or run ID. Every rule type against absent, `null`, wrong-type, empty-string, zero, false, negative, out-of-range and `dataType`-omitted `null` values |
| Runtime validation | n/a |
| Evidence | `docs/evidence/phase-16/incomplete-telemetry.md` |
| Matrix | `FR-010`, `FR-011` |
| Pass | local insufficient-evidence scoping preserved; the absent aborted-payment handler span stays a non-violation; **incomplete evidence never becomes a pass**; missing data never becomes zero or false |

### 12. Malicious span names and HTML

| | |
|---|---|
| Location | `packages/domain/src/hostile.test.ts`, `apps/api`, `apps/cli`, `apps/web`, `packages/artifact-compiler` (new tests) |
| Command | `pnpm run test`, `pnpm run test:e2e` |
| Tests | `<script>`, `<img onerror>`, `__proto__`, `constructor`, `toString`, `../../etc/passwd`, quotes, backticks, newlines, terminal control sequences, Unicode confusables, very long strings — through browser, API, logs, evidence export, CLI and managed artefact names |
| Runtime validation | the existing browser assertions that hostile telemetry is escaped, extended |
| Evidence | `docs/evidence/phase-16/hostile-input.md` |
| Matrix | `SEC-XSS`, `SEC-PROTO`, `SEC-PATH` |
| Pass | no XSS, no prototype pollution, no terminal escape injection, no path traversal, no broken YAML, no invalid artefact ownership |

### 13. High-cardinality safeguards and the metric dimensions

| | |
|---|---|
| Location | `packages/telemetry/src/instruments.ts`, `packages/telemetry/src/metrics.ts`, `apps/api/src/routes/violation-evidence.ts`, `apps/worker`, `apps/api` |
| Command | `pnpm run test`, then live `make demo-full` and a live `signoz_query_metrics` |
| Tests | dimension names cross-referenced against the emitting call sites and the querying call sites by one test, so E4 cannot recur; ID normalisation, label allowlists, bounded families, rare-route threshold, bounded evidence, bounded page size |
| Runtime validation | **live SigNoz proof** that `flight_rules.project.id` and `flight_rules.agent.id` are emitted, ingested and queryable with non-empty values, and that a filter on them narrows the series |
| Evidence | `docs/evidence/phase-16/metric-dimensions.md`, a new source-lock entry superseding SL-062's diagnosis |
| Matrix | `FR-016`, `QA-CARD-*` |
| Pass | required dimensions emitted, ingested and queryable. **Not complete while a dimension is empty or unqueryable.** |

### 15. Accessibility audit

| | |
|---|---|
| Location | `tests/e2e/phase-16-accessibility.spec.ts` (new), `@axe-core/playwright` (new pinned devDependency, MPL-2.0 — already on the licence allowlist), plus any component fixes |
| Command | `pnpm run test:e2e` |
| Tests | automated axe sweep of every PRD section 8 route at three viewports; keyboard-only walkthrough; visible focus; landmarks; heading order; form labels and error association; live job-progress announcement; graph text alternative; table semantics; modal focus; colour independence; mobile layout; zoom; reduced motion; copyable evidence; YAML editor; release diff; violation inspector |
| Runtime validation | the running product, not markup fixtures |
| Evidence | `docs/evidence/phase-16/accessibility.md` |
| Matrix | `QA-A11Y-*` |
| Pass | zero critical and zero serious axe violations; every P0 workflow keyboard-reachable; the four skipped tests investigated and their skip justified or removed; remaining moderate/minor findings recorded honestly |

### 16. Fresh-machine reproducibility

| | |
|---|---|
| Location | a clean clone outside this working tree, plus `README.md`, `docs/RUNBOOK.md`, `Makefile`, `scripts/` |
| Command | the 24-step sequence in the session brief, from committed files only |
| Tests | n/a — this is the runtime validation |
| Runtime validation | clone → no `.env` or generated state → pinned toolchain → lockfile install → Foundry SigNoz + MCP → `casting.yaml` and lock verified → images pinned → first-user bootstrap → credential → env → database → migrations → API → worker → web → idle-survival proof → `make demo-full` → gate 0 → gate 2 → ten artefacts read back → browser workflows → documented test commands |
| Evidence | `docs/evidence/phase-16/fresh-machine.md` |
| Matrix | `A15` |
| Pass | the sequence completes from committed files and documented prerequisites alone. **Every manual correction needed becomes documentation or automation.** No step left unverified. |

### OTLP logs (PRD section 17.5, handoff limitation 1)

| | |
|---|---|
| Location | `packages/telemetry/src/logs.ts` (new), `sdk.ts`, `bootstrap.ts`, `apps/api`, `apps/worker`, `apps/demo-services`, `apps/api/src/routes/violation-evidence.ts` |
| Command | `pnpm run test`, then live `make demo-full` and the Violation Inspector |
| Tests | log-record export, trace correlation, redaction of secrets / prompts / tool arguments / tool results, degraded retrieval |
| Runtime validation | logs queried out of SigNoz **by trace ID**, and the Violation Inspector's log panel showing them for a real violation |
| Evidence | `docs/evidence/phase-16/otlp-logs.md` |
| Matrix | `FR-017`, `PRD 17.5` |
| Pass | logs reach SigNoz, correlate by trace ID, carry no secret or raw payload, and the inspector renders them. **stdout JSON is not proof.** |

### Alert firing and recovery (handoff limitation 4)

| | |
|---|---|
| Location | `packages/artifact-compiler`, `scripts/verify-alert-lifecycle.mjs` (new) |
| Command | `node scripts/verify-alert-lifecycle.mjs` |
| Tests | alert spec read-back |
| Runtime validation | for every required alert: normal state, firing state, alert history records firing, conditions cleared, recovery where the pinned version supports it, history records recovery, query and threshold survive read-back |
| Evidence | `docs/evidence/phase-16/alert-lifecycle.md`, source-lock entry if the pinned version cannot expose recovery |
| Matrix | `A12`, `FR-015` |
| Pass | firing and recovery evidenced, or the exact limitation recorded from runtime behaviour. **Never invented.** |

---

## Completion criteria

Phase 16 passes only when all of the following hold together:

- no unresolved critical or high security finding;
- no failing P0 test;
- no unverified installation step;
- OTLP logs working and evidenced, or a grounded PRD-compatible blocker reported;
- the required metric dimensions working and evidenced live;
- accessibility P0 checks passing;
- alert firing and recovery evidenced within supported runtime behaviour;
- fresh-machine reproduction succeeding;
- `make verify`, `make test`, `make test-integration`, `make test-e2e` green, and `make demo-full`
  run **after** the integration suites reproducing exit 0 then exit 2.

Commits are focused and conventional, with no co-author trailers. The phase merges to `main` only
when every gate above passes.
