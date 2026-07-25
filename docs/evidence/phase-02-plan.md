# Phase 02 plan — SigNoz deployment through Foundry

Branch: `phase/02-signoz-foundry`
Date: 2026-07-25

## Objective (PRD section 21, Phase 02)

Create the reproducible SigNoz and MCP deployment the submission requires.

## Entry criteria check

| Criterion | Status |
|---|---|
| Phase 01 status `PASS`, merged to `main` | Satisfied |
| Foundry surfaces verified in Phase 00 | Satisfied (SL-003 to SL-010) |
| `foundryctl` installed | Satisfied (v0.2.16) |
| Docker daemon reachable | Satisfied (29.6.1, Compose v5.3.0) |

## Tasks (PRD Phase 02 list)

1. Generate a current Docker Compose casting example.
2. Create the verified `casting.yaml`.
3. Enable MCP using the verified schema.
4. Pin compatible versions where the schema permits.
5. Run `foundryctl gauge`.
6. Run `foundryctl forge`.
7. Inspect the generated files for expected ports and services.
8. Run `foundryctl cast`.
9. Verify SigNoz UI health.
10. Verify OTLP gRPC and HTTP ports.
11. Verify MCP `/livez` and `/readyz`.
12. Complete the documented first-user and API-key setup.
13. Connect Claude Code to the project-scoped SigNoz MCP Server.
14. Run MCP tool discovery.
15. Commit `casting.yaml` and `casting.yaml.lock`.
16. Add `scripts/verify-signoz.sh`.
17. Add teardown and data-reset documentation.

## Approach carried over from Phase 00

Phase 00 deployed the stack once in a scratch directory purely for verification, and that run
produced findings that shape this phase:

- `version:` alone does not pin the container image tag; `image:` must also be set (SL-006).
  The casting therefore sets both, and the tests assert on the **generated Compose file**, not on
  the lock file's `version` field.
- OTLP receivers do not bind until SigNoz first-user setup completes (SL-010). Bootstrap must
  therefore run before any telemetry is produced, and readiness must be proven with a real OTLP
  POST rather than a TCP port check, which passes in the broken state.
- Unmatched SigNoz API paths return the single-page-app shell with HTTP 200 (SL-012), so every
  direct HTTP assertion is on the response body.
- API keys are issued through service accounts, not a standalone key endpoint (SL-014).

## Verification plan

| Check | Command | Expected |
|---|---|---|
| Tool availability | `make signoz-gauge` | exit 0 |
| Generation | `make signoz-forge` | exit 0, lock and `pours/` written |
| Lock stability | forge twice, compare | byte-identical |
| Deployment | `make signoz-up` | every container healthy |
| Bootstrap | `make signoz-bootstrap` | org, service account, role, key, OTLP accepting spans |
| All surfaces | `make signoz-verify` | every check passes, including invalid-key rejection |
| Reproducibility | `make signoz-reproducibility` | regenerates byte for byte, no `:latest` |
| Capability discovery | `make signoz-capabilities` | 22 required tools present |
| Regression | `make test`, `make test-integration` | all pass |
