# Changelog

All notable changes to FlightRules are recorded here, one section per phase.

## Phase 00 — Source lock and feasibility proof (2026-07-25)

### Added

- Git repository initialised; PRD copied verbatim to `docs/PRD.md`.
- `CLAUDE.md` operating contract derived from the PRD, including the runtime facts discovered
  during verification.
- `docs/research/source-lock.md` with 35 verified entries covering SigNoz, Foundry, the SigNoz
  MCP Server, OpenTelemetry, the MCP TypeScript SDK, Node.js, pnpm and every application
  dependency.
- `docs/research/compatibility-matrix.md` recording pinned versions, published ports, the
  complete MCP tool surface against the PRD's required set, licences, and known incompatibilities.
- `docs/research/mcp-capabilities.json` — verbatim live snapshot of 41 MCP tools with full input
  and output schemas plus 19 resources, captured through the official SDK.
- `docs/research/otel-attributes.md` — attribute register with type, source, stability,
  cardinality risk, privacy classification, example and owning package for every attribute.
- `docs/ACCEPTANCE_MATRIX.md` mapping every P0 requirement, functional requirement, route and
  critical final assertion to its implementation, test and evidence path.
- ADR-0001 stack and version policy; ADR-0002 SigNoz deployment and pinning; ADR-0003 SigNoz
  access boundary and trace-retrieval path; ADR-0004 telemetry attribute conventions.
- `docs/evidence/phase-00-plan.md`, `docs/evidence/phase-00-result.md`, and six committed
  feasibility-proof scripts under `docs/evidence/phase-00/`.

### Verified

- Full chain proven end to end against a live deployment: OpenTelemetry emits → SigNoz ingests →
  FlightRules retrieves complete trace evidence including custom attributes → SigNoz artefacts
  can be created and read back.
- Foundry `forge` is deterministic; the lock file is byte-stable across repeated runs.
- TypeScript 7.0.2 typechecks a strict project and a Next.js 16 + React 19 App Router project
  cleanly.

### Discovered

- Foundry's `version:` field does not pin the deployed container image tag; `image:` must be set.
- OTLP receivers do not bind until SigNoz first-user setup completes; a TCP port check is a
  false positive in the broken state.
- `POST /api/v1/login` does not exist in SigNoz v0.134.0; unmatched paths return the SPA shell
  with HTTP 200.
- `signoz_get_trace_details` cannot return custom span attributes;
  `signoz_execute_builder_query` with `selectFields` can.
- All `gen_ai.*` semantic conventions are experimental; `vcs.commit.sha` is not a released
  attribute name.

## Phase 01 — Repository foundation and CI (2026-07-25)

### Added

- Strict pnpm workspace pinned to Node 24.14.1, pnpm 10.33.0 and TypeScript 7.0.2, with exact
  version specifiers throughout and one canonical lockfile.
- `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax` and `erasableSyntaxOnly`, and a project-reference build graph.
- Biome formatting and linting with `noExplicitAny`, `noConsole`, `noNonNullAssertion` and
  unused-code rules raised to error.
- Vitest split into `unit` and `integration` projects; the integration project fails rather than
  skips when a required service is absent.
- `@flightrules/config` — environment validation reporting every invalid variable at once, with a
  hosted-mode control that rejects loopback, link-local and private SigNoz addresses.
- `@flightrules/domain` — the complete PRD error-code set with a typed envelope, plus a redaction
  layer covering secret-key patterns, registered secret values, cyclic structures and the
  forbidden telemetry key list.
- `@flightrules/db` — checksummed SQL migrator with rollback, a CLI, and the foundation schema
  (`signoz_connections`, `projects`, `audit_events`) with a PL/pgSQL UUIDv7 generator.
- `compose.app.yaml` PostgreSQL 16 service on host port 5433, health-gated.
- `Makefile` with every PRD-required target plus `make verify`.
- `.env.example`, `scripts/verify-environment.sh`, `scripts/check-licences.mjs`, `.gitmessage`.
- Five-job CI workflow: static checks, unit tests, database integration against real PostgreSQL,
  security scanning, and a clean-install job that asserts installing does not modify the lockfile.
- ADR-0005 recording the tooling selections the PRD left open.
- README leading with the unsafe route that output evaluation misses.

### Verified

- 65 tests pass (57 unit, 8 integration); nothing skipped.
- Migrations apply from empty, re-apply idempotently, roll back, and re-apply against real
  PostgreSQL 16.
- A clean install from the committed lockfile leaves the lockfile unmodified and builds.

### Discovered

- The secret scanner and the licence checker each failed the build on a real finding before
  passing, which is what makes them controls rather than decoration.
