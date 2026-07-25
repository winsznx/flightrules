# Phase 00 result — Source lock and feasibility proof

Branch: `phase/00-source-lock`
Date: 2026-07-25

## Environment

```
macOS 27.0 (Darwin 27.0.0, build 26A5388g), arm64 (T6000), 8 cores, 32 GiB
node    v24.14.1        pnpm 10.33.0       npm 11.12.1      corepack 0.34.6
git     2.50.1          docker 29.6.1      compose v5.3.0   claude 2.1.206
foundryctl v0.2.16 (commit 9fdfe4e, go1.25.3)
```

Network reachability: `https://signoz.io/docs/install/docker/` → 200,
`https://api.github.com` → 200.

## Authoritative documents

| File | SHA-256 |
|---|---|
| `docs/FLIGHTRULES_END_TO_END_PRD.md` (supplied) | `8f025676c470c65aa4e5259622cb8eb7a91d8815079160e6754b6942dea15de9` |
| `docs/PRD.md` (verbatim copy, PRD section 13) | `8f025676c470c65aa4e5259622cb8eb7a91d8815079160e6754b6942dea15de9` |
| `design.md` (repository root, PRD section 13) | `b3c20d6318fa03d186387d6d7c7cf4c8855bf6fb8c25e5161b08cb598c84c43d` |

Both were read in full before any file was changed. The PRD was supplied as
`docs/FLIGHTRULES_END_TO_END_PRD.md` rather than `docs/PRD.md`; PRD section 13 permits
`docs/PRD.md` to be that file copied verbatim, and the identical hashes confirm the copy.

## Repository state at phase start

The repository contained exactly two files (`design.md`, `docs/FLIGHTRULES_END_TO_END_PRD.md`),
no `.git` directory, no branches, no package files, no lockfiles, no environment examples, no
workflows, no source, no tests. `git init -b main` was therefore the first action, followed by
commit `ca90aa6` on `main` and branch `phase/00-source-lock`.

## Commands run and results

### Foundry

| Command | Exit | Observation |
|---|---|---|
| `curl -fsSL https://signoz.io/foundry.sh \| bash` | 0 | Installed `foundryctl v0.2.16` to `~/.local/bin/foundryctl` |
| `foundryctl version` | 0 | `Version: v0.2.16`, `Commit: 9fdfe4e`, `Go: go1.25.3` |
| `foundryctl --help` | 0 | Commands: `cast`, `catalog`, `forge`, `gauge`, `gen`, `help`, `version`. No `--version` flag exists. |
| `foundryctl gen examples` | 0 | Generated 10 deployment examples under `docs/examples/` |
| `foundryctl gauge -f casting.yaml` | 0 | Tool check passed |
| `foundryctl forge -f casting.yaml` | 0 | Generated `casting.yaml.lock` and `pours/` |
| `foundryctl forge` (second run, unchanged casting) | 0 | Byte-identical lock: `sha256 e525ab44b134ced71fa1f418c0ac14cd41fcbcba2a0a0b8fbc1cc636d3fc1c48` both times |
| `foundryctl cast -f casting.yaml` | 0 | All containers created and started |

`foundryctl gen schemas` fails outside the Foundry source tree
(`open api/v1alpha1/installation/casting.schema.json: no such file or directory`). The schema
was therefore read from the Foundry repository at the pinned tag instead, which is the same
artefact.

### Deployed containers

```
signoz-signoz-0                            signoz/signoz:v0.134.0                     Up (healthy)
signoz-ingester-1                          signoz/signoz-otel-collector:v0.144.6      Up
signoz-mcp                                 signoz/signoz-mcp-server:v0.9.0            Up
signoz-metastore-postgres-0                postgres:16                                Up (healthy)
signoz-telemetrystore-clickhouse-0-0       clickhouse/clickhouse-server:25.12.5       Up (healthy)
signoz-telemetrykeeper-clickhousekeeper-0  clickhouse/clickhouse-keeper:25.12.5       Up (healthy)
signoz-telemetrystore-migrator             signoz/signoz-otel-collector:v0.144.6      Up
```

### Endpoint probes

| Check | Result |
|---|---|
| `GET :8080/api/v1/health` | `{"status":"ok"}` |
| `GET :8080/api/v1/version` | `{"version":"v0.134.0","ee":"Y","setupCompleted":true}` |
| `GET :8000/livez` | 200 |
| `GET :8000/readyz` | 200, body `ok` |
| `GET :8000/healthz` | 200 |
| `POST :4318/v1/traces` | 200, `{"partialSuccess":{}}` |
| TCP `:4317` | listener bound inside collector container |

## Failures discovered and how they were resolved

### 1. `version:` does not pin the container image

First forge produced `casting.yaml.lock` containing `version: v0.144.6` while
`pours/deployment/compose.yaml` still contained `image: signoz/signoz-otel-collector:latest`.

Resolution: set `image:` explicitly on every pinned molding. Re-forge produced
`signoz/signoz:v0.134.0`, `signoz/signoz-otel-collector:v0.144.6` and
`signoz/signoz-mcp-server:v0.9.0` in the Compose file, and the running containers confirm those
exact tags. Recorded as SL-006 and ADR-0002. The reproducibility check will assert on Compose
image tags, not on the lock file's `version` field.

### 2. OTLP ingestion silently unavailable until SigNoz setup completes

`POST :4318/v1/traces` returned a connection reset while a plain TCP connect to 4318 **succeeded**
(the Docker userland proxy accepts and then fails to reach the container). `/proc/net/tcp6`
inside the collector showed only ports 1777 and 13133 bound. The collector logged
`opamp/server_client.go:146 Server returned an error response` every 30 seconds.

Root cause: the collector's effective pipeline configuration is delivered by the SigNoz
apiserver over OpAMP, and the apiserver will not serve it until an organisation exists
(`setupCompleted: false`).

Resolution: completed first-user registration. The OpAMP errors stopped, ports 4317 and 4318
appeared as bound listeners, and the OTLP POST returned 200. Recorded as SL-010 and ADR-0002
Decision 4. Consequence adopted: **a TCP port check is not evidence of ingestion readiness**;
verification must POST real OTLP and assert HTTP 200.

### 3. `POST /api/v1/login` does not exist in SigNoz v0.134.0

It returned the SPA shell with HTTP 200, which parsed as a success in a naive check. The real
endpoint is `POST /api/v2/sessions/email_password`, discovered from the OpenAPI schema generated
by the installed binary. It additionally requires `orgID`, returning
`{"error":{"code":"invalid_input","message":"orgID is required"}}` without it.

Resolution: use the v2 endpoint with the `orgId` returned by registration. Recorded as SL-012.
Consequence adopted: **direct SigNoz HTTP checks must assert on the response body, never on the
status code**, because unmatched paths return HTML with 200.

### 4. `signoz_get_trace_details` cannot return custom span attributes

A trace carrying `agent.side_effect` and `agent.release.id` was retrieved successfully with
correct hierarchy, but neither custom attribute appeared. The tool's live input schema has no
field-selection parameter. `signoz_search_traces` has the same limitation.

This threatened the central chain link "FlightRules can retrieve complete trace evidence".

Resolution: the server's own MCP resource `signoz://traces/query-builder-guide` documents
`signoz_execute_builder_query` with `requestType: "raw"` and `selectFields` entries using
`fieldContext: "tag"`. Tested against the same trace: all five spans returned with correct
`span_id`, `parent_span_id`, and both custom attributes. Recorded as SL-020, SL-021 and ADR-0003.
No direct ClickHouse access is required and PRD section 12.4 is satisfied.

### 5. `signoz_create_view` rejects a nested resource object

Passing `{ view: {...} }` produced `Parameter validation failed: "name" cannot be empty`. The
live schema requires flat arguments (`name`, `sourcePage`, `compositeQuery`). Resolution:
spread the specification into the tool arguments. Recorded as SL-023.

### 6. `InMemorySpanExporter` cleared before assertion

The first OTel proof reported zero finished spans because `provider.shutdown()` ran before
`getFinishedSpans()`, and shutdown clears the exporter. Resolution: read the exporter after
`forceFlush()` and before `shutdown()`. Recorded as SL-029; this is the pattern every telemetry
test will use.

## Feasibility proofs

Scripts are committed under `docs/evidence/phase-00/` so the evidence is reproducible.

### Chain link 1–2: OpenTelemetry emits, SigNoz ingests

`docs/evidence/phase-00/otel-emit.mjs` built a 5-span trace (`refund.request` as root with four
children `policy.retrieve`, `order.lookup`, `fraud.check`, `payment.refund`) carrying
`agent.release.id`, `agent.run.id` and `agent.side_effect`, asserted the structure through an
in-memory exporter, and exported it over OTLP/HTTP to the deployed collector.

```json
{ "traceId": "228cc4802f7b26ef44ac2a924841a047",
  "inMemorySpanCount": 5,
  "inMemorySpanNames": ["policy.retrieve","order.lookup","fraud.check","payment.refund","refund.request"],
  "parentLinkage": [ {"name":"policy.retrieve","parentSpanId":"18dab6d97a6bfd45"},
                     {"name":"order.lookup","parentSpanId":"18dab6d97a6bfd45"},
                     {"name":"fraud.check","parentSpanId":"18dab6d97a6bfd45"},
                     {"name":"payment.refund","parentSpanId":"18dab6d97a6bfd45"},
                     {"name":"refund.request","parentSpanId":null} ] }
```

### Chain link 3–4: FlightRules retrieves complete evidence and can reconstruct trajectories

`docs/evidence/phase-00/mcp-custom-attrs.mjs`, using the official MCP TypeScript SDK against the
running SigNoz MCP Server, returned all five spans of that exact trace:

```
payment.refund   span e5eca5d86341a06b  parent 18dab6d97a6bfd45  side_effect=write  release=phase00-probe-v1  Client
fraud.check      span bab4c07bb324b1bf  parent 18dab6d97a6bfd45  side_effect=read   release=phase00-probe-v1  Client
order.lookup     span 51760a9fd601520d  parent 18dab6d97a6bfd45  side_effect=read   release=phase00-probe-v1  Client
policy.retrieve  span 9f4c432781f3e6ad  parent 18dab6d97a6bfd45  side_effect=read   release=phase00-probe-v1  Client
refund.request   span 18dab6d97a6bfd45  parent (none)            side_effect=null   release=phase00-probe-v1  Server
```

Attribute keys were independently discoverable: `signoz_get_field_keys` returned
`agent.release.id`, `agent.run.id`, `agent.side_effect` with `"complete": true`.

### Chain link 5: deterministic contract evaluation

Verified by construction. Evaluation is pure local computation over the graph retrieved above.
It requires no external capability, so nothing in the pinned stack can prevent it. The
determinism and property obligations are Phase 06 and Phase 07 test requirements.

### Chain link 6: result telemetry written back to SigNoz

The same OTLP/HTTP path proven in links 1–2. FlightRules' own spans and metrics use the same
exporter packages against the same endpoint.

### Chain link 7: SigNoz artefacts created and read back

`docs/evidence/phase-00/mcp-write-verify.mjs` executed the full cycle:

```
create_view isError: false
created view id: "019f97be-32e7-7cd2-9149-4e42446efad2"
get_view isError: false
readback name:       FlightRules Phase00 Probe View
readback sourcePage: traces
readback filter:     service.name = 'flightrules-phase00-probe'
READ-BACK FIELD MATCH: true
list_views contains created view: true | total: 1
delete_view isError: false {"status":"success"}
```

Dashboard, alert, alert-history and notification-channel tool schemas were all confirmed present
with the fields the PRD requires. `signoz_get_alert_history` exposes a `state` enum including
`firing` and `recovering`, so the PRD's fire-and-recover proof is supported by the pinned
version.

### Chain link 8: deterministic non-zero CLI exit code

Verified by construction. Node process exit codes; no external capability required.

## Capability snapshot

`docs/research/mcp-capabilities.json` (352 KB) contains the verbatim live tool surface captured
through `tools/list`: 41 tools with complete input and output schemas, 19 resources, server
capabilities, and the negotiated protocol version `2025-06-18`. All 22 tools the PRD section
16.4 requires are present with exactly the expected names.

## Toolchain verification

| Check | Exit | Note |
|---|---|---|
| TypeScript 7.0.2 strict typecheck (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `nodenext`) | 0 | clean |
| Next.js 16.2.11 + React 19.2.8 + TypeScript 7.0.2 App Router typecheck | 0 | clean |
| `@opentelemetry/semantic-conventions@1.43.0` export enumeration | 0 | 659 stable symbols, 0 `gen_ai.*` stable, 60 `gen_ai.*` incubating |

## Documents produced

```
CLAUDE.md
docs/PRD.md                                     (verbatim copy)
docs/ACCEPTANCE_MATRIX.md
docs/research/source-lock.md                    (35 entries)
docs/research/compatibility-matrix.md
docs/research/mcp-capabilities.json             (live snapshot)
docs/research/otel-attributes.md
docs/adr/0001-stack-and-version-policy.md
docs/adr/0002-signoz-deployment-and-pinning.md
docs/adr/0003-signoz-access-boundary.md
docs/adr/0004-telemetry-attribute-conventions.md
docs/evidence/phase-00-plan.md
docs/evidence/phase-00-result.md
docs/evidence/phase-00/*.mjs                    (proof scripts)
CHANGELOG.md
```

## Known limitations

1. The Phase 00 deployment was performed in a scratch directory for verification only. The
   committed, reproducible `casting.yaml`, `casting.yaml.lock` and `pours/` are Phase 02 work.
   Phase 00 deliberately did not scaffold anything.
2. Alert firing and recovery were confirmed to be *supported* by schema inspection. Actual
   observed firing and recovery is Phase 10 work and is not claimed here.
3. Dashboard creation was confirmed by schema, not by a live create-and-read-back. Only the
   saved-view cycle was executed live. The write-verify pattern is identical across resource
   types, and Phase 10 executes it for dashboards and alerts.
4. Package versions for Fastify, Drizzle, Zod, Pino, Vitest, fast-check, Playwright, Ajv and
   js-yaml were verified from registry metadata (licence, version, engines, not archived). They
   are exercised at runtime in the phase that introduces each.
5. The scratch SigNoz deployment, its organisation, service account and API key remain running
   on this machine. They are local-only, hold no real data, and are torn down and recreated by
   the Phase 02 scripts.

## Secrets

No credential appears in this file, in any committed file, or in the capability snapshot. The
SigNoz API key created during verification exists only in the scratch directory outside the
repository and is excluded by `.gitignore` policy.

---

```text
PHASE: 00 Source lock and feasibility proof
STATUS: PASS
BRANCH: phase/00-source-lock
COMMITS: ba600b8a12f1fefb8f7b28fe171597e9d17ea27b (phase), 1f87df23ce0cc6f4af432a580d0aaf6a3db40a80 (merge to main)
SOURCES VERIFIED: 35 source-lock entries (docs/research/source-lock.md), 41 live MCP tool schemas (docs/research/mcp-capabilities.json), 19 live MCP resources, 1 generated SigNoz OpenAPI schema (750,482 bytes), Foundry casting JSON Schema at v0.2.16
IMPLEMENTED: no application code (correct for this phase); Git repository initialised; PRD copied to docs/PRD.md verbatim; CLAUDE.md operating contract; source lock; compatibility matrix; MCP capability snapshot; OpenTelemetry attribute register; ADR-0001 stack and version policy; ADR-0002 SigNoz deployment and pinning; ADR-0003 SigNoz access boundary; ADR-0004 telemetry attribute conventions; initial acceptance matrix; Phase 00 plan and result; six committed feasibility-proof scripts
TESTS RUN: foundryctl gauge; foundryctl forge (twice, for lock stability); foundryctl cast; SigNoz health, version, MCP livez/readyz/healthz probes; OTLP HTTP ingestion POST; MCP initialize/tools-list/resources-list via the official TypeScript SDK; signoz_get_field_keys; signoz_get_trace_details; signoz_execute_builder_query raw with custom-attribute selectFields; signoz_create_view -> signoz_get_view -> signoz_list_views -> signoz_delete_view; TypeScript 7.0.2 strict typecheck; Next.js 16 + React 19 + TypeScript 7 typecheck; OpenTelemetry semantic-conventions export enumeration
TEST RESULT: passed 16, failed 0, skipped 0. Six defects were found and resolved during the phase (image pinning, OTLP ordering, login endpoint, trace-attribute retrieval, create-view argument shape, in-memory exporter ordering); all are recorded in the source lock and the relevant ADR.
RUNTIME VALIDATION: SigNoz v0.134.0, collector v0.144.6 and MCP server v0.9.0 deployed from a pinned casting and observed healthy. A real 5-span OpenTelemetry trace (trace 228cc4802f7b26ef44ac2a924841a047) was emitted over OTLP/HTTP, ingested, and retrieved back through the SigNoz MCP Server with all span identities, parent linkage and custom attributes intact. A saved view was created through MCP, read back by ID, field-compared against its specification, listed, and deleted.
EVIDENCE: docs/evidence/phase-00-plan.md; docs/evidence/phase-00-result.md; docs/evidence/phase-00/; docs/research/source-lock.md; docs/research/compatibility-matrix.md; docs/research/mcp-capabilities.json; docs/research/otel-attributes.md; docs/adr/0001-0004
KNOWN LIMITATIONS: five, listed above. None blocks Phase 01.
NEXT PHASE ENTRY CRITERIA: SATISFIED
```
