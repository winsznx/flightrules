# FlightRules

**Agents change their route without changing their answer. FlightRules catches the route.**

FlightRules turns SigNoz traces into deterministic release contracts that catch skipped checks,
duplicate side effects, unknown tool paths and behavioural drift before an AI-agent canary reaches
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
timeout and a retry, and the payment service's idempotency ledger recorded both. The customer-facing
answer is identical.

FlightRules reads the real distributed traces out of SigNoz, reconstructs both execution graphs,
compares them against a contract mined from approved runs, and fails the release with the exact
traces that prove it — `flightrules gate check` exits `2`.

---

## Why SigNoz is load-bearing

Remove SigNoz and there is no product.

- **It is the evidence store.** Every graph FlightRules reconstructs comes from spans SigNoz
  ingested.
- **It is the only supported path to custom span attributes.** `signoz_get_trace_details` cannot
  return them (SL-020); `signoz_execute_builder_query` with `selectFields` using
  `fieldContext: "tag"` can (SL-021). Every contract rule that reads an attribute depends on it.
- **It is the control surface.** FlightRules compiles the active contract into ten managed SigNoz
  resources — one notification channel, four saved views, one dashboard, four alert rules — through
  the SigNoz MCP Server, and reads every one of them back by identifier before recording it as
  synced.
- **It is where FlightRules' own telemetry goes.** Evaluation spans, `flight_rules.*` metrics and
  logs correlated to the trace that produced them.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the full picture.

## Architecture

```text
 Instrumented agent and five demo services
        │  OTLP traces, metrics and logs
        ▼
 SigNoz — deployed by Foundry from the committed casting.yaml
        │  SigNoz MCP Server (HTTP :8000)
        ▼
 FlightRules MCP client ──► trace discovery, complete trace retrieval, field discovery,
        │                    dashboard / view / alert creation, read-back verification
        ▼
 graph engine → baseline miner → contract engine → artifact compiler
        │
        ├──► API + worker + PostgreSQL, and OTLP telemetry back into SigNoz
        ├──► web application: baseline capture, Contract Studio, Release Diff, Violation Inspector
        └──► CLI: `flightrules gate check` → the exit code CI reads
```

---

## Try it without installing anything

The product is deployed, with a publicly reachable SigNoz behind it. Nothing in it runs on a
developer machine.

| Surface | URL |
|---|---|
| **Web application** | https://flightrules-web-production.up.railway.app |
| API | https://flightrules-api-production.up.railway.app |
| SigNoz | https://signoz-signoz-production-f19a.up.railway.app |
| SigNoz MCP Server | https://flightrules-signoz-mcp-production.up.railway.app/mcp |
| OTLP ingestion | https://signoz-ingester-production-a417.up.railway.app |
| Demo agent | https://flightrules-demo-agent-production.up.railway.app |

The hosted deployment holds a real seeded demo: a baseline mined from 26 live runs, an active
contract, ten SigNoz artefacts read back as `synced: 10, conflict: 0`, an approved release that
passes and a canary that fails with 80 violations and 8 duplicate refunds. The gate against it:

```bash
FLIGHTRULES_API_URL=https://flightrules-api-production.up.railway.app \
  node apps/cli/dist/index.js gate check \
    --project demo-commerce --agent refund-agent --release refund-agent-v1   # exit 0

FLIGHTRULES_API_URL=https://flightrules-api-production.up.railway.app \
  node apps/cli/dist/index.js gate check \
    --project demo-commerce --agent refund-agent --release refund-agent-v2   # exit 2
```

Every step of that sequence, with its output, is in
[docs/evidence/phase-17/railway.md](docs/evidence/phase-17/railway.md). The local path below remains
the reproducible one, and is what the SigNoz deployment is pinned for.

## Prerequisites

Verified on macOS 27.0 (`arm64`). `make verify-env` checks all of them.

| Tool | Version |
|---|---|
| Node.js | 24.14.1 (see `.nvmrc`) |
| pnpm | 10.33.0 |
| Docker Engine | 29.6.1, with the Compose plugin |
| foundryctl | v0.2.16 |

```bash
curl -fsSL https://signoz.io/foundry.sh | FOUNDRY_VERSION=v0.2.16 bash
export PATH="$HOME/.local/bin:$PATH"
```

## From a fresh clone to a failing release

Every command below was run, in this order, from a clone with no `.env`, no database and no Docker
volume. `scripts/verify-fresh-machine.sh` is the executable form of this section, and
`docs/evidence/phase-16/fresh-machine.txt` is the transcript.

```bash
git clone <this repository> flightrules && cd flightrules

# 1. toolchain and dependencies
make verify-env
make install

# 2. environment
cp .env.example .env

# 3. SigNoz, deployed by Foundry from the committed casting.yaml
make signoz-up

# 4. first user, and the API key FlightRules uses
#    The Aa1! suffix is required: SigNoz enforces at least 12 characters with an uppercase
#    letter, a lowercase letter, a digit and a symbol, and states the policy only when it rejects.
export SIGNOZ_ADMIN_PASSWORD="$(openssl rand -base64 18)Aa1!"
make signoz-bootstrap          # writes SIGNOZ_API_KEY into .env, mode 600, git-ignored
make signoz-verify             # every SigNoz surface, including a real authenticated tool call

# 5. database
make up
make db-migrate

# 6. build, then start the three processes, each in its own terminal
make build
make api
make worker
make web

# 7. the demo topology: the agent and five services
make demo-up

# 8. the whole story in one command
make demo-full
```

`make demo-full` emits 25 known-good runs, mines a baseline from them, proposes and activates a
contract, compiles and verifies ten SigNoz artefacts, evaluates the approved release, runs the
unsafe canary, evaluates it, and prints:

```text
  approved release refund-agent-v1      exit 0
  unsafe canary    refund-agent-v2      exit 2
```

Open http://localhost:3000. `make demo-urls` prints the exact URL of every page worth looking at,
including the three critical violations.

### If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| OTLP returns `000` rather than `200` | SigNoz first-user setup has not completed; the receivers do not bind before it | `make signoz-bootstrap`. Never use a TCP port check as a readiness signal — it passes in exactly the broken state |
| `password must be at least 12 characters…` | The bootstrap password does not meet SigNoz's policy | Use the command in step 4 verbatim |
| `the baseline produced no route family` | The telemetry has not become queryable yet | The seed already retries for a minute. If it persists, check `make demo-up` and `make signoz-verify` |
| Every page says "FlightRules could not reach its API" | The API is not running | `make api`. The web application never falls back to stale data |

[docs/RUNBOOK.md](docs/RUNBOOK.md) has the complete list, including the traps that cost an hour each.

---

## The release gate

```bash
make gate                       # exit 0 for the approved release
RELEASE=refund-agent-v2 make gate   # exit 2 for the canary
make gate-json                  # the same decision as one machine-readable document
make evidence                   # the replayable decision bundle
```

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
`.github/workflows/release-gate.yml` runs the same commands on a runner and asserts exit code `2` on
the canary.

## Tests

```bash
make verify              # format, lint, typecheck, unit tests, build, contracts, design, scans
make test                # 1,416 unit and property tests
make test-integration    # 286 tests against real PostgreSQL and a real SigNoz deployment
make test-e2e            # 89 browser tests against the built product, at three viewports
make verify-telemetry    # exported logs correlate, and metric dimensions are queryable
make verify-alerts       # every managed alert's configuration, firing and recovery
make verify-fresh-machine  # this README, executed, in a clone outside the working tree
```

Two facts about the suites, both consequences of talking to real services rather than mocks:

1. **Stop the worker before `make test-integration`** — it competes with the runner tests.
2. **The integration suites drop the schema, and `make test-e2e` resets the demo.** Run
   `make demo-full` afterwards.

## Worker lifecycle

The worker's idle poll timer is deliberately **not** `unref`ed. It was once, and the consequence was
a worker that exited silently the moment `postgres.js` closed its idle connections — after logging
nothing but successes, while every job submitted afterwards sat `queued` with nothing to claim it.
The lease heartbeat and the shutdown timeout *are* `unref`ed, correctly, because something else is
keeping the process alive while they run.

Two tests guard it: one drives the real loop across an idle period and then submits work, and one
asserts the absence of `unref` in the source directly — because the behavioural test alone would
pass if something unrelated happened to be holding the event loop open, which is exactly how the
original defect survived.

`GET /health/dependencies` reports queue depth, so a worker that has stopped claiming is visible.

## Privacy

FlightRules evaluates observable execution structure and safe metadata. By default it records no
prompt, no model output, no tool call arguments, no tool results and no chain-of-thought — and the
demo proves trajectory enforcement works without any of them. The forbidden-key redactor *removes*
those attributes rather than replacing them with a marker, because a marker would still record that
the product collected one. Raw idempotency keys are never emitted; only a salted one-way hash is.

Every attribute, with its stability, cardinality risk and privacy classification, is registered in
[docs/research/otel-attributes.md](docs/research/otel-attributes.md).

## Security

[SECURITY.md](SECURITY.md) and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) — 33 threats, each with
an asset, an attack path, the control, the residual risk and the verification. Five scanners run in
`make verify` and in CI.

## Known limitations

Stated plainly, because a limitation that is disclosed is a limitation a reviewer can weigh.

1. **No authentication.** P0 is scoped to a single-tenant local deployment (PRD section 6.1).
   Anyone who can reach the API can read and change everything. `T08`.
2. **Token and retry regression are disclosed rather than measured.** The demo agent makes no model
   call, so there is no token baseline to regress against. The gate says so rather than reporting a
   zero.
3. **The Phase 13 browser workflow is validated at one viewport.** The read-only suites run at
   three; the destructive workflow runs at desktop only, by design.
4. **`Open in SigNoz` opens the trace view, not a release-filtered view.** No verified URL shape
   exists for the latter in the pinned version.
5. **The API's own structured logs reach SigNoz without a trace identifier.** ESM import order
   defeats the HTTP instrumentation. It does not affect the Violation Inspector, which correlates on
   the demo services' traces.
6. **Browser coverage is Chromium only.** PRD section 20.4 names three engines.
7. **No container-image vulnerability scan.** No scanner is pinned by this repository; the images
   are unmodified upstream releases pinned by tag.
8. **Notification delivery is unverified.** The managed channel points at a local webhook nothing
   listens on, and SigNoz's own test-notification failure is recorded honestly in the register.
9. **An alert created moments before a metric spike does not fire on that spike.** Scheduling, not a
   defect; recorded in `docs/evidence/phase-16/alert-lifecycle.md`.
10. **The hosted SigNoz core is not version-pinned by this repository.** Railway has no bind mounts,
    no shared volumes and no init containers, and the Foundry casting needs all three, so the hosted
    core comes from SigNoz's own Railway template while the **MCP server is deployed at the pinned
    `v0.9.0`**. The pinned, reproducible deployment is the local Foundry one — `make signoz-up`,
    proven by `make signoz-reproducibility`. Reasoning in
    [docs/evidence/phase-17/railway.md](docs/evidence/phase-17/railway.md).
11. **The hosted SigNoz user interface needs credentials, which are not published.** No credential
    belongs in a public repository. Everything SigNoz-derived that the product itself shows — the
    graph diff, the violations, the correlated logs, the artefact register — is visible in the hosted
    web application without signing in to SigNoz.
12. **The hosted demo services are publicly reachable and unauthenticated,** like the hosted API
    itself (limitation 1). They hold no data but the demo's own ledger, which `POST /payments/reset`
    clears.

## Repository structure

```text
apps/                     web, api, worker, cli, demo-agent, demo-services/*
packages/                 config, db, domain, telemetry, signoz-mcp, trace-graph,
                          normaliser, contract-schema, contract-engine, baseline-miner,
                          artifact-compiler, test-fixtures, ui
contracts/                version-controlled trajectory contracts
docs/                     PRD, architecture, ADRs, research, evidence, runbook, threat model
scripts/                  bootstrap, verification, demo and reproducibility scripts
casting.yaml              the SigNoz deployment, deployed by Foundry
compose.app.yaml          FlightRules application services
```

## Documentation

| Document | Contents |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Authoritative product specification |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it works, package by package, and why |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Operating procedures and every trap worth knowing |
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) | The demo, timed, with expected markers |
| [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) | 33 threats with controls and verification |
| [docs/research/source-lock.md](docs/research/source-lock.md) | Every external technical claim, its source, and whether the runtime confirmed it |
| [docs/research/compatibility-matrix.md](docs/research/compatibility-matrix.md) | Pinned versions, MCP tool surface, licences, incompatibilities |
| [docs/ACCEPTANCE_MATRIX.md](docs/ACCEPTANCE_MATRIX.md) | Requirement → implementation → test → evidence |
| [docs/evidence/](docs/evidence/) | Per-phase plans and results |
| [CHANGELOG.md](CHANGELOG.md) | One section per phase |

## AI assistant disclosure

This repository was built with Claude Code, under the phase-gated operating contract in
[CLAUDE.md](CLAUDE.md). Every external technical claim is recorded in
[docs/research/source-lock.md](docs/research/source-lock.md) with its source and whether it was
confirmed against the installed runtime rather than recalled. Where documentation and runtime
behaviour disagreed, the runtime won and the mismatch was written down — sixty-six such entries,
several of which are defects in the pinned dependencies rather than in this product.

## Licence

Apache-2.0 — see [LICENSE](LICENSE).

FlightRules **deploys** SigNoz (MIT Expat, with `ee/` under the SigNoz Enterprise Licence), SigNoz
Foundry (AGPL-3.0), the SigNoz OTel Collector (AGPL-3.0) and the SigNoz MCP Server (Apache-2.0) as
unmodified upstream containers communicating over documented network interfaces. No AGPL code is
copied into, linked with, or redistributed as part of this repository. Full detail in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
