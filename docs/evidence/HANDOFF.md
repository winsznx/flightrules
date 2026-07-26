# FlightRules handoff — after Phase 15

Written 2026-07-26. `main` is green and the working tree is clean.

This replaces the previous handoff. Verify every claim below against the repository before relying
on it. The previous handoff was verified in full at the start of this session: `make verify` exit 0,
1,116 unit and 234 integration tests, `make demo-full` reproducing exit 0 then exit 2, and all
twenty route responses rendering real content. Nothing it claimed was found to be false.

---

## Phase status

| Phase | Status | Phase commit | Merge commit |
|---|---|---|---|
| 00–10 | PASS | see the Phase 12 handoff in git history | — |
| 11 Release evaluation, CLI, and GitHub gate | PASS | `e40b920` | `21b6b75` |
| 12 UI foundation and `design.md` integration | PASS | `a7b3c78` | `5726d26` |
| **13 Baseline and Contract Studio UI** | **PASS** | `d1ac0c4` | `faf2d26` |
| **14 Release Diff UI** | **PASS** | `d5d8daa` | `d14f4fb` |
| **15 Violation Inspector UI** | **PASS** | `676ffed` | `42ff820` |
| 16–17 | NOT STARTED | — | — |

## Verified state

```text
make verify              exit 0
make test                1,159 passed, 0 failed, 0 skipped   (54 files)
make test-integration      241 passed, 0 failed, 0 skipped   (15 files)
make test-e2e               68 passed, 0 failed, 4 skipped   (72 tests, 3 viewports)
                         ---
                         1,468 tests passed
make signoz-verify       exit 0
make contract-validate   exit 0, 20 documents
make demo-full           exit 0 — approved release exit 0, unsafe canary exit 2
managed artefacts        10 total, 10 synced, 0 drifted, 0 failed, 0 conflict
```

---

## What Phases 13 to 15 added

**Phase 13** made the product interactive. `packages/contract-schema/src/edit.ts` implements PRD
section 8.9's eight graph rule controls as deterministic transformations of the stored YAML, each
re-validated through the Phase 07 parser before it is returned — so the graph controls and the
editor are two views of one document and cannot drift. The baseline form submits, the job reports
persisted progress, the four review verbs write audit events, and the Contract Studio validates,
approves, activates, syncs and exports.

**Phase 14** made the regression readable. `GET /api/releases/:releaseId/diff` compares the
release's representative run against the approved route family **the evaluator itself** judged it
nearest to, on the server, deterministically. The page renders sentences before tables:
*"N step(s) the approved route always performs are absent from this release … Each one is a check
that did not run."*

**Phase 15** made every failure auditable. Two on-request reads —
`GET /api/violations/:id/logs` and `/metrics` — neither of which can fail the page, and an evidence
summary that carries identifiers and hashes and nothing else.

## Three things a later phase could undo by accident

1. **The four client components are the only ones.** `auto-refresh`, `submit-button`,
   `yaml-editor`, `copy-button`. Five assertions in `apps/web/src/web.test.ts` enforce it: no route
   file is a client component, exactly those four exist, none fetches or imports the `server-only`
   API client, each is under 160 lines, and the design-token rule applies inside them. A fifth
   client component should be a deliberate decision with its name added to that list.
2. **No comparison engine is bundled into the browser.** A test asserts no web module imports
   `@flightrules/trace-graph`, `@flightrules/contract-engine` or `@flightrules/baseline-miner`. That
   is how "no graph data is fabricated client-side" is guaranteed rather than reviewed.
3. **The metric's *kind* is a field, not a caption.** `measured`, `observed side effect`,
   `inferred risk`, `unavailable`. Collapsing them into one number would let the product imply an
   effect the telemetry does not prove.

## Operational facts that cost time to rediscover

- **A demo reset alone is not a clean state.** `make signoz-purge` **then** the reset. Without the
  purge the next sync correctly reports ten conflicts, because the SigNoz resources outlive the
  register rows that recorded owning them.
- **Stop the worker before `make test-integration`.** It competes with the suite for queued jobs and
  fails the runner shutdown test for a reason unrelated to the runner.
- **`make test-e2e` needs a seeded demo and leaves it reset.** `make demo-full` before, and again
  after. The destructive Phase 13 workflow runs in its own Playwright project, declared last.
- **Do not run a build while the development web server is running.** They share `.next`; the
  running server's chunks are replaced and every page 404s until it restarts.
- **A long-running API or worker can outlive its own `dist`.** Restart both after `make typecheck`.
- **`make demo-urls`** resolves every demo URL from the running API and writes `.demo-state.json`.
  Nothing in `docs/DEMO_SCRIPT.md` hard-codes an identifier.

---

## Unresolved limitations, for Phase 16

1. **Logs are not exported over OTLP.** FlightRules writes structured logs to stdout, so SigNoz holds
   none and the Violation Inspector's log panel is always `empty`. It says exactly that. This is the
   single largest honest gap in the evidence chain.
2. **The `flight_rules.*` metrics carry the project and agent dimensions with empty values**
   (SL-062), so a metric cannot be narrowed to one agent. The API discloses it in its own response.
3. **No automated accessibility audit.** Focus, labelling, landmarks, reading order and the absence
   of colour-only status are each asserted, but no axe-style sweep runs. PRD section 22.4.
4. **Alert recovery is not evidenced.** Firing is (Phase 10); recovery is not.
5. **The GitHub workflow has never run on GitHub.** Fourteen tests assert its shape and every command
   in it is one `make demo-full` runs locally. Phase 17 must run it for real.
6. **The Phase 13 workflow is validated at one viewport.** Presentation is validated at three.
7. **Token and retry regression are disclosed rather than measured** for the demo agent, which makes
   no model call.
8. **No authentication.** PRD section 6.1 scopes P0 to local mode.
9. **`Open in SigNoz` opens the trace view, not a release-filtered view.** SigNoz's release-scoped
   URL shape was not verified and SL-012 makes an HTTP probe worthless as verification, so no link
   was invented.

## Next phase: 16 — Hardening, performance, and adversarial validation

PRD line 3431. Entry criteria are satisfied: Phases 13, 14 and 15 are merged, `main` is green, and
the full demo reproduces exit 0 then exit 2.

The four highest-value items, in the order they repay effort:

1. **Export logs over OTLP**, closing limitation 1 and making the Violation Inspector's log panel
   show something. The panel, its correlation and its degraded states already exist.
2. **Attach the project and agent dimensions to the emitted metrics**, closing limitation 2.
3. **Add the accessibility sweep** to the browser suite that already runs at three viewports.
4. **Evidence alert recovery**, closing limitation 4.

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
