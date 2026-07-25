# Source lock

Every external technical claim that FlightRules depends on is recorded here with its source,
the pinned version or commit, the access date, the verified claim, the implementation
consequence, the local file it affects, and whether the claim was confirmed against the
installed runtime.

Source hierarchy used, in order (PRD section 2.2):

1. Installed runtime schema, generated OpenAPI schema, MCP tool discovery output, or source at the pinned commit.
2. Official versioned documentation for the installed version.
3. Official repository documentation at the pinned commit.
4. Official latest documentation, only when versioned documentation is unavailable.
5. Maintainer issue or pull request, clearly marked unstable.

No blog post, tutorial, forum answer, copied snippet or model memory is the sole basis for any
entry below.

Access date for every entry: **2026-07-25** unless stated otherwise.

---

## SL-001 — SigNoz latest stable release

- Source: `https://api.github.com/repos/SigNoz/signoz/releases/latest` (tier 1, official release metadata)
- Pinned: `v0.134.0`, repository commit `8c6a0de8c36e7982099437bfe2476c1a4ccbc553`, published 2026-07-22T13:23:58Z
- Verified claim: `v0.134.0` is the latest non-prerelease SigNoz release. The image `signoz/signoz:v0.134.0` exists on Docker Hub (pushed 2026-07-22T13:32:54).
- Runtime confirmation: **Yes.** `GET http://localhost:8080/api/v1/version` returned `{"version":"v0.134.0","ee":"Y","setupCompleted":...}` from the deployed container.
- Implementation consequence: `spec.signoz.spec.image` is pinned to `signoz/signoz:v0.134.0`.
- Local file: `casting.yaml` (Phase 02).

## SL-002 — SigNoz licence composition

- Source: `https://raw.githubusercontent.com/SigNoz/signoz/8c6a0de8c36e7982099437bfe2476c1a4ccbc553/LICENSE` and `ee/LICENSE` (tier 3, repository at pinned commit)
- Verified claim: SigNoz is MIT Expat except for `ee/` and `cmd/enterprise/`, which are under the SigNoz Enterprise License. The deployed image reports `"ee":"Y"`.
- Runtime confirmation: Yes, for the `ee` flag.
- Implementation consequence: FlightRules **deploys** SigNoz as a separate container and does not vendor, fork, or redistribute SigNoz source or images. No SigNoz code is copied into this repository. Recorded in the third-party notices.
- Local file: `docs/THREAT_MODEL.md`, `README.md` licences section.

## SL-003 — Foundry CLI installation

- Source: `https://github.com/SigNoz/foundry/blob/v0.2.16/docs/getting-started.md` (tier 3, pinned commit `9fdfe4ef0f195c6a52504937f2f79bfddfdbe542`)
- Verified claim: the official install path is `curl -fsSL https://signoz.io/foundry.sh | bash`, which detects OS and architecture, verifies the download checksum, and installs into `$XDG_BIN_HOME` or `~/.local/bin`. `FOUNDRY_VERSION` pins a specific release.
- Runtime confirmation: **Yes.** The script installed `foundryctl v0.2.16` to `/Users/mac/.local/bin/foundryctl`. `foundryctl version` reports `Version: v0.2.16`, `Commit: 9fdfe4e`, `Go: go1.25.3`.
- Implementation consequence: bootstrap and README use the official script with `FOUNDRY_VERSION=v0.2.16`.
- Local file: `scripts/bootstrap.sh`, `README.md`.

## SL-004 — Foundry CLI command surface

- Source: installed binary `foundryctl --help` (tier 1)
- Verified claim: available commands are `cast`, `catalog`, `forge`, `gauge`, `gen`, `help`, `version`. Global flags include `-f/--file`, `-p/--pours`, `--format json|text`, `--no-ledger`, `--no-updater`, `-d/--debug`. There is **no** `--version` flag; the subcommand is `foundryctl version`.
- Runtime confirmation: Yes.
- Implementation consequence: scripts call `foundryctl version`, never `foundryctl --version`. `--no-ledger` is set in automated scripts so reproducibility checks do not emit anonymous usage telemetry.
- Local file: `scripts/verify-signoz.sh`, `Makefile`.

## SL-005 — Foundry casting schema for an Installation

- Source: `api/v1alpha1/installation/casting.schema.json` at Foundry commit `9fdfe4ef0f195c6a52504937f2f79bfddfdbe542` (tier 1, generated schema shipped with the pinned release)
- Verified claim:
  - Top level is `apiVersion`, `kind`, `metadata`, `spec`, `status`.
  - `spec` requires `deployment` and optionally accepts `infrastructure`, `ingester`, `mcp`, `metastore`, `patches`, `signoz`, `telemetrykeeper`, `telemetrystore`. `additionalProperties` is `false`.
  - `spec.deployment.mode` is one of `docker`, `systemd`, `kubernetes`, `ec2`.
  - `spec.deployment.flavor` is one of `compose`, `swarm`, `binary`, `kustomize`, `helm`, `blueprint`, `stack`, `template`, `terraform`.
  - Every molding uses `V1Alpha1MoldingSpec`, which accepts `cluster`, `config`, `enabled`, `env`, `image` and `version`. `image` is pattern-constrained and accepts a `:tag` or `@sha256:` digest.
- Runtime confirmation: Yes — a casting written against this schema passed `foundryctl gauge` and `foundryctl forge` with exit code 0.
- Implementation consequence: the PRD's illustrative casting snippet (section 16.2) is structurally correct and was **not** copied blindly; it was reconciled against this schema before use.
- Local file: `casting.yaml`.

## SL-006 — Foundry `version` does not pin the container image tag

- Source: installed `foundryctl v0.2.16` behaviour (tier 1, runtime)
- Verified claim: setting only `spec.<molding>.spec.version: v0.134.0` records `version: v0.134.0` in `casting.yaml.lock` but leaves the generated Compose file using `image: signoz/signoz:latest`. Setting `spec.<molding>.spec.image: signoz/signoz:v0.134.0` **does** produce `image: signoz/signoz:v0.134.0` in `pours/deployment/compose.yaml`.
- Runtime confirmation: **Yes.** Observed directly: first forge produced `image: signoz/signoz-otel-collector:latest` alongside `version: v0.144.6`; after adding explicit `image:` fields the compose file contained `signoz/signoz:v0.134.0`, `signoz/signoz-otel-collector:v0.144.6` and `signoz/signoz-mcp-server:v0.9.0`.
- Implementation consequence: the committed casting sets **both** `image` and `version` on every pinnable molding. `version` alone would silently produce a floating `latest` deployment and break reproducibility. Recorded as ADR-0002.
- Local file: `casting.yaml`, `docs/adr/0002-signoz-deployment-and-pinning.md`.

## SL-007 — `casting.yaml.lock` generation and stability

- Source: installed `foundryctl v0.2.16` behaviour (tier 1, runtime)
- Verified claim: `foundryctl forge -f casting.yaml` writes `casting.yaml.lock` next to the casting and the `pours/` tree. Running `forge` a second time against an unchanged casting produces a byte-identical lock file (`sha256 e525ab44b134ced71fa1f418c0ac14cd41fcbcba2a0a0b8fbc1cc636d3fc1c48` both times).
- Runtime confirmation: Yes.
- Implementation consequence: the lock file is committed and a reproducibility check re-forges and diffs it.
- Local file: `casting.yaml.lock`, `scripts/verify-reproducibility.sh`.

## SL-008 — Foundry MCP molding enablement

- Source: `docs/concepts/mcp-server.md` and `docs/examples/docker/compose-mcp/casting.yaml` at Foundry commit `9fdfe4ef0f195c6a52504937f2f79bfddfdbe542` (tier 3)
- Verified claim: the MCP server is a Foundry molding, disabled by default, enabled with
  ```yaml
  spec:
    mcp:
      spec:
        enabled: true
  ```
  The molding then sets `TRANSPORT_MODE=http`, `MCP_SERVER_PORT=8000` and `SIGNOZ_URL` pointing at the co-located apiserver, and publishes port `8000`. Foundry deliberately does **not** put the SigNoz API key in the casting; the client sends a `SIGNOZ-API-KEY` header per request.
- Runtime confirmation: **Yes.** The generated `pours/deployment/compose.yaml` contains service `signoz-mcp` with `MCP_SERVER_PORT=8000`, `SIGNOZ_URL=http://signoz-signoz-0:8080`, `TRANSPORT_MODE=http` and `ports: - 8000:8000`.
- Implementation consequence: FlightRules holds the API key server-side and sends it as a request header. No secret enters `casting.yaml`.
- Local file: `casting.yaml`, `packages/signoz-mcp`.

## SL-009 — Ports published by the Docker Compose flavor

- Source: generated `pours/deployment/compose.yaml` from `foundryctl forge` (tier 1)
- Verified claim: `ingester` publishes `4317:4317` (OTLP gRPC) and `4318:4318` (OTLP HTTP); `signoz-mcp` publishes `8000:8000`; `signoz-signoz-0` publishes `8080:8080` (UI and API). ClickHouse, ClickHouse Keeper and Postgres are **not** published to the host.
- Runtime confirmation: Yes — `docker port signoz-ingester-1` reported `4317/tcp -> 0.0.0.0:4317` and `4318/tcp -> 0.0.0.0:4318`.
- Implementation consequence: FlightRules defaults are `SIGNOZ_URL=http://localhost:8080`, `SIGNOZ_MCP_URL=http://localhost:8000/mcp`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`.
- Local file: `.env.example`.

## SL-010 — OTLP receivers bind only after SigNoz setup is completed

- Source: installed runtime behaviour of `signoz-otel-collector v0.144.6` and `signoz v0.134.0` (tier 1)
- Verified claim: immediately after `foundryctl cast`, ports 4317 and 4318 accept a TCP connection through the Docker userland proxy but the collector process is **not** listening on them; any payload is answered with a connection reset. The collector logs repeat `opamp/server_client.go:146 Server returned an error response` every 30 seconds. Inspecting `/proc/net/tcp6` inside the collector container showed only ports 1777 (pprof) and 13133 (health check) bound. After `POST /api/v1/register` created the first organisation and user (`setupCompleted` flipped from `false` to `true`), the same inspection showed 1777, 13133, **4317 and 4318** bound, the OpAMP errors stopped, and `POST http://127.0.0.1:4318/v1/traces` returned HTTP 200 with `{"partialSuccess":{}}`.
- Runtime confirmation: **Yes**, both the failing and the working state were observed.
- Implementation consequence: this is a hard ordering requirement. The collector receives its effective pipeline configuration from the SigNoz apiserver over OpAMP, so **no telemetry can be ingested until the SigNoz first-user setup has completed**. The bootstrap script, the runbook and `scripts/verify-signoz.sh` must complete setup before starting the demo, and readiness checks must probe an actual OTLP POST rather than a bare TCP connect. A TCP port check alone is a false positive.
- Local file: `scripts/verify-signoz.sh`, `docs/RUNBOOK.md`.

## SL-011 — SigNoz first-user registration endpoint

- Source: running SigNoz `v0.134.0` (tier 1, runtime) corroborated by the generated OpenAPI schema
- Verified claim: `POST /api/v1/register` with `{"name","orgId","orgName","email","password"}` creates the first organisation and root user, returning `{"status":"success","data":{"id","displayName","email","orgId","isRoot":true,"status":"active",...}}` with HTTP 200. `GET /api/v1/version` then reports `"setupCompleted":true`.
- Runtime confirmation: Yes.
- Implementation consequence: the bootstrap script performs first-user registration idempotently and captures the returned `orgId`, which is required by the login call.
- Local file: `scripts/bootstrap.sh`.

## SL-012 — SigNoz login endpoint requires `orgID`

- Source: SigNoz `v0.134.0` generated OpenAPI schema and runtime (tier 1)
- Verified claim: `POST /api/v1/login` **does not exist** in v0.134.0 — the path falls through to the SPA and returns HTML with HTTP 200. The real endpoint is `POST /api/v2/sessions/email_password`. Calling it with only `{"email","password"}` returns HTTP 400 `{"error":{"code":"invalid_input","message":"orgID is required"}}`. Adding `orgID` returns `{"status":"success","data":{"tokenType":"bearer","accessToken":"…","refreshToken":"…"}}`.
- Runtime confirmation: Yes, including the failing case.
- Implementation consequence: any script that authenticates as a human user must first know the organisation ID. A 200 response is not sufficient evidence of success against this server because unmatched API paths return the SPA shell with HTTP 200; scripts must assert on the response body, not the status code.
- Local file: `scripts/bootstrap.sh`, `scripts/verify-signoz.sh`.

## SL-013 — SigNoz generates its own OpenAPI schema

- Source: installed `signoz v0.134.0` container (tier 1)
- Verified claim: the shipped binary exposes `signoz generate openapi`, which writes `docs/api/openapi.yml` relative to the working directory. Running it inside the deployed container produced a 750,482-byte OpenAPI 3 document describing every registered route and schema.
- Runtime confirmation: Yes.
- Implementation consequence: this is the authoritative source for any direct SigNoz HTTP call. It is used only for the bootstrap and verification scripts; all **product** reads and writes go through MCP (PRD section 12.4).
- Local file: `scripts/bootstrap.sh`, `docs/adr/0003-signoz-access-boundary.md`.

## SL-014 — SigNoz API keys are issued through service accounts

- Source: SigNoz `v0.134.0` generated OpenAPI schema and runtime (tier 1)
- Verified claim:
  - `POST /api/v1/service_accounts` with `{"name": string}` returns HTTP 201 and `{"data":{"id": uuid}}`.
  - `GET /api/v1/roles` lists the managed roles `signoz-admin`, `signoz-editor`, `signoz-viewer`, `signoz-anonymous`.
  - `POST /api/v1/service_account_roles` with `{"serviceAccountId","roleId"}` returns HTTP 201 and assigns the role. The alternative `POST /api/v1/service_accounts/{id}/roles` with `{"id"}` is marked `deprecated: true` in the schema.
  - `POST /api/v1/service_accounts/{id}/keys` with `{"name": string, "expiresAt": integer}` returns HTTP 201 and `{"data":{"id","key"}}`. The `key` value is 44 characters and is the value sent as the `SIGNOZ-API-KEY` header.
  - `GET /api/v1/service_account_roles` is **not** registered as a GET route; it returns the SPA shell.
- Runtime confirmation: Yes, all of the above were executed against the running instance.
- Implementation consequence: bootstrap creates one service account named `flightrules-mcp`, assigns `signoz-admin` (required because FlightRules creates dashboards, saved views, alerts and notification channels), mints one key, and writes it only to the operator's local `.env`. The key is never committed, logged, or sent to the browser. The privilege choice is recorded in the threat model.
- Local file: `scripts/bootstrap.sh`, `docs/THREAT_MODEL.md`.

## SL-015 — SigNoz MCP Server release and licence

- Source: `https://api.github.com/repos/SigNoz/signoz-mcp-server` releases and tags (tier 1)
- Pinned: `v0.9.0`, commit `66af322c02d9a804f11c5184753a97031b9cd1f7`, published 2026-07-22T05:32:08Z. Licence Apache-2.0.
- Verified claim: `v0.9.0` is the latest release; the image `signoz/signoz-mcp-server:v0.9.0` exists on Docker Hub.
- Runtime confirmation: **Yes.** MCP `initialize` returned `"serverInfo":{"name":"SigNozMCP","version":"v0.9.0"}`.
- Implementation consequence: `spec.mcp.spec.image` is pinned to `signoz/signoz-mcp-server:v0.9.0`.
- Local file: `casting.yaml`.

## SL-016 — SigNoz MCP Server minimum SigNoz versions

- Source: `README.md` at signoz-mcp-server commit `66af322c02d9a804f11c5184753a97031b9cd1f7` (tier 3)
- Verified claim: alert-rule list/get/create/update/delete require SigNoz **v0.120.0 or newer**; `signoz_get_alert_history` requires **v0.118.0 or newer**; `signoz_check_metric_usage` requires **v0.131.0 or newer**. Notification-channel tools target the `/api/v1/channels/*` render-envelope routes.
- Runtime confirmation: Indirect — the pinned SigNoz v0.134.0 exceeds every stated minimum, and the alert, view and dashboard tools were all present and callable.
- Implementation consequence: the compatibility page asserts `signoz >= 0.131.0` as the FlightRules floor. Below that floor the artifact compiler must report a capability failure, not degrade silently.
- Local file: `docs/research/compatibility-matrix.md`, `packages/signoz-mcp`.

## SL-017 — SigNoz MCP Server HTTP probes

- Source: `README.md` at signoz-mcp-server commit `66af322c02d9a804f11c5184753a97031b9cd1f7` (tier 3) plus runtime
- Verified claim: HTTP mode exposes unauthenticated `/livez` (shallow liveness), `/readyz` (ready only once the docs index is ready, otherwise 503) and legacy `/healthz` (same strictness as `/readyz`).
- Runtime confirmation: **Yes.** `/livez` returned 200, `/readyz` returned 200 with body `ok`, `/healthz` returned 200.
- Implementation consequence: setup step 2 of `/setup` probes `/livez` then `/readyz` and reports them separately.
- Local file: `apps/api` setup route, `scripts/verify-signoz.sh`.

## SL-018 — SigNoz MCP Server authentication in HTTP mode

- Source: `docs/concepts/mcp-server.md` (Foundry, pinned) and signoz-mcp-server `README.md` (pinned), tier 3, plus runtime
- Verified claim: with `SIGNOZ_URL` set on the server and no `SIGNOZ_API_KEY`, the client supplies the key per request as a `SIGNOZ-API-KEY` header. This is the mode Foundry configures.
- Runtime confirmation: **Yes.** MCP `initialize` and every subsequent tool call succeeded with the header set.
- Implementation consequence: FlightRules passes `SIGNOZ-API-KEY` in `requestInit.headers` of the Streamable HTTP transport. The browser never receives it.
- Local file: `packages/signoz-mcp`.

## SL-019 — Complete SigNoz MCP tool surface at v0.9.0

- Source: live MCP `tools/list` through the official MCP TypeScript SDK (tier 1)
- Verified claim: the server exposes **41 tools**. Every one of the 22 tools the PRD section 16.4 expects exists with exactly the expected name. The negotiated MCP protocol version was `2025-06-18`. Server capabilities are `logging`, `prompts`, `resources`, `tools`. Nineteen MCP resources are exposed, including `signoz://traces/query-builder-guide`, `signoz://view/instructions`, `signoz://dashboard/instructions` and `signoz://alert/instructions`.
- Runtime confirmation: Yes. Full snapshot including every input and output schema is stored verbatim.
- Implementation consequence: capability discovery compares the live tool list against the required set and raises `MCP_TOOL_MISSING` for anything absent.
- Local file: `docs/research/mcp-capabilities.json`, `packages/signoz-mcp`.

## SL-020 — `signoz_get_trace_details` returns a fixed column set

- Source: live MCP tool input schema and an actual call (tier 1)
- Verified claim: `signoz_get_trace_details` accepts only `traceId` (required), `start`, `end`, `timeRange` and `includeSpans`. It has **no** field-selection parameter. The rows it returns carry a fixed built-in column set: `trace_id`, `span_id`, `parent_span_id`, `name`, `kind`, `kind_string`, `duration_nano`, `has_error`, `status_code`, `status_code_string`, `status_message`, `timestamp`, `service.name`, `service.version`, plus a fixed list of well-known HTTP, DB, RPC, cloud and Kubernetes attributes. **Custom span attributes are not included.**
- Runtime confirmation: Yes — a trace carrying `agent.side_effect` and `agent.release.id` was retrieved and neither attribute appeared in the response.
- Implementation consequence: `signoz_get_trace_details` alone is **insufficient** for FlightRules. See SL-021.
- Local file: `docs/adr/0003-signoz-access-boundary.md`.

## SL-021 — Custom span attributes are retrievable through `signoz_execute_builder_query`

- Source: live MCP resource `signoz://traces/query-builder-guide` and an actual call (tier 1)
- Verified claim: `signoz_execute_builder_query` accepts a full Query Builder v5 request. With `requestType: "raw"` and a `selectFields` array, arbitrary span attributes can be selected using `fieldContext: "tag"`, resource attributes using `fieldContext: "resource"`, and built-in columns using `fieldContext: "span"`. `start` and `end` are Unix **milliseconds**. Every `builder_query` must carry a positive `limit` and a non-empty `order`. Filters are a **string** expression in `filter.expression`, not a structured object; unknown keys hard-error.
- Runtime confirmation: **Yes.** A raw query filtered on `trace_id = '<id>'` with `selectFields` including `{"name":"agent.side_effect","fieldContext":"tag"}` and `{"name":"agent.release.id","fieldContext":"tag"}` returned all 5 spans of the probe trace with correct `span_id`, `parent_span_id`, and both custom attribute values (`write`/`read`, `phase00-probe-v1`).
- Implementation consequence: this is the **primary** trace-retrieval path for FlightRules. `signoz_get_trace_details` is used as a corroborating fetch for hierarchy and quality checks. Both are officially supported MCP tools, so no direct ClickHouse access is required and PRD section 12.4 is satisfied. Recorded as ADR-0003.
- Local file: `packages/signoz-mcp`, `packages/trace-graph`.

## SL-022 — Custom attribute keys are discoverable

- Source: live MCP call to `signoz_get_field_keys` (tier 1)
- Verified claim: `signoz_get_field_keys(signal="traces", fieldContext="attribute", searchText="agent")` returned `agent.release.id`, `agent.run.id` and `agent.side_effect`, each with `fieldDataType: "string"` and `"complete": true`. The discovery tools accept `"tag"` as an alias for `"attribute"`; Query Builder `selectFields` and `groupBy` require `"tag"`.
- Runtime confirmation: Yes.
- Implementation consequence: agent registration uses field discovery to populate selector suggestions rather than hard-coding attribute names, and the `fieldContext` alias difference is handled explicitly in the client.
- Local file: `packages/signoz-mcp`.

## SL-023 — MCP write, read-back and delete verified for saved views

- Source: live MCP calls (tier 1)
- Verified claim: `signoz_create_view` takes **flat** arguments (`name`, `sourcePage`, `compositeQuery` required; `category`, `tags`, `extraData` optional) — it does **not** take a nested `view` object; passing one produced `Parameter validation failed: "name" cannot be empty`. A successful create returns `{"data":{"id": uuid}}`. `signoz_get_view` by that ID returned the stored view with `name`, `sourcePage` and `compositeQuery.queries[0].spec.filter.expression` byte-identical to the submitted specification. `signoz_list_views(sourcePage:"traces")` included it. `signoz_delete_view` removed it. `signoz_update_view` replaces the whole resource (upstream PUT) and requires fetching first.
- Runtime confirmation: **Yes**, the whole create → read-back → compare → list → delete cycle was executed and the field comparison returned `true`.
- Implementation consequence: the artifact compiler's read-back verification contract is proven feasible against the pinned version. Partial update bodies are never sent.
- Local file: `packages/artifact-compiler`.

## SL-024 — Alert history exposes firing and recovery states

- Source: live MCP tool input schema (tier 1)
- Verified claim: `signoz_get_alert_history` accepts a `state` parameter constrained to the enum `inactive`, `pending`, `recovering`, `firing`, `nodata`, `disabled`, plus `id`, `start`, `end`, `timeRange`, `filter`, `limit`, `cursor` and `order`.
- Runtime confirmation: Schema confirmed live. Actual firing and recovery observation is Phase 10 work.
- Implementation consequence: the PRD requirement to prove an alert fires **and** recovers is supported by the pinned version. Both states are asserted from alert history.
- Local file: `packages/artifact-compiler`.

## SL-025 — Notification channels must be verified before alert creation

- Source: live MCP tool schemas and `signoz://alert/instructions` (tier 1)
- Verified claim: `signoz_list_notification_channels` and `signoz_get_notification_channel` exist for name verification. `signoz_create_notification_channel` requires `type` and `name` and supports `webhook_url`, `slack_api_url`, `email_to`, `msteams_webhook_url`, `pagerduty_routing_key`, `opsgenie_api_key` and related fields, and sends a test notification on create. `signoz_create_alert` requires `alert`, `alertType`, `ruleType` and `condition`, and accepts `preferredChannels`.
- Runtime confirmation: Schemas confirmed live.
- Implementation consequence: the alert compiler lists channels and verifies every name in `preferredChannels` before creating an alert, satisfying PRD FR-015.
- Local file: `packages/artifact-compiler`.

## SL-026 — Node.js runtime

- Source: `node --version` on the build machine and `https://nodejs.org/dist/index.json` (tier 1)
- Verified claim: installed Node is **v24.14.1**. The 24.x line is an active LTS codenamed **Krypton** (latest 24.x at time of writing is v24.18.0). Every selected OpenTelemetry package declares `engines.node` of `^18.19.0 || >=20.6.0`, and `@modelcontextprotocol/sdk` declares `>=18`, so all are satisfied.
- Runtime confirmation: Yes — every proof script ran on this runtime.
- Implementation consequence: `engines.node` is `>=24.14.1 <25`, `.nvmrc` pins `24.14.1`, and CI uses the same major line.
- Local file: `package.json`, `.nvmrc`.

## SL-027 — Package manager

- Source: `pnpm --version` (tier 1)
- Verified claim: installed pnpm is **10.33.0**.
- Runtime confirmation: Yes — used to install every proof dependency.
- Implementation consequence: `packageManager` is `pnpm@10.33.0`; one canonical `pnpm-lock.yaml`; workspaces via `pnpm-workspace.yaml`.
- Local file: `package.json`, `pnpm-workspace.yaml`.

## SL-028 — MCP TypeScript SDK client API

- Source: installed `@modelcontextprotocol/sdk@1.29.0` (tier 1), licence MIT
- Verified claim: `Client` is imported from `@modelcontextprotocol/sdk/client/index.js` and `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk/client/streamableHttp.js`. The transport constructor takes `(new URL(url), { requestInit: { headers } })`. `client.connect(transport)` performs the handshake. `client.getServerVersion()`, `client.getServerCapabilities()`, `client.listTools()`, `client.listResources()`, `client.listResourceTemplates()`, `client.listPrompts()`, `client.readResource({uri})`, `client.callTool({name, arguments})` and `client.close()` all behave as used.
- Runtime confirmation: **Yes**, every listed method was called successfully against the real server.
- Implementation consequence: `packages/signoz-mcp` wraps exactly these APIs. Tool errors surface as `result.isError === true` with the message in `result.content[].text`; structured results arrive in `result.structuredContent`. Both paths are handled.
- Local file: `packages/signoz-mcp`.

## SL-029 — OpenTelemetry JavaScript packages

- Source: npm registry `latest` metadata plus the installed packages (tier 1), licence Apache-2.0
- Pinned: `@opentelemetry/api` 1.9.1; `@opentelemetry/sdk-trace-node`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/sdk-metrics`, `@opentelemetry/resources` 2.10.0; `@opentelemetry/sdk-node`, `@opentelemetry/sdk-logs`, `@opentelemetry/api-logs`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/exporter-metrics-otlp-http`, `@opentelemetry/exporter-logs-otlp-http`, `@opentelemetry/instrumentation-http`, `@opentelemetry/instrumentation-pino` 0.221.0; `@opentelemetry/auto-instrumentations-node` 0.79.0; `@opentelemetry/semantic-conventions` 1.43.0.
- Verified claim: the SDK 2.x API is used — `NodeTracerProvider` takes `{ resource, spanProcessors }` in its constructor, resources are built with `resourceFromAttributes(...)`, and a finished span exposes its parent as `span.parentSpanContext?.spanId`. `provider.forceFlush()` followed by `provider.shutdown()` flushes the OTLP batch; `InMemorySpanExporter.getFinishedSpans()` must be read **before** `shutdown()` because shutdown clears the exporter.
- Runtime confirmation: **Yes.** A 5-span trace was emitted, asserted in memory (correct names and parent linkage) and exported over OTLP/HTTP to the deployed collector.
- Implementation consequence: `packages/telemetry` uses this exact API surface. Tests read the in-memory exporter before shutdown.
- Local file: `packages/telemetry`.

## SL-030 — GenAI semantic conventions are experimental, not stable

- Source: installed `@opentelemetry/semantic-conventions@1.43.0` (tier 1)
- Verified claim: the stable entry point exports 659 symbols, of which **zero** are `gen_ai.*`. All 60 `gen_ai.*` attributes are exported only from `@opentelemetry/semantic-conventions/incubating`. `deployment.environment.name`, `service.instance.id` and every `vcs.*` attribute are likewise incubating. `service.name`, `service.version` and `error.type` **are** stable.
- Runtime confirmation: Yes, by enumerating the installed package exports.
- Implementation consequence: FlightRules uses `gen_ai.*` where the PRD requires it but records every one as **experimental** in the attribute register, imports them from the incubating entry point, and never makes a critical contract rule depend on an attribute whose absence cannot be distinguished from a convention change. Recorded as ADR-0004.
- Local file: `docs/research/otel-attributes.md`, `packages/telemetry`.

## SL-031 — `vcs.commit.sha` is not a released OpenTelemetry attribute

- Source: installed `@opentelemetry/semantic-conventions@1.43.0` incubating exports (tier 1)
- Verified claim: the released VCS attributes are `vcs.change.id`, `vcs.change.state`, `vcs.change.title`, `vcs.line_change.type`, `vcs.owner.name`, `vcs.provider.name`, `vcs.ref.base.*`, `vcs.ref.head.name`, **`vcs.ref.head.revision`**, `vcs.ref.head.type`, `vcs.ref.type`, `vcs.repository.*` and `vcs.revision_delta.direction`. There is **no** `vcs.commit.sha`.
- Runtime confirmation: Yes.
- Implementation consequence: the PRD section 17.2 names `vcs.commit.sha`. PRD principle 3 and section 17.1 both require released standard names where they exist. FlightRules therefore emits **both**: `vcs.ref.head.revision` as the released convention and `vcs.commit.sha` as the PRD-named demo attribute, so neither authority is weakened. Both are release-scoped and low cardinality. Recorded as ADR-0004.
- Local file: `docs/research/otel-attributes.md`, `packages/telemetry`.

## SL-032 — GenAI metric conventions

- Source: installed `@opentelemetry/semantic-conventions@1.43.0` incubating exports (tier 1)
- Verified claim: the released GenAI metric names are `gen_ai.client.operation.duration`, `gen_ai.client.operation.time_per_output_chunk`, `gen_ai.client.operation.time_to_first_chunk`, `gen_ai.client.token.usage`, `gen_ai.server.request.duration`, `gen_ai.server.time_per_output_token`, `gen_ai.server.time_to_first_token`. All are experimental.
- Runtime confirmation: Yes.
- Implementation consequence: FlightRules' own evaluator metrics use the `flight_rules.*` namespace required by PRD section 17.4 and do not attempt to reuse GenAI metric names.
- Local file: `docs/research/otel-attributes.md`.

## SL-033 — TypeScript, Next.js and React compatibility

- Source: npm registry metadata plus a real strict typecheck (tier 1)
- Pinned: `typescript@7.0.2`, `next@16.2.11`, `react@19.2.8`, `react-dom@19.2.8`.
- Verified claim: TypeScript 7.0.2 is the current `latest` dist-tag. A project with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules` and `nodenext` resolution typechecks cleanly. A Next.js 16.2.11 App Router project with React 19.2.8, `@types/react@19`, `moduleResolution: bundler` and the `next` TS plugin also typechecks cleanly with `tsc -p tsconfig.json` exit code 0.
- Runtime confirmation: **Yes**, both typechecks were executed and both exited 0.
- Implementation consequence: TypeScript 7.0.2 is pinned for the whole workspace. `skipLibCheck` stays on for third-party declaration files. Recorded as ADR-0001.
- Local file: `tsconfig.base.json`, `apps/web`.

## SL-034 — Remaining application dependencies

- Source: npm registry `latest` metadata (tier 1)
- Verified claim and pins: `fastify@5.10.0` (MIT), `drizzle-orm@0.45.2` (Apache-2.0), `drizzle-kit@0.31.10` (MIT), `zod@4.4.3` (MIT), `pino@10.3.1` (MIT), `vitest@4.1.10` (MIT, `engines.node ^20 || ^22 || >=24`), `fast-check@4.9.0` (MIT), `@playwright/test@1.62.0` (Apache-2.0), `ajv@8.20.0` (MIT), `js-yaml@5.2.2` (MIT). None is archived; every licence is permissive and compatible with an Apache-2.0 distribution.
- Runtime confirmation: partial at Phase 00 (registry metadata verified for all; installation and use verified per package in the phase that introduces it).
- Implementation consequence: these are the pinned versions used from Phase 01 onward. `drizzle-orm` stays on the stable `0.45.x` line rather than the `1.0.0-rc` dist-tag.
- Local file: `package.json`, workspace manifests.

## SL-035 — Claude Code MCP registration syntax

- Source: Foundry `docs/concepts/mcp-server.md` at the pinned commit, plus installed `claude` CLI 2.1.206 (tier 1/3)
- Verified claim: the documented command is
  `claude mcp add --transport http signoz-local http://localhost:8000/mcp --header "SIGNOZ-API-KEY: <your-key>"`,
  with `--scope` accepted before the name.
- Runtime confirmation: the CLI is installed at version 2.1.206. The command is documented in the runbook for developer use; it is not executed automatically because it writes to developer-level configuration outside this repository.
- Implementation consequence: documented in the runbook as an optional developer convenience. FlightRules itself never depends on Claude Code's MCP registration; the product connects through its own MCP client.
- Local file: `docs/RUNBOOK.md`.
