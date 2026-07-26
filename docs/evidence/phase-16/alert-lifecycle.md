# Alert firing and recovery

Phase 16. Closes the open limitation carried from Phase 10: *"alert **recovery** has not been
observed."*

Command: `make verify-alerts` (`scripts/verify-alert-lifecycle.mjs`)
Runtime: SigNoz v0.134.0, SigNoz MCP Server v0.9.0, `demo-commerce / refund-agent`
Raw output: `alert-lifecycle.txt` · Machine-readable: `alert-lifecycle.json`

---

## What was proven

Every one of FR-015's four managed alerts, against the running deployment:

| Alert | Configuration read back | Fired | Value | Recovered | Config unchanged |
|---|---|---|---|---|---|
| Violation Rate Alert | yes | **12:09:49Z** | 220 | **12:14:49Z → `inactive`** | yes |
| Duplicate Side Effect Alert | yes | **12:09:33Z** | 22 | **12:14:33Z → `inactive`** | yes |
| No Evaluation Data Alert | yes | **12:04:15Z** | 0 | **`inactive`** | yes |
| Release Evaluation Error Alert | yes | never | — | not applicable | yes |

The fourth alert is `inactive` throughout and that is the correct result, not a gap: no contract
evaluation errored during the window, so there was nothing for it to fire on. An alert reported as
firing without a cause would be the fabricated evidence the operating contract forbids.

Firing was driven by a real canary, not by editing a threshold: `DEMO_RUNS=5 make demo-v2` followed
by a real `release evaluate`, producing 270 violations and 81 zero-tolerance violations across 27
runs. Recovery was driven by *stopping* — every managed alert is an `increase` over a rolling five
minute window, so the condition clears when the window slides past the last violation. Both
transitions are read from SigNoz's own alert history, never from anything FlightRules believes.

The interval between firing and recovery is 300 s in both cases, to the second — exactly the
configured `evalWindow`. That is the strongest available evidence that the recovery is the real
state machine rather than a coincidence.

## Configuration, as SigNoz stores it

```text
Violation Rate Alert
  query      flight_rules.violations
             where project.slug = 'demo-commerce' AND agent.key = 'refund-agent'
  threshold  critical above 0, recovery 0

Duplicate Side Effect Alert
  query      flight_rules.duplicate_side_effects  (same filter)
  threshold  critical above 0

Release Evaluation Error Alert
  query      flight_rules.evaluations  (same filter, AND status = 'error')
  threshold  error above 0

No Evaluation Data Alert
  query      flight_rules.evaluations  (same filter)
  threshold  warning below 1
```

Every query and every threshold tier was compared before and after the whole cycle and is
byte-identical. Firing and recovering an alert does not mutate its definition.

---

## Two findings from the runtime, both recorded rather than worked around

### `signoz_get_alert_history` does not use the list envelope

Every other list tool answers `{"data": [...]}`. This one answers:

```json
{"status":"success","data":{"items":[...],"total":0}}
```

Reading `data` as an array throws rather than returning nothing, which is the better failure — but
it has to be handled, and the script accepts both shapes so that "no history" and "history somewhere
else" cannot become the same answer. Recorded as **SL-065**.

### A history row's `state` is the sample's state; `overallState` is the rule's

A single history row carries both:

```json
{"overallState":"firing","overallStateChanged":true,"state":"nodata","stateChanged":true,
 "unixMilli":1785067275132,"value":0}
```

`state` takes values a rule never takes — `nodata` among them. An implementation that read `state`
as the rule's state would report a rule that merely had a gap in its data as one that fired. The
current rule state is read from the rule itself for the same reason: history is written per
evaluated sample, so a rule with no sample in the last cycle has no row to read while still having a
state. Recorded as **SL-066**.

---

## What this does not prove

**Notification delivery.** The managed channel's destination is a local webhook that nothing is
listening on, so SigNoz's own test notification fails and that failure is recorded honestly in the
register. Setting `FLIGHTRULES_ALERT_WEBHOOK_URL` to a routable destination makes delivery real;
this evidence covers the alert state machine, not the transport beyond it.

**Immediate firing after creation.** An alert created moments before the metric spike does not fire
on that spike: the first observed run created the four alerts at 12:04:15 and the 220-violation
increase at 12:06 produced no transition, while the identical spike at 12:09 — against alerts that
had existed for five minutes — did. This is scheduling, not a defect, but it is why the demo script
does not assert a firing state immediately after `make demo-full` and why this evidence was gathered
from a second canary run.
