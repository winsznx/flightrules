# FlightRules runbook

Operational procedures for the SigNoz stack and the FlightRules application services.

---

## 1. Deploy SigNoz

SigNoz is deployed by Foundry from the committed `casting.yaml`. The deprecated legacy install
script and the deprecated bundled Compose deployment are not used.

```bash
curl -fsSL https://signoz.io/foundry.sh | FOUNDRY_VERSION=v0.2.16 bash
export PATH="$HOME/.local/bin:$PATH"

make signoz-gauge     # foundryctl gauge -f casting.yaml
make signoz-forge     # foundryctl forge -f casting.yaml
make signoz-up        # foundryctl cast  -f casting.yaml
```

`forge` regenerates `casting.yaml.lock` and `pours/`. Both are committed, so a fresh clone can
inspect exactly which image tags will run without needing Foundry installed first.

### Bootstrap: create the first user and mint an API key

**This must run before any telemetry is produced.** See section 5.

```bash
export SIGNOZ_ADMIN_PASSWORD="$(openssl rand -base64 18)"
make signoz-bootstrap
```

The script is idempotent. It creates the organisation and root user, creates the `flightrules-mcp`
service account, assigns the managed `signoz-admin` role, mints a 90-day API key, writes it to
`.env` with mode 600, and then waits for OTLP ingestion to actually accept a span.

Re-running after setup already completed requires the organisation ID:

```bash
SIGNOZ_ORG_ID=<uuid> make signoz-bootstrap
```

### Verify

```bash
make signoz-verify           # every SigNoz surface
make signoz-reproducibility  # casting reproduces, images are pinned
make signoz-capabilities     # refresh docs/research/mcp-capabilities.json
```

---

## 2. Endpoints

| Surface | URL |
|---|---|
| SigNoz UI and HTTP API | http://localhost:8080 |
| SigNoz MCP Server | http://localhost:8000/mcp |
| MCP liveness / readiness | http://localhost:8000/livez, /readyz |
| OTLP HTTP ingestion | http://localhost:4318 |
| OTLP gRPC ingestion | localhost:4317 |
| FlightRules PostgreSQL | localhost:5433 |

ClickHouse, ClickHouse Keeper and the SigNoz metastore are not published to the host.

---

## 3. Connect Claude Code to the SigNoz MCP Server

Optional developer convenience. FlightRules itself never depends on it; the product connects
through its own MCP client.

```bash
claude mcp add --scope project --transport http signoz http://localhost:8000/mcp \
  --header "SIGNOZ-API-KEY: $(grep '^SIGNOZ_API_KEY=' .env | cut -d= -f2-)"
```

Verify with `/mcp` or `claude mcp list`.

---

## 4. Start the FlightRules application services

```bash
make up          # PostgreSQL, health-gated
make db-migrate  # apply migrations
make api         # the API on API_PORT (4000 by default)
make worker      # the job worker, in a second terminal
```

Neither application migrates at startup. Both read the migration ledger and refuse to start against
a database missing a migration they were built for, so a half-migrated database fails loudly instead
of producing errors that read as product bugs.

| Check | Command | Healthy result |
|---|---|---|
| API liveness | `curl -s localhost:4000/health/live` | `{"status":"ok",...}` |
| API readiness | `curl -s localhost:4000/health/ready` | `"status":"ready"`, `"compatible":true` |
| Dependencies | `curl -s localhost:4000/health/dependencies` | database `up`; SigNoz `up` or `degraded` |
| API surface | `curl -s localhost:4000/api/openapi.json` | the generated OpenAPI document |

A worker stops claiming on `SIGTERM` and finishes the job it holds. A worker that is killed leaves
its job in `running` until the lease expires (`WORKER_LEASE_SECONDS`, 120 s by default), after which
any worker returns it to the queue or fails it terminally once its attempts are exhausted.

---

## 5. OTLP ingestion requires completed SigNoz setup

This is the single most likely reason telemetry appears to vanish.

The collector receives its effective pipeline configuration from the SigNoz apiserver over OpAMP.
The apiserver will not serve that configuration until an organisation exists. Until then the
collector process is **not listening** on 4317 or 4318.

The trap: the Docker userland proxy accepts a TCP connection on both ports anyway and then resets
it. `nc -z localhost 4318` succeeds. `docker port` shows the mapping. Everything looks correct and
nothing is ingested.

**Diagnosis**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:4318/v1/traces \
  -H 'Content-Type: application/json' -d '{"resourceSpans":[]}'
# 200  -> ingestion is working
# 000  -> the receiver is not accepting spans

curl -s http://localhost:8080/api/v1/version   # look for "setupCompleted":true
docker logs signoz-ingester-1 2>&1 | grep -i 'opamp' | tail -5
# repeating "Server returned an error response" means the collector cannot fetch its config
```

**Fix**: run `make signoz-bootstrap`. The OpAMP errors stop and both receivers bind within a few
seconds.

Never use a TCP port check as an ingestion readiness signal. It passes in exactly the broken state.

---

## 6. Other operational traps

| Symptom | Cause | Fix |
|---|---|---|
| A SigNoz API call returns HTTP 200 with HTML | The path is not registered and fell through to the single-page app | Assert on the response body, not the status code. `POST /api/v1/login` does not exist in v0.134.0; use `POST /api/v2/sessions/email_password`. |
| Login returns `orgID is required` | v0.134.0 requires the organisation ID | Supply `orgID`; it is in the registration response and in the SigNoz UI settings. |
| Containers run `:latest` despite a pinned casting | `version:` alone does not change the image tag | Set `image:` as well. `make signoz-reproducibility` asserts this. |
| Custom span attributes missing from a trace | `signoz_get_trace_details` returns a fixed column set | Use `signoz_execute_builder_query` with `requestType: "raw"` and `selectFields` entries using `fieldContext: "tag"`. |
| An MCP create call reports `"name" cannot be empty` | The tool takes flat arguments, not a nested resource object | Spread the specification into the tool arguments. |

---

## 7. Teardown and data reset

### Stop, keep data

```bash
docker compose -f pours/deployment/compose.yaml -p signoz stop
make down
```

### Stop and delete all SigNoz telemetry

Destroys ClickHouse and metastore volumes. The organisation, users, API keys, dashboards, saved
views and alerts all go with them, so `make signoz-bootstrap` must be re-run afterwards.

```bash
docker compose -f pours/deployment/compose.yaml -p signoz down -v
```

### Delete FlightRules application data

```bash
docker compose -f compose.app.yaml down -v
```

### Full reset from scratch

```bash
docker compose -f pours/deployment/compose.yaml -p signoz down -v
docker compose -f compose.app.yaml down -v
rm -f .env

make signoz-up
export SIGNOZ_ADMIN_PASSWORD="$(openssl rand -base64 18)"
make signoz-bootstrap
make up
make db-migrate
make signoz-verify
```

Resetting the **demo** without destroying the SigNoz installation is a separate operation
(`make demo-reset`, from Phase 03). It clears FlightRules application data and managed SigNoz
artefacts while leaving the deployment and its configuration in place.

---

## 8. Rotate the SigNoz API key

```bash
export SIGNOZ_ADMIN_PASSWORD='<the password used at bootstrap>'
SIGNOZ_ORG_ID=<uuid> make signoz-bootstrap
```

A fresh key is minted and written to `.env`. Delete the superseded key in the SigNoz UI under the
`flightrules-mcp` service account.

To revoke every FlightRules credential at once, delete that one service account.

---

## 9. Health checks

| Check | Command | Healthy result |
|---|---|---|
| SigNoz API | `curl -s localhost:8080/api/v1/health` | `{"status":"ok"}` |
| SigNoz version and setup | `curl -s localhost:8080/api/v1/version` | `"version":"v0.134.0"`, `"setupCompleted":true` |
| MCP liveness | `curl -s -o /dev/null -w '%{http_code}' localhost:8000/livez` | `200` |
| MCP readiness | `curl -s localhost:8000/readyz` | `ok` |
| OTLP ingestion | see section 5 | `200` |
| FlightRules database | `docker inspect --format '{{.State.Health.Status}}' flightrules-postgres` | `healthy` |
| Everything at once | `make signoz-verify` | all checks pass |

---

## 10. Production deployment notes

The local deployment is not a production configuration.

- **The MCP port is published on the host.** PRD section 18.2 forbids that in production. Bind it
  to the internal network only.
- **The service account holds `signoz-admin`**, required because FlightRules creates notification
  channels and alert rules. Scope it down if a narrower role covers the artefacts you actually
  generate.
- **The metastore uses default credentials** from Foundry's Compose flavor. Override them.
- **`DEMO_MODE=true` enables demo mutation endpoints.** It must be false outside the demo.
- **`DEPLOYMENT_MODE=hosted`** activates the control that rejects loopback, link-local and private
  SigNoz URLs, closing the server-side request forgery path in multi-user deployments.

---

## 11. Compile the SigNoz operational surface (Phase 10)

Activating a contract does not touch SigNoz by itself. Synchronisation is an explicit request that
returns a job.

```bash
PROJECT=demo-commerce make signoz-sync   # every agent of a project, waits for the jobs

# or, one contract at a time
curl -s -X POST localhost:4000/api/contracts/<contractId>/sync-signoz \
  -H 'content-type: application/json' -d '{}'

# every agent of a project holding an active contract
curl -s -X POST localhost:4000/api/setup/signoz/sync-artifacts \
  -H 'content-type: application/json' -d '{"projectId":"<projectId>"}'

# what exists, and whether it still matches
curl -s "localhost:4000/api/setup/signoz/artifacts?projectId=<projectId>" | jq .summary
```

Ten resources are created per agent, named exactly as PRD section 16.8 prescribes:

```text
FlightRules / <project> / Notifications                            (webhook channel)
FlightRules / <project> / <agent> / Violating Runs                 (saved view)
FlightRules / <project> / <agent> / Duplicate Side Effects         (saved view)
FlightRules / <project> / <agent> / Unknown Routes                 (saved view)
FlightRules / <project> / <agent> / Release Comparison             (saved view)
FlightRules / <project> / <agent> / Contract Health                (dashboard, 10 panels)
FlightRules / <project> / <agent> / Violation Rate Alert           (alert)
FlightRules / <project> / <agent> / Duplicate Side Effect Alert    (alert)
FlightRules / <project> / <agent> / Release Evaluation Error Alert (alert)
FlightRules / <project> / <agent> / No Evaluation Data Alert       (alert)
```

Every write is followed by a read-back and a field comparison. A mismatch fails the job and the
mismatch is recorded on the artefact row, so `GET /api/setup/signoz/artifacts` tells you which
artefact disagreed and on which field.

### Making the alerts fire

The alerts read FlightRules' own metrics, so they need a real evaluation, not just telemetry:

```bash
DEMO_RUNS=8 make demo-v2                    # seed the unsafe canary
curl -s -X POST localhost:4000/api/demo/evaluate-v2 \
  -H 'content-type: application/json' -d '{"lookbackMinutes":30}'
```

The alerts evaluate every minute over a five-minute window, so allow two cycles. Confirm with the
SigNoz UI under Alerts, or through MCP with `signoz_list_alert_rules` and `signoz_get_alert_history`.

### Configuration

| Variable | Default | Effect |
|---|---|---|
| `FLIGHTRULES_ALERT_WEBHOOK_URL` | `http://host.docker.internal:4000/internal/alert-sink` | Where SigNoz posts a fired alert. The default points at nothing on purpose: SigNoz sends a real test notification when the channel is created, and the recorded failure is honest. Set a routable destination to make delivery real. |
| `FLIGHTRULES_VIOLATION_ALERT_THRESHOLD` | `0` | Violations in one evaluation window above which the rate alert fires. |

### Traps

| Symptom | Cause | Fix |
|---|---|---|
| A second sync creates duplicate dashboards or alerts | List tools return the identifier under `id`, `uuid` or `ruleId` depending on the resource type (SL-056) | Use `LIST_FIELDS` in `apps/worker/src/artifact-sync.ts`; never assume `id` |
| `signoz_list_views` returns HTTP 500 `error in unmarshalling explorer query data` | Something called `signoz_update_view`, which corrupts the stored query for the **whole tenant** (SL-057) | FlightRules never calls it. To recover: `docker exec signoz-metastore-postgres-0 psql -U signoz -d signoz -c "delete from saved_views where data like '\\x%';"` |
| A dashboard is stored but a panel is empty or wrong | The server accepts an incomplete widget "best-effort" and only warns (SL-059) | Supply every field the input schema declares, even when empty |
| A dashboard panel shows a rising line that never falls | A cumulative counter charted with `sum` (SL-054) | Use `increase` |
| Every artefact reports `conflict` on a fresh sync | The FlightRules database was rebuilt while SigNoz kept its resources, so the register no longer records creating them — which is the ownership rule working, not a bug | `PROJECT=demo-commerce make signoz-purge`, then `make signoz-sync` |
| A sync after a purge still reports `conflict`, and the job says `created=False` | The `signoz_sync` job is idempotent on the contract's content, so a repeated request returns the *previous* job's cached result | `make signoz-purge` also clears the register rows and the completed sync jobs. It needs `DATABASE_URL`; without it the remote resources go and the register stays, which is exactly the state that cannot re-sync. |

---

## 12. The release gate (Phase 11)

The gate is a **read** over persisted evidence. It runs no job and fetches no trace, so it is safe
to call repeatedly and returns the same decision from a restarted API.

```bash
make demo-seed                       # empty database -> active contract -> synced artefacts

node apps/cli/dist/index.js release evaluate \
  --project demo-commerce --agent refund-agent --release refund-agent-v1 --lookback 360
PROJECT=demo-commerce AGENT=refund-agent RELEASE=refund-agent-v1 make gate    # exit 0

DEMO_RUNS=8 make demo-v2
node apps/cli/dist/index.js release evaluate \
  --project demo-commerce --agent refund-agent --release refund-agent-v2 --lookback 60
PROJECT=demo-commerce AGENT=refund-agent RELEASE=refund-agent-v2 make gate    # exit 2
```

Or all of it at once: **`make demo-full`**. It emits the telemetry, seeds the contract, evaluates
both releases and asserts the two exit codes, failing if they are anything but `0` then `2`.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | pass — the release stayed within the trajectory contract |
| `1` | reserved for an unclassified crash; never returned by a classified path |
| `2` | contract violation |
| `3` | insufficient data — too few completed runs, truncated retrieval, or a stale window |
| `4` | integration or evaluation error — a dependency failed, or a run evaluation errored |
| `5` | invalid configuration — bad arguments, an unknown project or agent, an invalid contract |

`flightrules release evaluate` exits `0` for an evaluation that *completed*, whatever it found.
Deciding is `gate check`'s job.

### CLI

```text
flightrules config verify                  the API, the database, the schema, SigNoz
flightrules contract validate <path>       offline; no network, no database
flightrules baseline capture               --project --agent --release --lookback
flightrules release evaluate               --project --agent --release --lookback
flightrules gate check                     the decision, and the process exit code
flightrules evidence export --out <file>   the replayable decision document
```

`--json` emits exactly one document on stdout; progress always goes to stderr. Set
`FLIGHTRULES_PROJECT`, `FLIGHTRULES_AGENT` and `FLIGHTRULES_RELEASE` to drop the repeated flags.
When `GITHUB_STEP_SUMMARY` is set, `gate check` appends a Markdown summary to it.

### Traps

| Symptom | Cause | Fix |
|---|---|---|
| `NOT_FOUND: No route matches that path` from `gate check` | The running API predates the gate route | `pnpm exec tsc --build --force tsconfig.build.json`, then restart `make api`. `tsc --build` alone has been observed leaving a new route out of `dist` |
| `RELEASE_INSUFFICIENT_DATA`, exit 3, on a release you just ran | Telemetry exists but nothing has evaluated it | `flightrules release evaluate` first; the gate never evaluates on demand |
| `AGGREGATION_STALE` | The evaluation window closed more than `--max-age` ago (24 h by default) | Re-evaluate. A decision about old evidence is not a decision about the release now |
| `CONTRACT_NOT_ACTIVE`, exit 4 | The contract those runs were judged against has been superseded | Re-evaluate against the current active contract |
| A CI step passes while the canary is broken | Something is swallowing the exit code | The workflow asserts exit `2` explicitly. Never wrap `gate check` in `\|\| true` |

---

## 13. The web application (Phase 12)

```bash
make web            # Next.js on WEB_PORT (3000 by default)
```

It requires a running API (`make api`) and reads `FLIGHTRULES_API_URL`
(`http://localhost:4000` by default). It talks to nothing else: PRD section 12.3 forbids SigNoz
credentials and MCP calls in the browser, and `src/lib/api.ts` is `server-only`, so importing it
from a client component is a build error.

| Route | What it shows |
|---|---|
| `/` | The landing page |
| `/setup` | The SigNoz connection, its six verification steps and the discovered MCP tools |
| `/projects` | Projects |
| `/projects/:projectId/overview` | Trajectory health: eight cards, release decisions, violations by rule |
| `/projects/:projectId/agents` | Agents |
| `/projects/:projectId/agents/:agentId` | Agent detail, six tabs (`?tab=routes`, `?tab=contracts`, …) |
| `/projects/:projectId/agents/:agentId/baselines/new` | Baseline capture |
| `/projects/:projectId/agents/:agentId/routes/:routeFamilyId` | Route family, canonical graph as a table |
| `/projects/:projectId/agents/:agentId/contracts/:contractId` | Contract Studio |
| `/projects/:projectId/agents/:agentId/releases` | Releases, with each one's gate decision |
| `/projects/:projectId/agents/:agentId/releases/:releaseId` | Release Diff: the decision, its findings and its evidence |
| `/projects/:projectId/violations/:violationId` | Violation Inspector |
| `/projects/:projectId/integrations/signoz` | Managed dashboards, alerts, views and channels |
| `/demo` | The demo |

### Traps

| Symptom | Cause | Fix |
|---|---|---|
| Every page shows "FlightRules could not reach its API." | The API is not running, or `FLIGHTRULES_API_URL` points elsewhere | `make api`, then reload. The web application never falls back to stale data |
| `next build` reports it cannot find TypeScript and then crashes | Next.js 16.2.11 cannot drive TypeScript 7.0.2 (SL-060) | Already handled: `pnpm --filter @flightrules/web run build` runs `tsc -p` first and `next build` second. Do not re-enable Next's own TypeScript step |
| A page renders but its table is empty | The API answered with no rows. That is the empty state, not a failure | Seed with `make demo-seed`, or evaluate a release |
| `make verify` fails on `scan-design` | A colour, size or font entered the product that `design.md` does not define | Use a `var(--…)` token. `design.md` is authoritative (ADR-0011) |
