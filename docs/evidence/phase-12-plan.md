# Phase 12 plan — UI foundation and `design.md` integration

Branch: `phase/12-ui-foundation`. Base: `1d3d1bb` on `main`.

PRD sections read in full before writing anything: Phase 12 (line 3283), section 8 in its entirety
(every route, every literal string), 12.2, 12.3 (Web boundary), 20.3 (accessibility), 20.4 (browser
support), 22.4 (end-to-end tests). `design.md` read in full.

## Entry criteria — all satisfied

| Criterion | Evidence |
|---|---|
| `design.md` exists | repository root, 18 581 bytes, read in full |
| Design assets referenced by it are present | it references **no asset files**. Its imagery section describes a 3D render it does not ship, and its sole typeface, HelveticaNowDisplay, is licensed and not committed — `design.md` supplies the substitute stack itself (Neue Haas Grotesk Display, Inter, Helvetica Neue). Recorded in ADR-0011. |
| Product API is stable enough for UI work | Phase 09 + Phase 10 + Phase 11 routes, all described by `GET /api/openapi.json`, generated from the declarations that serve traffic |
| Phase 11 merged and `main` green | `21b6b75`; `make verify` exit 0, 1 090 unit + 234 integration |

## Objective

Build the product shell, apply the supplied design system, and lock the information architecture.
Exit gate: the full route shell matches `design.md`, keeps the PRD's content hierarchy, and has no
placeholder copy.

## Tasks (PRD Phase 12, 1–10)

1. Parse `design.md`; write `docs/adr/0011-design-token-mapping.md`.
2. `packages/ui/src/tokens.css` — every token from `design.md`'s own Quick Start block, verbatim.
   Nothing invented; a value not in `design.md` does not exist.
3. Asset loading and validation — a build-time check that every asset the stylesheet references is
   present, and an explicit development error when one is not.
4. `packages/ui` — app shell, navigation, page header, table, card, form controls, dialog, toast,
   skeleton, empty state, status pill, stat card, key-value list, graph table fallback.
5. `apps/web` — every route from PRD section 8, with the PRD's literal copy.
6. Responsive layout: one breakpoint set, `--page-max-width: 1200px`, tables scrolling rather than
   truncating.
7. Accessibility: keyboard reachability, visible focus, skip link, labelled forms with error
   association, status never conveyed by colour alone, reduced-motion support.
8. Graph table fallback — the canonical graph as an ordered table, always present, never
   conditional on a rendering library.
9. Stable test selectors — `data-testid` on every route root and every asserted region.
10. Loading, empty, error, degraded and success states on every route that fetches.

## Design constraints and how they are honoured

| Constraint | Decision |
|---|---|
| no generic bento-grid dashboard | The project overview is `design.md`'s "Feature Block" 2-column grid on white, not a tile wall |
| no invented gradients, neon, glassmorphism, blobs | none used; elevation is surface colour and hairlines only, as `design.md` requires |
| no fake metrics | every number renders from an API response; a route with no data shows its empty state |
| no fake trace graphs in authenticated routes | the graph table renders the stored canonical graph or the empty state |
| landing visuals may be illustrative | `/` uses a labelled schematic diagram, marked as illustrative |
| UI copy from this PRD | every heading, CTA, empty state and status sentence is PRD section 8 verbatim; a test asserts it |

### The colour problem, stated

`design.md` forbids additional accent hues and permits exactly one `#bc7155` element per page.
PRD 20.3 requires that status is not conveyed by colour alone. Both are satisfied by conveying
status as an uppercase **word** plus a rule weight, never as a hue: `PASS`, `FAIL`,
`INSUFFICIENT DATA`, `ERROR`. Clay is reserved for the single most important element on a page.
Recorded in ADR-0011.

## Routes (PRD section 8)

```text
/                                                             landing
/setup                                                        connect to SigNoz
/projects                                                     projects list
/projects/[projectId]/overview                                trajectory health
/projects/[projectId]/agents                                  agents list
/projects/[projectId]/agents/[agentId]                        agent detail, six tabs
/projects/[projectId]/agents/[agentId]/baselines/new          baseline capture
/projects/[projectId]/agents/[agentId]/routes/[routeFamilyId] route family detail
/projects/[projectId]/agents/[agentId]/contracts/[contractId] Contract Studio
/projects/[projectId]/agents/[agentId]/releases               releases list
/projects/[projectId]/agents/[agentId]/releases/[releaseId]   Release Diff
/projects/[projectId]/violations/[violationId]                Violation Inspector
/projects/[projectId]/integrations/signoz                     SigNoz integration
/demo                                                         demo
```

Phase 12 delivers all fourteen with real data, real states and the PRD's copy. Phases 13, 14 and 15
deepen the baseline/Contract Studio, Release Diff and Violation Inspector interactions.

## Boundary

PRD 12.3: the web application calls the FlightRules API only. It holds no SigNoz credential and
makes no MCP call. Every fetch happens in a React Server Component against
`FLIGHTRULES_API_URL`, which is server-only, so no API base URL or header ever reaches the browser.

## Tests

- route smoke tests for all fourteen routes, against a scripted API
- PRD copy assertions: every literal string PRD section 8 fixes
- token integrity: no colour or font used that `design.md` does not define
- accessibility: labelled controls, focus order, skip link, status not colour-only
- responsive: the shell renders at 375 px, 768 px and 1440 px
- missing asset: the build fails, or the development error is explicit
- every displayed metric traces to an API field

## Out of scope

Interactive baseline review and the YAML editor (Phase 13), the graph diff visual (Phase 14), the
violation evidence deep-links (Phase 15).
