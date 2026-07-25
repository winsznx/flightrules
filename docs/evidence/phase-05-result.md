# Phase 05 result — SigNoz MCP client and capability layer

Branch: `phase/05-signoz-mcp-client`
Date: 2026-07-25

## Baseline verification before starting

Every Phase 00–04 claim in the handoff was checked rather than accepted.

| Claim | Verified | Result |
|---|---|---|
| Phase commits exist and are merged | `git log --graph` | `ba600b8`, `9e093da`, `bb50031`, `9a37a88`, `4d392b0` all present on `main` |
| `make verify` passes | Run | Exit 0 |
| 193 tests pass | `make test`, `make test-integration` | 153 unit + 40 integration = 193, 0 failed, 0 skipped |
| SigNoz stack healthy | `make signoz-verify` | Exit 0, including a real OTLP POST returning 200 |
| v1 produces 12 spans over 6 services | Live run + MCP retrieval | Trace `f176194973362b659a75c030fd40f028`, 12 spans, 6 services |
| v2 produces 8 spans over 4 services | Live run + MCP retrieval | Trace `2627ba04954ce0efbfe83219d45363fd`, 8 spans, 4 services |
| v2 omits policy and fraud | MCP retrieval | Both absent |
| v2 has two client write spans at retry 0 and 1 | MCP retrieval | Confirmed |
| Customer output identical | Compared responses | Byte-identical |
| MCP surface unchanged | `make signoz-capabilities` + diff | 41 tools, 19 resources, all 22 required present; only `capturedAtUtc` changed |

**One defect found.** `docs/ACCEPTANCE_MATRIX.md` was never updated for Phase 04, breaching the
operating contract's rule 23. It still read "Last updated: Phase 03" and marked A2 and A14 as
`PENDING` despite Phase 04 having produced their evidence. Fixed in `2d29bf6` before Phase 05
began. Row 6 was set to `IN PROGRESS`, not `DONE`, because metrics and logs are declared but not
yet emitted — marking it complete would have been the optimistic summary the PRD forbids.

## What was built

```text
packages/signoz-mcp/src/parse.ts       payload extraction from MCP content entries
packages/signoz-mcp/src/schemas.ts     runtime schemas for every observed SigNoz envelope
packages/signoz-mcp/src/normalise.ts   CallToolResult -> typed McpResult
packages/signoz-mcp/src/classify.ts    thrown errors and isError -> PRD error codes
packages/signoz-mcp/src/readers.ts     per-payload schema, row count and deep link
packages/signoz-mcp/src/transport.ts   injectable ToolCaller boundary, redacting logger
packages/signoz-mcp/src/client.ts      capability gate, retries, timeouts, circuit breaker
packages/signoz-mcp/src/operations.ts  typed wrappers over the pinned tool surface
packages/signoz-mcp/src/verify.ts      read-before-write and read-back verification
```

Callers receive a discriminated union, never a raw MCP object:

```text
SUCCESS_WITH_ROWS     validated payload, at least one row
SUCCESS_EMPTY         validated payload, zero rows
UNSUPPORTED_RESPONSE  valid JSON in a shape this client does not understand
MALFORMED_RESPONSE    no content entry yielded a machine-readable payload
MCP_ERROR             the server declared the failure
TRANSPORT_ERROR       connection, protocol or timeout failure
```

Each failure member carries a PRD section 19 error code, so `MCP_TOOL_MISSING`,
`SIGNOZ_AUTH_FAILED`, `MCP_UNAVAILABLE`, `MCP_RESPONSE_INVALID`, `SIGNOZ_UNREACHABLE` and
`TRACE_QUERY_FAILED` all reach callers through the existing typed error model rather than a
parallel one.

## Runtime findings

Four new source-lock entries, all from probing the live pinned server before writing code.

### SL-040 — the text fallback is mandatory, and entries must be parsed individually

`signoz_execute_builder_query` returns **no** `structuredContent` on the success path. The declared
`outputSchema` does not predict this: only 5 of 41 tools declare one, yet four list tools return
`structuredContent` without declaring an output schema. So the fallback cannot be inferred from
discovery metadata and must be unconditional.

More consequentially, a **successful** response may carry several content entries:

```text
entry 0  78142 chars  {"status":"success","data":{...}}
entry 1    109 chars  [Decisions applied]
                        query "A": limit=100 (request-type default), order=timestamp desc
```

Joining them and calling `JSON.parse` fails at position 78,143. Every FlightRules script written
before this phase joins entries before parsing, so all of them break on this response — including
the Phase 00 proof scripts and the baseline check used earlier in this session. The client parses
each entry on its own and keeps the advisory as a validation notice, which is also what the PRD's
Phase 05 task 5 requires. This is covered by a unit test and by an integration test that provokes
the real multi-entry response.

### SL-041 — the MCP SDK's own types do not typecheck under `exactOptionalPropertyTypes`

`Transport` declares `sessionId?: string`; `StreamableHTTPClientTransport` exposes a getter
returning `string | undefined`. `tsc` reports TS2379. Bridged with an assertion to the SDK's own
`Transport` type — no `as any`, `@ts-ignore` or `@ts-expect-error`, and every member FlightRules
calls stays fully typed. Relaxing the compiler flag for the package would have weakened checking
across all of its own code to work around one third-party declaration defect.

### SL-042 — a saved view needs both `queryType` and `panelType`

`signoz_create_view` rejects a `compositeQuery` missing either field with HTTP 400
`failed to validate request body`. All four combinations were tested; only
`{queryType: "builder", panelType: "list", queries: [...]}` was accepted. Neither field appears in
the MCP tool's input schema, which declares only `compositeQuery: object`. The create response
also returns the identifier as a **bare string** under `data`, refining SL-023, which recorded it
as `{"data":{"id": uuid}}`.

Without this, the Phase 10 artifact compiler would have reported a successful build and created
nothing.

### SL-043 — three discovery tools, three different envelopes

`signoz_get_field_keys` returns a map keyed by field name. `signoz_get_field_values` returns
values grouped by data type, and takes `name` rather than `key`. The list tools return
`{data, pagination}`. `signoz_get_alert_history` requires `id`. Each reader therefore carries its
own schema; a shared envelope classified two of these as `UNSUPPORTED_RESPONSE`, which is how the
mismatch surfaced.

## Defects found and fixed during the phase

### 1. Concurrent connects raced in the transport

Capability discovery lists tools and resources concurrently. The connection guard was a boolean
set only after the await, so both callers entered the handshake and the SDK rejected the second
with `Already connected to a transport`. Found by the integration test on its first run — the unit
tests could not have caught it, because they inject a caller and never connect.

Fixed by caching the in-flight promise rather than a flag, and by not caching a failed handshake,
so a transient connection failure does not permanently poison the client.

### 2. Three response envelopes were assumed to be one

The first implementation used a single list schema for every non-query tool. `get_field_keys` and
`get_field_values` both returned `UNSUPPORTED_RESPONSE` against the real server. The schemas were
corrected from observed responses, not from documentation. Recorded as SL-043.

Both defects were found by tests running against the real pinned server, which is the reason the
integration suite exists rather than mocking the MCP layer.

## Response shapes covered

All seventeen required, each with at least one unit test. Eight are reproduced from responses
observed live rather than invented: valid `structuredContent`, text-only JSON, multiple entries
with one usable, empty content, malformed JSON, an MCP-declared error, a transport error, and zero
rows as `rows: null`.

Parsing is explicit and ordered. The only pattern-matching in the payload path is a fence stripper
that works on line structure, not a regular expression over the body — an unbounded regular
expression over a 78 KB payload is the denial-of-service surface PRD section 18.1 names.

## Commands run and results

| Command | Exit | Result |
|---|---|---|
| `pnpm run typecheck` | 0 | clean |
| `make test` | 0 | **233 unit tests passed** (153 before, 80 added) |
| `make test-integration` | 0 | **61 integration tests passed** (40 before, 21 added) |
| `make verify` | 0 | complete suite green |
| `make signoz-verify` | 0 | every SigNoz surface healthy |
| `make demo-v1`, `make demo-v2` | 0 | fresh traces produced and retrieved through the new client |

Total: **294 tests passed, 0 failed, 0 skipped.**

## Runtime validation

Performed through the client under test, against the live stack.

1. **Capability discovery.** All 22 PRD-required tools present at v0.9.0, `requiredMissing` empty,
   server reported as `SigNozMCP v0.9.0`, and `signoz://traces/query-builder-guide` exposed.
2. **Text-only retrieval.** Rows recovered from `signoz_execute_builder_query` despite the absent
   `structuredContent`.
3. **Custom attributes.** `agent.side_effect`, `agent.release.id`, `agent.retry.number` and
   `gen_ai.tool.name` all retrieved as selected fields, confirming SL-020 and SL-021 still hold.
4. **Known-good release.** 12 spans over 6 services, including `flightrules-policy-service` and
   `flightrules-fraud-service`.
5. **Unsafe release.** 8 spans over 4 services, policy and fraud absent, exactly two client spans
   with `agent.side_effect=write` at `agent.retry.number` 0 and 1. The skipped prerequisites and
   the duplicate side effect are both visible through the client alone.
6. **Multi-entry response.** Provoked against the real server; rows recovered and the
   `[Decisions applied]` advisory preserved as a notice.
7. **Empty result.** A non-matching filter returns `SUCCESS_EMPTY`, distinct from a failure.
8. **Authentication failure.** An invalid key classified as `SIGNOZ_AUTH_FAILED`, never as a
   success.
9. **Unreachable endpoint.** Classified as `MCP_UNAVAILABLE` without throwing.
10. **Write verification.** A saved view created, read back, field-compared on `name`,
    `sourcePage` and the filter expression, and deleted. A second create under the same name
    returned `NAME_COLLISION` without attempting the write.
11. **Field discovery.** `agent.side_effect` returned exactly `["external","none","read","write"]`.
12. **Cleanup and secrets.** Zero saved views remain in SigNoz after the suite. The API key
    appears in no tracked file, and a test asserts a registered secret echoed inside an error
    message is redacted before it reaches a caller.

## Determinism note carried into Phase 06

Row order is **not** stable. The same trace fetched with `order: timestamp asc` returned
`policy.retrieve` before the root `refund.request`, and the ascending and descending fetches
returned the same span set in different orders. Phase 06 must sort canonically rather than trust
arrival order. An integration test asserts the two orderings yield identical span-id sets, so a
regression here fails rather than silently producing an unstable fingerprint.

## Privacy

Tool arguments are never logged: a test asserts a customer email in a filter expression does not
reach any log record, satisfying PRD section 17.6. The API key is registered as a secret value at
transport construction, so it is redacted even when interpolated into an error message. No raw MCP
response is persisted anywhere in the repository.

## Known limitations

1. **The capability snapshot is exposed but not persisted.** PRD Phase 05 task 12 asks that it be
   stored in setup data; that needs the database layer, which arrives in Phase 09. The client
   returns the snapshot and Phase 09 stores it. Nothing is faked in the interim.
2. **Dashboard, alert and notification-channel writes have typed wrappers but no read-back
   verification test.** `createAndVerify` is proven against a saved view, which is the harmless
   resource the Phase 05 exit gate names. Applying it to dashboards and alerts is Phase 10 work,
   and the helper is resource-agnostic by construction.
3. **`signoz_update_*` wrappers are not implemented.** Update tools replace the whole resource and
   require a fetch-modify-submit cycle. No Phase 05 requirement needs one, and writing an untested
   update path would be the placeholder the operating contract forbids. Phase 10 adds them with
   their tests.
4. **The Phase 04 aborted server-span limitation is unchanged.** Phase 05 does not touch it. It
   remains a Phase 06 trace-quality requirement, and this phase confirmed the two client-side write
   spans that make duplicate detection possible are both retrievable.
5. **Retry jitter is deterministic**, derived from the attempt number rather than randomness, so a
   failing test is reproducible. This is weaker than random jitter for avoiding synchronised
   retries across many concurrent clients; at P0's single-worker scale it is the right trade, and
   it is recorded here rather than left implicit.

---

```text
PHASE: 05 SigNoz MCP client and capability layer
STATUS: PASS
BRANCH: phase/05-signoz-mcp-client
COMMITS: see the phase commit and merge recorded in CHANGELOG.md
SOURCES VERIFIED: 8 — the live MCP tool and resource surface re-snapshotted and diffed (docs/research/mcp-capabilities.json, 41 tools, 19 resources); the installed @modelcontextprotocol/sdk@1.29.0 declaration files; and six live probe sessions characterising execute_builder_query success, empty and error envelopes, multi-entry content, authentication and transport failure classification, saved-view create/read/list/delete, and the three discovery envelopes. Four new entries recorded: SL-040, SL-041, SL-042, SL-043
IMPLEMENTED: packages/signoz-mcp with an injectable transport boundary, capability discovery against the 22 PRD-required tools, unconditional per-entry response normalisation with runtime schema validation, six-member typed result union mapped onto PRD section 19 error codes, bounded non-retrying-on-answer retry policy, timeout, circuit breaker, redacting structured logging, typed wrappers for the trace, discovery, view, dashboard, alert and notification-channel tools, and a resource-agnostic create-read-verify helper implementing PRD section 16.5
TESTS RUN: pnpm run typecheck; make test; make test-integration; make verify; make signoz-verify; make demo-v1; make demo-v2
TEST RESULT: passed 294, failed 0, skipped 0 (233 unit, 8 database integration, 53 SigNoz integration). Phase 05 added 80 unit and 21 integration tests. Two defects were found by the integration suite and fixed: a connection race in the transport, and three response envelopes wrongly assumed to be one
RUNTIME VALIDATION: capability discovery found all 22 required tools at v0.9.0 with none missing. Both live demo traces were retrieved through the client under test: the known-good release as 12 spans over 6 services, and the unsafe release as 8 spans over 4 services with flightrules-policy-service and flightrules-fraud-service absent and exactly two client-side payment.refund spans carrying agent.side_effect=write at agent.retry.number 0 and 1. A multi-entry response was provoked against the real server and its rows recovered where a joining parser fails. An invalid API key classified as SIGNOZ_AUTH_FAILED and an unreachable endpoint as MCP_UNAVAILABLE, neither as a success. A saved view was created, read back, field-compared and deleted, and a second create under the same name was refused. Zero artefacts remain in SigNoz and the API key appears in no tracked file
EVIDENCE: docs/evidence/phase-05-plan.md; docs/evidence/phase-05-result.md; docs/research/source-lock.md SL-040 to SL-043; docs/research/mcp-capabilities.json
KNOWN LIMITATIONS: five, listed above. None blocks Phase 06. The capability snapshot awaits Phase 09 persistence; update-tool wrappers and dashboard/alert read-back verification are Phase 10 scope by PRD assignment
NEXT PHASE ENTRY CRITERIA: SATISFIED
```
