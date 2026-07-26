# FlightRules handoff — Phase 16 in progress

> **Superseded.** Phase 16 completed and merged at `9f221e6`; Phase 17 completed and is recorded in
> [phase-17-result.md](phase-17-result.md), [phase-17/actions.md](phase-17/actions.md) and
> [phase-17/railway.md](phase-17/railway.md). This document is kept as the record of what was known
> mid-phase, including the three limitations Phase 17 then closed: the workflow had never run on
> GitHub (it now passes), there was no public deployment (there is now), and `gh` lacked the
> `workflow` scope (the push credential had it).


Written 2026-07-26. **Phase 16 is not complete.** `phase/16-hardening` is green and committed;
eight of the sixteen Phase 16 tasks are done with runtime evidence, and eight remain. Nothing has
been merged to `main`, and Phase 17 has not started — correctly, because Phase 17 may not begin
until Phase 16 passes.

Verify every claim below against the repository before relying on it.

---

## Phase status

| Phase | Status | Phase commit | Merge commit |
|---|---|---|---|
| 00–12 | PASS | see git history | — |
| 13 Baseline and Contract Studio UI | PASS | `d1ac0c4` | `faf2d26` |
| 14 Release Diff UI | PASS | `d5d8daa` | `d14f4fb` |
| 15 Violation Inspector UI | PASS | `676ffed` | `42ff820` |
| **16 Hardening** | **IN PROGRESS** | branch `phase/16-hardening`, head `ab597bb` | not merged |
| 17 Release | NOT STARTED | — | — |

`main` is unchanged at `9eac28d`.

## The previous handoff's claims were all true

Every figure in it was re-verified at the start of this session against the running stack, not
trusted:

```text
make verify              exit 0
make test                1,159 passed, 0 failed, 0 skipped   (54 files)
make test-integration      243 passed, 0 failed, 0 skipped   (15 files, 672 s)
make test-e2e               68 passed, 4 skipped             (72 tests, 4 projects)
make signoz-verify       exit 0
make contract-validate   exit 0, 20 documents
make demo-full           exit 0 — approved exit 0, unsafe canary exit 2
managed artefacts        {"total":10,"synced":10,"drifted":0,"failed":0,"conflict":0}
```

The built worker's idle poll timer is not `unref`ed (`apps/worker/dist/runner.js:232`); the lease
heartbeat and the shutdown timeout still are, correctly.

## Current state on the branch

```text
make test          1,324 passed, 0 failed, 0 skipped   (59 files)
make test-e2e         86 passed, 4 skipped             (90 tests, 3 read-only projects)
make scan-deps     exit 0    (was failing 100 % of the time before this branch)
make scan-secrets  exit 0
make scan-licences exit 0    302 packages
make scan-history  exit 0    58 commits, gitleaks
make scan-design   exit 0
make verify-telemetry exit 0 (new)
make measure-performance every PRD 20.2 target met
```

`make verify`, `make test-integration` and the destructive `workflow` browser project have **not**
been re-run since the last few commits. Do that first.

---

## Phase 16: what is done

Eighteen commits, `4abe32e..ab597bb`. `docs/evidence/phase-16-plan.md` maps all sixteen tasks.

### Four defects entry verification found before any Phase 16 work

| # | Defect | Fix |
|---|---|---|
| E1 | `make scan-deps` failed **100 %** of the time. `pnpm@10.33.0` hands a gzip body carrying no `content-encoding` header to `Response.json()`. The CI `security` job calls it, so the first real GitHub Actions run would have failed on a gate that had never run. | `scripts/audit-dependencies.mjs` (SL-064) |
| E2 | `make db-migrate` did not source `.env`, so the documented README step exited 5 on any fresh machine. | Makefile |
| E3 | `.env.example` set one `OTEL_SERVICE_NAME=flightrules-api`, which the worker also reads — every worker signal was attributed to the API. | `.env.example` |
| E4 | SL-062's diagnosis was wrong. See below. | instruments + API (SL-063) |

Running the dependency gate for the first time immediately surfaced **two high advisories** in
`postcss@8.4.31` with no patched version. Resolved by a `pnpm.overrides` pin to `8.5.23`, outside
both ranges.

### Tasks complete, with runtime evidence

| Task | Evidence |
|---|---|
| 1 Threat model | `docs/THREAT_MODEL.md` — 31 threats, each with asset, attack path, control, residual risk, verification, status. Three accepted risks, all disclosed |
| 2 Dependency, licence, secret and history scans | `docs/evidence/phase-16/security-scans.md` |
| 3 Fuzz contract parsing | `packages/contract-schema/src/fuzz.test.ts`, 54 cases and properties |
| 4 Fuzz graph and selectors | `packages/trace-graph/src/fuzz.test.ts`, 58 cases and properties |
| 5, 14 Large traces and performance | `docs/evidence/phase-16/performance.{md,txt,json}`, `make measure-performance` |
| 6 Malformed MCP responses | `packages/signoz-mcp/src/malformed.test.ts`, 25 cases on top of the existing 17 shapes |
| 13 High cardinality and metric dimensions | `docs/evidence/phase-16/metric-dimensions.md`, SL-063 |
| 15 Accessibility | `docs/evidence/phase-16/accessibility.md`, `tests/e2e/phase-16-accessibility.spec.ts` |
| OTLP logs | `docs/evidence/phase-16/otlp-logs.md` |

### The two findings worth reading before touching this area

**OTLP logs.** The Violation Inspector correlates on the **demo run's** trace, not FlightRules'. So
exporting only the API's and the worker's logs would have closed nothing — the only processes inside
a failing refund trace are the demo services. `registerServiceSpans` now emits one correlated record
per instrumented request and the payment service writes its ledger line. Proven live: five records
correlate to a real violation's trace, including **two `refund committed to the payment ledger`
lines in one trace** — the duplicate side effect in the service's own words.

**SL-062 was wrong, and SL-063 supersedes its third part.** The metric labels were empty because the
instruments emitted `project.slug`/`agent.key` while the API grouped by
`flight_rules.project.id`/`flight_rules.agent.id`. Grouping by a label nothing sets is not an error
in SigNoz, which is why no single query could tell the two explanations apart. Filtering on
`flight_rules.agent.id` now narrows two series to one, live.

`make verify-telemetry` re-proves both against the running deployment. It exists because neither
claim can be established from the application side: "the exporter was constructed" and "the counter
was incremented" are both true in a deployment where nothing arrives.

---

## Phase 16: what remains

In the order they repay effort.

### 1. Tasks 10 and 11 — incomplete telemetry and missing attributes

Pure unit tests against the evaluator, no infrastructure. Cover missing root, child or handler;
sampled traces; locally unobservable subtrees; malformed parent relationships; cross-trace links;
missing service, operation, release or run identifiers. Then every rule type against absent, `null`,
wrong-type, empty-string, zero, false, negative, out-of-range and `dataType`-omitted values.

**Two behaviours must be preserved and are the point of the task:** local insufficient-evidence
scoping must keep the absent aborted-payment handler span from becoming a false violation, and
missing data must never silently become zero or false.

### 2. Task 12 — hostile input across the remaining surfaces

Partly covered already: both fuzz suites assert no prototype pollution and no crash, and
`phase-14`/`phase-15` browser tests assert hostile telemetry is escaped rather than rendered. What
is not yet asserted: terminal control-sequence injection through the CLI, path traversal through
`evidence export --out`, and hostile strings reaching managed SigNoz artefact names.

### 3. Tasks 7, 8 and 9 — races, worker restarts, SigNoz outage

Integration tests. **Stop the worker before `make test-integration`** — it competes with the suite
and fails the runner shutdown test for an unrelated reason. The suite takes about 11 minutes and
**drops the schema**, so `make demo-full` must follow it.

Task 8 must extend rather than replace the existing lifecycle proof, and must not reintroduce
`unref()` on the idle poll timer. It also needs a production operational check for jobs remaining
queued beyond a threshold.

### 4. Alert firing and recovery

Firing is evidenced from Phase 10; recovery is not. For each required alert: normal state, firing
state, alert history records firing, conditions cleared, recovery where the pinned version supports
it, history records recovery, and the configured query and threshold survive read-back. If v0.134.0
cannot expose recovery, record the exact limitation from runtime behaviour — do not invent it.

### 5. Task 16 — fresh-machine reproducibility

The largest remaining item and mandatory. A genuinely clean clone outside this working tree, from
committed files and documented prerequisites only, through all 24 steps. Every manual correction
becomes documentation or automation.

E2 was found precisely because the README's step five does not work on a fresh machine. Expect
more of that kind.

### 6. Close out

Re-run everything, write `docs/evidence/phase-16-result.md`, update
`docs/ACCEPTANCE_MATRIX.md` and `CHANGELOG.md`, merge to `main`.

---

## Operational facts that cost time to rediscover

- **A demo reset alone is not a clean state.** `make signoz-purge` **then** the reset. Without the
  purge the next sync correctly reports ten conflicts, because the SigNoz resources outlive the
  register rows. Reproduced again this session after the integration suite dropped the schema:
  `synced: 0, conflict: 10`, then `synced: 10, conflict: 0` after a purge.
- **Stop the worker before `make test-integration`.**
- **`make test-e2e` needs a seeded demo and leaves it reset.** `make demo-full` before, and again
  after. The destructive Phase 13 workflow runs in its own Playwright project, declared last.
- **Do not run a build while a web server is running.** They share `.next`.
- **A long-running API or worker can outlive its own `dist`.** Restart both after `make typecheck`.
- **The browser suite runs on `:3100`**, while `WEB_PORT` defaults to `3000`. That is deliberate and
  documented at `docs/DEMO_SCRIPT.md:298` — the demo uses the dev server on 3000 and the browser
  suite a production build on 3100.
- **`make verify-telemetry` needs a recent `make demo-full`.** It correlates against a real
  violation's trace, and a violation whose run predates the current log export legitimately returns
  `empty`.
- **`make demo-urls`** resolves every demo URL from the running API into `.demo-state.json`.

## New commands this branch adds

```text
make verify-telemetry      prove exported logs correlate and metric dimensions are queryable
make measure-performance   every PRD 20.2 target, repetitions, median, p95, max, heap
make scan-history          gitleaks over the whole git history
```

---

## Unresolved limitations, updated

| # | Limitation | State |
|---|---|---|
| 1 | Logs not exported over OTLP | **CLOSED.** Proven live, `docs/evidence/phase-16/otlp-logs.md` |
| 2 | Metric dimensions empty (SL-062) | **CLOSED.** Diagnosis corrected in SL-063, proven live |
| 3 | No automated accessibility audit | **CLOSED.** axe sweep, three serious classes found and fixed |
| 4 | Alert recovery unevidenced | **OPEN.** Phase 16 |
| 5 | The GitHub workflow has never run on GitHub | **OPEN.** Phase 17 |
| 6 | The Phase 13 workflow is validated at one viewport | OPEN, by design |
| 7 | Token and retry regression are disclosed rather than measured | OPEN, the demo agent makes no model call |
| 8 | No authentication | OPEN, PRD section 6.1 scopes P0 to local mode. `docs/THREAT_MODEL.md` T08 |
| 9 | `Open in SigNoz` opens the trace view, not a release-filtered view | OPEN, no verified URL shape |
| 10 | The API's own pino lines reach SigNoz without a trace ID | **NEW.** ESM import order defeats the HTTP instrumentation; does not affect the inspector, which correlates on demo traces |
| 11 | No screen-reader walkthrough; browser coverage is Chromium only | **NEW.** PRD section 20.4 names three engines |
| 12 | No container-image vulnerability scan | **NEW.** No scanner is pinned by the repository; images are unmodified upstream releases pinned by tag |

---

## Phase 17 authorisation, unchanged and still standing

The repository owner has granted standing authorisation for the public release actions: create the
public GitHub repository and set its metadata, push `main`, push tags, create the release, inspect
and fix Actions failures, create or reuse Railway projects and services, configure Railway secrets,
deploy, run migrations, seed the public demo, and obtain a separate hosted SigNoz credential through
the supported process. A later session must **not** re-ask whether these are permitted.

It must still not perform any of them before Phase 16 is complete, merged and green.

### One thing to check before Phase 17 pushes anything

`gh` is authenticated as `winsznx` with scopes `gist, read:org, repo`. **There is no `workflow`
scope.** Pushing a branch that contains `.github/workflows/*` with a token lacking it is rejected by
GitHub. Either run `gh auth refresh -s workflow` in an interactive session first, or expect the
first `git push` of `main` to fail with a workflow-scope error.

No repository named `flightrules` exists on that account yet. Railway is authenticated as `winszn`.

### One file that must not be published

An untracked `ChatGPT Image Jul 26, 2026, 06_13_55 AM.png` sits in the repository root. It is not
part of the product, has never been committed, and must not be. Check `git status` before any
`git add -A`.
