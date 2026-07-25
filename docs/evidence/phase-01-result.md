# Phase 01 result — Repository foundation and CI

Branch: `phase/01-foundation`
Date: 2026-07-25

## What was built

A strict pnpm workspace with **no product logic**, plus the four packages that have real Phase 01
behaviour.

```text
package.json              pnpm 10.33.0, Node >=24.14.1 <25, exact pins, no ranges
pnpm-workspace.yaml       apps/*, apps/demo-services/*, packages/*
.npmrc                    engine-strict, save-exact
.nvmrc                    24.14.1
tsconfig.base.json        strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
                          + verbatimModuleSyntax + erasableSyntaxOnly + composite
tsconfig.build.json       project-reference graph for the build
biome.json                formatter + linter, rules raised above the recommended preset
vitest.config.ts          two projects: unit (no services) and integration (real services)
compose.app.yaml          FlightRules PostgreSQL 16 on host port 5433, health-gated
Makefile                  every target the PRD requires, plus `make verify`
.env.example              no secrets, every variable documented
.secretlintrc.json        recommended secret-detection preset
.gitmessage               conventional commit template, no co-author trailers
.github/workflows/ci.yml  five jobs: static, unit, database, security, clean-install
scripts/verify-environment.sh
scripts/check-licences.mjs
```

### Packages with real Phase 01 behaviour

| Package | Contents |
|---|---|
| `@flightrules/config` | Zod environment schema. Reports every invalid variable at once. Rejects loopback, link-local and private SigNoz addresses in hosted mode, and permits them in self-host mode (PRD section 18.1 server-side request forgery control). |
| `@flightrules/domain` | The complete PRD section 19 error-code set with a typed envelope, plus the redaction layer: secret-key patterns, registered secret values redacted wherever they appear in a string, cycle-safe recursive redaction, and the forbidden telemetry key list from PRD section 17.6. |
| `@flightrules/db` | Migration loader, checksummed migrator with per-migration transactions, rollback, CLI, and the Phase 01 schema. |

Packages listed in PRD section 13 that do **not** yet exist — `telemetry`, `signoz-mcp`,
`trace-graph`, `normaliser`, `contract-schema`, `contract-engine`, `baseline-miner`,
`artifact-compiler`, `test-fixtures`, `ui`, and every app — are deliberately absent. The
operating contract forbids placeholder implementations, and an empty package with a stub
`index.ts` is exactly that. Each appears in the phase that gives it real behaviour:

| Path | Phase |
|---|---|
| `apps/demo-agent`, `apps/demo-services/*` | 03 |
| `packages/telemetry` | 04 |
| `packages/signoz-mcp` | 05 |
| `packages/trace-graph`, `packages/normaliser`, `packages/test-fixtures` | 06 |
| `packages/contract-schema`, `packages/contract-engine` | 07 |
| `packages/baseline-miner` | 08 |
| `apps/api`, `apps/worker` | 09 |
| `packages/artifact-compiler` | 10 |
| `apps/cli` | 11 |
| `apps/web`, `packages/ui` | 12 |

### Database schema (migration `0001_foundation`)

- `flightrules_uuid_v7()` — PL/pgSQL UUIDv7 generator. PostgreSQL 16 has no native one, and PRD
  section 14 requires sortable identifiers. 48-bit big-endian Unix milliseconds, version-7 nibble,
  variant bits, 74 bits of randomness.
- `flightrules_touch_updated_at()` trigger function.
- `signoz_connections` — stores an `api_key_secret_reference`, never a key value (PRD section 14.2).
- `projects` — slug constrained to lower-kebab-case, unique.
- `audit_events` — cascades from `projects`, indexed by project and by entity.

## Commands run and results

| Command | Exit | Result |
|---|---|---|
| `make verify-env` | 0 | node 24.14.1, pnpm 10.33.0, docker 29.6.1, compose 5.3.0, git 2.50.1, foundryctl v0.2.16 |
| `pnpm install --frozen-lockfile` | 0 | 143 packages, 4 workspace projects |
| `make format-check` | 0 | 27 files checked, no changes needed |
| `make lint` | 0 | 27 files checked, no diagnostics |
| `make typecheck` | 0 | `tsc --build --force` across the project-reference graph |
| `make test` | 0 | **4 files, 57 tests passed, 0 failed, 0 skipped** |
| `make build` | 0 | 3 packages built |
| `make scan-secrets` | 0 | no findings |
| `make scan-licences` | 0 | 136 installed packages across 15 licence expressions, all allowed |
| `make scan-deps` | 0 | no known vulnerabilities |
| `make up` | 0 | `flightrules-postgres` reached Healthy |
| `make db-migrate` | 0 | `applied: 0001` |
| `make db-status` | 0 | `0001_foundation` |
| `make db-rollback` | 0 | `reverted: 0001` |
| `make db-migrate` (again) | 0 | `applied: 0001` |
| `make test-integration` | 0 | **1 file, 8 tests passed, 0 failed, 0 skipped** |
| Clean install: `rm -rf node_modules && pnpm install --frozen-lockfile` | 0 | succeeded |
| `git diff --exit-code -- pnpm-lock.yaml` after install | 0 | lockfile unmodified by installing |
| `pnpm run build` from the clean tree | 0 | succeeded |

Total this phase: **65 tests passed, 0 failed, 0 skipped** (57 unit, 8 integration).

## Runtime validation

Real PostgreSQL 16, not a mock:

- Every migration applied from an empty database; `audit_events`, `projects`,
  `schema_migrations` and `signoz_connections` were confirmed present in `information_schema`.
- A second `migrateUp` applied nothing, proving idempotency.
- `flightrules_uuid_v7()` was called twice in one statement: version nibble `7` at the expected
  position, values distinct, and the earlier value sorted before the later one.
- The `updated_at` trigger advanced on update.
- A duplicate project slug was rejected by the unique constraint.
- `'Not A Slug'` was rejected by the check constraint.
- Deleting a project cascaded its audit events to zero.
- The most recent migration was reverted and reapplied, and the applied count moved as expected
  in both directions.

## Failures discovered and how they were resolved

### 1. Node globals unresolved under the strict base configuration

`URL`, `process` and `import.meta.url` were unresolved because `lib` was `["ES2023"]` with no
`types` entry, so `@types/node` was never loaded. Resolved by adding `"types": ["node"]` to
`tsconfig.base.json`. Verified: `tsc --build --force` exits 0.

### 2. esbuild postinstall blocked by pnpm

pnpm 10 blocks dependency build scripts by default; `tsx` and `vitest` need esbuild's. Resolved
with an explicit `pnpm.onlyBuiltDependencies: ["esbuild"]` allowlist rather than disabling the
protection globally.

### 3. Secret scanner flagged a test fixture — correctly

`secretlint` failed the build on
`new Error("connection to postgres://user:hunter2@db:5432 refused")` in
`packages/domain/src/errors.test.ts`. The fixture existed to prove that an unrecognised error's
message is not echoed into the envelope, but it was a credential-shaped literal in committed
source.

Rewritten to use a header-shaped secret instead. The test still asserts the same behaviour. This
is recorded because it is evidence the scanner does something: a scanner that has never failed
is not a control.

### 4. Licence checker rejected six transitive devDependencies — correctly

`Artistic-2.0` (`binaryextensions`, `editions`, `istextorbinary`, `textextensions`,
`version-range`) and `CC-BY-3.0` (`spdx-exceptions`), all transitive devDependencies of
`secretlint`. Both licences are permissive; neither package ships in a runtime artefact. Added to
the allowlist with the reasoning recorded inline in `scripts/check-licences.mjs` and in ADR-0005.

### 5. Biome `useLiteralKeys` conflicts with `noPropertyAccessFromIndexSignature`

Biome wanted `obj.foo`; TypeScript's `noPropertyAccessFromIndexSignature` requires `obj["foo"]`.
The TypeScript rule is the stricter and more valuable one — it makes index-signature access
visibly different from declared-property access, which matters when reading untyped span
attribute bags. `useLiteralKeys` disabled with that reasoning in ADR-0005.

### 6. `docs/evidence/` was being linted

The committed Phase 00 proof scripts use `console.log`, which the raised `noConsole` rule
rejects. Reformatting or rewriting archived evidence would falsify the record of what was
actually executed, so `docs/evidence/` is excluded from Biome. Product source is not.

## CI

`.github/workflows/ci.yml` runs five jobs on `main` and every `phase/**` branch:

| Job | Gates |
|---|---|
| `static` | format check, lint, typecheck, build |
| `unit` | unit and property tests |
| `database` | real PostgreSQL 16 service; migrate, rollback, re-migrate, then integration tests |
| `security` | secret scan, licence check, vulnerability audit |
| `clean-install` | install from lockfile only, assert the lockfile was not modified, build |

CI runs the same commands as the local Makefile, so local and CI cannot disagree. The workflow
has not yet been executed on a remote, because the execution contract forbids pushing to a remote
without an explicit instruction; the identical command set was executed locally and every job's
steps passed.

## Known limitations

1. `make test-e2e` is declared in the Makefile but has no Playwright project yet. It arrives in
   Phase 12 with the UI. It currently fails with "missing script", which is honest — it is not
   wired to a no-op that would report success.
2. The CI workflow has been validated by running its exact command sequence locally, not by a
   remote CI run. No remote push has been made.
3. `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`, `docs/RUNBOOK.md`, `docs/DEMO_SCRIPT.md` and
   `docs/SUBMISSION.md` do not exist yet; they are Phase 17 deliverables and the README links to
   them as such.
4. Drizzle ORM is pinned in ADR-0001 but not yet installed. It arrives in Phase 09 with the query
   layer; installing it now would add an unused dependency.

---

```text
PHASE: 01 Repository foundation and CI
STATUS: PASS
BRANCH: phase/01-foundation
COMMITS: <filled at commit>
SOURCES VERIFIED: 4 new source-lock entries (SL-036 to SL-039) covering Biome 2.5.5, secretlint 13.0.4, postgres 3.4.9 and the pnpm built-in licence and audit commands; all versions read from the npm registry and confirmed by installing and running them
IMPLEMENTED: strict pnpm workspace; TypeScript strict base and project-reference build graph; Biome format and lint with raised rules; Vitest unit/integration project split that fails rather than skips; @flightrules/config environment validation with hosted-mode SSRF control; @flightrules/domain error model, typed envelope and redaction layer; @flightrules/db checksummed migrator, rollback, CLI and foundation schema with a UUIDv7 generator; compose.app.yaml PostgreSQL service; .env.example; Makefile with every required target plus `make verify`; five-job CI workflow; environment verification script; dependency licence checker; conventional commit template; ADR-0005; README
TESTS RUN: make verify-env; pnpm install --frozen-lockfile; make format-check; make lint; make typecheck; make test; make build; make scan-secrets; make scan-licences; make scan-deps; make up; make db-migrate; make db-status; make db-rollback; make db-migrate; make test-integration; clean-install then git diff --exit-code on pnpm-lock.yaml then build
TEST RESULT: passed 65, failed 0, skipped 0 (57 unit across 4 files, 8 integration across 1 file). All 17 gate commands exited 0.
RUNTIME VALIDATION: PostgreSQL 16 started via compose.app.yaml and reached Healthy. Migrations applied from an empty database, verified idempotent on a second run, reverted, and reapplied. The UUIDv7 generator was exercised in the database and produced version-7, distinct, monotonically sortable values. The updated_at trigger, the slug unique constraint, the slug format check constraint and the audit-event cascade were each confirmed against real SQL. A clean install from the committed lockfile succeeded and left the lockfile unmodified.
EVIDENCE: docs/evidence/phase-01-plan.md; docs/evidence/phase-01-result.md; docs/adr/0005-quality-tooling-selection.md; docs/research/source-lock.md (SL-036 to SL-039)
KNOWN LIMITATIONS: four, listed above. None blocks Phase 02.
NEXT PHASE ENTRY CRITERIA: SATISFIED
```
