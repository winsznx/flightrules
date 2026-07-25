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

## Phase 02 — SigNoz deployment through Foundry (2026-07-25)

### Added

- `casting.yaml` pinning SigNoz v0.134.0, the OTel Collector v0.144.6 and the MCP Server v0.9.0
  by explicit image tag as well as version, with the MCP molding enabled and no secrets.
- Committed `casting.yaml.lock` and the generated `pours/` tree, so a reviewer can see which image
  tags will actually run without installing Foundry first.
- `scripts/bootstrap-signoz.sh` — idempotent first-user setup, `flightrules-mcp` service account,
  `signoz-admin` role assignment, 90-day API key written to a mode-600 `.env`, and a wait for real
  OTLP ingestion rather than a port check.
- `scripts/verify-signoz.sh` — 14 checks across deployment images, API health and version, setup
  completion, MCP probes, authenticated initialize, invalid-key rejection, real OTLP ingestion and
  collector listener state.
- `scripts/verify-reproducibility.sh` — re-forges into a clean directory, diffs against what is
  committed, and asserts every image tag is pinned.
- `scripts/snapshot-mcp-capabilities.mjs` — live tool discovery that fails with `MCP_TOOL_MISSING`
  when any of the 22 required tools is absent.
- `@flightrules/test-fixtures` with casting and generated-deployment tests, plus a SigNoz
  integration suite exercising the MCP server through the official SDK.
- Nine `signoz-*` Makefile targets and a CI job that deploys, bootstraps, verifies, runs the SigNoz
  integration tests and tears down.
- `docs/RUNBOOK.md` covering deployment, bootstrap, endpoints, the operational traps, teardown,
  data reset, key rotation and production notes.

### Changed

- Vitest integration tests split into `integration-db` and `integration-signoz` projects by the
  external service each requires, so CI runs exactly the project whose dependency it provides
  instead of skipping tests.

### Verified

- 110 tests pass (70 unit, 8 database integration, 32 SigNoz integration); nothing skipped.
- Re-forging reproduces `casting.yaml.lock` and `pours/` byte for byte.
- Every running container matches an image tag the casting pins; no `:latest` anywhere.
- An invalid SigNoz API key is rejected, verified as explicitly as the success path.

## Phase 03 — Deterministic demo system (2026-07-25)

### Added

- Five demo services: policy (value-band refund policy), order (fixed dataset), fraud
  (deterministic SHA-256 scoring), payment (refund ledger with idempotency), notification (the
  customer-facing message).
- The refund-agent orchestrator with a provider interface and runtime-validated typed clients.
- `refund-agent-v1`, the approved six-step route, and `refund-agent-v2`, the unsafe four-step
  route that skips policy and fraud and issues the refund twice.
- A real timeout-and-retry path: the payment service commits the write, holds the response past
  the caller's `AbortController` deadline, and the unsafe release retries with a regenerated
  idempotency key, producing two genuine ledger entries.
- Demo-mode-restricted reset endpoints on the agent, payment and notification services.
- One pinned multi-stage `Dockerfile.demo` and six health-gated Compose services.
- `scripts/run-demo-v1.sh`, `scripts/run-demo-v2.sh`, `scripts/reset-demo.sh` and matching
  Makefile targets.
- `packages/domain/src/trace.ts` with the side-effect, edge-type, severity and evaluation-status
  vocabulary shared by instrumentation, the graph engine and the evaluator.

### Fixed

- Duplicate side-effect detection was scoped to the order rather than the run, so twenty
  legitimate baseline runs against one order reported a false duplicate. Now grouped by
  `(runId, orderId)`, with regression tests in both directions.
- `apps/demo-services/*` tests were not matched by the Vitest unit project's include pattern, so
  47 tests were silently uncollected while the suite reported green.

### Verified

- 177 tests pass (137 unit, 8 database integration, 32 SigNoz integration); nothing skipped.
- Against live containers: v1 produces one ledger entry, v2 produces two with distinct idempotency
  key hashes, and both return a byte-identical customer message.
- 20 seeded v1 runs produce zero duplicate side effects; one appended v2 run produces exactly one.

## Phase 04 — OpenTelemetry instrumentation (2026-07-25)

### Added

- `@flightrules/telemetry`: attribute register imported from the installed semantic-conventions
  packages, OTLP trace export, a forbidden-attribute redacting span processor, explicit Fastify
  server-span instrumentation with incoming context extraction, and declared metric instruments
  with their permitted dimension sets.
- Agent run spans and per-step tool spans with release, run, side-effect, data-domain, retry and
  step-category attributes; W3C trace context propagated to every service call.

### Verified

- The v1 run produces a complete 12-span trace across all six services, retrieved from SigNoz.
- The v2 run produces an 8-span trace with the policy and fraud services absent and two write
  spans at retry 0 and 1 — the regression is visible in telemetry alone.
- 193 tests pass; nothing skipped.

### Known limitation

- The timed-out payment attempt's server span is never exported, because the client aborts while
  the handler is still in flight and `onRequestAbort` does not fire for it. Duplicate detection is
  unaffected (both client-side write spans are present). Carried into Phase 06 as an explicit
  trace-quality requirement.

## Phase 05 — SigNoz MCP client and capability layer (2026-07-25)

### Added

- `packages/signoz-mcp`, the single boundary between FlightRules and SigNoz. Nothing downstream
  sees a raw MCP object.
- Typed six-member result union — `SUCCESS_WITH_ROWS`, `SUCCESS_EMPTY`, `UNSUPPORTED_RESPONSE`,
  `MALFORMED_RESPONSE`, `MCP_ERROR`, `TRANSPORT_ERROR` — each failure carrying a PRD section 19
  error code, so "the query failed" can never be read as "the query found nothing".
- Unconditional response normalisation: `structuredContent` first, then every content entry parsed
  individually, with runtime schema validation per payload family.
- Capability discovery against the 22 tools PRD section 16.4 requires, raising `MCP_TOOL_MISSING`
  rather than degrading silently.
- Bounded retry policy that never repeats a request the server already answered, a call timeout, a
  circuit breaker, and redacting structured logging that never records tool arguments.
- Typed wrappers for the trace, discovery, view, dashboard, alert and notification-channel tools,
  and `createAndVerify`, a resource-agnostic implementation of the PRD section 16.5
  list-create-read-back-compare flow.
- 80 unit tests covering all seventeen required response shapes against an injected fixture, and
  21 integration tests against the real pinned server.

### Fixed

- `docs/ACCEPTANCE_MATRIX.md` was never updated for Phase 04, breaching operating-contract rule 23.
  A2, A14 and scope item 7 are now marked `DONE` against their Phase 04 evidence; item 6 is
  `IN PROGRESS` because metrics and logs are declared but not yet emitted.
- A connection race in the transport: capability discovery lists tools and resources concurrently,
  and a boolean guard set after the await let both callers enter the handshake. Found by the
  integration suite on its first run.

### Discovered

- `signoz_execute_builder_query` returns no `structuredContent` on the success path, and a declared
  `outputSchema` does not predict which tools do — the text fallback is mandatory (SL-040).
- A successful response may carry several content entries; the server appends a `[Decisions applied]`
  advisory as a separate entry, and joining entries before parsing corrupts the JSON (SL-040).
- The MCP SDK's own transport declarations are not assignable under `exactOptionalPropertyTypes`
  (SL-041).
- A saved view's `compositeQuery` requires both `queryType` and `panelType`, neither of which
  appears in the tool's input schema, and the create returns the identifier as a bare string
  (SL-042).
- `signoz_get_field_keys`, `signoz_get_field_values` and the list tools use three different
  response envelopes (SL-043).
- Row order is not stable across requests. Phase 06 must sort canonically rather than trust arrival
  order; an integration test guards this.

## Phase 06 — Trace graph and normalisation engine (2026-07-25)

### Added

- `packages/normaliser`: the ten ordered normalisation steps of PRD section 11.6, with a versioned,
  content-hashed configuration. Every fingerprint records the normaliser that produced it, so two
  fingerprints computed under different rules can never be compared silently.
- `packages/trace-graph`: span deduplication by `(trace_id, span_id)`, PRD section 11.4 root
  selection with a synthetic root for orphans, cycle detection, trace-quality classification,
  canonical serialisation, SHA-256 route fingerprints, weighted feature sets with Jaccard
  similarity, the twelve typed graph changes, and a redacted deterministic JSON export.
- `scripts/capture-trace-fixtures.mjs` and `packages/test-fixtures/traces/`: the v1 and v2 demo
  traces captured verbatim from the live deployment through the Phase 05 client, so graph tests run
  against telemetry the instrumented system actually emitted.
- Explicit handling for the Phase 04 aborted server span: a client span with no server span raises
  a `client_span_without_server_span` warning and does **not** downgrade the trace, because the
  duplicate-side-effect evidence lives entirely in the two exported client write spans.
- 84 unit tests including six `fast-check` properties, a 1,000-span performance benchmark and a
  10,000-deep trace, plus 6 integration tests that reconstruct graphs from live SigNoz.

### Fixed

- Canonicalisation nested each child's subtree signature verbatim, so signature length grew with
  subtree size and a 10,000-span trace exceeded the maximum string length. Signatures are now
  fixed-width digests.
- Canonical structural paths were dotted strings whose length grew with depth, making
  canonicalisation quadratic: the 10,000-span test took 5.6 seconds. Replaced with a canonical
  order index; the graph suite now runs in 209 ms.
- `normaliseName` resolved a span named `toString` or `valueOf` through `Object.prototype`. Span
  names are external input, so this was reachable from telemetry. The same pattern was hardened in
  the Phase 05 `readPath` helper.
- The tokeniser split on `-` and `_`, breaking apart the very identifiers it needed to recognise.
- `flightrules_uuid_v7` did not order within a millisecond, so its Phase 01 test failed about one
  run in five and had been passing by luck. Migration `0002` encodes the microsecond remainder per
  RFC 9562 Method 3, and the test now asserts ordering over 200 identifiers rather than two.

### Discovered

- The Query Builder serialises the nanosecond `timestamp` column as an ISO-8601 string at
  millisecond precision, while `duration_nano` keeps full precision (SL-044). Determinism is
  unaffected because timestamps are excluded from the fingerprint, but it independently confirms
  why timestamp order is never treated as causal truth.


## Phase 07 — Contract schema and deterministic evaluator (2026-07-25)

### Added

- `@flightrules/contract-schema` — the versioned contract DSL of PRD section 10. TypeScript types,
  a published draft 2020-12 JSON Schema, safe YAML loading, static validation returning
  `{path, code, message}`, cross-rule contradiction detection, canonical serialisation, a SHA-256
  content hash, and a `flightrules-contract` validation command with PRD FR-012 exit codes.
- An RE2-compatible regular-expression engine for the `matches` operator: a Thompson NFA simulated
  over a state set, so matching is linear in pattern × input and no input can cause backtracking.
  `(a+)+$` against 5,000 characters completes in about 2.5 ms. A 2,000-run property test asserts
  agreement with `RegExp` across the supported subset.
- `@flightrules/contract-engine` — the deterministic run evaluator. `Map`-based query indexes, the
  six selector operators compiled once per run, all eleven PRD rule types, evidence references
  carrying both span IDs and canonical node positions, stable violation identifiers, PRD section
  11.11's evaluation order, canonical evaluation JSON with a SHA-256 hash, and evaluator versioning.
- `contracts/demo-commerce/refund-agent/production/contract.yaml` — the active contract, 15 rules
  covering all eleven rule types.
- 18 per-rule fixture contracts and a span-row builder (`packages/test-fixtures/src/spans.ts`) for
  topologies the demo legitimately never emits.
- `scripts/validate-contracts.sh` and `make contract-validate`, wired into `make verify`.
- ADR-0006 recording the DSL decisions, the determinism boundary and the insufficient-evidence scope.

### Verified

- The exit gate against live telemetry: the committed contract **passes** the approved release and
  **fails** the canary with three critical zero-tolerance violations naming the missing fraud check,
  the missing policy check and the duplicate refund. No LLM participates in any decision.
- The canary's aborted payment handler reports `insufficient_evidence` with reason
  `unobservable_subtree` rather than a violation, while the duplicate-refund finding — whose evidence
  lives in the two exported client spans — still fails the release.
- A run-scoped token budget reports `insufficient_evidence` / `metric_not_emitted` against both live
  traces, because the demo makes no model call.
- Byte-equivalent evaluation output across repeated runs, reordered spans, reordered attribute keys,
  reordered rule declarations and reformatted contract documents. No non-integer number appears
  anywhere in the canonical output.
- Performance: 0.28 ms for the demo canary, 15.6 ms for 1,000 spans, 191 ms for 10,000 spans, and
  15.3 ms for 1,000 spans against the 500-rule DSL ceiling — rule count is nearly free because the
  indexes are built once.
- 674 tests pass (599 unit, 75 integration), 0 failed, 0 skipped. Phase 07 added 290.

### Fixed

- **A telemetry attribute key of `__proto__` replaced a normalised record's prototype** (Phase 06
  code). An array value invoked the inherited setter, after which `evidence.length` and `evidence[0]`
  returned values no span emitted. Reproduced at runtime, then fixed with `Object.create(null)`; the
  attribute is now preserved as ordinary data.
- **`canonicalContract` depended on its caller having sorted the input.** For a parsed contract that
  held, but Phase 08's proposal generator and Phase 09's database rows are producers that do not go
  through the YAML validator, and either would have hashed one policy two ways. Canonicalisation now
  sorts its own input.
- **Ancestry undecidability was scoped too broadly**, conflating a chain truncated by unexported
  spans with one that legitimately ends at a second parentless root. A detached side effect could
  have escaped the rule by being detached.

### Discovered

- **A non-string tag in Query Builder `selectFields` returns `null` unless its `dataType` is
  declared.** The call succeeds with no error, no warning and every other column correct, so an
  attribute vanishes silently and per-column. Caught only because the evaluator reports insufficient
  evidence for an absent attribute instead of passing the rule. (SL-046)
- **`yaml@2.9.0` resolves `!!binary` to a `Buffer` and `!!timestamp` to a `Date` with no error and no
  warning,** and `customTags: []` does not prevent it. An unresolvable tag is only a warning. The tag
  defence therefore walks the document AST rather than reading options or diagnostics. (SL-047)
- `ajv@8.20.0`'s default export cannot compile a draft 2020-12 schema; `ajv/dist/2020.js` can. Used
  as a devDependency for the schema parity test only. (SL-048)
- `[]a]` is a two-member character class in RE2 and an empty class in JavaScript. FlightRules follows
  RE2, as PRD section 10.3 requires. (SL-049)

### Changed

- `@flightrules/trace-graph` now exports `canonicalOrdering`, so the evaluator can resolve a span to
  its canonical node index without reimplementing the sibling ordering. Two copies of that traversal
  would agree until one of them was changed, and then attach evidence to the wrong node.
- The demo contract's token budget is release-scoped rather than run-scoped. A rule that can never be
  decided against the agent it governs is a contract-authoring error, and run scope made the active
  contract unable to pass its own baseline. The insufficient-evidence path is proven by a dedicated
  fixture contract instead.
