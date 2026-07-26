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

## Phase 09 — Application core, API, jobs, and persistence (2026-07-25)

### Added

- `packages/db/migrations/0003_application_core.sql` — the thirteen remaining P0 tables of PRD
  section 14, completing the sixteen: `agents`, `releases`, `jobs`, `trace_runs`, `trace_graphs`,
  `baseline_versions`, `route_families`, `contracts`, `contract_rules`, `evaluations`,
  `run_evaluations`, `violations`, `signoz_artifacts`. Every closed vocabulary is a check
  constraint, every percentage is tied to its own counts by a check, and one active contract per
  agent and environment is a partial unique index.
- `packages/db` repositories for all sixteen tables, canonical JSON for every `jsonb` write,
  canonical-graph restoration on read, cursor pagination over the UUIDv7 key, the
  schema-compatibility check both applications refuse to start without, and the shared job input
  contract.
- `apps/api` — Fastify. Every Phase 09 route of PRD section 15, the typed error envelope with an
  exhaustive code-to-status map, bounded request identifiers, structured redacted logging, the
  body-size limit, and an OpenAPI document generated from the same route declarations that serve
  the traffic.
- `apps/worker` — race-safe claiming through `for update skip locked`, leases with heartbeats and
  recovery, monotonic progress events, result commit inside the transaction that marks success,
  retry classification, cancellation and graceful shutdown; four job handlers that call the
  existing deterministic packages rather than reimplementing them.
- Metric emission (PRD section 17.4, FR-016): `packages/telemetry` now creates a meter provider and
  a typed recording surface whose dimensions are filtered against the declared spec.
- `docs/adr/0008-application-core-persistence-and-jobs.md`.
- 132 tests: 32 unit, 94 database integration, 6 live SigNoz — including two-connection concurrency
  tests, atomic-commit tests that deliberately crash, lease recovery, and the full end-to-end gate.

### Changed

- `packages/domain` gains `NOT_FOUND`, `VALIDATION_FAILED` and `STATE_TRANSITION_INVALID`. PRD
  section 19 opens with "Required error codes **include**" and names these outcomes as ones the API
  must distinguish; ADR-0008 decision 10 records the addition, and a test pins the PRD's own
  twenty-three first and unchanged.

### Verified at runtime

- 76 live `refund-agent-v1` runs mined through the job system into one route family at
  `43070aa4…`, persisted with 80 trace runs and 80 canonical graphs in one transaction.
- A 28-rule draft contract proposed from the reviewed baseline, accepted by the Phase 07 validator,
  stored with every rule's evidence basis, then approved and activated.
- A fresh v1 evaluation passed with 0 violations; the canary failed with 40 violations including 12
  zero-tolerance, every one resolvable to its trace evidence through the API.
- A repeated identical submission returned the same job; a restarted API served every result.

## Phase 08 — Baseline mining and contract proposal (2026-07-25)

### Added

- `packages/baseline-miner` — turns known-good SigNoz traces into deterministic route families and a
  reviewable contract proposal. Storage-independent, because PRD sections 14.7 and 14.8 are Phase 09.
- Trace selection job with PRD section 8.7's controls validated, PRD section 8.7's five progress
  states, a selection hash that doubles as the job's idempotency key, and a baseline identifier
  derived from it rather than generated.
- Bounded batch retrieval through the supported MCP Query Builder path: field types confirmed against
  the live catalogue before any mining query runs, offset paging with truncation detected from
  `nextCursor`, complete span-tree fetching with every non-string tag's `dataType` declared, and
  returned values re-checked per row against the declared type.
- Fifteen typed exclusion reasons, one for each way a retrieved trace can fail to qualify, with counts
  that must reconcile exactly or mining fails.
- Exact route-family grouping by fingerprint (PRD section 11.8), per-family statistics, representative
  selection by proximity to the family's median duration, and rare marking against a configurable
  threshold.
- Integer statistics with nearest-rank percentiles and exact fractional ratios, so no floating-point
  value reaches the mining output.
- The four route-family review actions of PRD section 8.8, as pure state transitions that refuse a
  baseline whose dataset was truncated or whose run count is below the minimum.
- Rule proposal across nine rule types from nine distinct evidence bases, with an evidence basis,
  support ratio, sample size, outlier list and human-confirmation flag on every proposed rule.
- Deterministic draft YAML generation whose round trip through the public parser is proven by content
  hash, carrying the evidence for every rule as a comment beside it.
- `scripts/mine-demo-baseline.mjs` and `make mine-demo-baseline`, which reproduce the whole Phase 08
  runtime validation in one command.
- ADR-0007 recording the fifteen decisions behind the miner.
- `renumberTrace` in `@flightrules/test-fixtures`, which rewrites a captured trace into a distinct
  logical run by changing only what varies between two runs of identical behaviour.

### Verified

- 34 fresh `refund-agent-v1` runs retrieved live and mined into **one** route family at fingerprint
  `43070aa4af4f6c2c912a8d7bcc724f1d199e0425dc8ad7256b528eec195cb037` — the fingerprint the committed
  Phase 07 contract already approves, so neither is a stale constant.
- The generated 28-rule draft contract is accepted by the Phase 07 validator through the published
  `flightrules-contract` CLI and round-trips to the same content hash.
- A freshly executed known-good run passes the generated contract with 0 violations; the canary fails
  it with 10 violations including three critical zero-tolerance ones naming the missing policy check,
  the missing fraud check and the duplicate refund.
- The canary's aborted payment handler reports `insufficient_evidence` with reason
  `unobservable_subtree` rather than a skipped step, and the duplicate refund still fails — one local
  telemetry gap does not suppress a real finding.
- Repeated mining over one window produces a byte-identical baseline identifier, content hash and YAML.
- 953 tests pass (862 unit, 91 integration), 0 failed, 0 skipped. Phase 08 added 279.
- `make verify`, `make signoz-verify` and `make contract-validate` all exit 0; 20 contract documents
  valid, the twentieth being the one the miner generated.

### Discovered

- `nextCursor` is empty exactly when a Query Builder page is **not full**, and a non-empty opaque token
  when it is — including when the requested limit happens to equal the total row count. That is the
  only truncation signal the pinned server offers (SL-050).
- `signoz_get_field_keys` returns the whole trace field catalogue in one response with a
  `fieldDataType` per field, so the server can confirm the type a request should declare — which closes
  SL-046 by discovery rather than by a hand-maintained list. It omits `timestamp`, omits every resource
  attribute, and reports custom span attributes as `attribute` where `selectFields` needs `tag`
  (SL-051).

### Fixed

- The proposal generator prefixed a route fingerprint with `sha256:` twice, so the generated document
  carried `sha256:sha256:<hex>` and the validator rejected it. A proposed rule now holds the validated
  bare form the evaluator compares against, and the prefix is added once by the document renderer.
- A rule identifier was derived from the raw canonical label while its selector was derived from the
  sanitised one. For a label carrying a control character the two disagreed, and two labels that
  sanitise to one selector value would have produced two rules governing the same spans. Both now
  derive from one sanitised name, and where two labels collide neither gets a rule — a selector can
  only say `name: X`, so refusing and disclosing is the only answer that is not wrong.

### Deliberate

- A proposal is broader than a hand-written contract: 28 rules and 9 zero-tolerance identifiers against
  the demo, where the Phase 07 contract has 15 and 4. Every rule is evidence-backed and a reviewer is
  expected to prune. `order.lookup` becoming a critical prerequisite is the clearest case — every
  approved run did look the order up before refunding.
- A cardinality bound is the 95th percentile of the observed per-run counts when the maximum exceeds it,
  so an outlying duplicate side effect is disclosed rather than encoded as permitted policy. Reading
  PRD FR-008's "maximum observed cardinality" literally would have permitted the exact fault the
  product exists to catch.
- A step is proposed as required only when every observable approved run performed it. A step present in
  some runs and provably absent in others is bounded and disclosed as optional, never required — a
  proposal must not contain a rule its own baseline violates.
- `forbidden_span` and `forbidden_path` are never proposed. Neither can be derived from observation:
  naming a data domain the agent never touched would be an invention rather than a finding.
- A retried side effect's allowance is never widened by a safety margin, whatever the margin is set to.

## Phase 10 — SigNoz artifact compiler (2026-07-25)

### Added

- `packages/artifact-compiler` — the deterministic compiler. `names.ts` builds PRD section 16.8's
  managed names and rejects a segment that could forge or split one; `queries.ts` holds the typed
  field references and filter expressions; `views.ts`, `dashboard.ts`, `alerts.ts` and
  `channels.ts` build FR-013's four saved views, FR-014's ten-panel dashboard and FR-015's four
  alerts plus the notification channel; `compile.ts` produces the ordered artefact set with a
  `spec_hash` each and a plan hash over all of them; `plan.ts` decides create, update, unchanged,
  recreate, conflict and stale; `verify.ts` compares a read-back against the intended specification
  and reduces the verdict to something safe to persist.
- `apps/worker/src/artifact-sync.ts` — the MCP conversation. Lists before writing, writes, reads
  back by identifier, compares the material fields, and records the verdict. Contains no algorithm.
- The `signoz_sync` job handler, emitting `flight_rules.compile_signoz_artifacts` and
  `flight_rules.signoz_artifact_sync`.
- `POST /api/contracts/:contractId/sync-signoz` and `POST /api/setup/signoz/sync-artifacts`, the two
  routes deferred from Phase 09. `GET /api/setup/signoz/artifacts` now returns the verification
  verdict, the operation performed, the drift state and a summary.
- Migration `0004`: `signoz_sync` as a job type, `conflict` as an artefact status, and
  `contract_id`, `last_operation`, `sync_attempt`, `verification_json` and `last_error_json` on
  `signoz_artifacts`.
- `packages/signoz-mcp`: update, delete and notification-channel operations, a create-channel
  reader that captures the server's own delivery test, and a permissive delete reader.
- ADR-0009 — SigNoz artifact compilation, ownership and verification.
- Source-lock entries SL-053 … SL-059.

### Fixed

- **No FlightRules metric had ever reached SigNoz.** `bootstrapFromEnv` never opened a metric
  pipeline, so both applications ran with the API's no-op meter and every `flight_rules.*`
  recording was silently discarded (SL-053). Six FR-014 panels and all four FR-015 alerts depended
  on those metrics.
- **`flight_rules.duplicate_side_effects` was declared and never recorded.** A deterministic
  classifier now lives in `packages/contract-engine`: an over-cardinality violation against a rule
  whose selector pins it to a write or an external call.
- **PRD section 17.3's evaluator spans were declared and never created.** The worker now emits
  `flight_rules.evaluate_release` and `flight_rules.evaluate_run`.
- The acceptance matrix's Phase 09 claims about exported metrics and duplicate-side-effect
  recording were false. Corrected, and now true.

### Verified

- 961 unit tests and 209 integration tests pass; 1,170 total, 0 failed, 0 skipped.
- A contract activation produced ten managed SigNoz resources through MCP, each read back and
  field-compared. A second identical sync created none and updated none.
- A resource deleted by hand is recreated; one replaced by hand is adopted and restored; one of a
  managed name FlightRules does not own returns a conflict and is left untouched; a superseded
  artefact is reported stale rather than deleted.
- A real canary evaluation — 14 runs, 140 violations, 42 zero-tolerance — drove the
  `Violation Rate Alert` and the `Duplicate Side Effect Alert` to `firing` within two evaluation
  cycles. Alert history records the transition.
- The four saved views return real evaluated canary runs with typed values, not nulls.

### Known limitations

- `signoz_update_view` corrupts stored data and breaks the tenant's whole view list in the pinned
  version (SL-057). Saved views are replaced by delete-then-create; the defect is recorded, not
  worked around silently.
- Alert **recovery** is not yet evidenced: the canary keeps violating, so the rate alert has not
  crossed back below its recovery target.
- Notification **delivery** is not verified. The default destination is a local webhook nothing is
  listening on, and SigNoz's own test notification failure is recorded rather than hidden.
- Panel 8, "Token usage baseline versus canary", is an honest empty series: the demo agent emits no
  `gen_ai.usage.*` attribute.
- Logs are still not exported over OTLP.

## Phase 11 — Release evaluation, CLI, and GitHub gate (2026-07-25)

### Added

- `packages/contract-engine/src/release.ts` — the pure, deterministic release aggregation of
  FR-011 and FR-012. No I/O and no clock read: `nowMs`, the aggregation window, the retrieval state
  and the contract's lifecycle status all arrive as inputs. Produces evaluated, passed, failed,
  errored and undecidable run counts; violation, unknown-route, duplicate-side-effect and
  missing-prerequisite rates as exact fractions; latency, token and retry change from baseline;
  route-family coverage; typed findings; typed disclosures; and the gate decision.
- Release-scoped `numeric_budget` and `cardinality` rules, deferred at run scope since Phase 07,
  are now decided from the samples every run already contributed (PRD section 11.11).
- `packages/contract-engine/src/exit-codes.ts` — the FR-012 exit-code table, exported from the
  engine so the API, the CLI, the workflow and the tests all derive the same number from the same
  decision.
- `packages/trace-graph/src/measure.ts` — `retryCountOf`, which reads attempt indices from a stored
  canonical graph rather than adding a field to the evaluator's canonical output.
- `packages/db/src/repositories/gate.ts` — the gate's reads: the newest completed release-scoped
  evaluation, its per-run records joined to their trace runs and canonical graphs, and the
  count-weighted baseline reference built from **approved** route families only.
- `GET /api/releases/:releaseId/gate` — a read that runs no job and writes no row. Idempotent apart
  from `retrievedAt`, and identical from a restarted API. Emits `flight_rules.release_gate` and
  `flight_rules.release_gate.decisions`, both declared since Phase 04 and never previously called.
- `apps/cli` — the six PRD commands (`config verify`, `contract validate <path>`,
  `baseline capture`, `release evaluate`, `gate check`, `evidence export`), a `--json` mode that
  emits exactly one validated document on stdout, progress confined to stderr, and the documented
  exit codes. The CLI refuses to report a decision when the server's exit code disagrees with its
  own mapping.
- `.github/workflows/release-gate.yml` — a clean checkout, the pinned toolchain, the lockfile, a
  real SigNoz deployment through Foundry, real telemetry, a mined contract, and the gate. The canary
  step asserts exit code `2` specifically. Evidence and logs upload `if: always()` and cannot change
  the result.
- `scripts/seed-demo.sh` and `scripts/seed-demo.mjs` — PRD section 13 named this file and it had
  never been written. Drives an empty database to an active contract and synced artefacts entirely
  through the API.
- `scripts/demo-full.sh` and `make demo-full` — the whole demo in one command, asserting the two
  exit codes.
- `make cli`, `make gate`, `make gate-json`, `make evidence`, `make demo-seed`.
- `docs/adr/0010-release-aggregation-and-exit-codes.md`.
- `docs/evidence/phase-11/cli-inventory.md`, written before the CLI was implemented.

### Changed

- `make signoz-purge` now also clears the project's artefact register rows and its completed
  `signoz_sync` jobs. Without that, the documented purge-then-sync recovery could not work: the
  sync job is idempotent on the contract's content, so a request after a purge returned the previous
  job's cached conflict result and nothing was ever recreated.
- The CLI's `field` renderer separates a label longer than its column from its value.

### Fixed

- **The domain redactor destroyed FlightRules' own token measurements.** `/token/i` matched
  `maxTokenRegressionPercent` and `tokens`, so the live gate returned
  `"maxTokenRegressionPercent": "[redacted]"` — a security control silently corrupting part of a
  release decision. "token" is both a credential noun and this product's unit of LLM usage. Fixed
  with an exact-name allowlist of the measurement keys FlightRules emits, rather than a looser
  pattern that would also admit `access_tokens`. Tests assert `accessToken`, `refresh_token`,
  `bearerToken`, `id_token`, `session_token`, `token` and `API_TOKEN` still redact.

### Judgement calls

- Decision precedence is `error > fail > insufficient_data > pass`. A proven zero-tolerance
  violation in three runs outranks the absence of a twentieth run; reporting "insufficient data"
  there would downgrade the finding the product exists to surface. The live canary shows both
  `MIN_RUNS_NOT_MET` and `ZERO_TOLERANCE_VIOLATION`, and decides `fail`.
- A release-scoped budget that **no** run reports is `not_measured` and disclosed; one that **some**
  runs report is `insufficient_evidence` and makes the release `insufficient_data`. Neither is a
  pass.
- The violation rate is over failing **runs**, not violations, so one run with forty findings cannot
  outweigh forty runs with one each.
- `release evaluate` exits `0` for an evaluation that completed, whatever it found. Deciding is
  `gate check`'s job.
- Regression is measured against approved route families only, count-weighted by occurrence.

## Phase 12 — UI foundation and `design.md` integration (2026-07-25)

### Added

- `packages/ui` — the design system and the product's primitives. `tokens.css` is `design.md`'s own
  Quick Start block copied verbatim, sixty-nine declarations unchanged, plus nine semantic aliases
  that introduce no value. `base.css` is the shell, written entirely in `var(--…)` with no literal
  colour, size or font of its own.
- `packages/ui` components: app shell furniture, page header, section, card, the single clay
  featured block, dark band, stat, status pill, table with a required caption and a declared empty
  state, key-value list, form field with wired label and error association, dialog, skeleton, and
  the loading, empty, error, degraded and success states.
- `packages/ui/src/graph-table.tsx` — the canonical graph as an ordered table (PRD section 20.3).
  It is the route's normal rendering, not a fallback.
- `apps/web` — a Next.js 16.2.11 App Router application implementing every route in PRD section 8,
  all fourteen, each rendering live API data with its own loading, empty, error and degraded states.
- `apps/web/src/lib/copy.ts` — every literal string PRD section 8 fixes, in one module, asserted
  against `docs/PRD.md` by a test.
- `apps/web/src/lib/api.ts` — the application's only outward connection, `server-only`, validating
  every response against a declared schema and checking the content type before reading a field.
- `scripts/check-design-assets.mjs` and `make scan-design`, wired into `make verify`: every token
  `design.md` declares must be present with the same value, and `base.css` must contain no literal
  colour.
- `GET /api/route-families/:familyId`, which PRD section 8.8's page requires and PRD section 15.5
  does not list. Recorded in ADR-0011.
- `packages/db` `findRouteFamilyById`.
- `make web`.
- `docs/adr/0011-design-token-mapping.md`, `docs/evidence/phase-12-plan.md`.

### Judgement calls

- **Status is a word, never a hue.** `design.md` forbids additional accent hues and permits one
  `#bc7155` element per page; PRD section 20.3 requires that status is not conveyed by colour alone.
  Both are satisfied by rendering `PASS`, `FAIL`, `INSUFFICIENT DATA` and `ERROR` as uppercase words
  in a hairline pill, with emphasis carried by border weight. There is no green and no red anywhere
  in the product.
- **Clay appears once per page**, on the thing the page exists to say: the landing call to action,
  and the Release Diff decision banner.
- **Every page is a Server Component and no route file contains `use client`**, so no product state,
  API location or credential reaches the browser (PRD section 12.3). A test asserts it.
- **The graph table is the canonical rendering**, not a degraded mode.
- **The landing schematic is labelled as illustrative in words**, and no authenticated route
  contains a drawn graph (PRD Phase 12's design constraints).

### Known toolchain limitation

- **Next.js 16.2.11's built-in TypeScript step cannot drive TypeScript 7.0.2** (SL-060). It fails to
  detect it, reinstalls it on every build and crashes the build worker. `apps/web`'s `build` script
  runs `tsc -p tsconfig.json --noEmit` before `next build`, so the application is fully typechecked
  under the workspace's strict configuration — it rejected six `exactOptionalPropertyTypes`
  violations in the first draft of these routes — and only the broken integration is bypassed.

## Phase 13 — Baseline and Contract Studio UI (2026-07-26)

### Added

- `packages/contract-schema/src/edit.ts` — PRD section 8.9's eight graph rule controls, each a
  deterministic transformation of the stored YAML document. Every transformation is re-read through
  `parseContract` before it is returned, so a control cannot produce a document the Phase 07
  validator rejects. `controlStateOf` reads control state back out of the document, which is the
  other direction of the bidirectional requirement and the reason the graph and the YAML cannot
  drift: there is one document, not two models.
- The baseline capture workflow, live: the eight controls submit a Server Action, the job identifier
  goes in the URL, and the page renders the job's persisted stage and event list on every server
  render.
- The rejected-trace summary: totals, eligible, excluded, duplicates, exclusions grouped by stable
  reason, per-trace exclusions with quality warnings, disclosures, truncation state, untrusted typed
  attributes, and an explicit reconciliation line.
- PRD section 8.8's four review verbs as Server Actions, shared by the baseline page and the route
  family page, each writing its audit event and each re-read before the next render.
- The Contract Studio's six actions: validate, approve, activate, sync to SigNoz, export YAML and
  evaluate. Approval and activation are guarded on the server against the stored document.
- `components/yaml-editor.tsx`, `components/submit-button.tsx` and `components/auto-refresh.tsx` —
  the application's only three client components.
- `contracts/[contractId]/export/route.ts`, so `Export YAML` downloads the stored document without
  exposing the API's address to the browser.
- `@playwright/test@1.62.0` (SL-034, Apache-2.0), `playwright.config.ts` at three viewports, and
  `tests/e2e/phase-13-workflow.spec.ts` — the PRD's exit gate as twenty-three executable steps
  against the running product.
- `make test-e2e`.

### Changed

- `make test-integration`, `make test-integration-db`, `make test-integration-signoz` and
  `make test-e2e` now source `.env`. Without it every SigNoz integration file failed at import with
  `SIGNOZ_API_KEY must be set` — a green-looking "no tests ran".
- The Phase 12 assertion that no route file contains `use client` is replaced by five stronger ones:
  no route file is a client component; exactly three client modules exist, named; no client module
  fetches, subscribes or imports the server-only API client; every client module is under 160 lines;
  and the design-token rule applies inside client components too.

### Fixed

- **An action's redirect appended `?job=…` to a URL that already carried a query string**, so the
  job identifier was swallowed by the first parameter's value and a proposal's progress never
  appeared. `outcomeUrl` now merges through `URLSearchParams` and is the only way an action builds a
  redirect.
- **The approve guard trusted a query parameter.** It now revalidates the stored document server-side
  and requires both `valid` and `contentHashStable`, so the address bar cannot approve an unvalidated
  contract.
- The accessibility assertion no longer demands a label on `type="hidden"` inputs, which are not in
  the accessibility tree.

### Discovered

- **A demo reset alone is not a clean state.** `POST /api/demo/reset` clears the FlightRules database
  and leaves SigNoz untouched by design (FR-020), so the ten managed resources outlive the register
  rows that recorded owning them and the next sync correctly refuses to adopt them — ten conflicts,
  zero verified. A genuinely clean start is `make signoz-purge` **then** the reset. The browser suite
  does exactly that, and `docs/DEMO_SCRIPT.md` says so.
- A long-running API or worker process can outlive its own `dist`. Both had to be restarted before a
  route registered since Phase 12 appeared in `GET /api/openapi.json`.

## Phase 14 — Release Diff UI (2026-07-26)

### Added

- `GET /api/releases/:releaseId/diff`, closing the Phase 12 handoff's unresolved limitation 1. A
  read: no job, no trace fetch, no row written. It compares the release's representative run against
  the approved route family the **evaluator itself** judged it nearest to, using the deterministic
  engine, and returns the twelve PRD section 8.11 change labels. A release with no completed
  evaluation returns `RELEASE_INSUFFICIENT_DATA` rather than an empty diff.
- `diffCanonicalGraphs` in `@flightrules/trace-graph`, extracted from `diffGraphs` — which only ever
  used the raw graph for span-ID lookup. The database stores only canonical graphs, so this is what
  lets the diff read persisted evidence rather than re-fetching two traces from SigNoz. All fifty
  existing tests pass unchanged.
- `packages/signoz-mcp/src/web-url.ts` — browser-reachable SigNoz links, built from a runtime-verified
  path and the operator's configured origin (SL-061).
- `apps/web/src/components/graph-diff.tsx` — the narrative in sentences, the side-by-side ordered
  comparison, and the typed change list. Rendering only; the page contains no comparison code.
- Decision filters on the releases list, as links, so every filtered view is a URL.
- `releases/[releaseId]/evidence/route.ts` — the evidence download, assembled from the gate decision
  and the diff so it can carry nothing they do not.
- `reEvaluateRelease` — the `Re-run evaluation` action. The decision is never updated optimistically:
  the gate reads the most recent *completed* evaluation, so the previous decision stands until the
  new job finishes and the prior evidence is preserved either way.
- `listApprovedRouteGraphs` and `listCandidateRunGraphs` in `@flightrules/db`.
- A `workflow` Playwright project, declared last, holding the destructive Phase 13 exit-gate spec.

### Fixed

- **Every `trace_runs.signoz_web_url` was `null`, so no SigNoz link worked** — PRD section 8.11's
  `Open in SigNoz`, FR-017's evidence linking and acceptance A9 all depended on one. The cause is
  SL-061: the builder query FlightRules must use for custom attributes returns no `webUrl` at all,
  and the URL `signoz_get_trace_details` does return names SigNoz's internal container host, which no
  browser can resolve. Links are now built as **SigNoz's path, the operator's origin**.
- **The browser suite was not isolated.** Phase 13's workflow spec resets the demo, correctly, and ran
  before the read-only specs — failing twenty of them for a reason unrelated to what they assert.
  Destructive and read-only specs are now separate Playwright projects with the destructive one last.

### Discovered

- **A running worker steals the integration suite's queued jobs.** `runner.integration.test.ts`'s
  shutdown test expects one job to remain queued; a worker sharing the database claims it first.
  Stop the worker before `make test-integration`.

## Phase 15 — Violation Inspector UI (2026-07-26)

### Added

- `GET /api/violations/:violationId/logs` — logs correlated to a violation's trace through SigNoz
  MCP, **fetched on request**. Correlation is by the evaluator's recorded trace identifier, never by
  a time window or a service name, and an identifier that is not 32 lowercase hex characters is
  never sent. Every failure mode PRD Phase 15 lists returns HTTP 200 with a typed state.
- `GET /api/violations/:violationId/metrics` — the downstream metric evidence, with the **kind of
  claim** as a field: `measured`, `observed side effect`, `inferred risk`, `unavailable`. PRD Phase
  15 forbids a fabricated financial-loss figure and forbids inferring an effect telemetry does not
  prove, so the claim type is part of the response rather than a caption.
- `metricSeriesPayloadSchema`, `metricSeriesReader` and `metricPointsOf` in `@flightrules/signoz-mcp`,
  and `SigNozOperations.queryMetrics`.
- `apps/web/src/lib/evidence-summary.ts` — the deterministic, safe, copyable summary, assembled from
  fields that carry no prompt, tool payload, credential or customer field.
- `apps/web/src/components/copy-button.tsx` — the fourth and last client component. The summary is
  also rendered in a read-only textarea, so the clipboard is an accelerator and never the only route
  to the text.
- Evidence highlighting restricted to canonical indices the deterministic evaluator named; the
  approved comparison graph; and trace-quality warnings rendered as context rather than findings.

### Fixed

- **The evidence table paired labels with canonical nodes by index**, so the duplicate-refund
  violation — one label, two nodes — silently dropped half its own evidence. Labels, canonical nodes
  and span identifiers are now rendered as the three independent lists they are.
- **A metric with real data reported as "no series exists"** (SL-062). The shared reader counts
  `rows`; a metric answer has none. Fixed with a reader that counts observations.
- **The metric filter matched nothing while the data was real**: the series carry the FlightRules
  dimensions with empty values. The route now groups rather than filters, and states when the series
  is deployment-wide rather than narrowed to the agent.
- **A control character in telemetry could forge a line in the evidence summary.** Neutralised
  before assembly, asserted by a test that attempts exactly that forgery.

### Discovered

- **SL-062** — `signoz_query_metrics` answers in a time-series shape with dimensions as an array of
  `{key: {name}, value}`, not the `rows` shape every other builder query uses, and in this
  deployment the FlightRules dimensions come back named with empty values.

## Fix — the worker exited silently when idle (2026-07-26)

### Fixed

- **`JobRunner.loop()` unref'ed its idle poll timer, so the worker exited on its own whenever it had
  nothing to do.** An unref'ed timer does not keep the Node event loop alive, and while idle that
  timer is the only pending handle — `postgres.js` closes idle connections and takes its sockets with
  them. Node drained the loop and exited with `await runner.loop()` still pending, reporting
  "Detected unsettled top-level await" and exit code 13.

  The failure is silent: nothing is logged, the exit code is not 1, and every job before it
  succeeded. Afterwards every submitted job sits `queued` with nothing to claim it. This is the
  symptom hit during Phase 13, where a browser baseline capture stayed at `QUEUED`.

  Proven against the built worker: idle for 6m 08s with zero jobs claimed and the process still
  alive, then five jobs claimed when `make demo-full` submitted work, reproducing exit 0 then exit 2.

  The two other `unref()` calls in the worker are correct and unchanged: the lease heartbeat and the
  shutdown timeout each have something else keeping the process alive while they run.


## Phase 16 — Hardening, performance, and adversarial validation (2026-07-26)

### Added

- `packages/contract-engine/src/incomplete.test.ts` — 16 cases covering a missing root, a missing
  parent, a parent link into another trace, a self-parented span, contradictory duplicate records,
  every prefix of a head-sampled trace, an orphaned leaf, and a missing release, run, service or
  operation identifier. Each asserts that a gap in the telemetry becomes a violation the evidence
  supports or an explicit "cannot decide" — never a pass.
- `packages/contract-engine/src/missing-attributes.test.ts` — 51 cases putting every
  attribute-reading rule in front of the nine ways a value can fail to be the expected one: absent,
  `null`, `false`, `0`, empty string, wrong type, negative, out of range, and the `null` SL-046
  produces from an omitted `dataType`.
- `apps/worker/src/artifact-races.integration.test.ts` — 17 cases against real PostgreSQL: repeated
  syncs, concurrent syncs, a create whose response was lost, a register commit that failed after the
  remote create, unmanaged name conflicts, a resource deleted, renamed or edited by hand, a stale
  resource from a superseded contract, and two syncs racing through the saved-view
  delete-and-recreate.
- `apps/worker/src/signoz-outage.integration.test.ts` — 14 cases interrupting SigNoz before the
  first call, during a list, between a create and its read-back, during trace discovery, mid
  pagination and during a trace fetch, as a transport failure, a declared error, an empty response
  and the SPA shell of SL-012.
- `@flightrules/signoz-mcp/testing` — an in-memory MCP transport reproducing the pinned server's
  response envelopes, including SL-056's per-type identifier and name keys and SL-058's non-uniform
  delete responses. Used only by tests; every layer above the socket is the product's own.
- `packages/db/src/advisory-lock.ts` — `withAdvisoryLock`, a named cluster-wide exclusion on a
  reserved connection, and `artifactSyncLockKey`.
- `jobQueueDepth` in `packages/db`, surfaced by `GET /health/dependencies` as `jobs.status`,
  `queued`, `running`, `oldestQueuedSeconds` and `expiredLeases`, with `JOB_STALLED_AFTER_SECONDS`.
- `scripts/verify-alert-lifecycle.mjs` and `make verify-alerts` — every managed alert's
  configuration, firing transition, recovery transition and post-cycle configuration, read from
  SigNoz's own alert history.
- `scripts/verify-fresh-machine.sh` and `make verify-fresh-machine` — a clone outside the working
  tree, from committed files only, through fifteen stages to the two gate exit codes.
- 12 further worker lifecycle cases: lease expiry, stale-job recovery, a crash after the claim, a
  lease lost mid-run, no duplicate committed output, and shutdown while idle.

### Fixed

- **A negative `agent.retry.number` subtracted from the retry budget.** A run of nine retries and
  one mislabelled span reporting −5 totalled four against a limit of four and reported a clean run.
  A negative attempt index is not an attempt index; the normaliser now rejects it, which also
  protects the release-level summed retries.
- **The CLI printed terminal control sequences it received from telemetry.** A span name carrying
  `ESC [ 2 J ESC [ 1 ; 1 H PASS…` cleared the reader's screen and reprinted the opposite verdict.
  Every line the CLI writes now passes through a filter applied once at the entry point.
- **A hostile release key escaped the evidence download's `content-disposition` filename.** A quote
  closed the `filename` parameter; a newline was a header injection. The key is reduced to a
  filename segment and still travels intact inside the bundle.
- **`assertNameSegment` accepted the C1 control range**, so `0x9b` — a control-sequence introducer
  on its own — was a legal managed resource name segment.
- **Two concurrent syncs of one agent created duplicate saved views.** The register was written
  outside any exclusion, so a waiting sync could plan from a register that predated the one it was
  waiting for. Read-register, sync and persist-register now run under a per-agent advisory lock.
- **A managed artefact edited by hand was recreated rather than replaced**, leaving two resources of
  the same managed name. Drift is now distinguished from a stale identifier and replaces in both
  cases.
- **The documented SigNoz bootstrap password fails intermittently, and in CI it failed always.**
  SigNoz v0.134.0 requires at least 12 characters with an uppercase letter, a lowercase letter, a
  digit and a symbol, and states the policy only in the rejection body. `openssl rand -base64 18`
  satisfies it by luck; `ci-<run_id>`, which both workflows supplied, never does — so the
  release-gate workflow could not have passed on its first GitHub run. Every documented command now
  appends `Aa1!`, both workflows use a compliant value, and `bootstrap-signoz.sh` checks the policy
  before calling SigNoz.
- **`make signoz-bootstrap` failed on a fresh deployment with `Error 22` and no other information.**
  `/api/v1/health` reports ok before `/api/v1/register` is servable, and `curl -sf` discards the
  response body on an HTTP error — which is what hid the password policy above. Registration is
  retried for two minutes and the body is printed.
- **`make signoz-verify` passed while the SigNoz credential was still `replace-me`.** `initialize`
  succeeds against the MCP server without the credential ever reaching SigNoz. It now makes a real
  authenticated tool call, so a deployment it declares healthy is one whose key works.
- **`ci.yml`'s database job migrated without building**, so it would have failed with
  `ERR_MODULE_NOT_FOUND` on its first GitHub run for the same reason a clean clone did.
- **`make db-migrate` failed on a clean clone** with `ERR_MODULE_NOT_FOUND`: the migrator imports
  `@flightrules/domain` by its package entry point, which resolves to `dist/`. The database targets
  now build the package's project references first.
- **`make demo-full` mined its baseline before the telemetry was queryable**, failing intermittently
  with "the baseline mined no route families". Mining is retried for up to a minute.
- `scripts/measure-performance.mjs` was committed unformatted, so `make verify` exited 2 at entry.

### Verified

- Alert **firing and recovery** observed for every alert that fired: the violation-rate alert at
  12:09:49Z value 220 recovering at 12:14:49Z, and the duplicate-side-effect alert at 12:09:33Z
  value 22 recovering at 12:14:33Z — exactly 300 s apart, matching the configured `evalWindow`.
  Every query and threshold is byte-identical before and after.
- Fresh-machine reproduction from a clean clone through Foundry, bootstrap, migrations, build,
  idle-survival, the demo, and both gate exit codes.
- 1,415 unit tests, 286 integration tests, five security scans at exit 0.

### Discovered

- **SL-065** — `signoz_get_alert_history` answers `{"data":{"items":[…],"total":n}}` rather than the
  `{"data":[…]}` envelope every other list tool uses.
- **SL-066** — an alert history row carries the rule's state under `overallState` and the sample's
  under `state`, and `state` takes values a rule never takes, `nodata` among them.
