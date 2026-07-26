# Third-party notices

FlightRules is licensed under the Apache License 2.0. See [LICENSE](LICENSE).

This document records what FlightRules **deploys**, what it **depends on**, and why the licence of
each is compatible with redistributing this repository under Apache-2.0.

---

## Containers FlightRules deploys, unmodified, from upstream registries

FlightRules deploys these through Foundry from the committed `casting.yaml`, at the exact tags in
`casting.yaml.lock` and `pours/deployment/compose.yaml`. Every one runs as an **unmodified upstream
release**, in its own process, communicating over documented network interfaces. No code from any of
them is copied into, linked with, statically bound to, or redistributed as part of this repository.

| Image | Version | Licence | Role |
|---|---|---|---|
| `signoz/signoz` | `v0.134.0` | MIT Expat, with `ee/` under the SigNoz Enterprise Licence | Telemetry store, query API, UI |
| `signoz/signoz-otel-collector` | `v0.144.6` | AGPL-3.0 | OTLP ingestion |
| `signoz/signoz-mcp-server` | `v0.9.0` | Apache-2.0 | The MCP control surface FlightRules speaks to |
| `clickhouse/clickhouse-server` | `25.12.5` | Apache-2.0 | SigNoz's telemetry store |
| `clickhouse/clickhouse-keeper` | `25.12.5` | Apache-2.0 | ClickHouse coordination |
| `postgres` | `16` | PostgreSQL Licence (permissive, BSD-like) | SigNoz metastore, and FlightRules' own database |

**On the AGPL-3.0 components.** The SigNoz OTel Collector is AGPL-3.0, and so is SigNoz Foundry,
which FlightRules uses as a command-line tool to generate a Compose file. The AGPL's network clause
reaches software that is *conveyed* or made available over a network as a modified work. FlightRules
modifies neither, links to neither, and redistributes neither. It runs them as separate programs and
talks to them over HTTP and OTLP — the same relationship any user of a published container image
has. The images are pulled from their upstream registries by the user's own Docker daemon; this
repository ships only the pinned tag.

Full reasoning, with the tags verified against the running deployment, is in
[docs/research/compatibility-matrix.md](docs/research/compatibility-matrix.md) and
[ADR-0002](docs/adr/0002-signoz-deployment-and-pinning.md).

## Tools FlightRules invokes but does not redistribute

| Tool | Version | Licence | Role |
|---|---|---|---|
| SigNoz Foundry (`foundryctl`) | `v0.2.16` | AGPL-3.0 | Generates `casting.yaml.lock` and `pours/` from `casting.yaml` |
| Docker Engine and the Compose plugin | 29.6.1 | Apache-2.0 | Runs the containers above |
| gitleaks | user-installed | MIT | `make scan-history` |

`foundryctl` is installed by the user from the vendor's own installer, as the README documents. Its
*output* — the lock file and the generated Compose file — is committed so that a judge can read the
exact image tags before installing anything.

## npm dependencies

302 installed packages across 17 distinct licence expressions, every one permissive and on the
allowlist in `scripts/check-licences.mjs`. `make scan-licences` fails the build on anything else,
and it runs inside `make verify` and in CI.

The allowlist is: `0BSD`, `Apache-2.0`, `Artistic-2.0`, `BlueOak-1.0.0`, `BSD-2-Clause`,
`BSD-3-Clause`, `CC0-1.0`, `CC-BY-3.0`, `CC-BY-4.0`, `ISC`, `MIT`, `MIT-0`, `MPL-2.0`, `Python-2.0`,
`Unlicense`, `WTFPL`, `Zlib`.

Two entries were deliberate decisions rather than obvious ones, and the reasoning sits next to the
rule in `scripts/check-licences.mjs`:

- **Artistic-2.0** — transitive devDependencies of secretlint, never shipped in a runtime artefact.
- **MPL-2.0** — `@axe-core/playwright` and `axe-core`, used only by the accessibility test suite.
  MPL-2.0 is file-level copyleft; no MPL file is modified or distributed by this repository.

The principal direct dependencies:

| Package | Version | Licence |
|---|---|---|
| `@modelcontextprotocol/sdk` | 1.29.0 | MIT |
| `@opentelemetry/api` | 1.9.1 | Apache-2.0 |
| `@opentelemetry/sdk-node` | 2.10.0 | Apache-2.0 |
| `@opentelemetry/semantic-conventions` | 1.43.0 | Apache-2.0 |
| `next` / `react` | 16.2.11 / 19.2.8 | MIT |
| `fastify` | 5.10.0 | MIT |
| `drizzle-orm` / `drizzle-kit` | 0.45.2 / 0.31.10 | Apache-2.0 |
| `postgres` | 3.4.9 | Unlicense |
| `zod` | 4.4.3 | MIT |
| `vitest` / `fast-check` / `@playwright/test` | 4.1.10 / 4.9.0 / 1.62.0 | MIT |
| `@biomejs/biome` | see lockfile | MIT |

`pnpm-lock.yaml` is the authoritative record; this table is a reader's summary of it.

## OpenTelemetry semantic conventions

FlightRules emits attributes from the released OpenTelemetry semantic conventions and from the
**incubating** `gen_ai.*` set, which is experimental. Every one is registered, with its stability
and privacy classification, in
[docs/research/otel-attributes.md](docs/research/otel-attributes.md). No critical contract rule
depends on an experimental attribute alone (**SL-030**).
