# Submission

Fill the two placeholder URLs when the recording and the post are published. Everything else is
final.

---

## Team name

**Tim**

## Team members

- Tim
- Solution

> **Checklist item, not a claim.** Solution was added to the team during the event. If the
> organisers require approval for a team change after registration, that approval has not been
> obtained yet and must be requested before the submission is filed. Do not state that Solution
> joined before the event.

## Track

**Track 1: AI & Agent Observability**

## Project name

**FlightRules — Executable Trajectory Contracts for AI Agents**

## Project description

Agents change their route without changing their answer. FlightRules catches the route.

A refund agent ships v2. The customer gets the same sentence — *"Your refund of $48.20 has been
issued"* — and every output check passes. Underneath, the policy retrieval is gone, the fraud check
is gone, and the payment write happened twice after a timeout and a retry, with both entries in the
payment service's idempotency ledger. Output evaluation cannot see any of that. A distributed trace
can.

FlightRules reads real distributed traces out of SigNoz, reconstructs both execution graphs,
compares them against a **trajectory contract** mined from approved runs, and fails the release with
the exact traces that prove it. `flightrules gate check` exits `2`, and a CI pipeline stops.

The decision is deterministic by construction: no model, no clock and no network participates in it.
The same evidence always produces the same `decisionHash`. A model may explain a violation; it may
never decide whether a rule passed.

## GitHub URL

https://github.com/winsznx/flightrules

## Deployment URL

**https://flightrules-web-production.up.railway.app**

| Surface | URL |
|---|---|
| Web application | https://flightrules-web-production.up.railway.app |
| API | https://flightrules-api-production.up.railway.app |
| SigNoz | https://signoz-signoz-production-f19a.up.railway.app |
| SigNoz MCP Server | https://flightrules-signoz-mcp-production.up.railway.app/mcp |
| OTLP ingestion | https://signoz-ingester-production-a417.up.railway.app |
| Demo agent | https://flightrules-demo-agent-production.up.railway.app |

Sixteen Railway services: the web application, the API, the worker, PostgreSQL, the pinned SigNoz
MCP Server `v0.9.0`, the SigNoz core, and the six-service demo topology. Nothing runs on a developer
machine.

The canonical demo was executed against it end to end — 25 known-good runs, a baseline mined from 26
live runs, a contract validated, approved and activated, **ten SigNoz artefacts read back as
`synced: 10, drifted: 0, failed: 0, conflict: 0`**, the approved release gate exiting **`0`** and the
unsafe canary gate exiting **`2`** with 80 violations, 24 zero-tolerance and 8 duplicate refund
writes. Step by step, with output:
[docs/evidence/phase-17/railway.md](evidence/phase-17/railway.md).

The local path remains the reproducible one and is what the SigNoz deployment is pinned for:
`make demo-full` produces exit 0 for the approved release and exit 2 for the canary from a clean
clone, and `scripts/verify-fresh-machine.sh` proves that end to end.

## YouTube URL

_Placeholder — recording follows the live path, not a reconstruction._

## Blog URL

_Placeholder. The draft is `docs/BLOG_DRAFT.md`, written for this event; no pre-existing post is
being reused._

---

## How SigNoz is used, in detail

SigNoz is not a screenshot at the end of this product. It is the substrate. Remove it and baseline
capture, evidence retrieval, artefact compilation, alerting and the final proof all stop working.

### 1. Deployment, pinned and reproducible

SigNoz is deployed by **SigNoz Foundry** from a committed `casting.yaml`, with `casting.yaml.lock`
and the generated `pours/deployment/compose.yaml` committed alongside it so a judge can read the
exact image tags before installing anything. `make signoz-reproducibility` asserts the casting
reproduces byte-identically and that no image floats on `:latest`.

Pinned: SigNoz `v0.134.0`, SigNoz OTel Collector `v0.144.6`, SigNoz MCP Server `v0.9.0`,
ClickHouse `25.12.5`.

> **Finding.** `spec.<molding>.spec.version` does **not** pin the deployed container image; `image:`
> must be set as well, or Foundry deploys `latest`. Recorded as SL-006 and asserted against the
> generated Compose file rather than the lock file.

### 2. Ingestion

The demo agent and five demo services are instrumented with OpenTelemetry and export traces, metrics
and logs over OTLP into the SigNoz collector. FlightRules' own API and worker export their
evaluation spans, `flight_rules.*` metrics and correlated logs back into the same deployment.

> **Finding.** OTLP receivers do not bind until SigNoz first-user setup completes. Before that,
> ports 4317 and 4318 accept a TCP connection through the Docker proxy and then reset — so a port
> check passes in exactly the broken state and is worthless. Ingestion is proved with a real OTLP
> POST that returns HTTP 200. Recorded as SL-010.

### 3. Retrieval — the SigNoz MCP Server as the control surface

Every read and every write goes through the **SigNoz MCP Server** using the official MCP TypeScript
SDK, against 22 required tools discovered and asserted at startup.

Trace evidence is retrieved with `signoz_execute_builder_query`, `requestType: "raw"`, and
`selectFields` declaring `fieldContext: "tag"`.

> **Finding, and the one that shaped the whole retrieval path.** `signoz_get_trace_details` **cannot
> return custom span attributes**. Every contract rule that reads an attribute therefore depends on
> the Query Builder path. Recorded as SL-020 and SL-021.
>
> **Finding.** Discovery tools accept `fieldContext: "tag"` as an alias for `"attribute"`, but
> `selectFields` and `groupBy` require `"tag"` (SL-022).
>
> **Finding.** A non-string tag whose `dataType` is omitted comes back as `null` from a call that
> reports `SUCCESS_WITH_ROWS` — no error, no warning, and every other column correct. A rule keyed
> on `agent.idempotency.present` would silently read a missing attribute. This was caught only
> because the evaluator reports *insufficient evidence* for an absent attribute instead of passing
> the rule (SL-046). Field types are now verified against SigNoz's own catalogue before any mining
> query runs.

### 4. Writing back — ten managed artefacts, every one read back

The active contract is compiled into ten managed SigNoz resources:

| Type | Count | Names |
|---|---|---|
| Notification channel | 1 | `FlightRules / demo-commerce / Notifications` |
| Saved views | 4 | Contract Health, Violating Runs, Duplicate Side Effects, Unknown Routes |
| Dashboard | 1 | Contract Health, ten panels |
| Alert rules | 4 | Violation Rate, Duplicate Side Effect, Release Evaluation Error, No Evaluation Data |

Every write is followed by a read-back **by identifier**, and the fields that matter are compared
against the intended specification before the register records it as synced. A successful call is
never treated as proof.

> **Finding.** MCP create tools take flat arguments, not a nested resource object (SL-023), and
> update tools replace the whole resource — so a partial body erases what it omits.
>
> **Finding.** List tools key their identifier `id`, `uuid` or `ruleId` and their name `name` or
> `alert`, depending on the resource type. A single `id` lookup silently finds nothing for a
> dashboard and for an alert, which makes every already-created one look absent — so the next sync
> creates a second copy. The live integration test caught two managed dashboards of the same name
> (SL-056).
>
> **Finding.** `signoz_update_view` is unusable in the pinned version: whatever body it is given it
> persists the composite query as a hex-encoded byte string, after which `signoz_list_views` returns
> HTTP 500 for the whole tenant and **every saved view becomes unreadable — including views
> FlightRules did not create**. A view is therefore replaced by delete-then-create (SL-057).

### 5. Alerting, firing and recovery

Every managed alert was driven through its full lifecycle against the running deployment and read
back from SigNoz's own alert history:

| Alert | Fired | Recovered |
|---|---|---|
| Violation Rate Alert | value 220 | `inactive`, exactly 300 s later |
| Duplicate Side Effect Alert | value 22 | `inactive`, exactly 300 s later |
| No Evaluation Data Alert | on absent data | `inactive` |
| Release Evaluation Error Alert | never — nothing errored, which is the correct result | n/a |

The 300 s interval matches the configured `evalWindow` to the second. Every query and threshold is
byte-identical before and after the cycle.

> **Finding.** `signoz_get_alert_history` does not use the list envelope every other list tool uses
> (SL-065), and a history row carries the *rule's* state under `overallState` and the *sample's*
> under `state` — where `state` takes values a rule never takes, `nodata` among them. Reading
> `state` as the rule's state reports a rule that merely had a data gap as one that fired (SL-066).

### 6. Querying FlightRules' own signals back out

The Violation Inspector fetches logs correlated **by trace identifier** and downstream metrics for a
violation, on request, from SigNoz. `make verify-telemetry` proves both arrive: five log records
correlate to a real violation's trace — including **two `refund committed to the payment ledger`
lines in one trace**, the duplicate side effect in the payment service's own words — and the
`flight_rules.*` metric dimensions are queryable with real values.

> **Finding.** The metric labels were empty because the instruments emitted `project.slug` /
> `agent.key` while the API grouped by `flight_rules.project.id` / `flight_rules.agent.id`. Grouping
> by a label nothing sets is not an error in SigNoz, which is why no single query could distinguish
> "SigNoz drops the labels" from "the names never matched". Corrected in SL-063, superseding SL-062.

### Every SigNoz-derived finding

Sixty-six entries in [docs/research/source-lock.md](research/source-lock.md), each with its source,
its claim, and whether the installed runtime confirmed it. Where documentation and runtime behaviour
disagreed, the runtime won and the mismatch was recorded.

---

## Hackathon experience

The most useful thing this project did was refuse to accept a successful API call as evidence.

Operating-contract rule 13 — *every write is followed by a read-back that validates the fields that
matter* — sounded like ceremony when it was written. It found two managed dashboards of the same
name, a saved-view update tool that corrupts every view in the tenant, and a create response whose
identifier lives under a different key per resource type. None of those would have failed a test
that checked the call succeeded.

The same principle applied to our own claims. Entry verification for the final phase re-checked
every figure in the previous session's handoff instead of trusting it, and found `make verify`
exiting 2 on a file the handoff itself had added. The adversarial phase then found twelve more real
defects, four of them in the exact path a judge follows — including a bootstrap password policy that
SigNoz states only when it rejects you, which meant the release-gate workflow **could not have
passed on its first GitHub run**.

The hardest single design decision was scoping uncertainty. A client span whose server span was
never exported makes that span's subtree unobservable. Treating the whole trace as incomplete is the
safe-looking choice, and it destroys the product: the canary's genuinely missing fraud check becomes
"insufficient evidence" and the gate goes green. Treating it as complete is the other failure: an
aborted request looks like a skipped step. The answer was to scope the uncertainty to the one span,
keep the trace `complete`, and have the rules anchored on that span check for it individually — and
then to write a test that holds both halves at once, in one trace.

## AI assistant disclosure

FlightRules was built with **Claude Code**, under the phase-gated operating contract committed as
[CLAUDE.md](../CLAUDE.md). The contract is the disclosure: it forbids inferring an undocumented
request shape, inventing an endpoint or attribute, replacing a required integration with a mock,
and treating the existence of code as evidence that a feature works.

Every external technical claim is recorded in the source lock with its source and whether it was
confirmed against the installed runtime rather than recalled. Sixty-six entries; several are defects
in the pinned dependencies rather than in this product.
