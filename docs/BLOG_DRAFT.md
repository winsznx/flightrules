# The agent gave the right answer and did the wrong thing

*Building FlightRules: executable trajectory contracts for AI agents, on SigNoz.*

---

## The bug that passes every test

A refund agent ships v2. A customer asks for a refund. The agent replies:

> Your refund of $48.20 has been issued and will appear in 3–5 business days.

That is exactly what v1 said. The amount is right. The tone is right. An LLM judge scores it
identically. A regression suite comparing outputs sees no diff. Ship it.

Underneath, this happened:

```text
v1 (approved)                          v2 (shipped)
refund.request                         refund.request
  -> policy.retrieve                     -> order.lookup
  -> order.lookup                        -> payment.refund
  -> fraud.check                         -> payment.refund      <- charged twice
  -> refund.calculate                    -> customer.notify
  -> payment.refund
  -> customer.notify
```

The refund-policy retrieval is gone. The fraud check is gone. And the payment write happened twice —
a timeout, a retry, and the payment service's idempotency ledger recording both entries.

The customer got the right sentence. The company refunded $96.40 and skipped its own compliance
checks. Every output-based control in the pipeline was green.

This is not a hypothetical. It is the failure mode that appears the moment an agent has a retry
policy, a tool it can skip, and a prompt somebody edited on a Friday. Output evaluation is
structurally blind to it, because the output is fine.

The execution *trajectory* is where the bug lives. And a trajectory is exactly what a distributed
trace is.

## FlightRules

FlightRules turns SigNoz traces into deterministic release contracts. It mines a **trajectory
contract** from runs a human approved, then evaluates every subsequent release against it, and fails
the release with the traces that prove it. In CI that is one command:

```bash
$ flightrules gate check --release refund-agent-v2
FAIL: This release exceeded one or more trajectory thresholds.

Findings
  MISSING_PREREQUISITE (skipped_check)
    fraud.check is required at least 1 time(s) but occurred 0 time(s).
  DUPLICATE_SIDE_EFFECT (duplicate_write)
    payment.refund occurred 2 times; the contract permits at most 1 per run.

exit code: 2
```

Exit code 2. The pipeline stops.

---

## Architecture

Five stages, and the interesting design decisions are all about what is *not* allowed in each.

**1. Instrument.** The demo is a refund agent and five services — policy, orders, fraud, payment,
notification — instrumented with OpenTelemetry and exporting traces, metrics and logs over OTLP into
SigNoz. The agent emits `gen_ai.*` attributes for tool identity and operation, plus a small
FlightRules namespace: `agent.side_effect`, `agent.data_domain`, `agent.retry.number`,
`agent.idempotency.present`.

It emits **no prompt, no model output, no tool arguments, no tool results and no chain-of-thought**.
That was a constraint from the start, and it turned out to be the interesting one: if trajectory
enforcement works without any of it, the product is deployable in places prompt logging is not.
It does work. The forbidden-key redactor *removes* those attributes rather than replacing them with
`[redacted]` — a redaction marker would still record that the product collected one.

**2. Retrieve.** Everything goes through the SigNoz MCP Server, using the official MCP TypeScript
SDK. The first real discovery of the project came here: **`signoz_get_trace_details` cannot return
custom span attributes.** It returns a fixed column set. Every contract rule that reads an attribute
would have silently seen nothing.

The path that works is `signoz_execute_builder_query` with `requestType: "raw"` and `selectFields`
declaring `fieldContext: "tag"`. There is a further asymmetry that costs an afternoon if you meet it
by accident: discovery tools accept `"attribute"` as an alias for `"tag"`, but `selectFields` and
`groupBy` require `"tag"`.

**3. Reconstruct.** Spans become a causal graph, then a canonical form, then a fingerprint. Volatile
identifiers are normalised out, so two runs of the same behaviour with different order IDs produce
the same fingerprint. Identical traces produce identical fingerprints — asserted with property tests
over reordered input, reordered rules and reordered attribute keys.

**4. Mine and contract.** Twenty-five approved runs collapse into route families. The dominant family
is proposed as approved; anything rarer is left pending for a human, because approving every family
automatically would defeat the review step the product exists to make explicit. From the approved
family the miner proposes a contract in a small YAML DSL with eleven rule types — required spans,
forbidden spans, cardinality, required edges, required ancestry, forbidden paths, attribute
constraints, allowed values, retry budgets, approved routes, numeric budgets.

**5. Evaluate and gate.** A pure function over a graph and a contract. Then aggregation across a
release, then a gate decision, then a process exit code.

## The determinism boundary

The single decision everything else follows from: **no model, no clock, no network and no randomness
participates in a pass/fail.**

A model may explain a violation to a human. It may never decide whether a rule passed. The
consequences show up in odd places:

- The evaluator reads no clock. The caller injects `completedAt`, so a timestamp cannot enter the
  hashed region and two evaluations of the same evidence are byte-identical.
- Route similarity is a weighted Jaccard ratio compared by **exact integer cross-multiplication**,
  never by dividing into a double. A release decision must not depend on binary rounding of a
  threshold the author wrote in decimal.
- `evaluateRunSafely` is the one place an internal error becomes a status, and it structurally
  cannot produce `pass`.

The last one matters more than it sounds. A release gate that can return green after an internal
error is worse than no gate, because it launders a crash into a permission.

## Absence is not a value

The subtlest correctness problem in the whole product is what to do when the evidence is missing.

Consider `agent.idempotency.present` on a payment write. If the attribute is absent, has the rule
`equals: true` passed or failed?

Neither. It is undecided, and the evaluator says so — `insufficient_evidence`, and the run reports
`insufficient_data` rather than `pass`. A contract that could not be checked has not been satisfied.

But that answer is wrong for a different operator. `not_equals: admin` over an absent attribute is a
genuine **pass**: the span demonstrably does not carry the forbidden value. And `exists` over an
absent attribute is a genuine **violation**: the rule asks for the attribute itself.

So absence is resolved per operator. Defaulting it either way breaks something real: default to pass
and an uninstrumented service satisfies `refund-must-be-idempotent`; default to violation and a
release is punished for a telemetry gap.

This paid for itself. SigNoz returns a non-string tag as `null` — with no error and no warning — when
a query omits its `dataType`. A rule keyed on `agent.idempotency.present` would have read a missing
attribute from a query that reported success. It was caught only because absence produces
insufficient evidence instead of a pass. Had the evaluator defaulted to green, that would have been
a green release built on a query that returned nothing.

## The hardest scoping decision

A client span whose server span was never exported — an aborted request, a service that died
mid-call — makes that span's subtree unobservable.

The tempting move is to mark the whole trace incomplete and refuse to conclude anything from
absence. It is safe-looking and it destroys the product: the canary's genuinely missing fraud check
becomes "insufficient evidence" and the gate goes green on the exact release it exists to catch.

The opposite move is to treat the trace as complete. Then an aborted request looks like a skipped
step, and the gate fails releases for network weather.

The answer is to scope the uncertainty to the one span. The trace stays `complete`, because the
route it evidences is fully determined by the client span. The rules anchored on that span check for
its unobservable subtree individually and report `unobservable_subtree`. Everything else in the trace
is decided normally.

The test that pins this holds both halves at once, in a single trace: the aborted payment handler
stays insufficient evidence *while* the missing fraud check stays a violation.

## SigNoz as a control surface, not a dashboard

FlightRules does not just read SigNoz. It writes to it: the active contract compiles into ten managed
resources — a notification channel, four saved views, a ten-panel dashboard, and four alert rules —
created through MCP and **read back by identifier** before the register records them as synced.

The read-back is not ceremony. It found:

- **Two managed dashboards with the same name.** List tools key their identifier `id`, `uuid` or
  `ruleId` and their name `name` or `alert` depending on resource type. A single `id` lookup finds
  nothing for a dashboard or an alert, which makes every already-created one look absent — so the
  next sync creates a second copy.
- **`signoz_update_view` corrupts the tenant.** Whatever body it is given, it persists the composite
  query as a hex-encoded byte string, after which `signoz_list_views` returns HTTP 500 for the whole
  organisation and *every* saved view becomes unreadable — including views FlightRules did not
  create. A view is now replaced by delete-then-create.
- **An unmatched API path returns the single-page app with HTTP 200.** A client that trusts a status
  code reads a web page as a query result.

None of those would have failed a test that checked the call succeeded.

Alerts get the same treatment. Every managed alert was driven through firing *and* recovery against
the running deployment, read from SigNoz's own alert history: the violation-rate alert fired at value
220 and recovered to `inactive` exactly 300 seconds later, matching its configured evaluation window
to the second.

## What breaking it on purpose found

The hardening phase's job was to break the product before a judge did. Twelve real defects, and the
pattern in them is worth more than the list.

**A negative number is not a smaller number.** A span reporting `agent.retry.number: -5` had its
value summed into the run's retry total. Nine retries plus one mislabelled span totalled four against
a limit of four — a clean run. A negative attempt index is not fewer retries; it is not an attempt
index at all.

**Telemetry reaches terminals.** Span names, tool names and rule summaries all flow into the CLI's
human report. A span named with `ESC [ 2 J ESC [ 1 ; 1 H PASS…` clears the reader's screen and
reprints the opposite verdict — into a CI log that records the escape sequence faithfully, so the
deception survives review. Every line the CLI writes now passes through a filter applied once at the
entry point.

**Drift created duplicates.** A managed dashboard someone edited by hand failed its read-back, fell
out of the "unchanged" path, and then took the *create* branch — leaving a second resource beside the
edited one. And two concurrent syncs of one agent, racing through the saved-view
delete-and-recreate, each deleted one view and created another. Both now run under a per-agent
PostgreSQL advisory lock covering read-register → sync → persist-register, because the register is
what the *next* sync plans from.

**The documented setup did not work.** The reproducibility test — a clone outside the working tree,
volumes destroyed, from committed files only — found four defects in the exact path a judge follows.
The best of them: SigNoz enforces a password policy on registration and states it *only in the
rejection body*, and the command every document recommended, `openssl rand -base64 18`, satisfies it
only by luck. One reproduction passed and two failed on identical instructions. Worse, both GitHub
workflows supplied `ci-<run_id>`, which has neither an uppercase letter nor a symbol — **so the
release-gate workflow could not have passed on its first run**. It had never run.

`curl -sf` had been hiding the reason, because it discards the response body on an HTTP error. The
fix that mattered was not the password; it was making the failure legible.

## What I would tell someone starting this

**Make your verification verify.** `make signoz-verify` passed against a deployment whose credential
was still the literal string `replace-me`. It proved the MCP server was reachable and that
`initialize` succeeded — but `initialize` never presents the credential to SigNoz. Every subsequent
tool call returned 401 against a deployment the script had just declared healthy. It now makes a real
authenticated call.

**Distrust your own handoff.** Entry verification for the final phase re-checked every figure in the
previous session's notes instead of trusting them, and found `make verify` exiting 2 on a file those
notes had themselves added.

**Write down what the runtime did, not what the docs said.** Sixty-six source-lock entries, each with
its claim and whether the installed runtime confirmed it. Several are defects in pinned dependencies
rather than in this product. Every one of them was found by running something.

---

FlightRules is Apache-2.0 and reproducible from a clean clone: SigNoz deployed by Foundry from a
committed casting file, a real agent emitting real telemetry, a contract mined from real approved
runs, and a gate that exits 0 for the approved release and 2 for the canary.

The canary returns the right answer. That was always the point.
