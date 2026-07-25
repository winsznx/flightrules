# ADR-0011 — Design token mapping, and how `design.md` and the PRD are both honoured

- Status: accepted
- Date: 2026-07-25
- Phase: 12
- Extends: ADR-0001 (stack and version policy)

## Context

PRD Phase 12 task 1 requires `design.md` to be parsed into a token mapping recorded as an ADR.
`CLAUDE.md` makes `design.md` authoritative for colour, typography, spacing, layout styling,
borders, shadows, icon treatment, assets and motion, and forbids it from changing product wording,
routes, features, states or information architecture.

`design.md` is the Hyer Aviation style reference: a near-monochrome editorial system built on one
near-black, one white, two greys, two dark surfaces and a single warm clay accent, with
architectural display type, fully-rounded controls and elevation expressed as surface colour rather
than shadow.

Two of its rules collide with two of the PRD's, and resolving those collisions honestly is most of
what this ADR is for.

## Decisions

### 1. Tokens are copied, not authored

`packages/ui/src/tokens.css` is `design.md`'s own `Quick Start / CSS Custom Properties` block,
verbatim — sixty-nine declarations, unchanged. `scripts/check-design-assets.mjs` re-reads
`design.md` on every `make verify` and fails if any declaration is missing or has drifted, and a
unit test asserts the same thing plus that the stylesheet contains exactly the seven colours
`design.md` defines and no eighth.

`base.css` — the shell — contains no literal colour, size or font. Every declaration is
`var(--…)` against a token, enforced by the same check. An invented hex is the failure the design
system exists to prevent, and it is the one a reviewer is least likely to spot.

### 2. Nine semantic aliases, and nothing else

The product needs to say "text", "muted text", "border", "featured surface". `design.md` names its
tokens by appearance (`--color-cool-ash`), which is right for a style reference and wrong for a
component that must not care which grey it is using. Nine aliases sit at the end of `tokens.css`,
each one a `var()` of a token above it. No alias introduces a value.

### 3. Status is a word, never a hue

`design.md`: "Don't introduce additional accent hues — the system is monochrome with one warm note",
and "Don't place two `#bc7155` elements on the same page". PRD section 20.3: "status is not conveyed
by colour alone".

Both are satisfied by the same decision: **status is rendered as an uppercase word inside a hairline
pill, and emphasis is a border weight.** `PASS`, `FAIL`, `INSUFFICIENT DATA`, `ERROR`, `SYNCED`,
`CONFLICT` carry their own meaning; nothing is lost in monochrome, at low vision, or in a printed
screenshot. There is no green and no red anywhere in the product.

This is not a compromise between the two documents. It is a better answer than a colour would have
been, and the design system is the reason it was reached.

### 4. Clay appears once per page, on the thing the page exists to say

- `/` — the final call to action.
- Release Diff — the release decision banner.
- Every other route — no clay at all.

A violations table cannot colour its rows, which is the point of decision 3.

### 5. The typeface falls back to `design.md`'s own substitutes

HelveticaNowDisplay is licensed and is not committed. `design.md` supplies the substitute stack
itself — Neue Haas Grotesk Display, Inter, Helvetica Neue — and its `--font-helveticanowdisplay`
token already ends in a full system fallback chain. The token is used unchanged, so a deployment
that licenses the face gets it by installing it, and one that does not gets the substitute the
design system chose.

`design.md` references **no asset files**: its imagery section describes a 3D render it does not
ship. `apps/web/public` is therefore empty, and the asset check reports that rather than passing
silently. If a future asset is added and its file is missing, the check fails the build.

### 6. Illustration is confined to the landing route, and labelled

PRD Phase 12: "no fake trace graphs in authenticated product routes; landing visuals may use clearly
labelled illustrative diagrams". The landing page carries one schematic of the real pipeline with a
caption that says, in words, that it is illustrative and that every number in the authenticated
product comes from the API. No authenticated route contains a drawn graph: the canonical graph is
rendered from the stored canonical form, or its empty state is shown.

### 7. The graph table is the canonical rendering, not a fallback

PRD section 20.3 requires a table or list alternative to the graph. `GraphTable` is not a degraded
mode that appears when something fails — it is what the route family and violation pages render,
always. It is readable by a screen reader, copyable, and diffable between two releases. A visual
graph, when Phase 14 adds one, is an addition to it.

### 8. Every page is a Server Component; the API client is `server-only`

PRD section 12.3 forbids SigNoz credentials and MCP calls in the browser, and PRD section 8.2
promises the user that "credentials stay on the server and are never exposed to the browser".
`src/lib/api.ts` and `src/lib/load.ts` both begin `import "server-only"`, so importing either from a
client component is a build error rather than a code-review note. No route file contains
`"use client"`, and a test asserts it.

`FLIGHTRULES_API_URL` is read only inside that module, so the API's location never reaches a client
bundle either.

### 9. `GET /api/route-families/:familyId` was added to the API

PRD section 15.5 does not list it. PRD section 8.8 requires a bookmarkable page for a single route
family, and PRD section 12.3 allows the web application to call the FlightRules API and nothing
else, so the page cannot exist without it. Read-only, typed, validated, and covered by the same
generated OpenAPI document as every other route.

### 10. `next build`'s TypeScript step is skipped, and `tsc -p` runs instead

Next.js 16.2.11's built-in TypeScript integration cannot drive TypeScript 7.0.2: it fails to detect
it, reinstalls it on every build, and crashes the build worker (SL-060). `tsc -p
apps/web/tsconfig.json` over the same sources exits 0 under the workspace's full strict
configuration and does catch real errors — it rejected six `exactOptionalPropertyTypes` violations
in the first draft of these routes.

`apps/web`'s `build` script therefore runs the typecheck first and `next build` second. The
application is fully typechecked on every build; only the broken integration is bypassed.

## Consequences

- A colour, size or font that `design.md` does not define cannot enter the product without failing
  `make verify`.
- Status is legible without colour, which also happens to satisfy WCAG.
- The browser cannot reach SigNoz, the database, or a credential, by construction.
- Adding a route means adding it to `REQUIRED_ROUTES` in the route test, which asserts both that
  every PRD section 8 route exists and that no page exists which PRD section 8 does not describe.
