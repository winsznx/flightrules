# Phase 15 result — Violation Inspector UI

```text
PHASE: 15 — Violation Inspector UI
STATUS: PASS
BRANCH: phase/15-violation-inspector
```

Objective: provide complete trace-level evidence for each failed rule.
Exit gate: **every release failure can be audited from rule to trace evidence to downstream effect.**

---

## What was implemented

### Two API reads, both of which can fail without costing anything

`GET /api/violations/:violationId/logs` and `GET /api/violations/:violationId/metrics`. Both are
fetched **on request**, and that is a correctness decision rather than a performance one: a page
that always calls SigNoz cannot render when SigNoz is down, and a violation is local, persisted
evidence that needs no dependency at all. Fetching on request is what makes PRD Phase 15's "failed
log or metric fetch degrades without hiding the core violation" true by construction.

Neither route can fail the page. Every failure mode the PRD lists — zero results, unavailable,
malformed, timeout, typed-field mismatch, partial, truncated — is HTTP 200 with a typed `state` and
an empty result set.

Logs are correlated by the **trace identifier the evaluator recorded**, never by a time window or a
service name, and an identifier that is not 32 lowercase hex characters is never sent to SigNoz.

### The metric's kind is part of the answer

`measured`, `observed side effect`, `inferred risk` and `unavailable` are distinct states in the
response and distinct words on the page. PRD Phase 15 forbids a fabricated financial-loss figure and
forbids inferring an effect the telemetry does not prove; the way to satisfy that is to make the
*claim type* a field rather than a caption. For the duplicate refund the page shows
`flight_rules.duplicate_side_effects` as an **observed side effect** — a count of repetitions, not a
measure of their cost — and says so.

A browser test asserts the page contains no `$`, `usd`, `revenue`, `loss of` or `estimated cost`.

### The page

Evidence highlighting is restricted to canonical indices the deterministic evaluator named. Nothing
searches for a visually similar step: a highlight the evaluator did not produce would be an
assertion the product cannot defend. The approved comparison is the diff's baseline graph. Release,
contract and evaluation context, and the copyable summary, complete the nine PRD sections.

Trace-quality warnings — `client_span_without_server_span`, `unobservable_subtree`,
`insufficient_evidence` — render as what this trace could not show, in a `role="status"` panel that
says "context, not violations". The aborted server span the canary omits never becomes a finding.

### The evidence summary

`apps/web/src/lib/evidence-summary.ts`, assembled on the server from fields that are already safe
and from nothing else — which is the whole argument for it carrying nothing unsafe. Rendered into a
read-only textarea **and** offered on the clipboard, so a user without clipboard permission or
without JavaScript can still select and copy it.

---

## Defects found and fixed

| # | Defect | Consequence had it shipped |
|---|---|---|
| 1 | **The evidence table paired labels with canonical nodes by index.** The duplicate-refund violation records one label (`payment.refund`) and **two** nodes (`1`, `6`); the zip rendered one row and silently dropped node 6. | Half the evidence for the finding the demo exists to explain, missing from the page that exists to show it. Labels, nodes and span identifiers are now rendered as the three independent lists they are. |
| 2 | **`signoz_query_metrics` answers in a time-series shape, and the shared reader read it as empty** (SL-062). The reader counts `rows`; a metric answer has none — it has `series`. A metric with 67 observations, 7 of them non-zero, reported as "no series exists". | Worse than an error: indistinguishable from a truthful empty result, on the panel whose whole job is to say what actually happened. Fixed with `metricSeriesPayloadSchema` and `metricSeriesReader`, which count observations. |
| 3 | **The metric filter matched nothing while the data was real.** The series carry `flight_rules.project.id` and `flight_rules.agent.id` as dimension **names with empty values**, so a filter on them excluded everything. | An empty panel that looked like an absence of side effects. The route now **groups** rather than filters, and states in its own response when the series is deployment-wide rather than narrowed to the agent. Populating the dimensions is Phase 16. |
| 4 | **A control character in telemetry could forge a line in the evidence summary.** A canonical label containing `\n` could have added `zero_tolerance         no` to a document a reviewer pastes into an issue. | A reader would have taken a forged line as FlightRules' own statement. Control characters are neutralised before assembly, asserted by a test that attempts exactly that forgery. |

## Discovery recorded

**SL-062** — `signoz_query_metrics` answers `data.data.results[].aggregations[].series[]` with
dimensions as an array of `{key: {name}, value}`, not the `rows` shape every other builder query
uses; and in this deployment the FlightRules dimensions come back named with empty values.

---

## Tests run

```text
make verify                                  exit 0
make test                54 files   1,159 passed   0 failed   0 skipped
make test-integration    15 files     241 passed   0 failed   0 skipped
make test-e2e            72 tests      68 passed   0 failed   4 skipped
                         ---
                         1,468 tests passed
```

Unit tests rose from 1,151 to 1,159: eight for the evidence summary. Browser tests rose from 42 to
72: thirty for the Violation Inspector across three viewports.

```text
make signoz-verify       exit 0
make contract-validate   exit 0, 20 documents valid
make demo-full           exit 0 — approved exit 0, unsafe canary exit 2
scripts/smoke-web-routes 20 of 20 routes rendered real content and leaked nothing
managed artefacts        10 total, 10 synced, 0 drifted, 0 failed, 0 conflict
```

---

## Runtime validation — the exit gate

For the unsafe canary, all three critical violations were opened in a browser and asserted end to
end by `tests/e2e/phase-15-violation-inspector.spec.ts`:

| Requirement | `require-policy-retrieve` | `require-fraud-check` | `single-payment-refund-write` |
|---|---|---|---|
| Exact failed rule in the heading | yes | yes | yes |
| Severity and zero-tolerance state | `CRITICAL`, zero tolerance yes | same | same |
| Expected versus observed | yes | yes | `at most 1` / `2` |
| Trace and canonical graph evidence | yes | yes | yes |
| Approved comparison | yes | yes | yes |
| Release and contract context | yes | yes | yes |
| Evaluation metadata | yes | yes | yes |
| Correlated logs, fetched on request | typed state, correlation shown | same | same |
| Downstream metrics | `observed side effect`, 67 observations, 7 non-zero, peak `0.667` | same series | same |
| Safe SigNoz link | `http://localhost:8080/trace/<traceId>` | same | same |
| Evidence summary copied | yes, and asserted free of prompt, tool payload and credential terms | yes | yes |

### The dependency failure, reproduced rather than simulated

Recorded in `docs/evidence/phase-15/dependency-failure.txt`. The API was restarted with
`SIGNOZ_MCP_URL=http://127.0.0.1:9/mcp` — port 9 is the discard service, so every MCP call genuinely
fails at the transport. Nothing was mocked and no code path was stubbed.

```text
GET /api/violations/<id>/logs      HTTP 200   state unavailable   logs 0
GET /api/violations/<id>/metrics   HTTP 200   state unavailable   series 0

the violation page                 HTTP 200
  violation-what-failed            present
  violation-observed-route         present
  violation-approved-route         present
  violation-trace-evidence         present
  violation-release-context        present
  violation-rule                   present
  violation-evaluation             present
  violation-summary                present
  violation-summary-text           present
  both panels                      UNAVAILABLE, "could not be reached"
```

Every piece of core evidence renders with SigNoz switched off, and both dependent panels say so.

Also asserted: an unknown violation shows the not-found state; the rendered page never contains
`Ignore and pass release`; and no `script`, `iframe` or `on*` handler appears anywhere in `main`,
whatever the telemetry contained. No green and no red is painted at any of the three viewports, by
computed-style sweep.

---

## Evidence

```text
docs/evidence/phase-15-plan.md
docs/evidence/phase-15-result.md
docs/evidence/phase-15/browser-suite.txt         the 72-test browser run
docs/evidence/phase-15/dependency-failure.txt    a real SigNoz outage, and what survived it
docs/evidence/phase-15/route-smoke.txt           20 live route responses
docs/evidence/phase-15/demo-full.txt             the live demo, 0 then 2
docs/research/source-lock.md                     SL-062
```

## Known limitations

1. **Correlated logs are always empty in this deployment.** FlightRules writes structured logs to
   stdout and does not export them over OTLP yet, so SigNoz holds none. The panel says exactly that
   rather than showing an unexplained blank. OTLP log export is Phase 16.
2. **The downstream metric is not narrowed to one agent.** The series carry the FlightRules project
   and agent dimensions with empty values (SL-062), so what is shown is the deployment-wide series,
   and the response says so. Populating those dimensions is Phase 16.
3. **The metric is a rate over an interval, not a total.** `0.667` is what SigNoz's default
   aggregation returned; it is a real observation of the duplicate write, and it is not "two
   refunds". The page labels it an observed side effect rather than a count of refunds.
4. **Only one metric per violation.** The route picks by violation type — duplicate side effects for
   a cardinality or duplicate finding, violations otherwise. A violation with several relevant
   series shows one.
5. **The browser cannot inject the log failure**, because the fetch is server-side, which is the
   architecture the product should have. The browser test asserts that a non-`ok` state leaves the
   evidence intact; the genuine outage is reproduced separately and recorded above.

```text
NEXT PHASE ENTRY CRITERIA: SATISFIED
```
