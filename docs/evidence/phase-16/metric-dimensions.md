# Phase 16 task 13 — the metric dimensions, and why SL-062's diagnosis was wrong

Closes the handoff's unresolved limitation 2: *"The `flight_rules.*` metrics carry the project and
agent dimensions with empty values (SL-062), so a metric cannot be narrowed to one agent."*

Run 2026-07-26 against SigNoz v0.134.0 and MCP server v0.9.0.

---

## What SL-062 recorded

> For `flight_rules.duplicate_side_effects` in this deployment, grouping by
> `flight_rules.project.id` and `flight_rules.agent.id` returns one series whose label **values are
> empty strings**. The dimensions are named on the series and carry no value, so a `filter` on them
> matches nothing while the underlying data is real.

Filed under a SigNoz behaviour. It is not one.

## What was actually happening

`packages/telemetry/src/instruments.ts` emitted:

```text
project.slug   agent.key   release.key
```

`apps/api/src/routes/violation-evidence.ts` grouped by:

```text
flight_rules.project.id   flight_rules.agent.id
```

The two halves of the product had never agreed on a name. SigNoz answered exactly as asked — with
the labels the query requested, carrying empty values, because nothing had ever set them.

**Grouping by a label nothing sets is not an error.** That is why no single query could reveal it,
and why the empty values read as a quirk of the backend rather than as a mismatch. The only thing
that can catch it is a cross-reference between the emitting declaration and the querying
declaration.

## The fix

- `AGENT_IDENTITY` and `RELEASE_IDENTITY` in `packages/telemetry/src/metrics.ts` declare the
  identity dimensions once and are spread into every instrument, so no instrument can quietly carry
  a different set from its neighbours.
- Both the identifier **and** the human-readable key are emitted. The identifier is what the API,
  the saved views and the spans select on, so a metric and a span can be joined; the key is what a
  dashboard legend shows. They are one-to-one, so carrying both adds no series.
- `QUERYABLE_IDENTITY_DIMENSIONS` is exported and imported by the API route, so the two lists are
  one list.
- `metricDimensionDisagreement()` returns any instrument missing a dimension a caller may narrow by,
  and a test asserts it is empty. That is the check that could have caught this on the day it was
  introduced.
- `recordTraceFetchFailure` and `recordArtifactSync` now take the same identity object rather than
  two loose strings, so a call site cannot supply a slug where an identifier belongs.

## Live proof

`make verify-telemetry`, against the running deployment after `make demo-full`:

```text
Metric dimensions
  ok    2 series returned for flight_rules.duplicate_side_effects
  ok    1 series carry both FlightRules dimensions with real values
  ok    filtering on flight_rules.agent.id narrows 2 series to 1
```

Grouped, unfiltered — the two series are the legacy one (emitted before the fix, dimensions never
set) and the new one:

```text
series[flight_rules.project.id="" flight_rules.agent.id=""]
       points=46 nonZero=3 max=2.267
series[flight_rules.project.id="019f9ccf-7c3a-71bf-8bbd-f043cdf50a0c"
       flight_rules.agent.id="019f9ccf-7c3c-72b9-a688-db40a061ac70"]
       points=6 nonZero=1 max=0.183
```

Filtered on the agent — the thing SL-062 said matched nothing:

```text
series[flight_rules.project.id="019f9ccf-7c3a-71bf-8bbd-f043cdf50a0c"
       flight_rules.agent.id="019f9ccf-7c3c-72b9-a688-db40a061ac70"]
       points=6 nonZero=1 max=0.183
```

The identifiers match `.demo-state.json` exactly, so the series is scoped to the demo agent rather
than to the deployment.

Through the product, `GET /api/violations/:id/metrics`:

```text
state: ok | detail: null
metric: flight_rules.duplicate_side_effects | kind: observed_side_effect | points: 55
```

`detail: null` is the load-bearing part. The route sets a `detail` whenever the returned series
carries no point for this agent — the honest disclosure that the number is deployment-wide. It is
now absent, because the series **is** the agent's.

## What remains true from SL-062

Everything about the response *shape*. `signoz_query_metrics` still answers in
`data.data.results[].aggregations[].series[]` with `values: [{timestamp, value}]` and no `rows`
array, and a series still carries its labels as an array of `{key: {name}, value}` rather than as a
map. `metricSeriesReader` and `metricPointsOf` handle both, and
`packages/signoz-mcp/src/malformed.test.ts` pins that a populated metric is not read as empty.

Only the third part of SL-062 — the diagnosis of the empty label values — was wrong, and it is
superseded here.

## High-cardinality safeguards, re-verified

| Control | Where | State |
|---|---|---|
| dynamic IDs normalised out before fingerprinting | `packages/normaliser` | asserted |
| metric label allowlist | `METRIC_SPECS` + `filterDimensions`, checked twice | asserted |
| no trace ID, span ID, route fingerprint, evaluation ID or run ID as a metric dimension | `highCardinalityDimensions()` returns `[]` | asserted |
| bounded route-family count and rare-route threshold | `packages/baseline-miner` | asserted |
| bounded evidence output | `packages/contract-engine/src/evidence.ts` | asserted |
| bounded API page size | `apps/api` route validation | asserted |
| bounded log body | 2,000 characters, `apps/api/src/signoz.ts` | asserted |

The identity dimensions the fix adds are bounded by the number of releases, which is bounded by use
rather than by input, so the series count does not grow with traffic.
