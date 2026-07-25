# Compatibility matrix

Verified on **2026-07-25**. Every "Verified how" entry of `runtime` means the value was read
from the running process, the installed package, or a live API response — not from documentation
or memory.

## Build and run environment

| Component | Pinned value | Verified how | Source lock |
|---|---|---|---|
| Operating system | macOS 27.0 (Darwin 27.0.0), build 26A5388g | `sw_vers`, `uname -a` | — |
| Architecture | `arm64` (Apple silicon, T6000) | `arch`, `uname -a` | — |
| CPU / memory | 8 cores / 32 GiB | `sysctl hw.ncpu`, `hw.memsize` | — |
| Node.js | 24.14.1 (LTS line "Krypton") | `node --version`, runtime | SL-026 |
| npm | 11.12.1 | `npm --version` | SL-026 |
| pnpm | 10.33.0 | `pnpm --version`, runtime | SL-027 |
| corepack | 0.34.6 | `corepack --version` | — |
| Git | 2.50.1 (Apple Git-155) | `git --version` | — |
| Docker Engine | 29.6.1 | `docker --version`, daemon reachable | — |
| Docker Compose | v5.3.0 | `docker compose version` | — |
| Claude Code CLI | 2.1.206 | `claude --version` | SL-035 |

## SigNoz stack (deployed by Foundry, images explicitly pinned)

| Component | Pinned image | Version | Verified how | Source lock |
|---|---|---|---|---|
| Foundry CLI | — | `v0.2.16` (commit `9fdfe4e`, Go 1.25.3) | `foundryctl version` | SL-003, SL-004 |
| SigNoz apiserver / UI | `signoz/signoz:v0.134.0` | v0.134.0 | `GET /api/v1/version` → `{"version":"v0.134.0","ee":"Y"}` | SL-001 |
| SigNoz OTel Collector (ingester) | `signoz/signoz-otel-collector:v0.144.6` | v0.144.6 | container `Up`, OTLP HTTP 200 | SL-009, SL-010 |
| SigNoz MCP Server | `signoz/signoz-mcp-server:v0.9.0` | v0.9.0 | MCP `initialize` → `serverInfo.version` `v0.9.0` | SL-015 |
| ClickHouse server | `clickhouse/clickhouse-server:25.12.5` | 25.12.5 | Foundry default, container healthy | SL-005 |
| ClickHouse Keeper | `clickhouse/clickhouse-keeper:25.12.5` | 25.12.5 | Foundry default, container healthy | SL-005 |
| SigNoz metastore | `postgres:16` | 16 | Foundry default, container healthy | SL-005 |

Foundry pins ClickHouse, ClickHouse Keeper and Postgres itself. It defaults SigNoz, the
collector and the MCP server to `:latest`; FlightRules overrides all three with explicit
`image:` values because `version:` alone does not change the generated image tag (SL-006).

## Published ports

| Port | Purpose | Verified how | Source lock |
|---|---|---|---|
| 8080 | SigNoz UI and HTTP API | `GET /api/v1/health` → `{"status":"ok"}` | SL-009 |
| 4317 | OTLP gRPC ingestion | listener bound inside the collector container | SL-009, SL-010 |
| 4318 | OTLP HTTP ingestion | `POST /v1/traces` → HTTP 200 `{"partialSuccess":{}}` | SL-009, SL-010 |
| 8000 | SigNoz MCP Server (HTTP transport) | `/livez` 200, `/readyz` 200 `ok` | SL-017 |

ClickHouse (9000/8123), ClickHouse Keeper (9181) and Postgres (5432) are **not** published to
the host by the Compose flavor.

## MCP protocol and capabilities

| Property | Value | Verified how |
|---|---|---|
| MCP protocol version negotiated | `2025-06-18` | live `initialize` response |
| Server name / version | `SigNozMCP` / `v0.9.0` | live `initialize` response |
| Server capabilities | `logging`, `prompts`, `resources`, `tools` | live `initialize` response |
| Tools exposed | 41 | live `tools/list` |
| Resources exposed | 19 | live `resources/list` |
| Transport | Streamable HTTP at `/mcp` | live |
| Authentication | per-request `SIGNOZ-API-KEY` header | live |

### PRD-required tools (section 16.4) versus installed surface

All 22 required tools are present at v0.9.0.

| PRD-required tool | Present | Notes |
|---|---|---|
| `signoz_get_field_keys` | Yes | `fieldContext` accepts `attribute`; `tag` is an alias (SL-022) |
| `signoz_get_field_values` | Yes | |
| `signoz_search_traces` | Yes | fixed column set; no field selection |
| `signoz_get_trace_details` | Yes | fixed column set; **no custom attributes** (SL-020) |
| `signoz_aggregate_traces` | Yes | |
| `signoz_search_logs` | Yes | |
| `signoz_list_services` | Yes | |
| `signoz_list_views` | Yes | `sourcePage` required |
| `signoz_get_view` | Yes | |
| `signoz_create_view` | Yes | flat arguments, not a nested `view` object (SL-023) |
| `signoz_update_view` | Yes | full replace; fetch first |
| `signoz_list_dashboards` | Yes | |
| `signoz_get_dashboard` | Yes | |
| `signoz_create_dashboard` | Yes | requires `title`, `layout`, `widgets` |
| `signoz_update_dashboard` | Yes | full replace |
| `signoz_list_alert_rules` | Yes | requires SigNoz ≥ 0.120.0 (SL-016) |
| `signoz_get_alert` | Yes | |
| `signoz_create_alert` | Yes | requires `alert`, `alertType`, `ruleType`, `condition` |
| `signoz_update_alert` | Yes | full replace |
| `signoz_get_alert_history` | Yes | requires SigNoz ≥ 0.118.0; `state` enum includes `firing` and `recovering` (SL-024) |
| `signoz_list_notification_channels` | Yes | |
| `signoz_execute_builder_query` | Yes | the primary trace-retrieval path (SL-021) |

Additional tools available beyond the PRD's minimum: `signoz_aggregate_logs`,
`signoz_check_metric_cardinality`, `signoz_check_metric_usage`, `signoz_delete_alert`,
`signoz_delete_dashboard`, `signoz_delete_notification_channel`, `signoz_delete_view`,
`signoz_fetch_doc`, `signoz_get_notification_channel`, `signoz_get_service_top_operations`,
`signoz_get_top_metrics`, `signoz_import_dashboard`, `signoz_list_alerts`,
`signoz_list_dashboard_templates`, `signoz_list_metrics`, `signoz_query_metrics`,
`signoz_search_docs`, `signoz_create_notification_channel`, `signoz_update_notification_channel`.

### Minimum SigNoz version floor

| Capability | Minimum SigNoz | Pinned SigNoz satisfies |
|---|---|---|
| Alert history | 0.118.0 | Yes (0.134.0) |
| Alert rule CRUD | 0.120.0 | Yes |
| Metric usage lookup | 0.131.0 | Yes |
| **FlightRules declared floor** | **0.131.0** | Yes |

FlightRules refuses to sync artefacts against a SigNoz below the declared floor and reports a
capability failure rather than degrading silently.

## Application stack

| Package | Pinned | Licence | Verified how | Source lock |
|---|---|---|---|---|
| typescript | 7.0.2 | Apache-2.0 | strict typecheck exit 0 | SL-033 |
| next | 16.2.11 | MIT | App Router typecheck exit 0 | SL-033 |
| react / react-dom | 19.2.8 | MIT | typecheck exit 0 | SL-033 |
| fastify | 5.10.0 | MIT | registry | SL-034 |
| drizzle-orm | 0.45.2 | Apache-2.0 | registry | SL-034 |
| drizzle-kit | 0.31.10 | MIT | registry | SL-034 |
| zod | 4.4.3 | MIT | registry | SL-034 |
| pino | 10.3.1 | MIT | registry | SL-034 |
| vitest | 4.1.10 | MIT | registry | SL-034 |
| fast-check | 4.9.0 | MIT | registry | SL-034 |
| @playwright/test | 1.62.0 | Apache-2.0 | registry | SL-034 |
| ajv | 8.20.0 | MIT | registry | SL-034 |
| js-yaml | 5.2.2 | MIT | registry | SL-034 |
| @modelcontextprotocol/sdk | 1.29.0 | MIT | live MCP session | SL-028 |
| @opentelemetry/api | 1.9.1 | Apache-2.0 | live span emission | SL-029 |
| @opentelemetry/sdk-trace-node | 2.10.0 | Apache-2.0 | live span emission | SL-029 |
| @opentelemetry/sdk-trace-base | 2.10.0 | Apache-2.0 | live span emission | SL-029 |
| @opentelemetry/sdk-metrics | 2.10.0 | Apache-2.0 | registry | SL-029 |
| @opentelemetry/resources | 2.10.0 | Apache-2.0 | live span emission | SL-029 |
| @opentelemetry/semantic-conventions | 1.43.0 | Apache-2.0 | export enumeration | SL-029, SL-030 |
| @opentelemetry/sdk-node | 0.221.0 | Apache-2.0 | registry | SL-029 |
| @opentelemetry/exporter-trace-otlp-http | 0.221.0 | Apache-2.0 | live OTLP export | SL-029 |
| @opentelemetry/exporter-metrics-otlp-http | 0.221.0 | Apache-2.0 | registry | SL-029 |
| @opentelemetry/exporter-logs-otlp-http | 0.221.0 | Apache-2.0 | registry | SL-029 |
| @opentelemetry/sdk-logs | 0.221.0 | Apache-2.0 | registry | SL-029 |
| @opentelemetry/api-logs | 0.221.0 | Apache-2.0 | registry | SL-029 |
| @opentelemetry/instrumentation-http | 0.221.0 | Apache-2.0 | registry | SL-029 |
| @opentelemetry/instrumentation-pino | 0.67.0 | Apache-2.0 | registry | SL-029 |
| @opentelemetry/auto-instrumentations-node | 0.79.0 | Apache-2.0 | registry | SL-029 |

## Licences of deployed third-party services

| Project | Licence | Distribution note |
|---|---|---|
| SigNoz | MIT Expat, except `ee/` and `cmd/enterprise/` under the SigNoz Enterprise License | Deployed as an unmodified upstream image. No source vendored or redistributed. |
| SigNoz Foundry | AGPL-3.0 | Used as an unmodified CLI. Not linked into or redistributed with FlightRules. |
| SigNoz OTel Collector | AGPL-3.0 | Deployed as an unmodified upstream image. |
| SigNoz MCP Server | Apache-2.0 | Deployed as an unmodified upstream image. |
| ClickHouse | Apache-2.0 | Upstream image. |
| PostgreSQL | PostgreSQL License | Upstream image. |

No AGPL code is copied into, statically linked with, or redistributed as part of FlightRules.
FlightRules communicates with these services over documented network interfaces only.

## Known incompatibilities and behaviours to design around

| Finding | Impact | Mitigation | Source lock |
|---|---|---|---|
| `version:` alone does not pin the container image tag | A casting that looks pinned silently deploys `latest` | Always set `image:` as well; reproducibility check asserts the tag in the generated Compose file | SL-006 |
| OTLP receivers do not bind until SigNoz setup completes | Telemetry silently vanishes; a TCP port check reports a false positive | Complete first-user setup before any demo run; verify with a real OTLP POST, never a bare TCP connect | SL-010 |
| Unmatched SigNoz API paths return the SPA shell with HTTP 200 | Status-code-only checks give false positives | All direct HTTP checks assert on the response body | SL-012 |
| `signoz_get_trace_details` cannot return custom span attributes | Insufficient alone for trajectory reconstruction | Use `signoz_execute_builder_query` with `selectFields` as the primary path | SL-020, SL-021 |
| `signoz_create_view` takes flat arguments, not a nested object | Nested payload fails validation | Client spreads the specification into the tool arguments | SL-023 |
| All `gen_ai.*` attributes are experimental | Names may change between semconv releases | Imported from the incubating entry point, marked experimental in the register, never the sole basis of a critical rule | SL-030 |
| `vcs.commit.sha` is not a released convention | PRD name and OTel name differ | Emit both `vcs.ref.head.revision` and `vcs.commit.sha` | SL-031 |
