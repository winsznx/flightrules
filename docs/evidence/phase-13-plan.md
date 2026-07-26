# Phase 13 plan — Baseline and Contract Studio UI

Branch `phase/13-contract-studio`. PRD line 3331.

**Objective**: implement the complete baseline capture and contract review workflow.

**Exit gate**: a new user can move from v1 traces to an active contract entirely through the UI.

---

## Entry criteria — verified in this session, not assumed

| Criterion | Command | Result |
|---|---|---|
| Phase 12 merged and green | `git merge-base --is-ancestor 5726d26 main` | reachable |
| Complete validation suite | `make verify` | exit 0 |
| Unit and property tests | `make test` | 1,116 passed / 0 failed / 0 skipped, 51 files |
| Integration tests | `. ./.env && make test-integration` | 234 passed / 0 failed / 0 skipped, 15 files |
| SigNoz surfaces | `make signoz-verify` | exit 0 |
| Committed contracts | `make contract-validate` | exit 0, 20 documents |
| Live demo | `make demo-full` | exit 0; approved `refund-agent-v1` exit 0, unsafe `refund-agent-v2` exit 2 |
| All 14 routes and 6 tabs | `node scripts/smoke-web-routes.mjs` | 20/20 rendered real content, no leak |
| Design system locked | `make scan-design` | tokens match `design.md`; only its seven colours ship |
| Managed artefacts | purge, re-sync, read back | 10 total, 10 synced, 0 drifted, 0 failed, 0 conflict, 10 verified |

One environment note recorded rather than papered over: `make test-integration` needs `.env`
sourced; the Makefile target does not do it, and without it every integration file fails at import
with `SIGNOZ_API_KEY must be set`. That is a Makefile gap, addressed in this phase.

One live-state note: the integration suites drop the schema, which orphans the ten SigNoz resources
from their register rows. The next sync then reports ten conflicts, exactly as the Phase 12 handoff
describes. `make signoz-purge && make signoz-sync` recovered it to ten verified artefacts, proving
the documented recovery path a second time.

---

## Tasks, each mapped to a PRD Phase 13 task

| # | PRD task | Files |
|---|---|---|
| 1 | Baseline selection form | `baselines/new/page.tsx`, `baselines/new/actions.ts` |
| 2 | Job progress UI | `components/job-progress.tsx`, `components/auto-refresh.tsx` |
| 3 | Rejected-trace summary | `components/rejected-traces.tsx` |
| 4 | Route-family list | `baselines/new/page.tsx`, agent Routes tab |
| 5 | Canonical route graph | existing `GraphTable`, now reached from the review flow |
| 6 | Approve and exclude actions | `routes/[routeFamilyId]/actions.ts` |
| 7 | Proposed-rule review | `contracts/[contractId]/page.tsx` rules section |
| 8 | YAML editor with schema errors | `components/yaml-editor.tsx`, `contracts/[contractId]/actions.ts` |
| 9 | Graph-based rule controls | `packages/contract-schema/src/edit.ts`, studio controls section |
| 10 | Validate, approve, activate, export, sync | `contracts/[contractId]/actions.ts` |
| 11 | Prevent invalid or unsaved activation | `edit.ts` guards + server-side action guards |

## Decisions

1. **Server Actions, never browser fetches.** `lib/api.ts` stays `server-only`. Every mutation is a
   `"use server"` function that calls the API server-side, then `revalidatePath`.
2. **Progress is a server render, refreshed.** The job id lives in the URL. The page reads
   `GET /api/jobs/:id` and `/events` server-side. `AutoRefresh` is a client component that calls
   `router.refresh()` while the job is non-terminal and renders nothing. Reload, API restart, worker
   restart and closing the page therefore all work, and no progress value is invented in the browser.
3. **`MINING_STAGES` is the only progress vocabulary.** `discovering_traces`,
   `fetching_span_trees`, `normalising_routes`, `grouping_route_families`,
   `proposing_contract_rules` map one-to-one onto PRD section 8.7's five sentences. No second list.
4. **One canonical contract state.** `packages/contract-schema/src/edit.ts` applies each graph rule
   control as a deterministic transformation of the stored YAML, re-validated through the Phase 07
   parser before it is written. The graph controls and the editor are two views of one document.
   No contract semantics enter a React component.
5. **A plain accessible `<textarea>` rather than an editor dependency.** CodeMirror and Monaco were
   considered and rejected: both are large, both need a client-side language mode this product does
   not otherwise need, and the PRD asks for the smallest reliable implementation. Validation is
   server-side through the parser that already exists, and errors are rendered as a list linked by
   path and line. Nothing is lost: the parser is the authority either way.
6. **Nothing shows success from a write alone.** Every action re-reads and renders server-confirmed
   state. Sync shows the register's read-back verified status.
7. **The Phase 12 client-component assertion is replaced by a stronger one** (batch plan D3).

## Test inventory

Unit: `packages/contract-schema/src/edit.test.ts`; `apps/web/src/web.test.ts` client-boundary
invariants; action-guard tests. Integration: the whole capture-to-active-contract path through the
API. Browser: `@playwright/test@1.62.0` (SL-034, Apache-2.0, already source-locked) across desktop,
narrow desktop and mobile, keyboard-only, with console and hydration errors treated as failures.

## Live exit gate

The 23-step browser workflow from reset demo state, ending in ten read-back verified artefacts and
a reload that preserves every state.
