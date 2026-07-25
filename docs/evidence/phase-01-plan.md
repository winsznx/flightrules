# Phase 01 plan — Repository foundation and CI

Branch: `phase/01-foundation`
Date: 2026-07-25

## Objective (PRD section 21, Phase 01)

Create a strict, testable monorepo with **no product logic**.

## Entry criteria check

| Criterion | Status |
|---|---|
| Phase 00 status `PASS` | Satisfied (`docs/evidence/phase-00-result.md`) |
| Stack and versions pinned by ADR | Satisfied (ADR-0001) |
| `main` green | Satisfied (nothing to run yet; merged cleanly) |

## Tasks (PRD Phase 01 list)

1. Initialise the pnpm workspace with the pinned pnpm 10.33.0 and Node 24.14.1.
2. Add the strict TypeScript base configuration.
3. Create the repository structure from PRD section 13.
4. Add lint, format, typecheck, unit test, build and dependency-audit commands.
5. Configure environment validation.
6. Add `.env.example` with no secrets.
7. Add the PostgreSQL development service in `compose.app.yaml`.
8. Add database migration tooling.
9. Add the CI workflow.
10. Add secret scanning and dependency scanning.
11. Add conventional commit guidance.
12. Add the `Makefile` targets required by the PRD.

## Scope boundaries

- **No product logic.** Packages are created with their public surface and foundation tests
  only; the engines land in Phases 04–11.
- No UI beyond the workspace scaffold; permanent visual implementation starts at Phase 12.
- Empty test suites are explicitly rejected by the PRD, so every package created in this phase
  carries at least one meaningful behavioural test.

## Verification plan

| Check | Command | Expected |
|---|---|---|
| Clean install from lockfile | `pnpm install --frozen-lockfile` | exit 0 |
| Format check | `make format-check` | exit 0 |
| Lint | `make lint` | exit 0 |
| Typecheck | `make typecheck` | exit 0 |
| Unit tests | `make test` | all pass, no empty suites |
| Build | `make build` | exit 0 |
| Environment validation | `make verify-env` | reports pinned Node and pnpm; fails on mismatch |
| Database up and migration | `make up` then `pnpm --filter @flightrules/db migrate` | migration applies against real PostgreSQL |
| Migration rollback | `pnpm --filter @flightrules/db rollback` | reverts cleanly |
| Secret scanning | `make scan-secrets` | no findings |
| Dependency licences | `make scan-licences` | no incompatible licence |

## Tooling decisions to record

The PRD specifies outcomes (formatting checks, linting, secret scanning, dependency licence
checks) but not tools. Each selection is verified against the registry and recorded in ADR-0005
and the source lock, as the execution contract requires.
