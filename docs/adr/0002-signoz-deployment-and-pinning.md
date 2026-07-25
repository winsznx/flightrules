# ADR-0002 — SigNoz deployment through Foundry, and how versions are actually pinned

- Status: Accepted
- Date: 2026-07-25
- Phase: 00
- Related: SL-005, SL-006, SL-007, SL-008, SL-009, SL-010

## Context

PRD section 16.1 requires SigNoz to be deployed through Foundry, forbids the deprecated legacy
install script and the deprecated bundled Compose deployment, and requires both `casting.yaml`
and `casting.yaml.lock` in the repository. PRD section 16.2 requires pinned component versions.

The PRD supplies an illustrative casting and instructs that it must not be copied blindly but
compared against the installed Foundry schema. That comparison was performed.

## Decision 1 — Deployment shape

Use `mode: docker`, `flavor: compose`, with the MCP molding enabled:

```yaml
apiVersion: v1alpha1
kind: Installation
metadata:
  name: signoz
spec:
  deployment:
    mode: docker
    flavor: compose
  mcp:
    spec:
      enabled: true
```

This matches both the installed schema `api/v1alpha1/installation/casting.schema.json` and the
official `docs/examples/docker/compose-mcp/casting.yaml` at Foundry v0.2.16. The PRD's
illustrative snippet was structurally correct; it is adopted because it was verified, not
because it was supplied.

## Decision 2 — Pin `image`, not only `version`

**Setting `spec.<molding>.spec.version` alone does not pin the deployed container image.**

Observed directly with `foundryctl v0.2.16`: a casting setting only
`spec.signoz.spec.version: v0.134.0` produced `casting.yaml.lock` containing
`version: v0.134.0` while `pours/deployment/compose.yaml` still contained
`image: signoz/signoz:latest`. Adding `spec.signoz.spec.image: signoz/signoz:v0.134.0`
produced the pinned tag in the generated Compose file.

Therefore the committed casting sets **both** fields on every molding FlightRules pins:

| Molding | `image` | `version` |
|---|---|---|
| `signoz` | `signoz/signoz:v0.134.0` | `v0.134.0` |
| `ingester` | `signoz/signoz-otel-collector:v0.144.6` | `v0.144.6` |
| `mcp` | `signoz/signoz-mcp-server:v0.9.0` | `v0.9.0` |

ClickHouse (25.12.5), ClickHouse Keeper (25.12.5) and Postgres (16) are already pinned by
Foundry's own defaults and are left alone so that a Foundry upgrade brings coordinated
infrastructure versions rather than a hand-maintained drift.

The reproducibility check does not trust the lock file's `version` field as proof of pinning.
It asserts on the **image tags in the generated Compose file**, because that is what Docker
actually runs.

## Decision 3 — Commit the generated `pours/`

PRD section 12.5 leaves the commit policy for `pours/` to Phase 00. Decision: **commit it.**

Rationale: `pours/` is the only artefact that shows which image tags will actually run. Because
of Decision 2, a reviewer or judge who reads only `casting.yaml` and `casting.yaml.lock` cannot
tell a pinned deployment from a floating one. Committing `pours/` makes the deployed reality
reviewable and diffable, and lets `scripts/verify-reproducibility.sh` prove that re-forging on
a clean machine reproduces byte-identical output. `foundryctl forge` was verified to be
deterministic across repeated runs (identical SHA-256 both times), so this does not introduce
diff noise.

## Decision 4 — SigNoz setup must complete before any telemetry is produced

This is not a preference; it is a hard ordering requirement discovered at runtime.

Immediately after `foundryctl cast`, ports 4317 and 4318 accept TCP connections through the
Docker userland proxy, but the collector is not listening on them — `/proc/net/tcp6` inside the
collector container showed only the pprof (1777) and health-check (13133) listeners, every
payload was answered with a connection reset, and the collector logged
`Server returned an error response` from its OpAMP client every 30 seconds.

After `POST /api/v1/register` created the first organisation and user, the OpAMP errors stopped,
4317 and 4318 appeared as bound listeners, and `POST /v1/traces` returned HTTP 200.

The collector receives its effective pipeline configuration from the SigNoz apiserver over
OpAMP, and the apiserver will not serve it until an organisation exists.

Consequences:

1. `scripts/bootstrap.sh` completes first-user registration before anything else.
2. `scripts/verify-signoz.sh` proves ingestion with a real OTLP POST and asserts HTTP 200.
   **A TCP port check is treated as no evidence at all**, because it passes in the broken state.
3. The runbook and README document the ordering explicitly.

## Decision 5 — API key provisioning

Foundry deliberately keeps the SigNoz API key out of the casting; the MCP server runs with
`SIGNOZ_URL` only and the client supplies a `SIGNOZ-API-KEY` header per request.

FlightRules follows that model. `scripts/bootstrap.sh` creates one service account named
`flightrules-mcp`, assigns the managed `signoz-admin` role, mints one key, and writes it only
to the operator's local `.env`, which is git-ignored. No secret enters `casting.yaml`,
`casting.yaml.lock`, `pours/`, any committed file, any log, or the browser.

`signoz-admin` rather than `signoz-editor` is required because FlightRules creates notification
channels and alert rules in addition to dashboards and saved views. This is recorded in the
threat model as an accepted local-deployment privilege level, together with the mitigation that
the key is short-lived (90-day expiry), single-purpose, and revocable by deleting one service
account.

## Consequences

- A judge can reproduce the exact stack from two committed files plus the generated `pours/`.
- A silent drift to `latest` is caught by the reproducibility check rather than shipped.
- The false-positive port check that would have made "SigNoz is ready" a lie is eliminated.
- The repository never contains a SigNoz credential.
