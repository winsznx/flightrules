# FlightRules — video command sheet

Everything below runs real product behaviour. Nothing here fabricates a trace, a metric, an alert or
a decision.

Total runtime from a cold machine: about twelve minutes, most of it SigNoz starting.

---

## 0. Terminals

Four, in this order. Leave the first three running.

| # | Command | What it is |
|---|---|---|
| 1 | `make api` | the FlightRules API on `:4000` |
| 2 | `make worker` | the job worker |
| 3 | `make web` | the web application on `:3000` |
| 4 | — | the one you type into on camera |

---

## 1. Deploy and bootstrap (once, before recording)

```bash
curl -fsSL https://signoz.io/foundry.sh | FOUNDRY_VERSION=v0.2.16 bash
export PATH="$HOME/.local/bin:$PATH"

make install
make signoz-up
export SIGNOZ_ADMIN_PASSWORD="$(openssl rand -base64 18)"
make signoz-bootstrap          # writes SIGNOZ_API_KEY to .env, mode 600
make signoz-verify             # every SigNoz surface

make up                        # PostgreSQL
make db-migrate                # applied: 0001 … 0004
make demo-up                   # the six demo services
```

**Expected markers**

```text
ok    signoz-signoz-0 runs signoz/signoz:v0.134.0
ok    POST http://localhost:4318/v1/traces returns 200
All SigNoz checks passed.
applied: 0004
```

> If OTLP returns `000` rather than `200`, SigNoz first-user setup has not completed. Run
> `make signoz-bootstrap`. A TCP port check passes in exactly that broken state, so never trust one.

---

## 2. The whole story in one command

```bash
make demo-full
```

It emits 25 known-good runs, mines a baseline from them, proposes and activates a contract,
compiles and verifies ten SigNoz artefacts, evaluates the approved release, runs the gate, emits the
8-run unsafe canary, evaluates it, runs the gate again, and exports the evidence. It **fails** if the
two exit codes are anything but `0` then `2`.

**Expected final markers**

```text
  approved release refund-agent-v1      exit 0
  unsafe canary    refund-agent-v2      exit 2
  evidence         docs/evidence/phase-11/

A release pipeline failed because of trajectory evidence from SigNoz.
```

For a recording, run the steps individually instead — section 4.

---

## 3. URLs

| Surface | URL |
|---|---|
| FlightRules | http://localhost:3000 |
| The demo page | http://localhost:3000/demo |
| Projects | http://localhost:3000/projects |
| SigNoz | http://localhost:8080 |
| The API's own OpenAPI document | http://localhost:4000/api/openapi.json |

Get the seeded identifiers:

```bash
curl -s localhost:4000/api/projects | jq -r '.items[] | "\(.slug) \(.id)"'
```

---

## 4. The recording, step by step

### 4.1 The same answer, twice

Open **http://localhost:3000/demo**.

> "Two releases of a refund agent. The customer-facing answer is materially identical. Watch what
> happens to the route."

### 4.2 The known-good release

```bash
DEMO_RUNS=25 make demo-v1
```

**Marker**: a JSON array of 25 `run_…` identifiers.

### 4.3 Mine a baseline and activate a contract

```bash
make demo-seed
```

**Markers**

```text
   bl-…  — 1 route family(ies)
   approved 43070aa4af4f6c2c912a…
   valid / approved / active
   register: {"total": 10, "synced": 10, "drifted": 0, "failed": 0, "conflict": 0}
```

Show **http://localhost:8080** → Dashboards → *FlightRules / demo-commerce / refund-agent /
Contract Health*. Ten panels, real series.

### 4.4 The approved release passes

```bash
node apps/cli/dist/index.js release evaluate \
  --project demo-commerce --agent refund-agent --release refund-agent-v1 --lookback 360

PROJECT=demo-commerce AGENT=refund-agent RELEASE=refund-agent-v1 make gate
echo "exit $?"
```

**Markers**

```text
PASS: This release stayed within the approved trajectory contract.
  evaluated                   106
  violation                   0.000000%  (limit 0.5%)
exit 0
```

### 4.5 The canary

```bash
DEMO_RUNS=8 make demo-v2

node apps/cli/dist/index.js release evaluate \
  --project demo-commerce --agent refund-agent --release refund-agent-v2 --lookback 60

PROJECT=demo-commerce AGENT=refund-agent RELEASE=refund-agent-v2 make gate
echo "exit $?"
```

**Markers** — this is the moment

```text
FAIL: This release exceeded one or more trajectory thresholds.
  violation                   100.000000%  (limit 0.5%)
  unknown route               100.000000%  (limit 1%)
  zero tolerance              24

Findings
  ZERO_TOLERANCE_VIOLATION (fail)
  VIOLATION_RATE_EXCEEDED (fail)
  UNKNOWN_ROUTE_RATE_EXCEEDED (fail)
  LATENCY_REGRESSION_EXCEEDED (fail)

  zero-tolerance rules        require-fraud-check…, require-policy-retrieve…, single-payment-refund-write…
exit 2
```

> "The answer stayed correct. The agent skipped the policy check, skipped the fraud check, and
> issued the refund twice. The pipeline failed on trajectory evidence, not on output."

### 4.6 The same decision in the product

Open **http://localhost:3000/projects** → the project → **Releases**. Both releases, both decisions,
side by side. Click `refund-agent-v2`:

- the decision banner, in the PRD's own words
- the thresholds table: permitted against observed
- the findings, each with what was expected and what happened
- the representative failing traces

Then **Violations** → any violation → **Open trace in SigNoz**. That is the trace the decision was
taken over.

### 4.7 SigNoz depth

**http://localhost:3000/projects/:projectId/integrations/signoz** — ten managed artefacts, each
`SYNCED` and read-back verified.

In SigNoz: **Alerts** → *Violation Rate Alert* and *Duplicate Side Effect Alert*, firing on the
canary's own metrics.

### 4.8 CI

`.github/workflows/release-gate.yml` runs the same commands and asserts exit code `2` on the canary.

```bash
node apps/cli/dist/index.js gate check --json --quiet \
  --project demo-commerce --agent refund-agent --release refund-agent-v2 | jq '.exitCode, .result.decision'
```

**Marker**: `2` and `"fail"`.

---

## 5. Seeded identifiers

After `make demo-seed`:

| Thing | Value |
|---|---|
| Project slug | `demo-commerce` |
| Agent key | `refund-agent` |
| Approved release | `refund-agent-v1` |
| Unsafe canary | `refund-agent-v2` |
| Approved route fingerprint | `43070aa4af4f6c2c912a8d7bcc724f1d199e0425dc8ad7256b528eec195cb037` |
| Managed artefacts | 10 per agent, named `FlightRules / demo-commerce / refund-agent / …` |

UUIDs differ per seed. Read them from `/api/projects`.

---

## 6. Reset

```bash
make demo-reset                                  # payment ledger and notifications only
PROJECT=demo-commerce make signoz-purge          # managed artefacts and their register rows
make demo-seed                                   # rebuild to an active contract

# harder: application data only, SigNoz telemetry kept
docker compose -f compose.app.yaml down -v && make up && make db-migrate

# hardest: everything, including SigNoz telemetry
docker compose -f pours/deployment/compose.yaml -p signoz down -v
```

---

## 7. Recovery

| Symptom | Fix |
|---|---|
| OTLP ingestion returns `000` | `make signoz-bootstrap`. The collector does not bind until first-user setup completes |
| The gate exits `3` on a release you just ran | `flightrules release evaluate` first. The gate reads persisted evidence and never evaluates on demand |
| The gate exits `5` | The project or agent name is wrong, or no contract is active. `make demo-seed` |
| A job sits in `queued` | The worker is not running. `make worker` |
| Every artefact reports `conflict` | The database was rebuilt while SigNoz kept its resources. `make signoz-purge`, then `make signoz-sync` |
| `signoz_list_views` returns HTTP 500 | Something called `signoz_update_view`. FlightRules never does. Recovery is in `docs/RUNBOOK.md` section 6 |
| Every web page says the API is unreachable | `make api` |
| `next build` says it cannot find TypeScript | Use `pnpm --filter @flightrules/web run build`, which typechecks with `tsc` first (SL-060) |

---

## 8. The one-sentence claim

**A release pipeline can fail because of trajectory evidence from SigNoz** — deterministically, with
the trace identifiers that prove it, and no model anywhere in the decision.
