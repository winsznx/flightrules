# Phase 02 result — SigNoz deployment through Foundry

Branch: `phase/02-signoz-foundry`
Date: 2026-07-25

## What was built

```text
casting.yaml                        pinned Installation, MCP enabled, no secrets
casting.yaml.lock                   generated, committed, byte-stable across re-forge
pours/                              6 generated files, committed (ADR-0002 decision 3)
scripts/bootstrap-signoz.sh         idempotent first-user, service-account and API-key setup
scripts/verify-signoz.sh            verifies every SigNoz surface against the running deployment
scripts/verify-reproducibility.sh   re-forges into a temp dir and diffs against what is committed
scripts/snapshot-mcp-capabilities.mjs  live MCP tool discovery with a required-tool assertion
packages/test-fixtures              deployment parsing helpers plus casting and MCP tests
docs/RUNBOOK.md                     deploy, bootstrap, endpoints, traps, teardown, reset, rotation
Makefile                            nine signoz-* targets
.github/workflows/ci.yml            new `signoz` job: deploy, bootstrap, verify, integration test
```

### Casting

```yaml
apiVersion: v1alpha1
kind: Installation
metadata:
  name: signoz
spec:
  deployment: { mode: docker, flavor: compose }
  signoz:   { spec: { image: signoz/signoz:v0.134.0,                    version: v0.134.0 } }
  ingester: { spec: { image: signoz/signoz-otel-collector:v0.144.6,     version: v0.144.6 } }
  mcp:      { spec: { enabled: true, image: signoz/signoz-mcp-server:v0.9.0, version: v0.9.0 } }
```

SHA-256 `casting.yaml` `02cd770de6adc9970c9ac42c6f8d212e615ed7e6bde59fb4fbe80c34a15ceb24`,
`casting.yaml.lock` `e525ab44b134ced71fa1f418c0ac14cd41fcbcba2a0a0b8fbc1cc636d3fc1c48`.

Both `image` and `version` are set on every pinned molding. Setting `version` alone records the
version in the lock file while leaving the generated Compose file on `:latest` (SL-006), which
would produce a deployment that looks pinned and is not. ClickHouse, ClickHouse Keeper and the
metastore are left on Foundry's own pins so a Foundry upgrade moves them coherently.

## Commands run and results

| Command | Exit | Result |
|---|---|---|
| `foundryctl gauge -f casting.yaml` | 0 | required tools available |
| `foundryctl forge -f casting.yaml` | 0 | wrote `casting.yaml.lock` and 6 files under `pours/` |
| `foundryctl forge` (second run) | 0 | byte-identical lock, `LOCK STABLE across re-forge` |
| `foundryctl cast -f casting.yaml` | 0 | all containers created and started |
| `bash scripts/bootstrap-signoz.sh` | 0 | org, root user, service account, admin role, API key, OTLP accepting spans |
| `bash scripts/verify-signoz.sh` | 0 | 14 checks, all passed |
| `bash scripts/verify-reproducibility.sh` | 0 | 19 checks, all passed |
| `node scripts/snapshot-mcp-capabilities.mjs` | 0 | 41 tools, 19 resources, all 22 required tools present |
| `make test` | 0 | 70 unit tests passed |
| `make test-integration-db` | 0 | 8 database integration tests passed |
| `make test-integration-signoz` | 0 | 32 SigNoz integration tests passed |
| `make verify` | 0 | complete suite green |

Total this phase: **110 tests passed, 0 failed, 0 skipped** (70 unit, 8 database integration,
32 SigNoz integration).

## Runtime validation

### Deployed containers, observed

```text
signoz-signoz-0                            signoz/signoz:v0.134.0                 Up (healthy)
signoz-ingester-1                          signoz/signoz-otel-collector:v0.144.6  Up
signoz-mcp                                 signoz/signoz-mcp-server:v0.9.0        Up
signoz-metastore-postgres-0                postgres:16                            Up (healthy)
signoz-telemetrystore-clickhouse-0-0       clickhouse/clickhouse-server:25.12.5   Up (healthy)
signoz-telemetrykeeper-clickhousekeeper-0  clickhouse/clickhouse-keeper:25.12.5   Up (healthy)
```

Every running image matches a tag the casting pins. No container runs `:latest`.

### Published ports, observed

`4317:4317` and `4318:4318` on the ingester, `8000:8000` on the MCP server, `8080:8080` on the
SigNoz apiserver. ClickHouse (9000, 8123), ClickHouse Keeper (9181) and the metastore (5432) are
**not** published, which the deployment test asserts.

### `scripts/verify-signoz.sh` output

```text
Deployment
  ok    signoz-signoz-0 runs signoz/signoz:v0.134.0
  ok    signoz-mcp runs signoz/signoz-mcp-server:v0.9.0
  ok    collector runs signoz/signoz-otel-collector:v0.144.6
  ok    no floating ':latest' image tag in the generated Compose file
SigNoz API
  ok    GET /api/v1/health reports ok
  ok    SigNoz reports v0.134.0
  ok    first-user setup is complete
SigNoz MCP Server
  ok    GET /livez returns 200
  ok    GET /readyz returns 200
  ok    MCP initialize succeeds and reports v0.9.0
  ok    an invalid API key is rejected
OTLP ingestion
  ok    POST http://localhost:4318/v1/traces returns 200
  ok    the collector is listening on OTLP gRPC 4317
```

### `scripts/verify-reproducibility.sh` output

Re-forging `casting.yaml` into a fresh temporary directory reproduced `casting.yaml.lock` and the
entire `pours/` tree **byte for byte**. All six expected image tags are present in the generated
Compose file, no `:latest` tag appears, and each of the six running containers was matched back
to an image the casting pins.

### MCP capability discovery

`SigNozMCP v0.9.0 — 41 tools, 19 resources`, snapshot refreshed into
`docs/research/mcp-capabilities.json` from this deployment. All 22 tools PRD section 16.4
requires are present. The script exits non-zero with `MCP_TOOL_MISSING` if any is absent, so a
future version drop cannot pass silently.

### Authentication

An authenticated `signoz_list_services` call succeeded. A call with an invalid key was rejected,
verified in both the shell script and the integration suite. Confirming rejection matters as much
as confirming success: a server that accepts any key would pass a success-only check.

## Failures discovered and how they were resolved

### 1. Bootstrap failed on the first run: environment not visible to subshells

`KeyError: 'ADMIN_NAME'`. The shell variables were set but not exported, so the `python3`
processes inside command substitutions could not read them. Resolved with a single `export` of
every variable the JSON builders need, before the first use. The script then completed end to end.

### 2. A speculative CI change was written and reverted

An initial edit added a `VITEST_INCLUDE_SIGNOZ: "false"` environment variable to the CI database
job. Nothing read it. It would have looked like the SigNoz tests were deliberately excluded while
actually doing nothing, and the job would have failed on the missing stack.

Reverted, and replaced with a real mechanism: the Vitest integration project was split into
`integration-db` and `integration-signoz` by the external service each requires. CI's `database`
job runs `integration-db` against its PostgreSQL service; a new `signoz` job installs foundryctl,
deploys the pinned stack, bootstraps it, verifies every surface, refreshes the capability
snapshot, runs `integration-signoz`, and tears down with `if: always()`.

### 3. Secret scanner failed on a Phase 01 evidence file

`make verify` failed because `docs/evidence/phase-01-result.md` quoted the credential-shaped
literal that had been removed from the test fixture in Phase 01. The evidence file described the
finding by reproducing the string.

Resolved by describing the shape rather than reproducing the literal. Evidence must not contain
credential-shaped strings, and the scanner correctly refused to distinguish between a real one
and a documented one.

### 4. Import ordering after adding the deployment fixtures

Biome's `organizeImports` assist flagged the new files. Fixed with `pnpm run lint:fix`.

## Claude Code MCP connection

The documented command is in `docs/RUNBOOK.md` section 3:

```bash
claude mcp add --scope project --transport http signoz http://localhost:8000/mcp \
  --header "SIGNOZ-API-KEY: $(grep '^SIGNOZ_API_KEY=' .env | cut -d= -f2-)"
```

It was **not executed automatically**. It writes to developer-level Claude Code configuration
outside this repository, and the execution contract limits side effects to this repository. The
same MCP endpoint, transport and authentication header were exercised programmatically through
the official MCP TypeScript SDK in the integration tests, so the connection path itself is proven.

## Teardown and data reset

`docs/RUNBOOK.md` section 7 documents stop-keeping-data, stop-and-delete-telemetry, delete
application data, and full reset from scratch. Section 8 documents API-key rotation and full
credential revocation by deleting the single `flightrules-mcp` service account. Both are backed
by `make signoz-down`, `make signoz-destroy` and `make down`.

## Known limitations

1. The `signoz` CI job has been validated by running its exact command sequence locally, not by a
   remote CI run. No push to a remote has been made.
2. `make signoz-bootstrap` on an already-set-up instance requires `SIGNOZ_ORG_ID`, because the
   organisation ID is only returned by the registration call. The script says so explicitly rather
   than guessing. Documented in the runbook.
3. The MCP port is published on the host. Correct for local development; PRD section 18.2 forbids
   it in production. `verify-signoz.sh` prints a note, and the runbook's production section lists
   it first. Enforcing an unpublished production profile is Phase 16 hardening work.
4. The service account holds `signoz-admin`, required because FlightRules creates notification
   channels and alert rules. Mitigations — 90-day expiry, single purpose, revocable by deleting
   one account — are in the runbook; the full analysis lands in `docs/THREAT_MODEL.md` at Phase 16.
5. Only trace ingestion has been exercised so far. Metrics and logs use the same collector
   pipeline and are exercised in Phase 04.

---

```text
PHASE: 02 SigNoz deployment through Foundry
STATUS: PASS
BRANCH: phase/02-signoz-foundry
COMMITS: bb500315da51a39b32b1eac7b07e27d95232adfc (phase), 3b878ab6e3e04961aecbca2c3ed6b0ea5abcea15 (merge to main)
SOURCES VERIFIED: 10 existing source-lock entries re-confirmed against this deployment (SL-001, SL-003 to SL-010, SL-015 to SL-019); the live MCP capability snapshot in docs/research/mcp-capabilities.json was regenerated from this stack (41 tools, 19 resources, full input and output schemas)
IMPLEMENTED: pinned casting.yaml with the MCP molding enabled and no secrets; committed casting.yaml.lock and pours/; idempotent SigNoz bootstrap creating the organisation, root user, flightrules-mcp service account, signoz-admin role assignment and a 90-day API key written to a mode-600 .env; verify-signoz.sh covering deployment images, API health and version, setup completion, MCP liveness, readiness, authenticated initialize and invalid-key rejection, real OTLP ingestion and gRPC listener state; verify-reproducibility.sh re-forging into a clean directory and diffing; MCP capability snapshot script with a required-tool assertion; @flightrules/test-fixtures with casting and deployment tests; SigNoz integration test suite; nine Makefile targets; a CI job that deploys, bootstraps, verifies and tears down; docs/RUNBOOK.md
TESTS RUN: foundryctl gauge; foundryctl forge (twice, for lock stability); foundryctl cast; scripts/bootstrap-signoz.sh; scripts/verify-signoz.sh; scripts/verify-reproducibility.sh; node scripts/snapshot-mcp-capabilities.mjs; make test; make test-integration-db; make test-integration-signoz; make verify
TEST RESULT: passed 110, failed 0, skipped 0 (70 unit, 8 database integration, 32 SigNoz integration). Every gate command exited 0. Four defects were found and resolved during the phase: unexported shell variables breaking bootstrap, a speculative CI environment variable that did nothing, a credential-shaped literal in Phase 01 evidence, and import ordering.
RUNTIME VALIDATION: SigNoz v0.134.0, collector v0.144.6 and MCP server v0.9.0 were deployed from the committed casting and observed healthy, each running an image tag the casting pins, with no ':latest' anywhere. Bootstrap created the organisation, service account, admin role assignment and API key against the live API, then waited for a real OTLP POST to return 200 rather than trusting a port check. The MCP server was reached through the official TypeScript SDK: initialize reported v0.9.0, tools/list returned 41 tools containing all 22 required ones, an authenticated read tool call succeeded, and an invalid API key was rejected. Re-forging into a clean temporary directory reproduced casting.yaml.lock and pours/ byte for byte, and all six running containers were matched back to pinned images.
EVIDENCE: docs/evidence/phase-02-plan.md; docs/evidence/phase-02-result.md; docs/research/mcp-capabilities.json; docs/RUNBOOK.md; casting.yaml; casting.yaml.lock; pours/
KNOWN LIMITATIONS: five, listed above. None blocks Phase 03.
NEXT PHASE ENTRY CRITERIA: SATISFIED
```
