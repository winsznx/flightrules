# Phases 13 to 15 — batch plan

Written 2026-07-26, after independently re-verifying Phases 11 and 12 on `main`.

This document coordinates one session across three phases. It does **not** replace any phase's own
plan, branch, tests, evidence, acceptance-matrix update or changelog entry. Each phase still runs
the full workflow in CLAUDE.md, and no phase begins before its predecessor is merged and green.

---

## Entry state, independently verified

| Check | Command | Result |
|---|---|---|
| Working tree | `git status --porcelain` | clean |
| Phase 11 merge reachable | `git merge-base --is-ancestor 21b6b75 main` | yes |
| Phase 12 merge reachable | `git merge-base --is-ancestor 5726d26 main` | yes |
| No 13/14/15 branch exists | `git branch -a` | confirmed absent |
| Full validation suite | `make verify` | exit 0 |
| Unit and property tests | `make test` | 1,116 passed, 0 failed, 0 skipped, 51 files |
| SigNoz surfaces | `make signoz-verify` | exit 0 |
| Committed contracts | `make contract-validate` | exit 0, 20 documents valid |

`make test-integration` requires `.env` to be sourced; the Makefile target does not do it. That is a
documentation gap, not a regression — `docs/RUNBOOK.md` records the requirement.

---

## What Phase 12 left, precisely

Phase 12 shipped all fourteen PRD section 8 routes as Server Components with live data, real
loading, empty, error and degraded states, and the copy fixed in `apps/web/src/lib/copy.ts`. It
deliberately shipped **no interaction**:

- the baseline form renders its eight controls and validates, and submits nowhere;
- the route-family review actions are `aria-disabled` spans;
- the Contract Studio shows the YAML read-only and its five actions as disabled spans;
- `GET /api/releases/:releaseId/diff` is not registered at all;
- the Violation Inspector shows the stored violation and its evidence bundle, with no correlated
  logs, no downstream metrics and no copyable summary.

Phases 13, 14 and 15 are exactly the removal of those five gaps.

---

## Cross-cutting decisions taken once, for all three phases

### D1 — Interaction is a Server Action; the browser never holds product state

Every mutation is a Next.js Server Action colocated with its route (or in a `"use server"` module),
which calls `apps/web/src/lib/api.ts` server-side and then `revalidatePath`. `lib/api.ts` stays
`server-only`, so the API base URL and every future header remain on the server, and no page can
fabricate data client-side. This preserves PRD section 12.3 and the Phase 12 invariant that
authenticated routes render only live API responses.

### D2 — Progress is polled by refreshing the server, not by fetching in the browser

A long-running job's identifier goes in the URL (`?job=<uuid>`). The page reads
`GET /api/jobs/:jobId` and `GET /api/jobs/:jobId/events` **server-side** on every render and shows
the persisted stage and event list. The only client component involved calls `router.refresh()` on
an interval while the job is non-terminal and renders nothing.

Consequences, all of which the PRD requires: reload works, an API restart works, a worker restart
works, a job that completed while the page was closed shows its terminal state, and no graph,
metric or progress value is ever computed in the browser. Server-sent events are permitted by PRD
section 15.10 but not required; `GET /api/jobs/:jobId/events` returns the persisted event list
rather than a stream, so polling is the shape the installed API actually supports.

### D3 — The Phase 12 "no client component" assertion is replaced, not deleted

`apps/web/src/web.test.ts` asserts no route file contains `"use client"`. Phase 13 introduces
justified client components, so that assertion is replaced by the invariant that actually matters:

1. every `"use client"` module is in `src/components/`, never a `page.tsx` or `layout.tsx`;
2. no client module imports `lib/api.ts`, `lib/load.ts`, `server-only` or `@flightrules/db`;
3. no client module calls `fetch`, `XMLHttpRequest`, `EventSource` or `WebSocket`;
4. every client module is under a declared line budget, so a boundary cannot creep;
5. the design-token and PRD-copy rules apply to client modules exactly as to route files.

That is strictly stronger than the assertion it replaces: the old test permitted a page to fetch
from the browser through any module that was not a route file.

### D4 — Contract semantics stay in the domain packages

Graph rule controls do not build YAML in React. A new `packages/contract-schema/src/edit.ts`
exposes deterministic editing functions over the YAML document: parse with the existing safe
options, apply one structural change, re-serialise, and re-validate through `parseContract` before
returning. There is one canonical contract state — the stored YAML — and the graph controls and the
editor are two views of it. Nothing is held in two places, so nothing can drift.

### D5 — Nothing shows success from a write response alone

Every mutation re-reads the resource and renders the server-confirmed state. Artefact sync shows
the Phase 10 read-back verified status from the register, never the MCP write result.

### D6 — Browser validation uses `@playwright/test@1.62.0`

Already source-locked (SL-034, Apache-2.0, compatibility matrix line 126) and not yet installed.
Phase 13 installs it and adds the suite; Phases 14 and 15 extend it. Every phase asserts desktop,
narrow desktop and mobile widths, keyboard navigation, focus visibility, loading, empty and error
states, persistence across reload, live API data, and zero console or hydration errors.

---

## Phase 13 — Baseline and Contract Studio UI

Branch `phase/13-contract-studio`. PRD line 3331. Exit gate: **a new user can move from v1 traces
to an active contract entirely through the UI.**

### Scope

| # | PRD task | Deliverable |
|---|---|---|
| 1 | Baseline selection form | The existing eight controls submit a Server Action to `POST /api/agents/:agentId/baselines`; the response's `jobId` becomes the URL |
| 2 | Job progress UI | Server-rendered stage and persisted event list, plus the `AutoRefresh` client component |
| 3 | Rejected-trace summary | `counts`, `retrieval`, `excluded` and `disclosures` from `GET /api/baselines/:id`, reconciled |
| 4 | Route-family list | On the baseline result and on the agent's Routes tab |
| 5 | Canonical route graph | `GraphTable` from the stored canonical graph; hostile strings escaped |
| 6 | Approve and exclude actions | Server Actions on all four PRD verbs |
| 7 | Proposed-rule review | Every field PRD section 10 and ADR-0007 require, including the outlier disclosure |
| 8 | YAML editor with schema errors | Client `<textarea>`, dirty state, save, reset, path-linked errors |
| 9 | Graph-based rule controls | Eight PRD controls, each a deterministic `edit.ts` transformation |
| 10 | Validate, approve, activate, export, sync | Server Actions over the five existing endpoints |
| 11 | Prevent invalid or unsaved activation | Guarded server-side, not only in the markup |

### APIs consumed

`POST|GET /api/agents/:agentId/baselines`, `GET /api/baselines/:id`,
`POST /api/baselines/:id/route-families/:familyId/approve|exclude`,
`POST /api/baselines/:id/propose-contract`, `GET /api/route-families/:familyId`,
`GET|POST /api/agents/:agentId/contracts`, `GET|PUT /api/contracts/:id`,
`POST /api/contracts/:id/validate|approve|activate|sync-signoz`, `GET /api/contracts/:id/export`,
`GET /api/setup/signoz/artifacts`, `GET /api/jobs/:id`, `GET /api/jobs/:id/events`.

All exist. Phase 13 adds **no** API route.

### Client boundaries introduced

| Module | Why interaction requires it | Budget |
|---|---|---|
| `components/auto-refresh.tsx` | An interval that calls `router.refresh()` while a job runs | 40 lines |
| `components/yaml-editor.tsx` | Dirty-state tracking and an unsaved-changes guard | 140 lines |
| `components/confirm-button.tsx` | Pending state and duplicate-submission prevention | 60 lines |

Nothing else. Every page remains a Server Component.

### Live exit gate

The 23 numbered steps of the session brief, performed in a browser from reset demo state, ending in
ten read-back verified artefacts and a reload that preserves every state.

---

## Phase 14 — Release Diff UI

Branch `phase/14-release-diff`. PRD line 3366. Exit gate: **a judge can understand the v2 regression
from the release page without reading source code.**

### Scope

Releases list with the ten PRD columns and status filters; the baseline-versus-canary graph diff;
the typed change list; aggregate metrics; nearest approved route; representative passing and failing
traces; SigNoz deep links; evidence download; re-evaluation; insufficient-data, dependency-error and
stale-data states.

### The one API route this phase adds

`GET /api/releases/:releaseId/diff` — the handoff's unresolved limitation 1. It is a read. It
composes existing deterministic domain functions and invents nothing:

- `diffGraphs` and `unknownRouteChange` from `@flightrules/trace-graph` produce the twelve typed
  change kinds already defined in `packages/trace-graph/src/diff.ts`;
- the baseline side is the approved route family's stored canonical graph;
- the candidate side is the stored trace graph of a representative failing run;
- aggregate metrics come from the same release aggregation `GET /api/releases/:id/gate` serves, so
  the page and the CLI cannot disagree.

The browser computes no difference. PRD section 8.11's twelve required diff labels map onto the
engine's kinds; a label with no supporting evidence is not shown.

### Live exit gate

The sixteen numbered steps of the session brief, ending with a non-technical reading of the page
that identifies the missing policy check, the missing fraud check and the duplicate refund write.

---

## Phase 15 — Violation Inspector UI

Branch `phase/15-violation-inspector`. PRD line 3399. Route `/projects/[projectId]/violations/[violationId]`
(PRD section 8.12 — the route already exists and is not to be reinvented). Exit gate: **every
release failure can be audited from rule to trace evidence to downstream effect.**

### Scope

The nine PRD-required sections; evidence highlighting restricted to nodes the deterministic
evaluator named; the approved comparison; correlated logs fetched through MCP **on request**;
downstream metrics; release and contract context; evaluation metadata; trace-quality warnings; the
copyable evidence summary; safe SigNoz deep links.

### API routes this phase adds

Two reads, both server-side and both degrading without hiding the violation:

- `GET /api/violations/:violationId/logs` — correlated logs for the violation's verified trace ID,
  through the SigNoz MCP path Phase 05 established. Returns a typed degraded state on every failure
  mode: zero logs, unavailable, malformed, timeout, typed-field mismatch, partial, truncated.
- `GET /api/violations/:violationId/metrics` — the FlightRules and downstream metrics PRD section
  17.4 defines that are genuinely associated with the violation. No fabricated financial loss and
  no inferred business effect: `measured`, `observed side effect`, `inferred risk` and `unavailable`
  are distinct states.

### Preserved decisions

`client_span_without_server_span`, `unobservable_subtree` and `insufficient_evidence` stay local
trace-quality context. The missing aborted server span never becomes a violation of its own.

### Live exit gate

Pages for the missing `policy.retrieve`, the missing `fraud.check` and the duplicate
`payment.refund` write, each showing rule, severity, zero-tolerance state, trace and graph evidence,
approved comparison, release and contract context, evaluation metadata, correlated logs, downstream
metrics, safe links and a copied evidence summary — followed by a reproduced log or metric
dependency failure that leaves the core evidence visible.

---

## Test inventory

| Phase | Unit and contract | Integration | Browser |
|---|---|---|---|
| 13 | `edit.ts` transformations, client-boundary invariants, copy, action guards | baseline capture to active contract through the API, audit events, activation guards | the 23-step workflow, three viewports, keyboard-only |
| 14 | typed change mapping, evidence-bundle schema, deep-link construction | `GET /api/releases/:id/diff` against the seeded v1 and v2 releases | pass and fail pages, accessible text equivalent, evidence download |
| 15 | evidence highlighting, summary redaction, degraded states | log and metric routes including every failure mode | three violation pages, dependency failure, keyboard, mobile |

Targeted suites during implementation; `make verify` once before each merge; the full regression
after each merge; `make demo-full` after Phase 13 and again after Phase 15.

---

## Evidence files

```text
docs/evidence/phase-13-plan.md    docs/evidence/phase-13-result.md    docs/evidence/phase-13/
docs/evidence/phase-14-plan.md    docs/evidence/phase-14-result.md    docs/evidence/phase-14/
docs/evidence/phase-15-plan.md    docs/evidence/phase-15-result.md    docs/evidence/phase-15/
```

Each phase also updates `docs/ACCEPTANCE_MATRIX.md`, `CHANGELOG.md` and, where it makes a decision
worth preserving, an ADR.

## Demo-video impact

Phase 13 replaces the demo script's scripted seed with a browser walkthrough, so section 24.2 of the
PRD becomes recordable without a terminal. Phase 14 supplies the reveal in section 24.4. Phase 15
supplies the depth in section 24.5. `docs/DEMO_SCRIPT.md` is rewritten at the end of Phase 15 with
exact commands, URLs, expected output markers and a stable identifier file, so the video can be
recorded without reconstructing state.
