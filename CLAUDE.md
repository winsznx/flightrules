# FlightRules — operating contract

This file is the working contract for anyone (human or agent) changing this repository. It is
derived from `docs/PRD.md`, which remains authoritative. Where this file and the PRD disagree,
the PRD wins and this file is wrong and must be fixed.

`design.md` at the repository root is authoritative **only** for colours, typography, spacing,
layout styling, borders, shadows, icon treatment, logos, illustrations, assets, visual motion
and responsive visual rules. It must never change product wording, routes, features, states or
information architecture.

## What this product is

FlightRules turns SigNoz traces into deterministic release contracts that catch skipped checks,
duplicate side effects, unknown tool paths and behavioural drift before an agent canary reaches
production.

The graph diff is the product hero. A chatbot is not the interface.

## Non-negotiable rules

1. One numbered phase at a time. Do not start a phase whose entry criteria are unmet.
2. A phase is complete only when its tests and its runtime validation have both passed.
3. Code existing is not evidence a feature works. Runtime evidence is required.
4. Never infer an undocumented request or response shape.
5. Never invent a SigNoz endpoint, MCP tool, OpenTelemetry attribute, Foundry field, package
   option, environment variable or CLI flag.
6. Verify against installed runtime first, then official versioned docs, then the official
   repository at the pinned commit. A blog post, tutorial, forum answer or recalled syntax is
   never the sole basis for an implementation decision.
7. Record every external technical decision in `docs/research/source-lock.md`.
8. When documentation and runtime behaviour disagree, the runtime wins for the installed
   version, and the mismatch is recorded.
9. Never silently downgrade a requirement.
10. Never replace a required integration with a mock and call the phase complete. Mocks are for
    unit tests and deterministic offline fixtures only.
11. No placeholder `return true`, fabricated telemetry, hard-coded dashboard screenshot,
    invented trace ID, fake MCP response, or manually inserted database row may be used as proof.
12. No unresolved P0 TODO, FIXME, stub, disabled test, skipped test or commented-out
    implementation may remain at submission.
13. Every MCP write is followed by a read-back that confirms the resource and validates the
    fields that matter. A successful call is not proof the resource is correct.
14. Every generated dashboard panel must return real data after the seeded demo runs.
15. Every alert must be driven through a real firing state, and a recovery state where the
    installed SigNoz version supports it.
16. Every trace rule must be tested against both a passing and a violating trace.
17. `main` stays green. Do not merge a phase branch with failing checks.
18. Focused conventional commits. No co-author trailers.
19. Do not rewrite unrelated code while completing a phase.
20. No secret in source, logs, test snapshots, screenshots, browser storage or telemetry.
21. Never capture chain-of-thought. FlightRules evaluates observable execution structure and
    safe metadata only.
22. Read the surrounding code and its tests before changing an existing file.
23. After every phase, update the acceptance matrix, evidence log, ADRs and changelog.

## Determinism boundary

These must remain deterministic and testable without an LLM:

span normalisation, trace reconstruction, route fingerprinting, route-family mining, graph
comparison, contract parsing, contract validation, rule evaluation, violation generation,
release-gate decision, CLI exit status.

An LLM may explain evidence or suggest contract wording where the PRD allows it. **It must never
decide whether a rule passed.**

Identical traces must produce identical graph fingerprints. Use stable ordering and canonical
serialisation everywhere.

## Verified environment (Phase 00, 2026-07-25)

Do not change any of these without a new source-lock entry recording what was re-verified.

| Component | Pinned |
|---|---|
| Node.js | 24.14.1 |
| pnpm | 10.33.0 |
| TypeScript | 7.0.2 |
| Next.js / React | 16.2.11 / 19.2.8 |
| Fastify | 5.10.0 |
| Drizzle ORM / Kit | 0.45.2 / 0.31.10 |
| Vitest / fast-check / Playwright | 4.1.10 / 4.9.0 / 1.62.0 |
| `@modelcontextprotocol/sdk` | 1.29.0 |
| OpenTelemetry API / SDK / exporters / semconv | 1.9.1 / 2.10.0 / 0.221.0 / 1.43.0 |
| foundryctl | v0.2.16 |
| SigNoz | v0.134.0 |
| SigNoz OTel Collector | v0.144.6 |
| SigNoz MCP Server | v0.9.0 |

Full detail: `docs/research/compatibility-matrix.md`.

## Runtime facts that bite

These were discovered by running the system. Ignoring any of them produces a build that looks
correct and is not.

- **`spec.<molding>.spec.version` does not pin the container image.** Set `image:` as well, or
  Foundry deploys `latest`. Assert on the image tag in the generated Compose file, never on the
  lock file's `version` field. (SL-006)
- **OTLP receivers do not bind until SigNoz first-user setup completes.** Before that, ports
  4317 and 4318 accept a TCP connection through the Docker proxy and then reset. A port check
  passes in the broken state, so it is worthless. Prove ingestion with a real OTLP POST that
  returns HTTP 200. (SL-010)
- **Unmatched SigNoz API paths return the SPA shell with HTTP 200.** Never treat a 200 as
  success from a direct SigNoz HTTP call; assert on the body. (SL-012)
- **`signoz_get_trace_details` cannot return custom span attributes.** Use
  `signoz_execute_builder_query` with `requestType: "raw"` and `selectFields` using
  `fieldContext: "tag"`. (SL-020, SL-021)
- **MCP create tools take flat arguments,** not a nested resource object. (SL-023)
- **MCP update tools replace the whole resource.** Fetch, strip server-populated fields, modify,
  submit the complete object. Never send a partial body.
- **Discovery tools accept `fieldContext: "tag"` as an alias for `"attribute"`, but Query
  Builder `selectFields` and `groupBy` require `"tag"`.** (SL-022)
- **Builder query `start`/`end` are Unix milliseconds; the `timestamp` column is nanoseconds.**
  Bound the window with `start`/`end`, never with an inline `timestamp` filter.
- **Every `builder_query` needs a positive `limit` and a non-empty `order`.**
- **All `gen_ai.*` attributes are experimental.** Import them from
  `@opentelemetry/semantic-conventions/incubating`. No critical rule may depend on one alone.
  (SL-030)
- **`vcs.commit.sha` is not a released convention.** Emit `vcs.ref.head.revision` too. (SL-031)
- **`InMemorySpanExporter.getFinishedSpans()` must be read before `provider.shutdown()`**, which
  clears it. (SL-029)

## Branches and commits

Branch per phase, exactly:

```
phase/00-source-lock      phase/09-application-core
phase/01-foundation       phase/10-signoz-artifact-compiler
phase/02-signoz-foundry   phase/11-release-gate
phase/03-demo-system      phase/12-ui-foundation
phase/04-telemetry        phase/13-contract-studio
phase/05-signoz-mcp-client phase/14-release-diff
phase/06-trace-graph      phase/15-violation-inspector
phase/07-contract-engine  phase/16-hardening
phase/08-baseline-mining  phase/17-release
```

Commits are `<type>(<scope>): <specific completed change>`. Never `update`, `fix stuff`,
`final`, or `changes`. No co-author trailers.

## Phase workflow

1. Read the PRD section for the phase and the files named in its entry criteria.
2. Create the phase branch.
3. Write `docs/evidence/phase-XX-plan.md`.
4. Verify the documentation and runtime capabilities the phase needs.
5. Implement the smallest complete slice that satisfies the phase.
6. Add or update tests before claiming completion.
7. Run the phase tests, then all earlier regression tests.
8. Validate through the actual running system where applicable.
9. Write `docs/evidence/phase-XX-result.md`.
10. Update `docs/ACCEPTANCE_MATRIX.md` and `CHANGELOG.md`.
11. Commit, then merge only when every gate passes.

Every phase ends with the mandatory report block from PRD section 2.4. Report exact results, not
optimistic summaries. Never continue from a `BLOCKED` or `FAIL` phase.

## Stop conditions

Report `BLOCKED` when an official required capability does not exist, a required MCP tool is
absent in the pinned version, a documented installation cannot be reproduced, a security control
cannot be implemented safely, a P0 test reveals the product claim is false, a trace lacks enough
causal evidence for a proposed rule, `design.md` is missing at Phase 12, a dependency licence is
incompatible, or a resource can be created but not verified.

Before reporting blocked, exhaust the grounded options: installed schemas, generated API
descriptions, MCP tool discovery, pinned dependency source, command help output, runtime
responses, existing repository configuration. When a real incompatibility remains, record the
evidence, explain the impact, and propose the smallest technically honest alternative that
preserves the thesis. Never fake the capability.

## Commands

```
make verify-env       make test-integration
make install          make test-e2e
make lint             make build
make typecheck        make up / make down
make test             make demo
make verify           # complete validation suite
```
