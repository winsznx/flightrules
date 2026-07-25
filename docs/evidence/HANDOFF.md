# FlightRules handoff — after Phase 12

Written: 2026-07-26. `main` is green and the working tree is clean.

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
| **11 Release evaluation, CLI, and GitHub gate** | **PASS** | `e40b920` | `21b6b75` |
| **12 UI foundation and `design.md` integration** | **PASS** | `a7b3c78` | `5726d26` |
| 13–17 | NOT STARTED | — | — |

## Verified state

```text
make verify              exit 0   (verify-env, format, lint, typecheck, test, build,
                                   contract-validate, scan-design, scan-secrets, scan-licences)
make signoz-verify       exit 0
make test                1,116 passed, 0 failed, 0 skipped   (51 files)
make test-integration    234 passed, 0 failed, 0 skipped     (15 files)
                         ---
                         1,350 tests passed
make demo-full           exit 0 — approved release exit 0, unsafe canary exit 2
```

The session began by independently reproducing the Phase 10 baseline: 961 unit and 209 integration
tests, exactly as reported, with SigNoz green and all ten managed artefacts verified.

---

## What Phase 11 added

`packages/contract-engine/src/release.ts` — the pure release aggregation of FR-011 and FR-012. No
I/O and no clock read: `nowMs`, the window, the retrieval state and the contract's lifecycle status
all arrive as inputs. `packages/contract-engine/src/exit-codes.ts` holds the exit-code table, so the
API, the CLI, the workflow and the tests all derive the same number from the same decision.

`GET /api/releases/:releaseId/gate` is a read — no job, no trace fetch, no row written. `apps/cli`
implements the PRD's six commands with `--json`, stream discipline and the documented exit codes.
`.github/workflows/release-gate.yml` runs the same commands and asserts exit `2` on the canary.

**The exit gate is proven live**: 25 known-good runs emitted, a baseline mined from them, a contract
activated, ten artefacts compiled and verified, 106 runs evaluated and the gate exiting `0`; then 8
unsafe runs, 80 violations, 24 zero-tolerance, and the gate exiting `2` — with the same decision
served from a restarted API.

## What Phase 12 added

`packages/ui` — `tokens.css` is `design.md`'s Quick Start block verbatim (69 declarations, excluded
from the formatter so a reflowed font stack cannot break the comparison), `base.css` is the shell
with no literal colour, size or font, and sixteen primitives including the graph table.

`apps/web` — a Next.js 16.2.11 App Router application implementing **all fourteen** PRD section 8
routes against live API data, each with its own loading, empty, error and degraded states. Every
page is a Server Component; `lib/api.ts` and `lib/load.ts` are `server-only`.

`scripts/check-design-assets.mjs` re-reads `design.md` on every `make verify` and fails if a token
drifted or a literal colour entered the shell.

---

## Defects found and fixed this session

| # | Defect | Consequence had it shipped |
|---|---|---|
| 1 | **The domain redactor destroyed FlightRules' own token measurements.** `/token/i` matched `maxTokenRegressionPercent` and `tokens`, so the live gate returned `"maxTokenRegressionPercent": "[redacted]"`. | A security control silently corrupting part of a release decision. Fixed with an exact-name allowlist; credential-shaped keys still redact, asserted by tests. |
| 2 | **The documented purge-then-sync recovery could not work.** The `signoz_sync` job is idempotent on the contract's content, so a sync after a purge returned the previous job's cached conflict result. | A deployment whose database was rebuilt could never re-sync. `make signoz-purge` now also clears the register rows and completed sync jobs. |
| 3 | **The licence gate crashed instead of checking.** `/\bOR\b/i` matched the "or" inside `LGPL-3.0-or-later` (a hyphen is a word boundary), the split made no progress, and the function recursed until the stack overflowed. | A security gate that has not actually run since Phase 01. Fixed; a malformed expression now fails the check rather than the process. |
| 4 | **An LGPL dependency entered the tree.** Behind that crash: Next.js pulls in `sharp`, whose `@img/sharp-libvips-*` is `LGPL-3.0-or-later`, which this repository's policy denies. | A licence violation in a distributed artefact. Removed via `pnpm.ignoredOptionalDependencies` — not suppressed, not allow-listed. This product uses no `next/image`. |

## Important discoveries

New source-lock entry: **SL-060** — Next.js 16.2.11's built-in TypeScript step cannot drive
TypeScript 7.0.2. It fails to detect it, reinstalls it on every build and crashes the build worker.
`tsc -p apps/web/tsconfig.json` over the same sources exits 0 under the full strict configuration
and does catch real errors. `apps/web`'s build script runs the typecheck first; only the broken
integration is bypassed.

## Judgement calls to preserve

ADR-0010 and ADR-0011 hold the full set. The ones a later phase could undo by accident:

1. **Decision precedence is `error > fail > insufficient_data > pass`.** A proven zero-tolerance
   violation in three runs outranks the absence of a twentieth run. The live canary shows both
   `MIN_RUNS_NOT_MET` and `ZERO_TOLERANCE_VIOLATION`, and decides `fail`.
2. **A check whose evidence is structurally absent is disclosed, never passed.** `not_measured` plus
   a disclosure when *no* run reports the metric; `insufficient_evidence` when *some* do.
3. **The violation rate is over failing runs, not violations.**
4. **`release evaluate` exits `0` for an evaluation that completed, whatever it found.** Deciding is
   `gate check`'s job.
5. **The exit-code table lives in the engine.** The CLI refuses to report a decision when the
   server's `exitCode` disagrees with its own mapping.
6. **Status is a word, never a hue.** There is no green and no red anywhere in this product.
7. **Clay appears once per page.** `design.md` permits one `#bc7155` element per viewport.
8. **The graph table is the canonical rendering**, not a fallback.
9. **`tokens.css` is excluded from the formatter** because it is a verbatim copy.
10. Everything Phase 10 established still holds: pure compilation, register-based ownership,
    `signoz_update_view` never called, material-field read-back.

---

## Unresolved limitations

1. **`GET /api/releases/:id/diff` is not registered** — Phase 14.
2. **The GitHub workflow has not run on GitHub.** Its shape is asserted by 14 tests and every
   command in it is one `make demo-full` runs locally, which reproduced `0` then `2`.
3. **The interactive UI workflows are Phase 13, 14 and 15 work**, and the pages say so rather than
   offering inert buttons. The baseline form renders and validates but does not submit; the Contract
   Studio shows the YAML read-only.
4. **No automated accessibility scan and no Playwright suite** — Phase 16, PRD section 22.4.
5. **Alert recovery is not yet evidenced** — Phase 16.
6. **Logs are structured but not exported over OTLP** — Phase 16.
7. **Token and retry regression are disclosed rather than measured** for the demo agent, which makes
   no model call and whose approved family carries no retries.
8. **No authentication.** PRD section 6.1 scopes P0 to local mode.
9. Everything else Phase 10 listed still stands.

---

## Next phase: 13 — Baseline and Contract Studio UI

PRD section: line 3331.

### Entry criteria — all SATISFIED

| Criterion | Evidence |
|---|---|
| Phase 12 merged and green | `5726d26`; `make verify` exit 0 on `main` |
| Every PRD section 8 route exists with its data, states and copy | `docs/evidence/phase-12/route-smoke.txt`, 20 live responses |
| Baseline, route-family, contract, job and sync APIs reachable | Phases 09, 10 and 12; `GET /api/openapi.json` |
| The design system is locked and enforced | `make scan-design`, inside `make verify` |

### Scope

Branch `phase/13-contract-studio`. PRD Phase 13 lists eleven tasks: baseline selection form, job
progress UI, rejected-trace summary, route-family list, canonical route graph, approve and exclude
actions, proposed-rule review, YAML editor with schema errors, graph-based rule controls, the
validate/approve/activate/export/sync flows, and preventing activation of invalid or unsaved
changes.

The exit gate: **a new user can move from v1 traces to an active contract entirely through the UI.**

### Facts that will matter

- Phase 12 deliberately left the forms non-submitting. The markup, the labels, the error association
  and the progress vocabulary are already in place and tested; Phase 13 adds the Server Actions.
- A Server Action must not import `lib/api.ts` from a client component — it is `server-only`. Put
  the action in the route's own module, or a `"use server"` file, and keep the fetch server-side.
- The first client component in this application will be the YAML editor. `web.test.ts` currently
  asserts that **no** route file contains `"use client"`; that assertion will need to become
  "no route file fetches from the browser" instead, which is the rule that actually matters.
- Contract activation must trigger artifact sync (PRD Phase 13 test 7). The API route already exists
  (`POST /api/contracts/:id/sync-signoz`) and returns a job; the UI needs the job-progress component.
- `make demo-seed` is the reference implementation of the whole flow, in `scripts/seed-demo.mjs`.
  Phase 13 is that sequence, in a browser.
- The route-family review actions write audit events. PRD Phase 13 test 3 asserts the exclusion path
  specifically.
- Integration tests drop the schema. Re-run `make demo-full` before recording anything.
- Start order: `make up`, `make db-migrate`, `make api`, `make worker`, `make web`.

---

## Release and deployment authorisation (recorded 2026-07-26, for Phase 16 and Phase 17)

The repository owner has granted standing authorisation for the public release actions below. A
later session must **not** re-ask whether they are permitted. It must still not perform any of them
before Phases 13 to 16 are complete, merged and green — partial phase work is never published.

### Granted authorisations

| Capability | State |
|---|---|
| `gh` GitHub CLI | Already authenticated on this machine |
| Railway CLI and account | Already authenticated on this machine |
| Create the final **public** GitHub repository and set its metadata | Authorised |
| Push `main`, create tags, create GitHub releases | Authorised |
| Deploy the completed application through Railway | Authorised |

### GitHub release requirements (Phase 17)

1. Inspect whether a GitHub remote or repository already exists; never create a duplicate.
2. If none exists, create a **public** repository under the PRD's final product name.
3. Set a precise description derived from the PRD section 3.6 product claim.
4. Add suitable topics.
5. Use the licence the repository already establishes — `Apache-2.0`, declared in `package.json`
   and enforced by `make scan-licences`. It is a deliberate decision, already documented; do not
   re-decide it without an ADR.
6. Finalise the README, architecture document, threat model, contribution instructions, security
   policy, third-party notices and AI-assistant disclosure that PRD section 26 requires.
7. Push complete `main`, then the release tag, then create the release with factual notes.
8. **Run the real GitHub Actions workflows after pushing.** The 14 local shape tests over
   `.github/workflows/release-gate.yml` are not the final proof — the handoff's unresolved
   limitation 2 stands until a real run exists.
9. Inspect every workflow result and fix every failure before declaring release readiness.
10. Record the public repository URL and every workflow run URL in the final evidence.

### Railway deployment requirements (Phase 17)

1. Inspect the existing Railway account, projects and services first; never duplicate.
2. Deploy through the repository's supported production architecture (`compose.app.yaml` names the
   services: postgres, api, worker, web, and the demo topology).
3. **Foundry and `casting.yaml` remain the authoritative, judge-reproducible SigNoz deployment.**
   Railway is the hosted public demo path and must not replace that requirement.
4. Decide explicitly whether SigNoz is deployed on Railway or FlightRules connects to another
   publicly reachable SigNoz. Never deploy against an address reachable only from this machine —
   `http://localhost:8080` and `http://localhost:8090` are local-only.
5. All secrets go through Railway's secret configuration. Never into source, images, build args,
   logs, screenshots or evidence files.
6. Run migrations through the documented process (`make db-migrate`, `@flightrules/db run migrate`).
7. Verify API, worker, web, database, SigNoz, MCP and OTLP connectivity **from the deployed
   environment**, functionally. A successful Railway build is not deployment success, and an open
   port is not readiness — SL-010 and SL-012 both apply.
8. Run the real public demo: approved release passes, unsafe release fails with the deterministic
   gate result, the UI shows the real diff and violation evidence, public SigNoz links resolve.
9. Save public deployment URLs and redacted deployment evidence.

### SigNoz credential audit (do before asking for any key)

A valid local credential already exists — Phase 10's live MCP writes and read-backs prove it. Find
and document its source rather than requesting a new one. The audit to perform and record in
`docs/RUNBOOK.md`:

1. The environment schema and setup scripts: `.env.example`, `scripts/bootstrap-signoz.sh`.
2. How the local SigNoz first user was bootstrapped, and how the API key was minted.
3. The exact server-side variable names FlightRules reads. Use the repository's existing names —
   do not add aliases.
4. That the key is not committed (`make scan-secrets`), not exposed to the browser
   (`apps/web/src/lib/api.ts` is `server-only`), and redacted from logs and evidence
   (`packages/domain/src/redaction.ts`).
5. That `.env.example` names the variable and carries no value.
6. That `POST /api/setup/signoz/verify` validates a supplied key through a read-only MCP call, and
   that an incorrect key produces the expected authentication failure.

For the hosted environment, mint a **separate** deployment credential through the supported SigNoz
process and store it only in Railway secrets.

### Final outputs the release session must return

Public repository URL; final commit; release tag and release URL; GitHub Actions run results;
public web URL; public API URL; public SigNoz URL where appropriate; Railway project and service
names; final exact test counts; approved gate result; unsafe gate result; the exact demo commands;
the exact reset command; remaining honest limitations; submission-ready status.
