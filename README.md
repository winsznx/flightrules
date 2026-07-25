# FlightRules

**Agents change their route without changing their answer. FlightRules catches the route.**

FlightRules turns SigNoz traces into deterministic release contracts that catch skipped checks,
duplicate side effects, unknown tool paths, and behavioural drift before an agent canary reaches
production.

---

## The failure output evaluation misses

A refund agent ships v2. A customer asks for a refund. The agent replies:

> Your refund of $48.20 has been issued and will appear in 3–5 business days.

Exactly what v1 said. Every output check passes.

What actually happened underneath:

```text
v1 (approved)                          v2 (shipped)
refund.request                         refund.request
  -> policy.retrieve                     -> order.lookup
  -> order.lookup                        -> payment.refund
  -> fraud.check                         -> payment.refund      <- charged twice
  -> refund.calculate                    -> customer.notify
  -> payment.refund
  -> customer.notify
```

The policy retrieval is gone. The fraud check is gone. The payment write happened twice after a
timeout and retry, and the payment service's idempotency ledger recorded both. The customer-facing
answer is identical.

FlightRules reads the real distributed traces out of SigNoz, reconstructs both execution graphs,
compares them against a contract mined from approved runs, and fails the release with the exact
traces that prove it.

---

## Status

This repository is under phase-gated construction. Completed phases are recorded in
[CHANGELOG.md](CHANGELOG.md), with per-phase evidence in [docs/evidence/](docs/evidence/).

| Phase | Name | Status |
|---|---|---|
| 00 | Source lock and feasibility proof | PASS |
| 01 | Repository foundation and CI | PASS |
| 02–17 | See [docs/PRD.md](docs/PRD.md) section 21 | In progress |

Complete setup, demo and test instructions land in Phase 17. What follows is what works today.

---

## Prerequisites

Verified on macOS 27.0 (`arm64`). Versions are pinned; `make verify-env` checks them.

| Tool | Version |
|---|---|
| Node.js | 24.14.1 (see `.nvmrc`) |
| pnpm | 10.33.0 |
| Docker Engine | 29.6.1 with the Compose plugin |
| foundryctl | v0.2.16 (required from Phase 02) |

```bash
curl -fsSL https://signoz.io/foundry.sh | FOUNDRY_VERSION=v0.2.16 bash
```

## Getting started

```bash
make verify-env          # check the toolchain matches the pinned versions
make install             # install from the committed lockfile
cp .env.example .env     # then set SIGNOZ_API_KEY once Phase 02 bootstrap mints it
make up                  # start the FlightRules PostgreSQL service
make db-migrate          # apply database migrations
make verify              # format, lint, typecheck, test, build, secret and licence scans
```

## Commands

| Command | What it does |
|---|---|
| `make verify-env` | Verify Node, pnpm, Docker, Git and foundryctl versions |
| `make install` | `pnpm install --frozen-lockfile` |
| `make lint` / `make format-check` | Biome lint and formatting |
| `make typecheck` | Strict TypeScript build of every package |
| `make test` | Unit and property tests, no external services required |
| `make test-integration` | Integration tests, requires `make up` and a running SigNoz stack |
| `make build` | Build every package |
| `make up` / `make down` | Start and stop the FlightRules PostgreSQL service |
| `make db-migrate` / `make db-rollback` / `make db-status` | Database migrations |
| `make scan-secrets` / `make scan-licences` / `make scan-deps` | Security and licence gates |
| `make verify` | The complete validation suite |
| `make api` / `make worker` | Run the API and the job worker |
| `make demo-seed` | Empty database to an active contract and synced SigNoz artefacts, through the API |
| `make demo-full` | The whole demo: telemetry, contract, artefacts, a passing gate and a failing one |
| `make gate` / `make gate-json` | Read the release-gate decision and exit with its code |
| `make evidence` | Export the replayable decision document |

## The release gate

```bash
make demo-full     # emits telemetry, mines a contract, and asserts exit 0 then exit 2
```

`flightrules gate check` returns the decision and the process exit code:

| Code | Meaning |
|---|---|
| `0` | pass — the release stayed within the trajectory contract |
| `1` | reserved for an unclassified crash; never returned by a classified path |
| `2` | contract violation |
| `3` | insufficient data — too few completed runs, truncated retrieval, or a stale window |
| `4` | integration or evaluation error |
| `5` | invalid configuration |

The decision is computed from persisted evidence by a pure function. No model is involved, the same
evidence always produces the same `decisionHash`, and a restarted API returns the identical answer.
`.github/workflows/release-gate.yml` runs the same commands and asserts exit code `2` on the canary.

Full operating detail, including every CLI flag and the failure traps, is in
[`docs/RUNBOOK.md`](docs/RUNBOOK.md) section 12.

## Architecture

```text
Instrumented agent and demo services
        |  OTLP traces, metrics, logs
        v
SigNoz OTel ingestion, deployed by Foundry from casting.yaml
        |
        |  SigNoz MCP Server (HTTP, port 8000)
        v
FlightRules SigNoz MCP client
        +--> trace discovery and complete trace retrieval
        +--> field discovery
        +--> dashboard, saved view and alert creation
        +--> resource read-back verification
        |
        v
FlightRules API and worker
        +--> graph engine, baseline miner, contract compiler
        +--> deterministic evaluator, release gate
        +--> application PostgreSQL
        +--> OTLP evaluation telemetry back to SigNoz
        |
        v
FlightRules web application and CLI / CI release gate
```

Full detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (Phase 17).

## How SigNoz is used

SigNoz is not a screenshot at the end of this product. It is the operational substrate.

- It stores the distributed trace evidence used to reconstruct execution routes.
- Query Builder v5 through `signoz_execute_builder_query` is how FlightRules retrieves complete
  span trees **including custom attributes** — the only officially supported path that returns
  them (see [ADR-0003](docs/adr/0003-signoz-access-boundary.md)).
- The MCP Server is the programmatic control surface for trace queries, dashboards, saved views
  and alerts. Every write is followed by a read-back that compares the stored resource against
  the intended specification.
- FlightRules emits its own evaluation telemetry back into SigNoz over OTLP.
- Remove SigNoz and baseline capture, evidence retrieval, artifact compilation, alerting and the
  final proof all stop working.

## Privacy model

FlightRules evaluates observable execution structure and safe metadata. By default it does not
record prompts, model output, tool call arguments, tool results, or chain-of-thought — and the
demo proves trajectory enforcement works without them. Raw idempotency keys are never emitted;
only a salted one-way hash is. The complete register of every attribute, with its stability,
cardinality risk and privacy classification, is in
[docs/research/otel-attributes.md](docs/research/otel-attributes.md).

## Repository structure

```text
apps/                     web, api, worker, cli, demo-agent, demo-services/*
packages/                 config, db, domain, telemetry, signoz-mcp, trace-graph,
                          normaliser, contract-schema, contract-engine, baseline-miner,
                          artifact-compiler, test-fixtures, ui
contracts/                version-controlled trajectory contracts
docs/                     PRD, ADRs, research, evidence, runbook, threat model
scripts/                  bootstrap, verification, demo and reproducibility scripts
casting.yaml              SigNoz deployment, deployed by Foundry
compose.app.yaml          FlightRules application services
```

Packages appear in the phase that gives them real behaviour; the operating contract forbids
placeholder implementations.

## Documentation

| Document | Contents |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Authoritative product specification |
| [CLAUDE.md](CLAUDE.md) | Operating contract and the runtime facts that bite |
| [docs/research/source-lock.md](docs/research/source-lock.md) | Every external technical claim, its source and its runtime confirmation |
| [docs/research/compatibility-matrix.md](docs/research/compatibility-matrix.md) | Pinned versions, MCP tool surface, licences, known incompatibilities |
| [docs/research/otel-attributes.md](docs/research/otel-attributes.md) | Telemetry attribute register |
| [docs/adr/](docs/adr/) | Architecture decision records |
| [docs/evidence/](docs/evidence/) | Per-phase plans and results |
| [docs/ACCEPTANCE_MATRIX.md](docs/ACCEPTANCE_MATRIX.md) | Requirement to implementation to test to evidence |

## AI assistant disclosure

This repository was built with Claude Code under the phase-gated operating contract in
[CLAUDE.md](CLAUDE.md). Every external technical claim is recorded in the source lock with its
source and whether it was confirmed against the installed runtime.

## Licences

FlightRules is Apache-2.0.

FlightRules **deploys** SigNoz (MIT Expat, with `ee/` under the SigNoz Enterprise License),
SigNoz Foundry (AGPL-3.0), the SigNoz OTel Collector (AGPL-3.0) and the SigNoz MCP Server
(Apache-2.0) as unmodified upstream containers, communicating over documented network interfaces.
No AGPL code is copied into, linked with, or redistributed as part of this repository. Full
detail is in the [compatibility matrix](docs/research/compatibility-matrix.md).
