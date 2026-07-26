# Phase 14 plan — Release Diff UI

Branch `phase/14-release-diff`. PRD line 3366.

**Objective**: make behavioural release changes immediately understandable.

**Exit gate**: a judge can understand the v2 regression from the release page without reading source
code.

---

## Entry criteria — verified

| Criterion | Evidence |
|---|---|
| Phase 13 merged and green | `faf2d26` on `main`; `make verify` exit 0, 1,140 unit tests |
| The release gate is a read over persisted evidence | `GET /api/releases/:id/gate`, Phase 11 |
| Both releases exist with completed evaluations | `make demo-full` exit 0, `refund-agent-v1` 0 and `refund-agent-v2` 2 |
| The typed graph diff exists and is deterministic | `packages/trace-graph/src/diff.ts`, 50 tests |
| A browser suite exists | Phase 13, `@playwright/test@1.62.0` |

## Scope

| # | PRD task | Approach |
|---|---|---|
| 1 | Release list and status filters | Filters as links, so each view is a URL |
| 2 | Baseline-versus-canary graph diff | New `GET /api/releases/:id/diff`; the page renders, never compares |
| 3 | Typed change list | The engine's twelve kinds, mapped to PRD section 8.11's twelve labels in the API |
| 4 | Aggregate release metrics | Already served by the gate; unchanged, so the page and the CLI cannot disagree |
| 5 | Nearest approved route | `run_evaluations.nearest_route_family_id` — the evaluator's own judgement |
| 6 | Representative passing and failing traces | From the diff endpoint, ordered failing-first and by trace ID |
| 7 | SigNoz deep links | Only from verified identifiers |
| 8 | Evidence download | A route handler composing the gate and the diff |
| 9 | Re-evaluation | A Server Action over `POST /api/releases/:id/re-evaluate` |
| 10 | Insufficient-data and error states | `RELEASE_INSUFFICIENT_DATA` rather than an empty diff |

## Decisions

1. **The diff is a server read, not a browser computation.** PRD Phase 14's last test is "no graph
   data is fabricated client-side"; the way to satisfy it is for the web application to contain no
   code that could. A static test asserts no web module imports `@flightrules/trace-graph`,
   `@flightrules/contract-engine` or `@flightrules/baseline-miner`.
2. **`diffGraphs` is extracted, not duplicated.** The database stores only canonical graphs, and the
   comparison was already canonical-to-canonical; the raw graph was only ever used for span-ID
   lookup. Exporting `diffCanonicalGraphs` and passing the lookup as a parameter preserves the
   existing behaviour exactly — all fifty existing tests must pass unchanged.
3. **The accessible equivalent is the artefact.** The comparison is a table of steps and a narrative
   in sentences. There is no visual-only channel, so there is nothing for a text alternative to fall
   out of date with.
4. **A link is built only from something verified at runtime.** An HTTP probe of a SigNoz path is not
   verification (SL-012); the MCP server's own answer is.
5. **Re-evaluation never updates the decision optimistically.** The gate reads the most recent
   *completed* evaluation, so the previous decision stands until the new job finishes, and the prior
   evidence is preserved either way.

## Test inventory

Unit: the SigNoz link builder; the no-engine-in-the-browser invariant. Integration: the diff endpoint
— representative selection, link construction, byte-identical repeat reads, PRD labels, the
no-approved-route disclosure, the never-evaluated refusal, and an unknown release. Browser: the
sixteen exit-gate steps, the ten columns, filters, evidence download schema and redaction,
re-evaluation with a reload, hostile-telemetry escaping, and three viewports.
