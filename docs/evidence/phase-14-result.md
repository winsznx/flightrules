# Phase 14 result — Release Diff UI

```text
PHASE: 14 — Release Diff UI
STATUS: PASS
BRANCH: phase/14-release-diff
```

Objective: make behavioural release changes immediately understandable.
Exit gate: **a judge can understand the v2 regression from the release page without reading source
code.**

---

## What was implemented

### `GET /api/releases/:releaseId/diff` — the handoff's unresolved limitation 1, closed

`apps/api/src/routes/diff.ts`. A **read**: no job, no trace fetch, no row written. It loads the
release's most recent completed evaluation, takes the approved route family the evaluator itself
judged the representative run nearest to, and hands both stored canonical graphs to the deterministic
comparison in `@flightrules/trace-graph`.

Three properties it exists to guarantee, each of which the browser could otherwise get wrong:

1. **The comparison is server-side and deterministic.** An integration test reads the endpoint twice
   and asserts the two bodies are byte-identical apart from the retrieval timestamp.
2. **The baseline side is an *approved* route family, never "the previous release".** A release is
   judged against what a human sanctioned.
3. **The nearest approved route is the evaluator's own judgement**, read from
   `run_evaluations.nearest_route_family_id`, never recomputed by similarity in a page.

A release with no completed evaluation returns `RELEASE_INSUFFICIENT_DATA`, not an empty diff:
"nothing changed" and "we have not looked" are different answers and only one is safe to show.

### `diffCanonicalGraphs`, extracted rather than reimplemented

`diffGraphs` only ever used the raw `TraceGraph` to look up span identifiers; the comparison itself
was already canonical-to-canonical. It now delegates to an exported `diffCanonicalGraphs`, which
takes a span-ID lookup as a parameter. The database stores only the canonical form, so this is what
lets the diff read persisted evidence instead of re-fetching two traces from SigNoz. All fifty
existing `trace-graph` tests pass unchanged, which is the point: the behaviour is the same function.

### The pages

- **Releases list** — PRD section 8.10's ten columns, plus decision filters as links, so every
  filtered view is a URL that can be sent and reloaded, and the filter works without JavaScript. A
  filter matching nothing says how many releases exist rather than showing a bare empty state.
- **Release Diff** — the decision banner, then `components/graph-diff.tsx`: a narrative in sentences,
  a side-by-side ordered comparison, and the typed change list. All four PRD actions are live:
  `Open representative violation`, `Re-run evaluation`, `Download evidence`, `Open in SigNoz`.
- **Evidence download** — `releases/[releaseId]/evidence/route.ts`, assembled from the gate decision
  and the diff, so it can carry nothing they do not.

### Accessibility: the text equivalent is the artefact, not a copy of it

The comparison is rendered as a **table of steps**, not a drawing, and the narrative above it states
the same facts in sentences. There is no visual-only channel to have an equivalent *for*. A screen
reader user reads "5 step(s) the approved route always performs are absent from this release:
fraud.check, policy.retrieve, … Each one is a check that did not run." and
"payment.refund 2 times against 1. A repeated write is a repeated side effect." — the same words a
sighted reader sees. Presence is carried by the words `IN BOTH`, `REMOVED`, `ADDED`, `REPEATED` and
by border weight. No colour distinguishes anything.

---

## The discovery this phase turned up — SL-061

**Every `trace_runs.signoz_web_url` in the database was `null`, so no SigNoz link worked.** PRD
section 8.11 requires `Open in SigNoz`, FR-017 requires evidence linking, and acceptance A9 requires
that a failure links to real SigNoz trace evidence. None of it was working, and nothing had noticed
because no page had tried to use the link before.

Probing the pinned MCP server directly established three facts:

1. `signoz_get_trace_details` **does** return a `webUrl`, and its path is `/trace/<traceId>`.
2. `signoz_execute_builder_query` returns **no `webUrl` at all** — and SL-020 and SL-021 require the
   builder query for custom span attributes, so that is the call the miner and evaluator make.
3. The host in the URL SigNoz returns is `signoz-signoz-0:8080`, its **Compose service name**, which
   no browser outside the deployment network can resolve.

Probing `${SIGNOZ_URL}/trace/<id>` over HTTP was deliberately not treated as confirmation: SL-012
records that an unmatched SigNoz path returns the SPA shell with HTTP 200.

`packages/signoz-mcp/src/web-url.ts` implements the rule that follows: **the path is SigNoz's, the
origin is the operator's.** It refuses a non-`http(s)` base and any trace identifier that is not 32
lowercase hex characters, so neither a hostile configuration value nor hostile telemetry can become
an anchor `href`. Ten unit tests, anchored to the URL the live server actually returned.

## Other defects found and fixed

| # | Defect | Consequence had it shipped |
|---|---|---|
| 1 | **The browser suite was not isolated.** Phase 13's workflow spec purges the managed SigNoz artefacts and resets the database — correctly, that is its exit gate — and it ran before the read-only specs, destroying the state they assert against. Twenty tests failed for a reason that had nothing to do with them. | A suite that fails for the wrong reason is a suite that gets ignored. The destructive spec is now its own Playwright project, declared last, and the read-only projects exclude it. Ordering is a property of the configuration, not of anyone's memory. |
| 2 | **A running worker steals the integration suite's queued jobs.** `runner.integration.test.ts`'s shutdown test expects one job to remain queued; a worker process sharing the database claims it first. | An intermittent failure that looks like a race in the runner and is not. Recorded here and in the runbook: stop the worker before `make test-integration`. |

---

## Tests run

```text
make verify                                  exit 0
make test                53 files   1,151 passed   0 failed   0 skipped
make test-integration    15 files     241 passed   0 failed   0 skipped
make test-e2e            42 tests      38 passed   0 failed   4 skipped
                         ---
                         1,430 tests passed
```

Unit tests rose from 1,140 to 1,151: ten for the SigNoz link builder, one for the new
"no comparison engine reaches the browser" invariant. Integration rose from 234 to 241: seven for the
diff endpoint. The four skipped browser tests are viewport-scoped by design.

```text
make signoz-verify       exit 0
make contract-validate   exit 0, 20 documents valid
make demo-full           exit 0 — approved exit 0, unsafe canary exit 2
scripts/smoke-web-routes 20 of 20 routes rendered real content and leaked nothing
```

---

## Runtime validation — the exit gate

`docs/evidence/phase-14/canary-diff.json` is the live endpoint's answer for the unsafe canary.
Fifteen typed changes, and the three the demo exists to reveal are all there:

```text
Removed step             policy.retrieve          the missing policy check
Removed step             fraud.check              the missing fraud check
Duplicate side effect    payment.refund|write     1 → 2, the duplicate refund
Cardinality changed      payment.refund           1 → 2
Route not approved       22ffa0c0e578ef70…        the route matches no approved family
```

The sixteen numbered steps of the exit gate, performed in a browser and asserted by
`tests/e2e/phase-14-release-diff.spec.ts`:

| Step | Observed |
|---|---|
| 1–2 | The approved v1 release reads `PASS: This release stayed within the approved trajectory contract.` and its narrative says every step matches the approved route |
| 3–5 | The unsafe v2 release reads `FAIL: This release exceeded one or more trajectory thresholds.`; the banner carries the zero-tolerance count and the findings table shows `ZERO TOLERANCE VIOLATION` |
| 6–8 | The narrative names `policy.retrieve` and `fraud.check` as checks that did not run, and `payment.refund 2 times against 1` as a repeated write. The typed list shows `REMOVED STEP`, `DUPLICATE SIDE EFFECT`, `CARDINALITY CHANGED` and `ROUTE NOT APPROVED` |
| 9 | `Open the nearest approved route` opens the route family and its canonical graph |
| 10–11 | Representative failing and passing traces are listed with their outcome, route approval and similarity |
| 12 | The SigNoz link resolves to `http://localhost:8080/trace/<traceId>` and names a trace the page itself lists |
| 13 | The evidence download carries release, baseline, decision, contract, counts, typed changes, findings and evidence — and contains none of `prompt`, `completion`, `chain_of_thought`, `authorization`, `api_key`, `bearer `, `tool_arguments` or `tool_result` |
| 14–15 | Re-evaluation creates a job, the decision is **unchanged** while it runs, the job survives a reload, and a real decision is shown once it completes |
| 16 | The page's own sentences name all three regressions without any identifier a non-technical reader would have to decode |

Also asserted: the ten PRD columns, the decision filter as a URL, a filter matching nothing, an
unknown release identifier showing the not-found state, no green or red anywhere by computed-style
sweep, no horizontal overflow at any width, and no injected `script`, `iframe` or `on*` handler
anywhere in `main` whatever the telemetry contained.

---

## Evidence

```text
docs/evidence/phase-14-plan.md
docs/evidence/phase-14-result.md
docs/evidence/phase-14/browser-suite.txt    the 42-test browser run
docs/evidence/phase-14/canary-diff.json     the live diff endpoint's answer for refund-agent-v2
docs/evidence/phase-14/route-smoke.txt      20 live route responses
docs/evidence/phase-14/demo-full.txt        the live demo, 0 then 2
docs/research/source-lock.md                SL-061
```

## Known limitations

1. **The diff compares one representative run, not the whole release.** A release whose runs took
   several different routes shows the first failing one. The aggregate rates beside it are over every
   run, so nothing is hidden, but the topology shown is one run's.
2. **Typed changes carry no span identifiers.** A canonical node has no span ID by design — the
   fingerprint must not depend on one — so `candidateSpanIds` is empty on this path. Span-level
   evidence is the Violation Inspector's, which is Phase 15.
3. **`Open in SigNoz` opens the trace view, not a filtered release view.** SigNoz's release-scoped
   URL shape was not verified, and SL-012 makes an HTTP probe worthless as verification, so no link
   was invented for it.
4. **Latency and token change are disclosed rather than measured for the demo agent**, which makes no
   model call. Unchanged from Phase 11.
5. **The browser suite needs a seeded demo and leaves the demo reset.** `make demo-full` before
   `make test-e2e`, and again after, if the full demo state is wanted back. Recorded in the runbook.

```text
NEXT PHASE ENTRY CRITERIA: SATISFIED
```
