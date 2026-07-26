# FlightRules architecture

FlightRules turns SigNoz traces into deterministic release contracts. This document says how, which
package owns each step, and — where the design looks unusual — why the obvious alternative was
rejected.

[docs/PRD.md](PRD.md) is authoritative. Where this document and the PRD disagree, this document is
wrong.

---

## The shape of the problem

An agent's answer is not its behaviour. Two releases can return the same sentence to the customer
while one retrieved the refund policy, checked for fraud and wrote once, and the other skipped both
checks and wrote twice. Output evaluation cannot see the difference. A distributed trace can.

So the product is a comparison between **execution structure that was approved** and **execution
structure that actually happened**, decided by a pure function over evidence retrieved from SigNoz.

## The pipeline

```text
 Instrumented agent and five demo services
        │  OTLP traces, metrics and logs, over the collector
        ▼
 SigNoz — deployed by Foundry from the committed casting.yaml
        │  SigNoz MCP Server, HTTP on :8000
        ▼
 @flightrules/signoz-mcp        the only place FlightRules talks to SigNoz
        │  Query Builder v5 raw rows, with custom span attributes
        ▼
 @flightrules/normaliser        volatile identifiers out, classifications in
        ▼
 @flightrules/trace-graph       spans → a causal graph → a canonical form → a fingerprint
        │
        ├──► @flightrules/baseline-miner    many approved runs → route families → a proposed contract
        │
        ▼
 @flightrules/contract-schema   parse and validate the contract document
        ▼
 @flightrules/contract-engine   evaluate one run, then aggregate a release, then decide the gate
        │
        ├──► @flightrules/artifact-compiler  the contract → ten SigNoz views, panels and alerts
        │
        ▼
 apps/api + apps/worker         persistence, jobs, and the HTTP surface
        │
        ├──► apps/web           baseline capture, Contract Studio, Release Diff, Violation Inspector
        └──► apps/cli           `flightrules gate check` → the process exit code CI reads
```

## The determinism boundary

This is the load-bearing design decision, and everything else follows from it.

**Inside the boundary — no model, no clock, no network, no randomness:** span normalisation, trace
reconstruction, route fingerprinting, route-family mining, graph comparison, contract parsing,
contract validation, rule evaluation, violation generation, the release-gate decision, and the CLI
exit status.

**Outside it:** retrieval from SigNoz, persistence, artefact creation, and any explanation a model
might offer about evidence that already exists.

A model may explain a violation or suggest contract wording. It may never decide whether a rule
passed. The practical consequences run through the whole codebase:

- The evaluator takes a graph and a contract and returns a result. It reads no clock — the caller
  injects `completedAt` and `nowMs` — so the hashed region cannot contain a timestamp.
- Similarity is an exact integer cross-multiplication of a weighted Jaccard ratio, never a
  floating-point comparison, because a release decision must not depend on binary rounding.
- Canonical serialisation and stable ordering are everywhere, so identical traces produce identical
  fingerprints and two runs over the same evidence produce the same `decisionHash`.

`packages/contract-engine/src/evaluate.test.ts` asserts this directly: byte-identical output across
repeated evaluations, across reordered spans, across reordered rules, and across reordered attribute
keys, with no floating-point value anywhere in the canonical output.

## Why SigNoz is load-bearing rather than decorative

Remove SigNoz and there is no product. It is:

1. **The evidence store.** Every graph FlightRules reconstructs comes from spans SigNoz ingested.
2. **The only supported path to custom span attributes.** `signoz_get_trace_details` cannot return
   them (**SL-020**); `signoz_execute_builder_query` with `selectFields` using
   `fieldContext: "tag"` can (**SL-021**). Every contract rule that reads an attribute depends on
   that call.
3. **The control surface.** Dashboards, saved views, alert rules and notification channels are
   created through the MCP server and read back by identifier.
4. **The destination for FlightRules' own telemetry.** Evaluation spans, `flight_rules.*` metrics
   and correlated logs go back into the same deployment the evidence came from.

The access boundary is [ADR-0003](adr/0003-signoz-access-boundary.md): FlightRules speaks to SigNoz
through the MCP server, never through the raw HTTP API, except where a documented capability does
not exist there.

---

## Package by package

### `@flightrules/signoz-mcp`

The single point through which FlightRules talks to SigNoz. Nothing downstream ever sees a raw MCP
object: callers get a discriminated `McpResult`, so *"the query failed"* cannot be mistaken for
*"the query found nothing"* — a distinction the whole product's honesty rests on.

It carries the runtime facts the pinned server actually exhibits, each with a source-lock entry:
create tools take flat arguments (**SL-023**); update tools replace the whole resource; list tools
key their identifier `id`, `uuid` or `ruleId` and their name `name` or `alert` depending on the type
(**SL-056**); `signoz_update_view` corrupts the stored view and then breaks `signoz_list_views` for
the whole tenant, so a view is replaced by delete-then-create (**SL-057**); an unmatched path returns
the single-page application with HTTP 200 (**SL-012**); a non-string tag without a declared
`dataType` comes back `null` from a call that reports success (**SL-046**).

`@flightrules/signoz-mcp/testing` is an in-memory transport that reproduces those envelopes, used by
the race and outage suites. Every layer above the socket is the product's own code.

### `@flightrules/normaliser`

Turns a raw span row into something comparable across runs: volatile identifiers replaced by
placeholders, attributes split into the set that contributes to route identity and the set kept only
as evidence, and classifications derived (`sideEffect`, `dataDomain`, `toolName`, `retryNumber`).

Two rules matter more than the rest. An unclassified side effect resolves to `unknown`, never to
`none` — a rule forbidding a duplicated write must be able to tell "this span performed no write"
from "nobody said what this span did". And a value that cannot be interpreted is dropped rather than
coerced: a negative `agent.retry.number` is not a smaller number of retries, so it is no retry
evidence at all.

Attribute records are null-prototype objects, because attribute keys arrive from telemetry and
`record["__proto__"] = [...]` on an ordinary object replaces the record's prototype instead of
storing a key.

### `@flightrules/trace-graph`

Spans in, causal graph out, then a canonical form and a fingerprint.

Root selection prefers the configured root span, then the earliest parentless span, then a synthetic
root over all orphans — so an incomplete trace is still analysable. Quality is a verdict, not a
boolean: only contradiction between duplicate records of one span makes a trace `inconsistent`, and
only a structural defect that changes what the graph means makes it `incomplete`.

A **client span whose server span was never exported does neither**. That is deliberate and it is
the subtlest decision in the engine: the route such a span evidences is fully determined by the
client span, so widening its uncertainty across the trace would turn the canary's genuinely missing
fraud check into "insufficient evidence" and destroy the release gate. The uncertainty is instead
scoped to that one span's subtree, and the rules anchored on it check for it individually.

### `@flightrules/contract-schema`

The trajectory contract DSL: parse, validate, canonicalise, hash. Eleven rule types, a selector
model, a gate definition. `fuzz.test.ts` drives it with malformed YAML, anchors, alias bombs, depth,
width, huge scalars, duplicate rule identifiers, numeric overflow, unsafe Unicode and prototype
member names.

### `@flightrules/contract-engine`

The evaluator, and the only place a pass/fail is decided.

Rules run in PRD section 11.11's order, expressed once as data so a refactor cannot silently reorder
them. Any violation fails a run; an *undecidable* rule makes the run `insufficient_data` rather than
a pass, because a contract that could not be checked has not been satisfied. `evaluateRunSafely` is
the single place an internal error becomes a status, and it cannot produce `pass`.

Absence is handled per operator rather than globally, because "must equal true" and "must not equal
admin" make opposite claims about a span that carries neither: `exists` treats absence as a
violation, `equals`/`in`/`matches` as insufficient evidence, and `not_equals`/`not_in` as a pass.
Defaulting absence either way would either let an uninstrumented service satisfy
`refund-must-be-idempotent`, or punish a release for a telemetry gap.

### `@flightrules/baseline-miner`

Many approved runs → route families → a proposed contract, with its evidence and its disclosures.

Retrieval is paged and bounded, and a page that fails is a **discovery failure**, not a short
dataset: a truncated set returned as success would become a baseline mined from half the runs, and
nothing downstream could tell. Field types are verified against SigNoz's own catalogue before any
mining query runs, which closes **SL-046** by discovery rather than by convention.

### `@flightrules/artifact-compiler`

The active contract compiled into ten managed SigNoz resources: one notification channel, four saved
views, one dashboard, four alerts.

Ownership is the register, not the name. A name FlightRules would generate but has never recorded
belongs to whoever created it, and the sync reports a conflict rather than overwriting it. Managed
names are `FlightRules / <project> / <agent> / <label>`; a segment containing the separator or a
control character is rejected rather than escaped, because escaping would let `a / b` and `a` + `b`
collide.

Planning is a pure function of the desired specification hash, the register's recorded hash, and
whether SigNoz still holds the name — so two workers reaching the same conclusion concurrently reach
it from the same durable state.

### `apps/api` and `apps/worker`

Fastify and a job runner over PostgreSQL. Neither migrates at startup; both read the migration
ledger and refuse to start against a database missing a migration they were built for, so a
half-migrated database fails loudly instead of producing errors that read as product bugs.

The runner claims a job under a lease, renews it on a timer, and commits the handler's output and
the transition to `succeeded` in **one transaction guarded on the lease** — so a worker whose lease
was reclaimed mid-run cannot overwrite the outcome of the worker that now owns the job. A job whose
lease expires is returned to the queue while attempts remain, and failed terminally otherwise.

Artefact sync runs under a per-agent PostgreSQL advisory lock covering read-register → sync →
persist-register. The saved-view delete-and-recreate workaround is not atomic and has no remote
compare-and-set, so two concurrent syncs of one agent would otherwise each delete one view and
create another.

`GET /health/dependencies` reports queue depth, because a worker that has stopped claiming takes no
other health signal down with it.

### `apps/web`

Next.js App Router, server components, no client-side data fetching of product state. Every route in
PRD section 8. The graph diff is the hero; a chatbot is not the interface.

`design.md` is authoritative for every colour, size, font and spacing value, enforced by
`make scan-design`.

### `apps/cli`

`flightrules gate check` returns the decision and the process exit code CI reads: `0` pass, `2`
contract violation, `3` insufficient data, `4` integration or evaluation error, `5` invalid
configuration. `1` is reserved for an unclassified crash and is never returned by a classified path.

`run()` returns an exit code rather than calling `process.exit`, so every path — including the error
paths that matter most — is exercised in-process by a unit test with a scripted API rather than by
spawning a shell and hoping. Every line it writes passes through a filter that strips terminal
control sequences, because span names reach the human report and a terminal treats an escape
sequence in one as an instruction.

---

## Data model

Sixteen tables, four migrations. The ones that carry the argument:

| Table | What it holds |
|---|---|
| `trace_runs`, `trace_graphs` | one row per retrieved run, and its canonical graph |
| `baseline_versions`, `route_families` | a mined baseline and the families a human approved |
| `contracts`, `contract_rules` | the contract document, its canonical form, its content hash, and a rule projection |
| `evaluations`, `run_evaluations`, `violations` | the decision, per run and aggregated, with evidence |
| `signoz_artifacts` | the ownership register: managed name, remote identifier, spec hash, verification verdict |
| `jobs` | queue, lease, progress, attempt, idempotency key |
| `audit_events` | who changed what, written in the transaction that made the change |

`signoz_connections` stores the **name** of the environment variable holding the API key, never its
value.

## Telemetry FlightRules emits about itself

Spans for evaluation and compilation, `flight_rules.*` metrics, and logs correlated to the trace
that produced them. The metric dimensions the API queries and the dimensions the instruments emit
are cross-referenced by a test, because they once disagreed silently and SigNoz reported the
requested labels carrying empty values (**SL-063**).

By default FlightRules records no prompt, no model output, no tool arguments, no tool results and no
chain-of-thought. The forbidden-key redactor **removes** them rather than replacing them with
`[redacted]`, because a redaction marker would still record that the product collected one.

## What runs where

| Process | Port | Needs |
|---|---|---|
| SigNoz UI and HTTP API | 8080 | Foundry-deployed |
| SigNoz MCP Server | 8000 | the minted API key |
| OTLP ingestion | 4317 / 4318 | first-user setup completed — the receivers do not bind before it (**SL-010**) |
| FlightRules PostgreSQL | 5433 | — |
| FlightRules API | 4000 | database, migrations applied |
| FlightRules worker | — | database, SigNoz |
| FlightRules web | 3000 | the API |
| Demo agent and five services | 4100+ | OTLP |
