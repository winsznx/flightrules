# ADR-0003 — SigNoz access boundary and the trace-retrieval path

- Status: Accepted
- Date: 2026-07-25
- Phase: 00
- Related: SL-013, SL-019, SL-020, SL-021, SL-022, SL-023

## Context

PRD section 12.4 requires that P0 use the official SigNoz MCP Server for **product reads and
SigNoz artifact writes**. Direct SigNoz HTTP APIs are permitted only when an official MCP tool
cannot express a P0 requirement, the endpoint is documented or present in the pinned OpenAPI
schema, an ADR explains why MCP was insufficient, and tests cover it. Direct ClickHouse access
is prohibited.

PRD FR-004 requires that FlightRules capture, for every span, "approved low-cardinality
attributes" and derive "tool, side-effect, retry, release, environment, and data-domain
classifications". Those classifications come from custom span attributes such as
`agent.side_effect`, `agent.retry.number`, `agent.release.id` and `gen_ai.tool.name`.

The question this ADR answers: **can the pinned MCP server actually return them?**

## Investigation

`signoz_get_trace_details` was the obvious candidate. Its live input schema accepts only
`traceId`, `start`, `end`, `timeRange` and `includeSpans` — there is no field-selection
parameter. A real call against a trace that carried `agent.side_effect` and `agent.release.id`
returned all five spans with correct `span_id`, `parent_span_id`, `name`, `kind_string`,
`duration_nano`, `status_code_string`, `service.name` and `service.version`, plus a fixed list
of well-known HTTP, DB, RPC, cloud and Kubernetes attributes — and **neither custom attribute**.

`signoz_search_traces` has the same limitation: no field selection.

The server's own MCP resource `signoz://traces/query-builder-guide` documents the supported
alternative: `signoz_execute_builder_query` accepts a complete Query Builder v5 request, and a
`requestType: "raw"` query may declare `selectFields` entries with
`fieldContext: "span" | "resource" | "tag"`, where `"tag"` selects arbitrary span attributes.

This was tested against the same trace. The query returned all five spans with `span_id`,
`parent_span_id`, `name`, `kind_string`, `duration_nano`, `service.name` **and** the correct
values of `agent.side_effect` (`write` on `payment.refund`, `read` on the three read steps,
absent on the root) and `agent.release.id` (`phase00-probe-v1` on every span).

Attribute keys are discoverable: `signoz_get_field_keys(signal="traces",
fieldContext="attribute", searchText="agent")` returned `agent.release.id`, `agent.run.id` and
`agent.side_effect` with `"complete": true`.

## Decision

**All product reads and all SigNoz artifact writes go through the official SigNoz MCP Server.
No direct SigNoz HTTP API call and no ClickHouse access is used on any product path.**

The trace-retrieval path is:

1. **Discover** the workspace's field keys with `signoz_get_field_keys` (both `resource` and
   `attribute` contexts) and observed values with `signoz_get_field_values`. Attribute names are
   never hard-coded into a query; the guide states unknown keys hard-error.
2. **Find candidate runs** with `signoz_search_traces`, filtered by the agent's workflow or root
   selector, release attribute, environment and time range, collecting unique `trace_id` values.
   Never assume the first returned span is the root.
3. **Retrieve complete evidence** per trace with `signoz_execute_builder_query`,
   `requestType: "raw"`, filtered on `trace_id = '<id>'`, with `selectFields` covering the
   built-in structural columns plus every attribute the active contract and normaliser
   configuration reference. This is the authoritative source for graph reconstruction.
4. **Corroborate** with `signoz_get_trace_details` for the same trace. It is used as an
   independent check on span count and hierarchy: a disagreement between the two responses marks
   the trace `TRACE_INCONSISTENT` and excludes it from baseline mining rather than being silently
   reconciled.
5. **Deduplicate** by `(trace_id, span_id)` and classify quality before any rule is evaluated.

Constraints carried into the implementation, all taken from the live schema and the server's own
guide rather than from memory:

- `start` and `end` in a builder query are Unix **milliseconds**; the `timestamp` column is
  nanosecond-scale, so a millisecond value must never appear in an inline `timestamp` filter.
- Every `builder_query` carries a positive `limit` and a non-empty `order`.
- `filter` is a **string** expression in `filter.expression`, never a structured object.
- Discovery tools accept `fieldContext: "tag"` as an alias for `"attribute"`, but Query Builder
  `selectFields` and `groupBy` require `"tag"`. The client normalises this difference explicitly.
- `signoz_create_view` and the other create tools take **flat** arguments, not a nested resource
  object. A nested payload fails validation with `"name" cannot be empty`.
- Update tools replace the whole resource, so the client always fetches, strips server-populated
  fields, modifies, and submits the complete object.

## Permitted non-MCP SigNoz HTTP usage

Exactly one narrow exception, and it is **not** on any product path:

`scripts/bootstrap.sh` and `scripts/verify-signoz.sh` call the SigNoz HTTP API to complete
first-user registration (`POST /api/v1/register`), authenticate
(`POST /api/v2/sessions/email_password`), and provision the service account and API key
(`POST /api/v1/service_accounts`, `POST /api/v1/service_account_roles`,
`POST /api/v1/service_accounts/{id}/keys`).

Justification against PRD section 12.4:

1. *An official MCP tool cannot express the requirement.* The MCP server **consumes** an API key;
   it cannot mint the first one. There is no MCP tool for organisation setup, session creation,
   service accounts, or key issuance — the live 41-tool surface contains none.
2. *The endpoints are present in the pinned OpenAPI schema.* All five were read from the
   750 KB OpenAPI document generated by the installed `signoz v0.134.0` binary itself
   (`signoz generate openapi`), which is tier-1 evidence.
3. *This ADR explains it.*
4. *Tests cover it.* `scripts/verify-signoz.sh` runs in CI's integration job and asserts on
   response bodies, not status codes — necessary because unmatched SigNoz paths return the SPA
   shell with HTTP 200.

These calls happen once, during operator bootstrap, before FlightRules starts. The running
product holds only the resulting API key and speaks only MCP.

## Consequences

- Positive: PRD section 12.4 is satisfied with real evidence rather than an assumption, and the
  central chain link "FlightRules can retrieve complete trace evidence" is proven, not hoped for.
- Positive: because retrieval is a declared `selectFields` list, the set of attributes a
  contract depends on is explicit and versioned rather than implicit in whatever the backend
  happens to return.
- Negative: two retrieval calls per trace instead of one. Accepted — the corroboration is what
  makes `TRACE_INCONSISTENT` detectable, which the PRD requires. Both calls are batched per
  trace and bounded by the configured maximum traces per evaluation.
- Negative: a future SigNoz release could change the built-in column set. Mitigated by runtime
  schema validation of every MCP response, the capability snapshot, and the compatibility page.
