# Phase 12 result — UI foundation and `design.md` integration

```text
PHASE: 12 — UI foundation and `design.md` integration
STATUS: PASS
BRANCH: phase/12-ui-foundation
COMMITS: see docs/evidence/phase-12-commits.md
SOURCES VERIFIED: design.md in full (69 CSS custom properties, 7 colours, 11 components, the do and
                  don't list, the surface stack); PRD Phase 12 (line 3283), PRD section 8 in its
                  entirety, 12.2, 12.3, 20.3, 20.4, 22.4; the installed Next.js 16.2.11, React
                  19.2.8 and TypeScript 7.0.2, run. One new source-lock entry: SL-060.
IMPLEMENTED:      packages/ui (tokens.css verbatim from design.md, base.css, 16 primitives, the
                  graph table); apps/web (Next.js App Router, all 14 PRD section 8 routes);
                  scripts/check-design-assets.mjs and make scan-design, wired into make verify;
                  GET /api/route-families/:familyId; packages/db findRouteFamilyById; make web;
                  ADR-0011; two defects fixed
TESTS RUN:        make verify; make test; make test-integration; node scripts/smoke-web-routes.mjs
TEST RESULT:      1,116 unit passed (51 files); 234 integration passed (15 files); 1,350 total;
                  0 failed, 0 skipped. 20 live route responses, 0 failures.
RUNTIME VALIDATION: see "Runtime validation" below
EVIDENCE:         docs/evidence/phase-12-plan.md, docs/evidence/phase-12/route-smoke.txt,
                  docs/adr/0011-design-token-mapping.md, docs/research/source-lock.md SL-060
KNOWN LIMITATIONS: see "Known limitations" below
NEXT PHASE ENTRY CRITERIA: SATISFIED
```

---

## Runtime validation

The built application was started against the running API and the seeded demo state, and every
route in PRD section 8 was requested. `scripts/smoke-web-routes.mjs` records the result and is
committed, so it is reproducible rather than described.

Each response had to satisfy four conditions, not one: HTTP 200, its own `data-testid="route-…"`
marker, at least two independent pieces of real page content, and no leak. A 200 carrying an empty
shell fails, which is the whole point — PRD section 16 records exactly that failure mode against
SigNoz (SL-012), and a page is no different.

```text
HTTP  MARKER            EVIDENCE            ROUTE
200   landing           title+content+skip  /
200   setup             title+content+skip  /setup
200   projects          title+content+skip  /projects
200   demo              title+content+skip  /demo
200   overview          title+content+skip  /projects/:project/overview
200   agents            title+content+skip  /projects/:project/agents
200   agent             title+content+skip  /projects/:project/agents/:agent  (and all six tabs)
200   baseline-new      title+content+skip  /projects/:project/agents/:agent/baselines/new
200   route-family      title+content+skip  /projects/:project/agents/:agent/routes/:family
200   contract-studio   title+content+skip  /projects/:project/agents/:agent/contracts/:contract
200   releases          title+content+skip  /projects/:project/agents/:agent/releases
200   release-diff      title+content+skip  /projects/:project/agents/:agent/releases/:release
200   violation         title+content+skip  /projects/:project/violations/:violation
200   integration       title+content+skip  /projects/:project/integrations/signoz

All 20 route responses rendered real content and leaked nothing.
```

The leak check asserts that no response contains a SigNoz API key header name, a PostgreSQL
connection string, a database column name (`result_json`, `canonical_graph_json`, `summary_json`),
or the string PRD section 8.12 forbids the product from ever offering.

The data behind those pages was produced by `make demo-full` in the same session: 25 known-good
runs, a baseline mined from them, a contract proposed, approved and activated, ten SigNoz artefacts
compiled and read-back verified, then 8 unsafe canary runs, and the two gate decisions. The Release
Diff page renders the same `FAIL` decision and the same evidence the CLI printed.

---

## What was built

| | |
|---|---|
| `packages/ui/src/tokens.css` | `design.md`'s Quick Start block, verbatim. 69 declarations, unchanged, plus 9 aliases that introduce no value. Excluded from the formatter so a reflowed font stack cannot break the verbatim comparison. |
| `packages/ui/src/base.css` | The shell. No literal colour, size or font: every declaration is `var(--…)`. |
| `packages/ui` components | Page header, section, card, the single clay featured block, dark band, stat, status pill, table, key-value list, form field, dialog, skeleton, and the empty, error, degraded and success states. |
| `packages/ui/src/graph-table.tsx` | The canonical graph as an ordered table. The route's normal rendering, not a fallback. |
| `apps/web` | All 14 PRD section 8 routes, each rendering live API data with its own states. |
| `scripts/check-design-assets.mjs` | Re-reads `design.md` on every `make verify`. |

---

## Defects found and fixed

### 1. The licence gate crashed instead of checking

Installing Next.js pulled in `@img/sharp-libvips-darwin-arm64`, whose licence is
`LGPL-3.0-or-later`. `check-licences.mjs` tested for the SPDX operator with `/\bOR\b/i`, and a
hyphen is a word boundary — so "or" inside `LGPL-3.0-or-later` matched, the split that followed
produced the same string, and the function recursed until the stack overflowed. **A security gate
that crashes is a security gate that is not running.** It has been that way since Phase 01; no
dependency until now happened to carry a hyphenated `-or-` in its identifier.

Fixed by matching the operator with its surrounding whitespace and refusing to recurse unless the
split made progress. A malformed expression now fails the check rather than the process.

### 2. An LGPL dependency entered the tree

Behind that crash was a real policy violation: `LGPL-3.0-or-later` is in this repository's `DENIED`
set. `sharp` is an optional dependency of Next.js used only by `next/image`'s optimiser. This
product ships no raster imagery and uses no `next/image`, so it is now in
`pnpm.ignoredOptionalDependencies` and is not installed at all. The tree went from 282 packages to
297 with Next.js added, and the licence check passes across 17 expressions.

Not suppressed, not allow-listed — removed.

---

## How `design.md` and the PRD were both honoured

The full reasoning is ADR-0011. The two collisions worth restating:

**Status cannot be a colour.** `design.md` forbids additional accent hues and permits one
`#bc7155` element per page. PRD section 20.3 requires that status is not conveyed by colour alone.
Both are satisfied by rendering `PASS`, `FAIL`, `INSUFFICIENT DATA` and `ERROR` as uppercase words
in a hairline pill, with emphasis carried by border weight. There is no green and no red anywhere in
this product, and nothing is lost in monochrome or at low vision.

**Clay appears once per page**, on the thing the page exists to say: the landing call to action, and
the Release Diff decision banner. Nowhere else.

---

## Tests

Phase 12 added **26 unit tests** in `apps/web/src/web.test.ts`:

- all 14 PRD section 8 routes exist, and no page exists that PRD section 8 does not describe
- every route carries a stable `data-testid`
- every literal string in `lib/copy.ts` appears in `docs/PRD.md` verbatim — 100-odd assertions
  across sections 8.1 to 8.14, including PRD section 8.11's four decision sentences character for
  character
- the string PRD section 8.12 forbids appears in no rendered markup
- no route file contains a hex colour, a pixel size or a `font-family`
- no route file imports the database, the MCP client, or reads a credential
- `lib/api.ts` and `lib/load.ts` are `server-only`, and no route is a client component
- `tokens.css` carries every token `design.md` declares, and exactly its seven colours
- `base.css` contains no drop shadow, gradient, blur or filter
- reduced motion, visible focus and both responsive breakpoints are present
- the skip link, the `main` landmark and the labelled navigation exist
- every control on the baseline form is labelled, and every `htmlFor` resolves to an `id`

```text
make verify              exit 0   (including make scan-design)
make test                1,116 passed, 0 failed, 0 skipped   (51 files)
make test-integration    234 passed, 0 failed, 0 skipped     (15 files)
                         ---
                         1,350 tests passed
node scripts/smoke-web-routes.mjs   20 routes, 0 failures
```

---

## Known limitations

1. **Next.js 16.2.11's built-in TypeScript step cannot drive TypeScript 7.0.2** (SL-060). The
   application is fully typechecked by `tsc -p apps/web/tsconfig.json`, which runs before
   `next build` in the package's own build script and in `make typecheck`. Only the broken
   integration is bypassed, and it caught six real `exactOptionalPropertyTypes` violations in the
   first draft of these routes.
2. **The interactive workflows are Phase 13, 14 and 15 work, and say so on the page.** The baseline
   form renders and validates its controls but does not submit; the Contract Studio shows the YAML
   read-only; the route-family review actions and the Release Diff's evidence download are labelled
   and disabled rather than silently inert. Every one of those operations is available through the
   API and the CLI today.
3. **The typeface is the substitute stack `design.md` supplies.** HelveticaNowDisplay is licensed
   and not committed; `design.md` names Neue Haas Grotesk Display, Inter and Helvetica Neue itself,
   and the token is used unchanged.
4. **No automated accessibility scan runs in CI.** The affordances PRD section 20.3 lists are
   asserted structurally by unit tests — labels, error association, focus, reduced motion, the graph
   table alternative, status not conveyed by colour — but an axe-style audit against the rendered
   DOM is a Phase 16 item, along with the Playwright end-to-end suite PRD section 22.4 requires.
5. **Responsive rendering is asserted from the stylesheet, not from screenshots.** Both documented
   breakpoints exist and are tested; capturing images at 375, 768 and 1440 pixels belongs with the
   Playwright suite.
6. **`GET /api/route-families/:familyId` was added to the API.** PRD section 15.5 does not list it
   and PRD section 8.8 requires the page it serves. Recorded in ADR-0011.

---

## Next phase: 13 — Baseline and Contract Studio UI

Entry criteria are satisfied: every route exists with its data, its states and its copy; the
baseline, route-family, contract, job and sync APIs are all reachable; and the design system is
locked and enforced by `make verify`.
