# Phase 16 task 15 — accessibility audit

Closes the handoff's unresolved limitation 3: *"No automated accessibility audit."*

Run 2026-07-26 against the built web application on `:3100`, backed by the running API, worker,
database and SigNoz. Not against markup fixtures.

| | |
|---|---|
| Tool | `@axe-core/playwright@4.11.2` (MPL-2.0, on the licence allowlist), `axe-core` 4.11.2 |
| Standards | `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` |
| Suite | `tests/e2e/phase-16-accessibility.spec.ts` |
| Viewports | 1440×900, 820×900, Pixel 7 |
| Routes swept | 14 — every PRD section 8 route, plus Contract Studio, baseline result, Release Diff and the Violation Inspector |
| Gate | any `critical` or `serious` finding fails the suite. `moderate` and `minor` are printed and recorded, never suppressed |

**Result: 86 browser tests pass, 4 skipped, 0 failed. Zero critical and zero serious findings
remain.**

---

## What the first run found

Eighteen hand-written accessibility assertions were already in the suite from Phases 12 to 15 —
visible focus, no colour-only status, a table alternative for the graph, labelled form fields. The
automated sweep found three serious classes none of them covered, because none of them was a
property anyone had thought to check.

### 1. Contrast — `color-contrast`, serious, 10 routes

`--color-cool-ash` (`#8e8e95`) on the white canvas measures **3.25:1**. PRD section 20.3 requires
WCAG AA, which is 4.5:1. It affected navigation links, table captions, muted helper text and
definition terms — up to 32 nodes on the Release Diff page.

A second instance: the featured Clay Ember card (`#bc7155`) carried white text at **3.72:1** and
muted grey at **1.31:1**.

**Fixed without changing design.md's palette.** Cool Ash keeps its declared value and still serves
the dark surfaces it was drawn for, where it measures 6.06:1 on Footer Ink and 5.51:1 on Dark Slate.
The *semantic* muted-text role points at `#707077` (4.91:1) for the white canvas, and the featured
card takes Deep Ink (5.29:1). Which member of the palette may sit on which surface is PRD section
20.3's decision; the palette itself is unchanged.

`apps/web/src/web.test.ts` guarded that `tokens.css` declares exactly design.md's seven colours.
Rather than delete that guard, it now admits precisely one derived value, and a second test
**recomputes** all four contrast ratios the decision rests on — including the one that must stay
*below* AA, white on Clay Ember, which is why the featured card changed.

### 2. Keyboard access to scrolling regions — `scrollable-region-focusable`, serious

Three scroll containers were unreachable by keyboard: the table wrapper (Contract Studio, Release
Diff), and the landing page's architecture schematic at narrow widths. Their right-hand halves could
not be read without a pointer.

The table wrapper is now a labelled `section` with `tabIndex={0}`, so a screen reader announces the
caption rather than "group". The schematic's scroll moved onto a labelled wrapper, because `pre` has
no ARIA role and therefore takes no accessible name.

Biome's `noNoninteractiveTabindex` rule objects to both. Each suppression names WCAG 2.1.1 rather
than the rule: a scrollable region is the documented case where a non-interactive element must be
focusable.

### 3. A test that was wrong, not a product defect

The 200 %-zoom check emulated zoom by halving the viewport, which at the Pixel 7 viewport asks for
about 197 CSS pixels. No success criterion requires that. WCAG 1.4.10 requires reflow at **320**
pixels, so the emulation now floors at 320 rather than the product being changed to satisfy a
requirement nobody has.

---

## What is checked, beyond the automated sweep

| Check | Where |
|---|---|
| automated axe sweep, 14 routes × 3 viewports | `phase-16-accessibility.spec.ts` |
| first tab stop is a working skip link, visibly focused | same |
| focus moves and is never trapped on a data-heavy route | same |
| no horizontal scroll at any viewport | same, plus `expectNoHorizontalOverflow` |
| usable at 200 % zoom, floored at WCAG's 320 px reflow width | same |
| reduced motion honoured — nothing animates beyond 0.1 s | same |
| visible focus states | `phase-13-presentation.spec.ts` |
| status is a word, never a colour | `phase-13-presentation.spec.ts`, `components.tsx` |
| graph has a table alternative | `phase-15-violation-inspector.spec.ts` |
| form labels and error association | `phase-13-workflow.spec.ts` |
| live job progress is announced | `phase-13-workflow.spec.ts` |
| no console or hydration error on any route | the `clean` fixture, every test |

## The four skipped browser tests, investigated

Both are in `tests/e2e/phase-14-release-diff.spec.ts`:

| Line | Test | Skip |
|---|---|---|
| 171 | evidence download carries the decision and no prompt payload | `test.skip(project.name !== "desktop", "the download runs once")` |
| 226 | re-evaluation creates a job without changing the decision | `test.skip(project.name !== "desktop", "re-evaluation runs once")` |

Two tests × two non-desktop projects = four skips. **Neither is a disabled test.** Both run at the
desktop viewport on every run, and both assert server behaviour — a file download and a job
submission — that does not vary with viewport width. Running the same download three times would
triple the state churn for no coverage.

No P0 accessibility workflow is skipped.

## Remaining findings, recorded honestly

The sweep reported **no** `moderate` or `minor` findings on any route at any viewport in the final
run. Where the suite prints advisory findings, that section of the output was empty.

Two limitations that an automated tool cannot settle:

1. **No screen-reader walkthrough.** axe checks names, roles and structure; it cannot tell whether
   the reading order of the Release Diff makes sense to somebody listening to it. The page's
   sentence-before-table structure was designed for that, and it has not been verified with a real
   screen reader.
2. **Browser coverage is Chromium only.** PRD section 20.4 names Chrome, Firefox and Safari.
   Playwright runs the three viewport projects on Chromium; the other two engines are untested.

## Reproducing this

```bash
make demo-full                                  # seed, so every route renders real content
WEB_PORT=3100 pnpm --filter @flightrules/web run start
npx playwright test --project=desktop --project=narrow --project=mobile
```
