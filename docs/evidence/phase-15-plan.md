# Phase 15 plan — Violation Inspector UI

Branch `phase/15-violation-inspector`. PRD line 3399. Route: `/projects/[projectId]/violations/[violationId]`
(PRD section 8.12 — the route already exists; it is completed, not replaced).

**Objective**: provide complete trace-level evidence for each failed rule.

**Exit gate**: every release failure can be audited from rule to trace evidence to downstream effect.

---

## Entry criteria — verified

| Criterion | Evidence |
|---|---|
| Phase 14 merged and green | `d14f4fb` on `main`; `make verify` exit 0, 1,151 unit tests |
| The violation and evidence endpoints exist | `GET /api/violations/:id`, `/evidence`, Phase 09 |
| The release diff supplies the approved comparison | `GET /api/releases/:id/diff`, Phase 14 |
| The demo produces three critical violations | `make demo-full`, canary exit 2 |
| Browser suite exists at three viewports | Phases 13 and 14 |

## Scope

| # | PRD task | Approach |
|---|---|---|
| 1 | Violation detail page | Complete the existing PRD section 8.12 route |
| 2 | Rule definition and severity | Already present; extended with expected-versus-observed |
| 3 | Highlight observed evidence | Only canonical indices the evaluator named. No similarity search |
| 4 | Approved comparison | The diff's baseline graph, rendered as the canonical table |
| 5 | Correlated logs through MCP **when requested** | New `GET /api/violations/:id/logs` |
| 6 | Downstream metrics | New `GET /api/violations/:id/metrics` |
| 7 | Release and contract context | From the violation row and the gate |
| 8 | Evaluation metadata | Evaluator version, evaluated-at, run evaluation |
| 9 | Copyable evidence summary | `lib/evidence-summary.ts`, plus a textarea and a copy button |
| 10 | Safe SigNoz deep links | `traceLink` from Phase 14 (SL-061) |

## Decisions

1. **Logs and metrics are fetched on request, and that is a correctness decision, not a performance
   one.** A page that always calls SigNoz cannot render when SigNoz is down — and the violation
   evidence is local, persisted and needs no dependency at all. Fetching on request is what makes
   "failed log or metric fetch degrades without hiding the core violation" true by construction
   rather than by careful error handling.
2. **Neither endpoint can fail the page.** Every failure mode PRD Phase 15 lists — zero results,
   unavailable, malformed, timeout, typed-field mismatch, partial, truncated — is HTTP 200 with a
   typed `state`. The panel says what happened; nothing throws.
3. **Correlation is by the evaluator's recorded trace identifier**, never by a time window or a
   service name, either of which would attach another run's evidence to this violation. A trace
   identifier that is not 32 lowercase hex characters is never sent to SigNoz.
4. **Highlighting is restricted to evidence the evaluator produced.** A highlight the deterministic
   evaluator did not name would be an assertion the product cannot defend.
5. **The metric's *kind* is part of the answer.** `measured`, `observed side effect`, `inferred risk`
   and `unavailable` are distinct states in the API response, because PRD Phase 15 forbids a
   fabricated financial-loss figure and forbids inferring an effect telemetry does not show.
6. **Trace-quality warnings stay context.** `client_span_without_server_span`,
   `unobservable_subtree` and `insufficient_evidence` are rendered as what this trace could not
   show, never as findings. The aborted server span the canary omits never becomes a violation.
7. **The summary is on the page as well as on the clipboard.** A read-only textarea, so a user
   without clipboard permission or without JavaScript can still select and copy it.

## Test inventory

Unit: the evidence summary — every required identifier, determinism, redaction, newline forgery,
control characters, bounding, unknown-field naming, trace-quality framing. Browser: the three
critical violations end to end, evidence highlighting, on-request fetching, the metric-kind
distinction, degradation, the not-found state, the `Ignore and pass release` prohibition in the
rendered page, and hostile-telemetry escaping. Live: a genuine SigNoz outage, reproduced by pointing
the API at an unroutable MCP address.
