# FlightRules threat model

Written for Phase 16 (PRD section 26, PRD Phase 16 task 1). It covers the P0 product: the
local self-host deployment described in PRD section 12.6, plus the hosted public demo.

**No risk below is marked resolved on the strength of an intention.** Every `Controlled` status
cites a named test, a runtime artefact, or both. Where a control is partial, the residual risk says
so in the same words a reviewer would use.

## Assets, in the order an attacker would want them

| Asset | Why it matters |
|---|---|
| A1 SigNoz API key | Full read/write on the observability tenant: dashboards, alerts, saved views, all trace and log data |
| A2 Application database | Contracts, evaluations, violations, audit history — the release decisions themselves |
| A3 The release decision | The product's output. A decision that can be forced to `pass` makes the whole system a rubber stamp |
| A4 Trace and log evidence in SigNoz | Customer-adjacent operational data |
| A5 The managed SigNoz artefacts | Ten resources FlightRules owns in a tenant it shares with its user |
| A6 Deployment secrets | Railway and GitHub Actions configuration |
| A7 The browser session | The operator's view of every decision |

## Trust boundaries

```text
browser  ──HTTPS──▶  web (server components only)  ──server-side──▶  API
                                                                      │
                                              ┌───────────────────────┼────────────────┐
                                              ▼                       ▼                ▼
                                        PostgreSQL              SigNoz MCP        OTLP collector
                                                                (API key)          (no key)
```

The browser never holds the SigNoz key, never calls SigNoz, and never calls MCP.
`apps/web/src/lib/api.ts` is `server-only`, and a test asserts that no web module imports the
comparison engines, so nothing that decides anything runs client-side.

---

## Threats

### T01 Malicious telemetry

- **Asset** A2, A3, A7.
- **Attack path** An agent under an attacker's control emits span names, attribute keys and
  attribute values chosen to break the consumer: markup, control characters, enormous strings,
  prototype-polluting keys.
- **Existing control** Everything derived from telemetry is treated as untrusted data at every
  boundary: normalisation bounds length and character class, the graph builder indexes with
  `Map` rather than object literals, React escapes by default, the CLI strips terminal control
  sequences, and managed artefact names are derived from validated project and agent identity
  rather than from span text.
- **Residual risk** A span name can still make a UI table wide. It cannot execute, escape or
  rename anything.
- **Verification** `packages/normaliser`, `packages/trace-graph/src/fuzz.test.ts`,
  `tests/e2e/phase-14-release-diff.spec.ts:269`, `tests/e2e/phase-15-violation-inspector.spec.ts:245`.
- **Status** Controlled.

### T02 Prototype pollution

- **Asset** A3.
- **Attack path** `__proto__`, `constructor` or `prototype` arrives as a YAML key, a span
  attribute key, a route-family key or a JSON field, and mutates `Object.prototype` so a later
  lookup returns an attacker's value — including a rule lookup that decides a release.
- **Existing control** The contract loader inspects converted values with `Object.keys` and rejects
  any non-plain prototype outright (`packages/contract-schema/src/yaml.ts`). Graph indexes are
  `Map`s. Attribute bags are read with `Object.hasOwn`-style access rather than `in`.
- **Residual risk** None known for the covered paths.
- **Verification** `packages/contract-schema/src/fuzz.test.ts`,
  `packages/trace-graph/src/fuzz.test.ts`.
- **Status** Controlled.

### T03 YAML parser abuse

- **Asset** A3, availability.
- **Attack path** A contract document uses anchors, aliases, alias bombs, explicit tags
  (`!!binary`, `!!timestamp`, `!!python/object:...`), extreme depth or width, or huge scalars, to
  crash the validator or to smuggle a non-plain value into the rule set.
- **Existing control** `maxAliasCount: 0`, `uniqueKeys`, `merge: false`, YAML 1.2 core schema, an
  explicit tree walk that rejects **any** node carrying an anchor, alias or explicit tag, byte and
  line limits applied before parsing, and a depth bound applied before `toJS`. Each of those was
  established by running `yaml@2.9.0`, because `customTags: []` and `schema: "core"` do *not*
  disable dangerous tags.
- **Residual risk** None known. A rejection is a typed diagnostic, never an exception.
- **Verification** `packages/contract-schema/src/yaml.test.ts`,
  `packages/contract-schema/src/fuzz.test.ts`.
- **Status** Controlled.

### T04 Selector abuse and regex denial of service

- **Asset** availability of the evaluator.
- **Attack path** A contract selector carries a catastrophically backtracking pattern, or a span
  name is chosen to trigger one, and one evaluation consumes the worker indefinitely.
- **Existing control** Selector patterns are length-bounded and compiled through
  `packages/contract-schema/src/regex.ts`, which rejects the nested-quantifier constructs that
  backtrack; evaluation is bounded by span and trace limits; the job has a lease and a timeout.
- **Residual risk** The pattern check is structural, not a proof of linear time. A pathological
  pattern that passes it is still bounded by the job timeout rather than running for ever.
- **Verification** `packages/contract-schema/src/regex.test.ts`,
  `packages/contract-engine/src/fuzz.test.ts`.
- **Status** Controlled, with the residual risk stated.

### T05 MCP schema drift

- **Asset** A3, A5.
- **Attack path** A SigNoz or MCP upgrade changes a tool's argument or response shape, and
  FlightRules silently reads a differently-shaped answer as success — creating an artefact it
  cannot verify, or reading an empty result as "no violations".
- **Existing control** Capability discovery at startup against
  `docs/research/mcp-capabilities.json`, typed runtime validation of every response, a pinned MCP
  version, and read-back verification after every write. Outcomes are a closed set
  (`SUCCESS_WITH_ROWS`, `SUCCESS_EMPTY`, and typed failures) rather than a boolean.
- **Residual risk** A drift that keeps the shape and changes the meaning would not be caught by
  shape validation. The compatibility matrix records the pinned versions this was verified against.
- **Verification** `packages/signoz-mcp/src/malformed.test.ts`, `make signoz-capabilities`,
  `docs/research/compatibility-matrix.md`.
- **Status** Controlled, version-scoped.

### T06 Malformed MCP responses

- **Asset** A3, A5.
- **Attack path** A response arrives with no `structuredContent`, JSON only in text, fenced JSON,
  the SPA shell with HTTP 200 (SL-012), a missing or renamed identifier (SL-056), a changed field
  type, a repeated pagination cursor, or `null` numerics from an omitted `dataType` (SL-051) — and
  is treated as a verified resource or as real data.
- **Existing control** One reader per response shape, each returning a typed outcome; identifier
  extraction that tries the documented alternatives and fails loudly when none is present; a
  pagination guard that treats a repeated cursor as truncation rather than looping.
- **Residual risk** None known for the enumerated shapes.
- **Verification** `packages/signoz-mcp/src/malformed.test.ts`.
- **Status** Controlled.

### T07 SigNoz credential theft

- **Asset** A1.
- **Attack path** The key reaches source, a log line, a test snapshot, a screenshot, browser
  storage, an evidence file, or a CI artefact.
- **Existing control** Server-side only: `apps/web/src/lib/api.ts` is `server-only`, the browser
  never calls SigNoz. `protectSecret` registers the value with `packages/domain/src/redaction.ts`
  at every entrypoint's first statements, so it is replaced wherever it appears in a string, not
  only under a suspicious key. `.env` is git-ignored and written mode 600 by
  `scripts/bootstrap-signoz.sh`. `make scan-secrets` gates every build; the release-gate workflow
  uploads application logs but never `.env`.
- **Residual risk** An operator who pastes a key into an issue is outside the product's control.
- **Verification** `packages/domain/src/redaction.test.ts`, `make scan-secrets`,
  `packages/test-fixtures/src/release-gate-workflow.test.ts`,
  `docs/evidence/phase-16/security-scans.md`.
- **Status** Controlled.

### T08 API authentication and authorisation boundaries

- **Asset** A2, A3.
- **Attack path** Anyone who can reach the API can approve a contract, activate it, or reset the
  demo.
- **Existing control** **None. This is a scoping decision, not a control.** PRD section 6.1 scopes
  P0 to local mode: the API binds a local port and the product is single-tenant. Demo mutation
  routes additionally require `DEMO_MODE`.
- **Residual risk** **Accepted and material.** Any hosted deployment reachable from the internet is
  administratively open. The hosted demo is deployed on that understanding, and the README says so.
  Authentication is P1 (PRD section 6.2).
- **Verification** `apps/api/src/api.integration.test.ts` (demo routes refuse outside demo mode);
  README "Known limitations".
- **Status** **Accepted risk, disclosed.**

### T09 Job idempotency abuse

- **Asset** A2, A3.
- **Attack path** The same job is submitted repeatedly, or replayed, producing duplicate
  evaluations, duplicate violations, or duplicate artefacts.
- **Existing control** Jobs carry an idempotency key; a repeat submission returns the existing job
  rather than creating a second. Evaluation writes are transactional and keyed on the evaluation
  identifier.
- **Residual risk** None known.
- **Verification** `apps/api/src/api.integration.test.ts`, `apps/worker/src/runner.integration.test.ts`.
- **Status** Controlled.

### T10 Job queue flooding

- **Asset** availability.
- **Attack path** Unbounded job submission starves the worker and delays every real evaluation.
- **Existing control** Rate limits on the evaluation and demo endpoints; bounded traces per
  evaluation and spans per trace; one lease per job. `GET /health/ready` reports queue depth so a
  backlog is observable rather than silent.
- **Residual risk** Without authentication (T08), a local caller can still saturate the queue. The
  effect is delay, not incorrect results.
- **Verification** `apps/api/src/api.integration.test.ts`,
  `docs/evidence/phase-16/worker-lifecycle.md`.
- **Status** Controlled, bounded by T08.

### T11 Worker lease abuse

- **Asset** A2, A3.
- **Attack path** Two workers claim the same job and commit conflicting output, or a crashed
  worker's job is never recovered.
- **Existing control** A claim is an atomic conditional update; the lease is heartbeated while the
  job runs and expires if the worker dies; recovery re-queues an expired lease. Output is committed
  in one transaction keyed on the evaluation, so a re-run replaces rather than duplicates.
- **Residual risk** None known.
- **Verification** `apps/worker/src/runner.integration.test.ts`,
  `docs/evidence/phase-16/worker-lifecycle.md`.
- **Status** Controlled.

### T12 Database injection

- **Asset** A2.
- **Attack path** Telemetry-derived text reaches a query as SQL.
- **Existing control** `postgres.js` tagged templates parameterise by construction; there is no
  string-concatenated SQL in the repository. Identifiers are never interpolated from input.
- **Residual risk** None known.
- **Verification** `packages/db` integration tests; a lint rule and review would catch
  a concatenated query.
- **Status** Controlled.

### T13 Stored cross-site scripting

- **Asset** A7.
- **Attack path** A span name or attribute containing `<script>` or `<img onerror=…>` is persisted
  and later rendered as markup.
- **Existing control** React escapes text by default and the product uses no
  `dangerouslySetInnerHTML`. Telemetry-derived text is rendered as text nodes everywhere.
- **Residual risk** None known.
- **Verification** `tests/e2e/phase-14-release-diff.spec.ts:269`,
  `tests/e2e/phase-15-violation-inspector.spec.ts:245`,
  `docs/evidence/phase-16/hostile-input.md`.
- **Status** Controlled.

### T14 Reflected cross-site scripting

- **Asset** A7.
- **Attack path** A query parameter or path segment is reflected into a page or an error message.
- **Existing control** Route parameters are validated as UUIDs or bounded slugs before use; the
  error envelope carries a typed code and a fixed message, never the raw input; the request
  identifier is bounded to `[A-Za-z0-9._-]{1,128}`.
- **Residual risk** None known.
- **Verification** `apps/api/src/api.integration.test.ts`, `docs/evidence/phase-16/hostile-input.md`.
- **Status** Controlled.

### T14a Terminal control-sequence injection

- **Asset** A7, and the reviewer's own judgement.
- **Attack path** A span name, service name, tool name or rule summary carrying `ESC [ 2 J` or a
  bare `0x9b` reaches the CLI's human report. The sequence clears the reader's screen and reprints
  the opposite verdict, and a CI log records it faithfully — so the deception survives review.
- **Existing control** Every line the CLI writes passes through `printable()`, which replaces C0
  except tab and newline, DEL and the whole C1 range with U+FFFD. Applied once by wrapping `Io` at
  the entry point, so a command added later cannot reintroduce the hole. `assertNameSegment`
  rejects the same ranges in a managed SigNoz resource name.
- **Residual risk** None known. `--json` output was never affected: `JSON.stringify` escapes every
  code point below `0x20`, and it passes through the same filter regardless.
- **Verification** `apps/cli/src/cli.test.ts` "hostile telemetry cannot drive the reader's
  terminal"; `packages/artifact-compiler/src/compile.test.ts` "hostile strings cannot forge or
  split a managed name"; `docs/evidence/phase-16/hostile-input.md`.
- **Status** Controlled. **Found and closed in Phase 16.**

### T14b Header injection through a download filename

- **Asset** A7.
- **Attack path** `releaseKey` is any string of up to 200 characters — correctly, since a release
  key is whatever deployed it — and was interpolated into `content-disposition`. A quote closes the
  `filename` parameter and everything after it becomes attacker-chosen header parameters; a newline
  is a header injection.
- **Existing control** `downloadNameSegment()` reduces the value to `[A-Za-z0-9._-]`, bounds it to
  64 characters, strips a leading dot or dash, and falls back rather than emitting an empty name.
  The real key still travels inside the bundle body, where it is data.
- **Residual risk** None known.
- **Verification** `apps/web/src/lib/download-name.test.ts`;
  `docs/evidence/phase-16/hostile-input.md`.
- **Status** Controlled. **Found and closed in Phase 16.**

### T15 Public evidence leakage

- **Asset** A4.
- **Attack path** A committed evidence file, a screenshot or a release asset carries a key, a URL
  with a token, a raw customer payload, or an internal address.
- **Existing control** Evidence documents carry identifiers and hashes; the exported gate bundle is
  generated by the CLI through the same redactor. `make scan-secrets` runs over every file
  including `docs/evidence/`.
- **Residual risk** Evidence files carry real trace identifiers and real project and agent
  identifiers of the demo tenant. That is intentional and is what makes the evidence checkable; the
  tenant is a disposable demo.
- **Verification** `make scan-secrets`, `docs/evidence/phase-16/security-scans.md`.
- **Status** Controlled.

### T16 Raw prompt leakage

- **Asset** A4, user privacy.
- **Attack path** Instrumentation emits `gen_ai.input.messages`, `gen_ai.system_instructions` or
  `gen_ai.prompt` — all of which exist in the released registry and are one line away.
- **Existing control** `ForbiddenAttributeRedactor` strips them from every span at start and at
  end, before any exporter sees them; `safeLogAttributes` drops them from every log record.
  Removal, not redaction: a `[redacted]` value would still record that the product collected one.
- **Residual risk** A third-party instrumentation library added later could emit them from a
  process that does not install the redactor. The redactor is installed by `startTelemetry`, which
  every entrypoint calls first.
- **Verification** `packages/telemetry/src/telemetry.test.ts`, `packages/telemetry/src/logs.test.ts`.
- **Status** Controlled.

### T17 Tool-argument and tool-result leakage

- **Asset** A4, user privacy.
- **Attack path** As T16, through `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`, or
  through a log line that includes a request body.
- **Existing control** The same forbidden-key register covers both. The demo services log the route
  template rather than the URL, and no body, header or query string is logged. The payment service
  logs the **salted hash** of an idempotency key; the raw key never leaves the service.
- **Residual risk** None known.
- **Verification** `packages/telemetry/src/logs.test.ts`,
  `apps/demo-services/payment-service/src/app.test.ts`.
- **Status** Controlled.

### T18 Railway secret exposure

- **Asset** A6, A1.
- **Attack path** A secret reaches an image layer, a build argument, a build log, or a
  browser-visible environment variable.
- **Existing control** Secrets are configured only as Railway service variables, read at runtime.
  Next.js exposes only `NEXT_PUBLIC_*` to the browser and FlightRules defines none carrying a
  secret. The API key is read by the API and worker services alone; the web service does not
  receive it.
- **Residual risk** A Railway project member can read the variables. That is the platform's model.
- **Verification** `docs/evidence/phase-17/` deployment evidence, redacted.
- **Status** Controlled.

### T19 GitHub Actions secret exposure

- **Asset** A6, A1.
- **Attack path** A workflow echoes a secret, uploads `.env`, or grants a job more permission than
  it needs.
- **Existing control** `permissions: contents: read` on both workflows; the SigNoz key is **minted
  per run** by `scripts/bootstrap-signoz.sh` rather than supplied as a repository secret, so there
  is no long-lived credential to leak; the admin password is derived from the run identifier and
  never echoed; the evidence upload lists explicit paths and `.env` is not among them.
- **Residual risk** None known. A fork pull request cannot read secrets, and none is required.
- **Verification** `packages/test-fixtures/src/release-gate-workflow.test.ts`,
  the real workflow runs recorded in Phase 17 evidence.
- **Status** Controlled.

### T20 Public SigNoz access

- **Asset** A1, A4.
- **Attack path** The MCP port or the SigNoz UI is published on a public address, letting anyone
  read the tenant.
- **Existing control** `scripts/verify-signoz.sh` reports the published MCP port explicitly and
  states that it is correct for local development and forbidden in production (PRD section 18.2).
  The hosted deployment keeps SigNoz and MCP reachable only from the deployed services.
- **Residual risk** The local development stack publishes 8080, 8000, 4317 and 4318 on the host.
  That is a deliberate local-mode choice and is documented.
- **Verification** `make signoz-verify`, `packages/test-fixtures/src/deployment.test.ts`.
- **Status** Controlled per mode.

### T21 Artifact ownership conflicts

- **Asset** A5.
- **Attack path** FlightRules overwrites or deletes a SigNoz resource a human created, or claims
  one it does not own.
- **Existing control** Managed names carry the `FlightRules / <project> / <agent> /` prefix; the
  register records every resource FlightRules created, with its remote identifier and spec hash. A
  name collision with an unmanaged resource is reported as a **conflict** and nothing is written.
  `make signoz-purge` deletes only registered resources.
- **Residual risk** A human who renames a resource into the managed prefix creates a conflict, which
  is reported rather than resolved silently.
- **Verification** `packages/artifact-compiler/src/race.integration.test.ts`,
  `docs/evidence/phase-16/artifact-races.md`.
- **Status** Controlled.

### T22 Unsafe contract activation

- **Asset** A3.
- **Attack path** A contract is activated without validation, or a contract's stored text no longer
  matches the rules being evaluated.
- **Existing control** Activation requires a document that parsed and validated through the Phase 07
  parser; the content hash is stored and re-checked; the eight graph controls are transformations of
  the stored YAML and are re-validated before being returned, so the editor and the controls cannot
  drift. Every lifecycle transition writes an audit event.
- **Residual risk** None known.
- **Verification** `packages/contract-schema/src/edit.test.ts`,
  `tests/e2e/phase-13-workflow.spec.ts:199`, `:231`.
- **Status** Controlled.

### T23 Release-gate bypass

- **Asset** A3. **The highest-value target in the product.**
- **Attack path** Any path that makes the gate return `pass` when the evidence does not support it:
  an internal error swallowed into a pass, a missing evaluation read as no violations, a UI control
  that dismisses a violation.
- **Existing control** The decision is a pure function of persisted evidence with a `decisionHash`;
  no LLM participates. An internal error maps to exit 4 and insufficient evidence to exit 3, never
  to 0 — asserted as a property, not a case. The Violation Inspector offers no "ignore" action.
- **Residual risk** Bounded by T08: without authentication, someone who can reach the API can
  change the contract. They cannot make the gate misreport the contract they left in place.
- **Verification** `packages/contract-engine/src/exit-codes.test.ts` (no internal error maps to
  pass), `packages/contract-engine/src/release.test.ts`,
  `tests/e2e/phase-15-violation-inspector.spec.ts:233`, and `make demo-full` reproducing exit 0
  then exit 2.
- **Status** Controlled.

### T24 Incomplete telemetry causing a false pass

- **Asset** A3.
- **Attack path** A sampled or truncated trace is missing the span a rule requires, and the rule
  reports "absent" as a violation — or, worse, a missing critical step is read as satisfied.
- **Existing control** Trace quality is labelled; incomplete traces are excluded from baselines by
  default; a rule that cannot see enough returns **insufficient evidence**, which is exit 3, not a
  pass and not a fail. Local unobservability is scoped locally, so the demo's aborted payment
  handler does not become a false violation.
- **Residual risk** A globally incomplete trace that *looks* complete cannot be distinguished from a
  complete one. PRD section 28 accepts this and requires the label rather than a guess.
- **Verification** `packages/contract-engine/src/incomplete.test.ts`,
  `docs/evidence/phase-16/incomplete-telemetry.md`.
- **Status** Controlled.

### T25 Truncated query results

- **Asset** A3.
- **Attack path** A page of results is read as the whole set, so an evaluation runs against a subset
  and passes.
- **Existing control** A full page is reported as truncated rather than presented as everything;
  `nextCursor` is empty exactly when a page is not full (SL-050); a repeated cursor is treated as
  truncation; a truncated retrieval produces exit 3, not exit 0.
- **Residual risk** None known.
- **Verification** `packages/signoz-mcp/src/malformed.test.ts`,
  `packages/contract-engine/src/exit-codes.test.ts`.
- **Status** Controlled.

### T26 High-cardinality denial of service

- **Asset** A4, cost.
- **Attack path** Dynamic identifiers reach metric labels or route fingerprints, so the series count
  or the route-family count grows without bound and the observability bill does too.
- **Existing control** Dynamic IDs are normalised out of span names before fingerprinting; metric
  dimensions are declared as data and filtered twice — the declaration and `filterDimensions` —
  and `highCardinalityDimensions()` fails a build that adds a trace ID, span ID, route fingerprint,
  evaluation ID or run ID as a label. Route families are bounded with a rare-path threshold.
- **Residual risk** Project, agent and release identifiers are labels. Their cardinality is the
  number of releases, which is bounded by use rather than by input.
- **Verification** `packages/telemetry/src/telemetry.test.ts`,
  `docs/evidence/phase-16/metric-dimensions.md`.
- **Status** Controlled.

### T27 Large-trace denial of service

- **Asset** availability.
- **Attack path** A trace with hundreds of thousands of spans is fetched and canonicalised,
  exhausting memory or the job lease.
- **Existing control** `MAX_SPANS_PER_TRACE` and `MAX_TRACES_PER_EVALUATION` are configuration with
  defaults, and exceeding either is an **explicit error state** rather than a silent truncation.
  Graph algorithms are iterative rather than recursive where depth is input-controlled.
- **Residual risk** Bounded by the configured limits.
- **Verification** `packages/contract-engine/src/performance.test.ts`,
  `docs/evidence/phase-16/performance.md`.
- **Status** Controlled.

### T28 Dependency compromise

- **Asset** everything.
- **Attack path** A malicious or vulnerable package enters through the lockfile or a postinstall
  script.
- **Existing control** `--frozen-lockfile` everywhere including CI, with a job that fails if
  installing modifies the lockfile; `onlyBuiltDependencies` restricts postinstall scripts to
  `esbuild`; exact versions (`save-exact=true`); a licence gate; and a dependency-vulnerability gate
  that **now actually runs** — `pnpm audit` had never completed against the current registry, and
  fixing it immediately surfaced two high advisories in `postcss@8.4.31`, resolved by an override to
  `8.5.23`.
- **Residual risk** One moderate advisory remains, in `@hono/node-server`, a transitive dependency of
  the MCP SDK: a Windows-only path traversal in its `serve-static` middleware. FlightRules is an MCP
  **client** and never runs that server, and the deployment targets are Linux and macOS. Recorded
  rather than suppressed.
- **Verification** `make scan-deps`, `make scan-licences`, `make scan-secrets`,
  `packages/test-fixtures/src/repository-hygiene.test.ts`,
  `docs/evidence/phase-16/security-scans.md`.
- **Status** Controlled, with one disclosed moderate.

### T29 Public demo reset abuse

- **Asset** A2, the demo's availability during judging.
- **Attack path** Anyone hits `POST /api/demo/reset` on the public deployment and wipes the seeded
  state mid-demonstration.
- **Existing control** Demo mutation routes exist only when `DEMO_MODE` is enabled and are rate
  limited. The reset is idempotent and `make demo-full` reseeds from scratch in one command.
- **Residual risk** **Accepted.** With `DEMO_MODE` on and no authentication (T08), the public demo
  can be reset by a visitor. It is a demo tenant holding no real data, and recovery is one command.
- **Status** **Accepted risk, disclosed.**

### T30 Server-side request forgery through the configurable SigNoz URL

- **Asset** internal network, A6.
- **Attack path** `SIGNOZ_URL` or `SIGNOZ_MCP_URL` is pointed at a cloud metadata endpoint or an
  internal service, and FlightRules fetches it.
- **Existing control** Both are validated as `http`/`https` URLs at configuration load. In hosted
  multi-user mode PRD section 18.2 requires loopback and metadata addresses to be blocked; in local
  self-host mode local addresses are explicitly permitted, which is why the default is
  `http://localhost:8080`.
- **Residual risk** In P0 the URLs are operator configuration, not user input, so the boundary is
  the operator. A hosted multi-user product would need the allowlist enforced, which is P1.
- **Verification** `packages/config/src/env.ts` and its tests.
- **Status** Controlled for P0's deployment model; the multi-user control is P1.

### T31 Path traversal during contract export

- **Asset** the host filesystem.
- **Attack path** `--out ../../etc/passwd`, or a contract path derived from a project slug
  containing `../`.
- **Existing control** Project and agent identifiers are validated slugs, so a derived path cannot
  contain a traversal segment; CLI output paths are resolved and the write is a plain file write
  performed by the operator's own shell user.
- **Residual risk** An operator can still write anywhere they themselves can write. That is the
  expected behaviour of a CLI `--out` flag.
- **Verification** `docs/evidence/phase-16/hostile-input.md`.
- **Status** Controlled.

---

## Summary

| Status | Count | Threats |
|---|---|---|
| Controlled | 30 | T01–T07, T09–T28 excluding the two below, plus T14a and T14b, T30, T31 |
| Accepted risk, disclosed | 3 | T08 (no authentication), T29 (public demo reset), and the moderate advisory inside T28 |

The three accepted risks share one root: **P0 is scoped to a single-tenant local deployment**
(PRD section 6.1), and the public demo is that same product placed on the internet so it can be
judged. Authentication and multi-tenant isolation are PRD section 6.2 (P1) work. The README's
"Known limitations" states this in the same terms.
