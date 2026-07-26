# The hosted deployment

FlightRules runs publicly on Railway, with a publicly reachable SigNoz behind it. Nothing in it
depends on a developer machine: every process, the database, the observability stack and the demo
topology are hosted, and the whole canonical demo was executed against them.

**Railway project** `flightrules` — `0b392e15-3824-4ef0-829f-fc41a73b2c9f`, workspace `winszn`,
environment `production`, region EU West.

---

## Public URLs

| Surface | URL |
|---|---|
| Web application | https://flightrules-web-production.up.railway.app |
| API | https://flightrules-api-production.up.railway.app |
| SigNoz | https://signoz-signoz-production-f19a.up.railway.app |
| SigNoz MCP Server | https://flightrules-signoz-mcp-production.up.railway.app/mcp |
| OTLP ingestion (HTTP) | https://signoz-ingester-production-a417.up.railway.app |
| Demo agent | https://flightrules-demo-agent-production.up.railway.app |

## Services

| Service | What it runs |
|---|---|
| `flightrules-web` | `apps/web`, Next.js 16.2.11 |
| `flightrules-api` | `apps/api`, Fastify |
| `flightrules-worker` | `apps/worker` |
| `Postgres` | Railway PostgreSQL, the FlightRules database |
| `flightrules-signoz-mcp` | `signoz/signoz-mcp-server:v0.9.0` — the pinned version, unchanged |
| `signoz-signoz` | SigNoz, from the official SigNoz Railway template |
| `signoz-ingester` | SigNoz OTel Collector |
| `signoz-telemetrystore-clickhouse` | ClickHouse |
| `signoz-telemetrykeeper-clickhousekeeper` | ClickHouse Keeper |
| `signoz-telemetrystore-migrator` | ClickHouse schema migrator |
| `flightrules-demo-agent` | the refund agent |
| `flightrules-demo-{policy,order,fraud,payment,notification}` | the five demo services |

Sixteen services. Every secret is a Railway variable; none is committed, printed or logged.

### Why SigNoz comes from Railway's template and the MCP server does not

Railway has no bind mounts, no volume shared between services, and no `depends_on:
service_completed_successfully` init container. The Foundry-generated `pours/deployment/compose.yaml`
needs all three: ClickHouse mounts `config-0-0.yaml` and `functions.yaml`, Keeper mounts
`keeper-0.yaml`, the collector mounts `ingester.yaml` and `opamp.yaml`, and a one-shot container
populates a `user_scripts` volume that ClickHouse then reads. Reproducing that on Railway means
building and publishing three modified images, at which point the deployment is no longer the
committed, Foundry-reproducible artefact the project's thesis rests on.

So the hosted SigNoz core is Railway's **official SigNoz template**, whose services carry the same
names as the Foundry casting — and the **SigNoz MCP Server is deployed separately at the pinned
`v0.9.0`**, because that is the component FlightRules actually integrates against and it needs no
mounts. **Foundry remains the judge-reproducible path**: `make signoz-up` deploys the pinned stack
from the committed `casting.yaml`, and `make signoz-reproducibility` proves it reproduces.

The hosted SigNoz core is therefore *not* version-pinned by this repository. That is stated as a
limitation rather than glossed over.

---

## Verification, in the order it was executed

### Platform

```text
GET /api/v1/health          → {"status":"ok"}          (body asserted, not the status code — SL-012)
bootstrap-signoz.sh          → first user, service account, API key minted, OTLP accepting spans
snapshot-mcp-capabilities    → SigNozMCP v0.9.0 — 41 tools, 19 resources
                               All 22 required tools are present.
```

### The API, the database and the worker

```text
GET /health/live             {"status":"ok","service":"flightrules-api"}
GET /health/ready            {"status":"ready","database":"up",
                              "schema":{"compatible":true,"applied":["0001","0002","0003","0004"]}}
GET /health/dependencies     {"database":{"status":"up"},
                              "signoz":{"status":"up","missingTools":[]},
                              "jobs":{"status":"ok","queued":0,"running":0}}
```

`signoz.status: up` with no missing tools is the hosted API reaching the hosted MCP server over the
public HTTPS domain and completing capability discovery.

Migrations were applied through the documented production process — the same
`pnpm --filter @flightrules/db run migrate` the README and `make db-migrate` use — against the
Railway database. The API **refused to start** until they were, which is the schema guard working:

```text
SchemaIncompatibleError: The database schema does not match the migrations this build requires.
  expectedMigration: "0001, 0002, 0003, 0004"   appliedMigrations: []
```

### Worker idle survival and job claiming

```text
19:56:57Z  worker ready   lease_seconds=120
20:15:55Z  job claimed and completed — 19 minutes idle, then work claimed on demand
```

The idle poll timer is deliberately not `unref`ed; this is that behaviour observed in a hosted
deployment, across an idle period far longer than `postgres.js` keeps an idle connection open.

### OTLP — all three signals

| Signal | Evidence |
|---|---|
| Traces | Every demo run is queryable through the MCP Query Builder path within one polling attempt |
| Metrics | `flight_rules.duplicate_side_effects` returns a series carrying **both** FlightRules dimensions with real values, and filtering on `flight_rules.agent.id` narrows it |
| Logs | 5 records correlate to violation trace `fc4213ada8be595cd919cf1bbcbb1f9a`, every one carrying the trace identifier, 5 also carrying a span identifier, across three services |

`make verify-telemetry` against the hosted deployment:

```text
Exported logs
  ok    5 log record(s) correlate to trace fc4213ada8be595cd919cf1bbcbb1f9a
  ok    every returned record carries the trace identifier
  ok    service names present: flightrules-notification-service, flightrules-order-service,
        flightrules-payment-service
  ok    5 record(s) also carry a span identifier
  ok    no prompt, tool-argument or tool-result key appears in any record
  ok    no credential appears in any log body

Metric dimensions
  ok    1 series returned for flight_rules.duplicate_side_effects
  ok    1 series carry both FlightRules dimensions with real values
  ok    filtering on flight_rules.agent.id returns the agent's series

Exported logs and metric dimensions both verified against the running SigNoz.
```

---

## The canonical demo, executed against the hosted deployment

| # | Step | Result |
|---|---|---|
| 1 | 25 known-good runs through the hosted agent | `completedRuns: 25` |
| 2 | Mine a baseline from live telemetry | `1 route family from 26 runs` |
| 3 | Propose a contract | `019fa000-1484-718f-a748-2f040a8afab5` |
| 4 | Validate it | `valid` |
| 5 | Approve and activate | `active` |
| 6 | Sync the SigNoz artefacts | job succeeded |
| 7 | Read every artefact back | **`{"total":10,"synced":10,"drifted":0,"failed":0,"conflict":0}`** |
| 8 | Evaluate the approved release | `pass`, 26 runs, 0 violations |
| 9 | **Approved gate** | **exit `0`** |
| 10 | 8 unsafe canary runs | `completedRuns: 8` |
| 11 | Evaluate the canary | `fail`, 8 runs, **80 violations, 24 zero-tolerance, 8 duplicate side effects** |
| 12 | **Canary gate** | **exit `2`** |
| 13 | Missing policy check | `require-policy-retrieve-98fbf144` violated |
| 14 | Missing fraud check | `require-fraud-check-4dccc488` violated |
| 15 | Duplicate refund write | `single-payment-refund-write-8846bedd` violated, `duplicateSideEffects: 8` |
| 16 | Release Diff page | HTTP 200, `data-testid="route-release-diff"` |
| 17 | Three critical violation pages | HTTP 200, `data-testid="route-violation"` |
| 18 | Correlated logs | 5 records, above |
| 19 | Metric dimensions | queryable with real values, above |
| 20 | Worker survives idle, then claims | above |
| 21 | Restart the API, re-read the decision | **identical `decisionHash`** |

The canary gate's own words:

```text
  ZERO_TOLERANCE_VIOLATION (fail)       expected 0; observed 24
  VIOLATION_RATE_EXCEEDED (fail)        100.000000% of runs (8 of 8); the gate permits at most 0.5%
  UNKNOWN_ROUTE_RATE_EXCEEDED (fail)    100.000000% of runs; the gate permits at most 1%
  LATENCY_REGRESSION_EXCEEDED (fail)    p95 moved 740.740740% (189 ms to 1589 ms)
  RELEASE_BUDGET_EXCEEDED (fail)        p95 1589 over a budget of 227
  zero-tolerance rules  require-fraud-check-4dccc488, require-policy-retrieve-98fbf144,
                        single-payment-refund-write-8846bedd
```

### Determinism across a restart

```text
decisionHash before restart  c5fc5afd456c1cc4d60b6e5a154a0954e2a9fb522c40d47d7c4ce458d259d77e
decisionHash after  restart  c5fc5afd456c1cc4d60b6e5a154a0954e2a9fb522c40d47d7c4ce458d259d77e
```

---

## Two hosted findings worth recording

**The environment attribute is part of the contract's identity.** The demo services emit
`deployment.environment.name = railway`, and the baseline miner filters on it. Seeding with the
default `local` mined zero route families and reported `insufficient_runs` — correct behaviour that
reads exactly like missing telemetry. `POST /api/demo/reset` recreates the project with the API's own
`DEPLOYMENT_ENVIRONMENT_NAME`, which is the supported way to make the two agree.

**A managed notification channel needs a routable destination.** The default alert webhook points at
`host.docker.internal`, which SigNoz cannot resolve when it is not on the same host, and the channel
creation failed with `ARTIFACT_CREATE_FAILED` — the read-back catching it rather than the call
reporting success. `FLIGHTRULES_ALERT_WEBHOOK_URL` now points at a routable path that returns 404, so
delivery is still honestly recorded as failing (limitation 8) while the channel itself is real.
