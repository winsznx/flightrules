# Phase 05 plan — SigNoz MCP client and capability layer

Branch: `phase/05-signoz-mcp-client`
Date: 2026-07-25
PRD section: Phase 05, plus sections 12.4, 16.3, 16.4, 16.5, 19.

## Entry criteria, verified before starting

| Criterion | How it was checked | Result |
|---|---|---|
| Working tree clean, Phase 00–04 commits present and merged | `git status`, `git log --graph` | Clean; `ba600b8`, `9e093da`, `bb50031`, `9a37a88`, `4d392b0` all present and merged to `main` |
| No Phase 05 work already started | `packages/` listing, `git log` | `packages/signoz-mcp` does not exist |
| Full verification suite green | `make verify` | Exit 0, 153 unit tests passed |
| Integration suite green | `make test-integration` | Exit 0, 40 tests passed (8 database, 32 SigNoz) |
| SigNoz stack functionally healthy | `make signoz-verify` | Exit 0. Functional checks, including a real OTLP POST returning 200 — not a TCP port check |
| Known-good demo still correct | `make demo-v1` | Trace `f176194973362b659a75c030fd40f028`, 12 spans, 6 services |
| Unsafe demo still correct | `make demo-v2` | Trace `2627ba04954ce0efbfe83219d45363fd`, 8 spans, 4 services, policy and fraud absent, two client `payment.refund` write spans at retry 0 and 1 |
| Customer-facing output identical between releases | Compared both responses | Byte-identical `customerMessage` |
| MCP tool surface unchanged since Phase 00 | `make signoz-capabilities`, then `git diff` | 41 tools, 19 resources, all 22 PRD-required tools present. Only `capturedAtUtc` changed |

One defect was found in the baseline and fixed before starting: `docs/ACCEPTANCE_MATRIX.md` was
never updated for Phase 04, in breach of the operating contract's rule 23. Corrected in `2d29bf6`.

## Runtime findings that shape this phase

Gathered by probing the live pinned server before writing any client code, per PRD section 2.2.

### F1 — `structuredContent` is present for most tools but absent for the one that matters most

`signoz_execute_builder_query` returns its payload **only** as text content on the success path.
Every list tool returns `structuredContent`. The declared `outputSchema` does not predict this:
only 5 of 41 tools declare one, yet `signoz_list_services`, `signoz_list_views`,
`signoz_list_dashboards` and `signoz_list_notification_channels` all return `structuredContent`
without declaring an output schema.

Consequence: the text fallback is mandatory and cannot be inferred from discovery metadata. It
must be unconditional.

### F2 — A success response may carry more than one content entry, and concatenating them destroys the JSON

When the server fills in a default it did not receive, it appends a second text entry:

```text
entry 0  78142 chars  {"status":"success","data":{...}}
entry 1    109 chars  [Decisions applied]
                        query "A": limit=100 (request-type default), order=timestamp desc (signal-safe default)
```

Joining the entries and calling `JSON.parse` fails at position 78143. Every existing FlightRules
script that reads MCP output joins entries before parsing, so all of them break on this response.
The client must parse **per entry** and keep the advisory text as a validation notice, which is
also what PRD Phase 05 task 5 requires.

### F3 — Error envelopes are structured, and their text is prose rather than JSON

| Condition | Observed |
|---|---|
| Invalid API key | `isError: true`, `structuredContent` `{code:"UNAUTHORIZED", status:401, upstreamCode:"unauthenticated", ...}`, text `SigNoz API error: unexpected status 401: unauthenticated` |
| Missing key header | `connect()` throws `StreamableHTTPError` with `code: 401` |
| Unreachable host | `connect()` throws `TypeError: fetch failed` |
| Wrong MCP path | `connect()` throws `StreamableHTTPError` with `code: 404` |
| Unknown tool name | `callTool()` throws `McpError` with code `-32602` |
| Invalid tool arguments | `isError: true`, text `Parameter validation failed: "signal" must be one of: ...` |
| Malformed builder query | `isError: true`, `structuredContent` `{code:...}`, text is prose |

So an error is never signalled one single way. Classification must consider thrown SDK errors,
`isError`, and the structured error envelope together.

### F4 — A successful query with no matching rows returns `rows: null`, not `[]`

`{"status":"success","data":{"data":{"results":[{"queryName":"A","nextCursor":"","rows":null}]}}}`.
An empty result is a success, and it must normalise to `SUCCESS_EMPTY` rather than a parse failure.

## Scope

Create `packages/signoz-mcp`, the only place in FlightRules that knows what an MCP response
looks like. Nothing downstream ever sees a raw MCP object.

### Boundaries

```text
transport        connection, headers, close             injectable
discovery        tools/list, resources, capability gate
requests         argument construction and validation
normalisation    CallToolResult -> McpOutcome           the F1/F2 layer
validation       runtime schema check of the payload
classification   throwable + isError -> ErrorCode
retry            bounded, jittered, only on retryable
redaction        every log line and evidence record
logging          structured, redacted
wrappers         typed per-tool operations
verification     read-before-write and read-back compare
```

### Result type

The caller receives a discriminated union. The PRD's error model (section 19) supplies the error
codes; the outcome names distinguish the shapes a caller must branch on.

```text
SUCCESS_WITH_ROWS     payload validated, at least one row
SUCCESS_EMPTY         payload validated, zero rows
UNSUPPORTED_RESPONSE  understood, but not a shape this client can use  -> MCP_RESPONSE_INVALID
MALFORMED_RESPONSE    no content entry yielded usable data             -> MCP_RESPONSE_INVALID
MCP_ERROR             server declared the failure                      -> classified by envelope
TRANSPORT_ERROR       connection or protocol failure                   -> MCP_UNAVAILABLE / SIGNOZ_AUTH_FAILED
```

`MCP_TOOL_MISSING` is raised by the capability gate before a call is attempted, and also when the
server answers `-32602 tool not found`.

### Response shapes the normaliser must survive

All seventeen required by the handoff, each with a unit test. Shapes 1, 2, 6, 7, 8, 9, 10, 12 are
reproduced from observed live behaviour rather than invented.

```text
 1 valid structuredContent                    9 MCP-declared error
 2 text-only JSON object                     10 transport error
 3 plain text JSON object                    11 shape differs from schema
 4 plain text JSON array                     12 zero rows (rows: null)
 5 Markdown code fence                       13 large result set within limits
 6 multiple entries, one usable              14 duplicate span rows
 7 empty content                             15 missing required span fields
 8 malformed JSON                            16 unexpected additional fields
                                             17 redacted or unavailable attributes
```

Parsing is explicit: try `structuredContent`, then each content entry in order, stripping a fence
if one is present. No substring scanning and no regular expression over the payload body.

### Exposed operations

Only what the pinned server actually supports, verified against the live snapshot:

```text
traces      searchTraces, executeBuilderQuery, getTraceDetails, getFieldKeys, getFieldValues,
            listServices, aggregateTraces
logs        searchLogs
metrics     queryMetrics, listMetrics
views       listViews, getView, createView, updateView, deleteView
dashboards  listDashboards, getDashboard, createDashboard, updateDashboard
alerts      listAlertRules, getAlert, createAlert, updateAlert, getAlertHistory
channels    listNotificationChannels, getNotificationChannel, createNotificationChannel
```

`createAndVerify` implements the PRD section 16.5 write flow: check capability, list for a name
collision, write, capture the identifier, read back, compare the fields that matter, and fail with
`ARTIFACT_VERIFY_FAILED` on any material difference. Phase 10 consumes it; Phase 05 proves it
against a harmless saved view.

## Tests

Unit tests inject a fake transport, so no test in `make test` needs a running stack. Integration
tests run against the real pinned server and fail rather than skip when it is absent.

| PRD requirement | Test |
|---|---|
| unit tests against an MCP fixture server | `mcp-client.test.ts` with an injected tool caller |
| malformed tool response rejected | shapes 8 and 11 assert `MALFORMED_RESPONSE` / `UNSUPPORTED_RESPONSE` |
| authentication failure classified correctly | thrown 401 and `UNAUTHORIZED` envelope both map to `SIGNOZ_AUTH_FAILED` |
| missing tool produces `MCP_TOOL_MISSING` | capability gate and `-32602` |
| timeout does not return a false success | an aborted call resolves to `TRANSPORT_ERROR`, never a success outcome |
| create-read-verify detects mismatched resource | read-back returning an altered field fails |
| integration tests call the real local server | `*.signoz.integration.test.ts` |
| tool discovery snapshot stored | `docs/research/mcp-capabilities.json`, refreshed and diffed |

## Runtime validation to perform

1. Retrieve both live demo traces through the client and assert 12/6 and 8/4.
2. Assert the v2 trace omits policy and fraud and carries two client write spans at retry 0 and 1.
3. Exercise the multi-entry response against the real server and confirm the client returns rows
   where a joining parser fails.
4. Create, read back, field-compare and delete a saved view through `createAndVerify`.
5. Confirm no API key appears in any log line or evidence file produced during the phase.

## Exit gate

FlightRules can query real traces and read and write a harmless test resource through MCP with
verified read-back.

## Out of scope

Graph reconstruction (Phase 06), contract evaluation (Phase 07), the artifact compiler's
dashboards and alerts (Phase 10), and persistence of the capability snapshot in setup data, which
needs the database layer from Phase 09. The client exposes the snapshot; Phase 09 stores it.
