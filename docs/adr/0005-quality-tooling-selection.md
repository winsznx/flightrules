# ADR-0005 — Quality tooling selection

- Status: Accepted
- Date: 2026-07-25
- Phase: 01

## Context

The PRD specifies quality **outcomes** — formatting checks, linting, strict type checking,
secret scanning, dependency licence checks, clean-install tests — but names a tool only for
testing (Vitest, fast-check, Playwright). The execution contract requires that where the PRD
specifies an outcome but not a tool, a suitable maintained tool is selected, verified, and
recorded in an ADR.

## Decisions

### Formatting and linting: Biome 2.5.5

One tool replaces ESLint plus Prettier plus their plugin and config packages. That is fewer
dependencies to pin, no formatter/linter rule conflicts to arbitrate, and a single command in CI.
Licence is `MIT OR Apache-2.0`.

Rules deliberately raised above the recommended preset:

| Rule | Level | Why |
|---|---|---|
| `suspicious/noExplicitAny` | error | The operating contract forbids type-error suppression. |
| `suspicious/noConsole` (allowing `error`, `warn`) | error | All application output is structured Pino logging. A stray `console.log` can print a secret to an unredacted stream. |
| `style/noNonNullAssertion` | error | `!` defeats `noUncheckedIndexedAccess`, which is the setting that makes span-array access safe. |
| `correctness/noUnusedImports`, `noUnusedVariables` | error | Dead code hides incomplete work. |

One rule disabled, with reason: `complexity/useLiteralKeys`. It wants `obj.foo` where TypeScript's
`noPropertyAccessFromIndexSignature` requires `obj["foo"]`. The TypeScript setting is the stricter
and more valuable of the two — it forces index-signature access to be visibly different from
declared-property access, which matters when reading untyped span attribute bags — so the lint
rule yields.

`docs/evidence/` is excluded from linting and formatting. Those files are archived proof of what
was actually executed; reformatting them would falsify the record.

### Secret scanning: secretlint 13.0.4 with the recommended preset

Chosen over gitleaks because it installs from the same lockfile as everything else, so a clean
clone gets the identical scanner version with no extra binary in the reproducibility path. Runs
over the whole tree honouring `.gitignore`.

It proved itself immediately: it flagged a PostgreSQL connection string in a test fixture that
had been written purely to assert redaction. The fixture was rewritten to use a non-credential
shape. A scanner that only ever passes is not evidence of anything.

### Dependency licence check: `pnpm licenses list --json` plus `scripts/check-licences.mjs`

pnpm already knows the installed tree, so no extra dependency is needed. The script reads the
**installed** tree rather than manifests, so transitive dependencies are covered, parses SPDX
expressions including `OR`, `AND` and `WITH`, and fails the build on anything outside the
allowlist.

Two non-obvious allowlist entries, both transitive devDependencies of secretlint and never
shipped in a runtime artefact:

- **Artistic-2.0** (`binaryextensions`, `editions`, `istextorbinary`, `textextensions`,
  `version-range`) — OSI-approved and permissive for redistribution.
- **CC-BY-3.0** (`spdx-exceptions`) — an attribution-only data licence over a list of SPDX
  identifiers, not code.

Explicitly denied: AGPL, GPL, SSPL, BUSL and Elastic. FlightRules **deploys** AGPL software
(Foundry, the SigNoz collector) as unmodified upstream containers over network interfaces; it
does not link or redistribute it, so no AGPL obligation attaches to this repository. That
distinction is recorded in the compatibility matrix.

### Dependency vulnerability audit: `pnpm audit --audit-level high`

Built in, no extra dependency. `high` is the failure threshold so the build is not held hostage
by a low-severity advisory in a transitive devDependency, while anything genuinely exploitable
stops the pipeline.

### Test project separation: Vitest projects `unit` and `integration`

Two projects rather than one suite with conditional skips.

`unit` requires no external service and is what `make test` and the CI unit job run.
`integration` requires real PostgreSQL, a real SigNoz stack, or both.

The integration project **throws at import time** when `DATABASE_URL` is missing rather than
skipping. A skipped test that reports green is precisely the false evidence the operating
contract forbids; if the dependency is not there, the run must fail and say why.

### Migration tooling: SQL files with `-- migrate:up` / `-- migrate:down` markers

ADR-0001 selected Drizzle for typed queries. Schema **migration** is handled by a small
in-repository migrator instead of `drizzle-kit generate`, because:

1. The PRD requires rollback of the latest migration to be a tested behaviour. Both directions
   living in one file makes drift between up and down impossible.
2. The Phase 01 schema needs raw DDL — a PL/pgSQL UUIDv7 function, a trigger, and check
   constraints — that a schema-diffing generator does not express well.
3. A committed SQL file is reviewable evidence of exactly what will run against a judge's
   database.

Each migration is checksummed. Editing an already-applied migration is a hard failure rather
than a silent divergence, because that is how a deployed schema stops being reproducible.

Drizzle remains the query layer from Phase 09 onward.

### Identifier generation: `flightrules_uuid_v7()`

PRD section 14 requires UUIDv7 or another sortable format, consistently. PostgreSQL 16 — the
version Foundry already deploys, reused here so the environment has one Postgres major — has no
native `uuidv7()`. The function is implemented in the migration from `gen_random_bytes` with
48-bit big-endian Unix milliseconds, the version-7 nibble and the variant bits, and is tested at
runtime for version nibble, uniqueness and monotonicity.

## Consequences

- One command, `make verify`, runs every gate; CI runs the same commands, so local and CI cannot
  disagree.
- Fewer pinned dependencies than an ESLint/Prettier/gitleaks/license-checker stack.
- The licence allowlist must be revisited when a dependency is added, which is intentional
  friction.
- The migrator is code this project owns and tests, rather than a dependency to trust.
