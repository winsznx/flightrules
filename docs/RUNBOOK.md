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
```

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
