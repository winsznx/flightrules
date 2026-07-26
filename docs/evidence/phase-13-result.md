# Phase 13 result — Baseline and Contract Studio UI

```text
PHASE: 13 — Baseline and Contract Studio UI
STATUS: PASS
BRANCH: phase/13-contract-studio
```

---

## What was implemented

### One new domain module

`packages/contract-schema/src/edit.ts` — the eight graph rule controls of PRD section 8.9, each as a
deterministic transformation of the stored YAML document. It parses to the AST with the same safe
options `loadContractDocument` uses, applies one structural change, re-serialises, and then
**re-reads the result through `parseContract`**, refusing the edit if it does not validate. So a
control cannot produce a document the Phase 07 validator rejects, and the studio cannot reach an
approvable state the API would refuse.

`controlStateOf` reads control state back out of the stored document. That is the other direction of
PRD Phase 13's bidirectional requirement: a hand edit that removes a rule turns its control off on
the next render, with no second update path and therefore nothing to drift.

No contract semantics entered a React component.

### The web application

| File | What it does |
|---|---|
| `lib/outcome.ts` | Carries an action's result in the URL, merging rather than appending query parameters |
| `lib/review-actions.ts` | PRD section 8.8's four review verbs and the contract proposal, as Server Actions |
| `components/auto-refresh.tsx` | Client. Calls `router.refresh()` while a job runs; renders nothing |
| `components/submit-button.tsx` | Client. Per-form pending state, so a second click cannot resubmit |
| `components/yaml-editor.tsx` | Client. Dirty-state tracking and the unsaved-navigation guard |
| `components/job-progress.tsx` | Server. Persisted stage and event list, and the five PRD sentences |
| `components/rejected-traces.tsx` | Server. Counts, exclusions by reason, excluded traces, disclosures, reconciliation |
| `components/review-actions.tsx` | Server. The four verbs as four forms |
| `components/outcome-banner.tsx` | Server. Success and failure as words and structure, never a hue |
| `baselines/new/{page,actions}.tsx` | The capture form submits, the job reports, the result is reviewed |
| `routes/[routeFamilyId]/page.tsx` | The four review actions, live |
| `contracts/[contractId]/{page,actions}.tsx` | Validate, approve, activate, sync, export, edit |
| `contracts/[contractId]/export/route.ts` | `Export YAML` as a download, without exposing the API's address |

Three client components exist and no more. Every page and layout is still a Server Component.

### Tooling

`@playwright/test@1.62.0` — already source-locked as SL-034 (Apache-2.0, compatibility matrix line
126) and not previously installed. `make test-e2e` now runs it. `make scan-licences` still passes
over 300 packages.

---

## Defects found and fixed

| # | Defect | Consequence had it shipped |
|---|---|---|
| 1 | **An action's redirect appended `?job=…` to a URL that already had a query string.** `returnTo` for a review action is `.../baselines/new?baseline=<uuid>`, so the result was `…?baseline=X?job=Y`, and the job identifier was swallowed by the first parameter's value. | The contract-proposal job's progress never appeared — on exactly the paths that carry state, which are the paths that matter. Fixed by merging parameters through `URLSearchParams` in `outcomeUrl`, which is now the only way an action builds a redirect. |
| 2 | **The approve guard trusted a query parameter.** The first implementation read `validated=1` from the URL to decide whether the contract had unvalidated changes. | A user could have approved an unvalidated contract by editing the address bar. Replaced with a server-side revalidation: `approve` calls `POST /api/contracts/:id/validate` and requires `valid` **and** `contentHashStable` before it will transition anything. |
| 3 | **`make test-integration` did not source `.env`.** Every SigNoz integration file failed at import with `SIGNOZ_API_KEY must be set`. | A green-looking "no tests ran" result. All four integration targets and the new e2e target now source `.env`, as `docs/RUNBOOK.md` already said they needed. |
| 4 | **The accessibility assertion required a label on hidden inputs.** | It would have forced labels onto controls that are not in the accessibility tree, announcing fields that cannot be focused. Narrowed to visible controls, with the reason recorded. |

## Discoveries recorded

**A demo reset alone is not a clean state.** `POST /api/demo/reset` clears the FlightRules database
and deliberately leaves SigNoz alone (FR-020). The ten managed dashboards, views and alerts
therefore outlive the register rows that recorded owning them, and the next sync correctly refuses
to adopt ten resources it can no longer prove it created — reporting ten conflicts and zero
verified. This is the safe behaviour, not a bug, but it means **a genuinely clean start is
`make signoz-purge` followed by the demo reset**, and the browser suite does exactly that. Recorded
here and in `docs/DEMO_SCRIPT.md` rather than worked around.

**The running API and worker can outlive their own `dist`.** Both had to be restarted before
`/api/route-families/:familyId` — registered since Phase 12 — appeared in `GET /api/openapi.json`.
A stale long-running process is indistinguishable from a missing route from the browser's side.

---

## The Phase 12 assertion that was replaced

`apps/web/src/web.test.ts` asserted that no route file contained `"use client"`. Phase 13 makes the
forms work, so three client components now exist and that assertion could only have been satisfied
by deleting it. Five assertions took its place:

1. no route file is a client component — every page and layout stays server-rendered;
2. exactly three client modules exist, named, so a fourth is a deliberate decision;
3. no client module contains `fetch(`, `XMLHttpRequest`, `EventSource`, `WebSocket`, `@/lib/api`,
   `@/lib/load`, `server-only`, `@flightrules/db` or `FLIGHTRULES_API_URL`;
4. every client module is under 160 lines, so a boundary cannot creep;
5. the design-token rule applies inside client components too.

That is strictly stronger than what it replaced: the old rule permitted a page to fetch from the
browser through any module that was not itself a route file, and said nothing about boundary size.

---

## Tests run

```text
make verify                                  exit 0
  verify-env, format-check, lint, typecheck, test, build,
  contract-validate, scan-design, scan-secrets, scan-licences

make test                52 files   1,140 passed   0 failed   0 skipped
make test-integration    15 files     234 passed   0 failed   0 skipped
make test-e2e            18 tests      12 passed   0 failed   6 skipped
                         ---
                         1,386 tests passed
```

Unit tests rose from 1,116 to 1,140: twenty for `edit.ts`, four for the client-boundary invariants.
The six skipped browser tests are the workflow and the two server guards, which are scoped to the
`desktop` project deliberately — they prove product behaviour, which does not vary by viewport,
and the presentation tests run at all three widths.

```text
make signoz-verify       exit 0
make contract-validate   exit 0, 20 documents valid
make demo-full           exit 0 — approved refund-agent-v1 exit 0, unsafe refund-agent-v2 exit 2
scripts/smoke-web-routes 20 of 20 routes rendered real content and leaked nothing
```

---

## Runtime validation — the exit gate, in a browser

`tests/e2e/phase-13-workflow.spec.ts` performs the PRD's exit gate as twenty-three numbered steps
against the running product. Recorded in `docs/evidence/phase-13/browser-suite.txt`.

| Step | Observed |
|---|---|
| Clean start | Ten managed artefacts purged from SigNoz; database reset through `POST /api/demo/reset` |
| 1–2 | Agent opened; `Capture baseline` followed to the capture page |
| 3–4 | `refund-agent-v1`, `local`, last 6 hours, minimum 20 runs; `Analyse baseline` submitted |
| 5 | Job identifier appeared in the URL; the five PRD section 8.7 sentences rendered with live state; the job reached `SUCCEEDED` from the persisted row |
| 6 | 156 discovered, 156 retrieved, 156 eligible, 0 excluded, 0 duplicate, 1 route family, dataset `COMPLETE`; the reconciliation line read `Reconciled:` |
| 7 | Route family opened; the canonical graph rendered as the ordered node table from the stored canonical form |
| 8 | `Approve` recorded, status `APPROVED`, **and still `APPROVED` after a browser reload** |
| 9–10 | `Propose contract` submitted; the proposal job reached `SUCCEEDED` |
| 11 | Contract Studio opened at status `DRAFT`, 28 rules |
| 12–13 | One `Maximum calls` control applied; the YAML gained `type: cardinality` on the selected step |
| 14–15 | One hand edit added a `forbidden_span` rule; the rules table gained exactly one row and named it |
| 16–17 | Saved, then validated |
| 18–19 | Approved, then activated; status `ACTIVE` |
| 20–21 | `Sync to SigNoz` submitted; the job reached `SUCCEEDED`; the register reported **10 managed artefacts, 10 read-back verified** |
| 22–23 | Browser reloaded; status still `ACTIVE`, the hand-edited rule still present, the control's edit still in the document, and the save control absent because the version is now immutable |
| Throughout | Zero console errors and zero hydration errors; no green and no red painted anywhere |

Two server-side guards were exercised the same way: a document that does not validate cannot be
saved and the stored document is unchanged afterwards, and a control that would contradict an
existing rule is refused with the validator's own `CONTRADICTORY_RULES` finding.

Presentation was validated at 1440px, 820px and 393px: no horizontal overflow, the first tab stop is
a visibly focused skip link, all eight capture controls are labelled and reachable, statuses render
as upper-case words, and a computed-style sweep of every element on the page found no green and no
red.

---

## Evidence

```text
docs/evidence/phase-13-plan.md
docs/evidence/phase-13-result.md
docs/evidence/phase-13/browser-suite.txt     the 18-test browser run
docs/evidence/phase-13/route-smoke.txt       20 live route responses
docs/evidence/phase-13/demo-full.txt         the live demo, 0 then 2
tests/e2e/phase-13-workflow.spec.ts          the exit gate, executable
```

## Known limitations

1. **The workflow test runs at one viewport.** Presentation is validated at three; the workflow is
   not. A layout regression that only breaks the *workflow* on mobile would not be caught. Phase 16.
2. **No automated accessibility audit.** Focus, labelling, landmarks and contrast affordances are
   asserted individually; no axe-style sweep runs yet. Phase 16, PRD section 22.4.
3. **`Evaluate against traces` is a link to the releases page**, not an in-studio evaluation form.
   The PRD lists it among the studio's actions; the evaluation itself is Phase 14's surface.
4. **Route-family review has no bulk action.** Each family is decided individually, which is correct
   for one family and tedious for fifty. Not a P0 concern for the demo topology.
5. Everything Phase 12 listed still stands, except its limitation 3 — the interactive workflows —
   which this phase closes for baseline capture and the Contract Studio.

```text
NEXT PHASE ENTRY CRITERIA: SATISFIED
```
