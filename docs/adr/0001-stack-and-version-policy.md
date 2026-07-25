# ADR-0001 — Stack selection and version policy

- Status: Accepted
- Date: 2026-07-25
- Phase: 00
- Supersedes: none

## Context

PRD section 12.2 states a preferred stack but explicitly requires Claude to "verify current
compatibility before pinning versions". Nothing may be pinned on the basis of memory.

The build machine is macOS 27.0 on `arm64` with Node 24.14.1, pnpm 10.33.0, Docker 29.6.1 and
Docker Compose v5.3.0 already installed.

## Decision

Adopt the PRD's preferred stack, with every version pinned to a value verified on 2026-07-25
and recorded in `docs/research/source-lock.md`.

| Concern | Choice | Version | Why this version |
|---|---|---|---|
| Runtime | Node.js | 24.14.1 | Installed runtime; 24.x is an active LTS line ("Krypton"). Satisfies every dependency's `engines.node`. |
| Package manager | pnpm | 10.33.0 | Installed; PRD requires pnpm workspaces and one canonical lockfile. |
| Language | TypeScript | 7.0.2 | Current `latest`. Verified: a strict project with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` and `nodenext` resolution typechecks cleanly (exit 0). |
| Web | Next.js + React | 16.2.11 / 19.2.8 | Verified: an App Router project typechecks cleanly under TypeScript 7.0.2 with the `next` TS plugin (exit 0). |
| API | Fastify | 5.10.0 | PRD preference; current stable; MIT. |
| Database | PostgreSQL | 16 | Matches the Postgres major that Foundry already deploys for the SigNoz metastore, so one image is reused across the environment. FlightRules uses its own separate instance and database. |
| ORM and migrations | Drizzle ORM + Drizzle Kit | 0.45.2 / 0.31.10 | PRD names Drizzle as the first option and requires "typed, migration-first". Pinned to the stable line, not the `1.0.0-rc` dist-tag. |
| Validation | Zod | 4.4.3 | PRD permits Zod or JSON-Schema-backed validation. Zod is used for runtime boundaries; Ajv 8.20.0 backs the published contract JSON Schema so the contract format stays tool-agnostic. |
| Logging | Pino | 10.3.1 | PRD preference; required for OTel log correlation via `@opentelemetry/instrumentation-pino`. |
| Unit and integration tests | Vitest | 4.1.10 | PRD preference. `engines.node` includes `>=24`. |
| Property tests | fast-check | 4.9.0 | PRD preference. |
| End-to-end tests | Playwright | 1.62.0 | PRD preference. |
| MCP client | `@modelcontextprotocol/sdk` | 1.29.0 | The official SDK, as PRD section 12.2 requires. Verified against the real server. |
| OpenTelemetry | see compatibility matrix | api 1.9.1, SDK 2.10.0, exporters 0.221.0, semconv 1.43.0 | Verified by emitting and exporting a real trace. |
| Job runner | PostgreSQL-backed, in-repository | — | PRD section 12.2 requires "a small job runner backed by PostgreSQL, selected and pinned after verification" and forbids adding Redis without a proven requirement. The workload is a handful of long-running, idempotent, single-node jobs; a `jobs` table with advisory-lock claiming (PRD section 14.15 already specifies the schema, including `idempotency_key` and `attempt`) meets every stated requirement with no extra dependency, no extra service in the reproducibility path, and full control over the idempotency semantics the PRD demands. |

## Version policy

1. Every dependency is pinned to an exact version. No range specifiers in any manifest.
2. One canonical `pnpm-lock.yaml` at the repository root.
3. Container images are pinned by explicit tag, including those Foundry would otherwise float
   to `latest` (see ADR-0002).
4. Dependency changes are made only within the phase that needs them. No broad upgrade sweeps.
5. Any version change requires a source-lock entry recording what was re-verified.

## Consequences

- Positive: the whole stack was proven to work together before a line of product code existed.
  The riskiest pin (TypeScript 7, a compiler rewrite) was validated against the heaviest
  consumer (Next.js App Router) rather than assumed.
- Positive: no Redis, no message broker, no extra service in the reproducibility path.
- Negative: TypeScript 7 is new. `skipLibCheck` stays enabled so a third-party declaration file
  cannot block the build. If a specific library's types prove incompatible later, the fallback
  is TypeScript 5.9.3 and this ADR will be superseded with the evidence.
- Negative: an in-repository job runner is code we own and must test. Mitigated by the fact
  that its correctness properties (idempotent replay, no false pass after worker error) are
  already mandatory PRD test obligations regardless of which runner is used.

## Alternatives considered

- **TypeScript 5.9.3.** Rejected as the default because 7.0.2 was verified to work; keeping the
  older compiler would have been an unverified assumption in the opposite direction.
- **Prisma instead of Drizzle.** Rejected: the PRD names Drizzle first and Prisma's engine
  binary adds a platform-specific artefact to the reproducibility path.
- **BullMQ or pg-boss for jobs.** BullMQ requires Redis, which the PRD forbids without a proven
  requirement. pg-boss was a genuine candidate; rejected because the PRD already specifies the
  exact `jobs` table shape, so an external runner would mean maintaining two job models.
