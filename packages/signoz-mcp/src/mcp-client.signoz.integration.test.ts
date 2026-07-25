import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REQUIRED_TOOLS, SigNozMcpClient } from "./client.js";
import { buildTraceQuery, SigNozOperations, toSpanRows } from "./operations.js";
import { fieldNamesOf, fieldValuesOf, listReader, rowsOf } from "./readers.js";
import { StreamableToolCaller } from "./transport.js";
import { createAndVerify, deepEquals } from "./verify.js";

/**
 * Phase 05 integration tests. These run the real client against the deployed pinned SigNoz MCP
 * Server. They fail rather than skip when the stack is absent, because a skipped test reporting
 * green is the false evidence this project forbids.
 *
 * They require a demo run in the recent past. `make demo-v1` and `make demo-v2` produce one.
 */

const mcpUrl = process.env["SIGNOZ_MCP_URL"] ?? "http://localhost:8000/mcp";
const apiKey = process.env["SIGNOZ_API_KEY"];

if (!apiKey || apiKey === "replace-me") {
  throw new Error(
    "SIGNOZ_API_KEY must be set for SigNoz integration tests. Deploy the stack with " +
      "`make signoz-up` and run `make signoz-bootstrap`, then source .env.",
  );
}

const CONTEXT =
  "FlightRules Phase 05 integration test: verify the typed MCP client against the pinned server";

const SPAN_FIELDS = [
  { name: "trace_id", context: "span" as const },
  { name: "span_id", context: "span" as const },
  { name: "parent_span_id", context: "span" as const },
  { name: "name", context: "span" as const },
  { name: "kind_string", context: "span" as const },
  { name: "service.name", context: "resource" as const },
  { name: "agent.side_effect", context: "tag" as const },
  { name: "agent.retry.number", context: "tag" as const, dataType: "number" as const },
  { name: "agent.release.id", context: "tag" as const },
  { name: "gen_ai.tool.name", context: "tag" as const },
];

let caller: StreamableToolCaller;
let client: SigNozMcpClient;
let operations: SigNozOperations;

function window() {
  const endMs = Date.now();
  return { startMs: endMs - 6 * 60 * 60 * 1000, endMs };
}

beforeAll(async () => {
  caller = new StreamableToolCaller({
    url: mcpUrl,
    apiKey: apiKey as string,
    clientName: "flightrules-phase05-tests",
  });
  client = new SigNozMcpClient({ caller, timeoutMs: 60_000 });
  operations = new SigNozOperations(client);
  await client.discoverCapabilities();
}, 120_000);

afterAll(async () => {
  await client?.close().catch(() => {});
});

describe("capability discovery against the pinned server", () => {
  it("finds every tool PRD section 16.4 requires", () => {
    // #then no required tool is missing at v0.9.0
    expect(client.capabilities?.requiredMissing).toEqual([]);
    expect(client.capabilities?.satisfied).toBe(true);
  });

  it("reports the pinned server version", () => {
    expect(client.capabilities?.server).toMatchObject({ name: "SigNozMCP", version: "v0.9.0" });
  });

  it("exposes at least the required tools plus the server's own extras", () => {
    expect(client.capabilities?.toolNames.length).toBeGreaterThanOrEqual(REQUIRED_TOOLS.length);
  });

  it("exposes the Query Builder guide the trace path depends on", () => {
    expect(client.capabilities?.resourceUris).toContain("signoz://traces/query-builder-guide");
  });
});

describe("trace retrieval through the Query Builder", () => {
  it("recovers rows from a response that carries no structuredContent", async () => {
    // #given the tool that returns its payload as text only — the case that made this fallback
    // mandatory rather than defensive
    const result = await operations.executeBuilderQuery(
      buildTraceQuery({
        filter: "service.name = 'flightrules-demo-agent'",
        selectFields: SPAN_FIELDS,
        ...window(),
        limit: 20,
      }),
      { searchContext: CONTEXT },
    );

    // #then the client returns rows anyway
    expect(result.outcome).toBe("SUCCESS_WITH_ROWS");
    expect(result.outcome === "SUCCESS_WITH_ROWS" && result.rowCount).toBeGreaterThan(0);
  });

  it("retrieves custom span attributes, which get_trace_details cannot return", async () => {
    // #given a query selecting the attributes contract rules read (SL-020, SL-021)
    const result = await operations.executeBuilderQuery(
      buildTraceQuery({
        filter: "service.name = 'flightrules-demo-agent' AND name = 'payment.refund'",
        selectFields: SPAN_FIELDS,
        ...window(),
        limit: 20,
      }),
      { searchContext: CONTEXT },
    );

    // #then the custom attributes are present on the returned rows
    expect(result.outcome).toBe("SUCCESS_WITH_ROWS");
    if (result.outcome !== "SUCCESS_WITH_ROWS") return;
    const { spans } = toSpanRows(result.value);
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.some((span) => span.attributes["agent.side_effect"] === "write")).toBe(true);
    expect(spans.every((span) => span.attributes["agent.release.id"] !== undefined)).toBe(true);
  });

  it("returns SUCCESS_EMPTY rather than a failure when nothing matches", async () => {
    // #given a filter that cannot match
    const result = await operations.executeBuilderQuery(
      buildTraceQuery({
        filter: "trace_id = 'deadbeefdeadbeefdeadbeefdeadbeef'",
        selectFields: SPAN_FIELDS,
        ...window(),
        limit: 10,
      }),
      { searchContext: CONTEXT },
    );

    // #then an empty result is a success, distinct from a query that failed
    expect(result.outcome).toBe("SUCCESS_EMPTY");
  });

  it("recovers rows from a multi-entry response that also carries a server advisory", async () => {
    // #given a query with no limit or order, which makes the server substitute defaults and
    // append `[Decisions applied]` as a second content entry. Joining the entries before parsing
    // produces invalid JSON, so this is the case a naive parser fails on.
    const { startMs, endMs } = window();
    const result = await operations.executeBuilderQuery(
      {
        schemaVersion: "v1",
        start: startMs,
        end: endMs,
        requestType: "raw",
        compositeQuery: {
          queries: [
            {
              type: "builder_query",
              spec: { name: "A", signal: "traces", disabled: false, filter: { expression: "" } },
            },
          ],
        },
        formatOptions: { formatTableResultForUI: false, fillGaps: false },
        variables: {},
      },
      { searchContext: CONTEXT },
    );

    // #then the payload is still recovered, and the advisory is preserved rather than discarded
    expect(result.outcome).toBe("SUCCESS_WITH_ROWS");
    expect(result.notices.length).toBeGreaterThan(0);
    expect(result.notices.some((notice) => notice.text.includes("Decisions applied"))).toBe(true);
  });

  it("reconstructs the known-good release as a complete distributed trace", async () => {
    // #given the most recent refund-agent-v1 run
    const traceId = await latestTraceIdFor("refund-agent-v1");
    const result = await operations.getTraceSpans(
      traceId,
      { selectFields: SPAN_FIELDS, ...window(), limit: 200 },
      { searchContext: CONTEXT },
    );

    // #then all six services appear, which is the approved route
    expect(result.outcome).toBe("SUCCESS_WITH_ROWS");
    if (result.outcome !== "SUCCESS_WITH_ROWS") return;
    const { spans } = toSpanRows(result.value);
    const services = new Set(spans.map((span) => span.attributes["service.name"]));

    expect(spans).toHaveLength(12);
    expect(services.size).toBe(6);
    expect(services).toContain("flightrules-policy-service");
    expect(services).toContain("flightrules-fraud-service");
  });

  it("shows the unsafe release skipping prerequisites and duplicating the side effect", async () => {
    // #given the most recent refund-agent-v2 run
    const traceId = await latestTraceIdFor("refund-agent-v2");
    const result = await operations.getTraceSpans(
      traceId,
      { selectFields: SPAN_FIELDS, ...window(), limit: 200 },
      { searchContext: CONTEXT },
    );

    expect(result.outcome).toBe("SUCCESS_WITH_ROWS");
    if (result.outcome !== "SUCCESS_WITH_ROWS") return;
    const { spans } = toSpanRows(result.value);
    const services = new Set(spans.map((span) => span.attributes["service.name"]));

    // #then the skipped prerequisites are visible as absent services
    expect(spans).toHaveLength(8);
    expect(services).not.toContain("flightrules-policy-service");
    expect(services).not.toContain("flightrules-fraud-service");

    // #and the duplicate side effect is visible as two client write spans at retry 0 and 1
    const writes = spans.filter(
      (span) =>
        span.attributes["agent.side_effect"] === "write" &&
        span.attributes["kind_string"] === "Client",
    );
    expect(writes).toHaveLength(2);
    expect(new Set(writes.map((span) => String(span.attributes["agent.retry.number"])))).toEqual(
      new Set(["0", "1"]),
    );
  });

  it("preserves the SigNoz deep link when the payload returns one", async () => {
    // #given a trace-details fetch, which returns a webUrl
    const traceId = await latestTraceIdFor("refund-agent-v1");
    const result = await operations.getTraceDetails(
      traceId,
      { timeRange: "6h" },
      {
        searchContext: CONTEXT,
      },
    );

    // #then FR-003's requirement to retain the link is satisfied
    expect(result.outcome).toBe("SUCCESS_WITH_ROWS");
    expect(result.outcome === "SUCCESS_WITH_ROWS" && result.webUrl).toContain(traceId);
  });

  it("produces identical rows regardless of the order they were requested in", async () => {
    // #given the same trace fetched ascending and descending
    const traceId = await latestTraceIdFor("refund-agent-v1");
    const spec = { selectFields: SPAN_FIELDS, ...window(), limit: 200 };
    const ascending = await operations.getTraceSpans(
      traceId,
      { ...spec, orderDirection: "asc" },
      { searchContext: CONTEXT },
    );
    const descending = await operations.getTraceSpans(
      traceId,
      { ...spec, orderDirection: "desc" },
      { searchContext: CONTEXT },
    );

    // #then the same span set comes back both ways. Row order is not stable across requests, so
    // Phase 06 must sort canonically rather than trust arrival order.
    expect(ascending.outcome).toBe("SUCCESS_WITH_ROWS");
    expect(descending.outcome).toBe("SUCCESS_WITH_ROWS");
    if (ascending.outcome !== "SUCCESS_WITH_ROWS") return;
    if (descending.outcome !== "SUCCESS_WITH_ROWS") return;

    const idsOf = (payload: typeof ascending.value) =>
      toSpanRows(payload)
        .spans.map((span) => span.span_id)
        .sort();
    expect(idsOf(ascending.value)).toEqual(idsOf(descending.value));
  });
});

describe("discovery tools", () => {
  it("discovers the custom attribute keys the demo emits", async () => {
    // #given a field-key search for the FlightRules namespace
    const result = await operations.getFieldKeys(
      { signal: "traces", searchText: "agent" },
      { searchContext: CONTEXT },
    );

    // #then the attributes contract rules depend on are discoverable rather than hard-coded
    expect(result.outcome).toBe("SUCCESS_WITH_ROWS");
    if (result.outcome !== "SUCCESS_WITH_ROWS") return;
    const names = fieldNamesOf(result.value);
    expect(names).toContain("agent.side_effect");
    expect(names).toContain("agent.release.id");
    expect(names).toContain("agent.retry.number");
  });

  it("discovers the values of a custom attribute", async () => {
    // #given a value lookup for the side-effect classification
    const result = await operations.getFieldValues(
      { signal: "traces", name: "agent.side_effect" },
      { searchContext: CONTEXT },
    );

    // #then the demo's classifications come back
    expect(result.outcome).toBe("SUCCESS_WITH_ROWS");
    if (result.outcome !== "SUCCESS_WITH_ROWS") return;
    expect(fieldValuesOf(result.value)).toEqual(["external", "none", "read", "write"]);
  });

  it("lists the demo services", async () => {
    const result = await operations.listServices({ timeRange: "6h" }, { searchContext: CONTEXT });
    expect(result.outcome).toBe("SUCCESS_WITH_ROWS");
    expect(JSON.stringify(result)).toContain("flightrules-demo-agent");
  });
});

describe("error classification against the real server", () => {
  it("classifies a rejected API key as an authentication failure", async () => {
    // #given a client holding an invalid key
    const rogueCaller = new StreamableToolCaller({
      url: mcpUrl,
      apiKey: "definitely-not-a-valid-flightrules-key",
      clientName: "flightrules-phase05-rogue",
    });
    const rogue = new SigNozMcpClient({ caller: rogueCaller, retry: { maxAttempts: 1 } });

    // #when it calls a read-only tool
    const result = await rogue.call({
      tool: "signoz_list_services",
      arguments: { timeRange: "1h" },
      reader: listReader,
      searchContext: CONTEXT,
    });
    await rogue.close().catch(() => {});

    // #then the failure is classified as authentication, and never as a success
    expect(["MCP_ERROR", "TRANSPORT_ERROR"]).toContain(result.outcome);
    expect(result.outcome !== "SUCCESS_WITH_ROWS" && result.outcome !== "SUCCESS_EMPTY").toBe(true);
    if (result.outcome === "MCP_ERROR" || result.outcome === "TRANSPORT_ERROR") {
      expect(result.code).toBe("SIGNOZ_AUTH_FAILED");
    }
  });

  it("returns MCP_UNAVAILABLE for an unreachable endpoint without throwing", async () => {
    // #given an endpoint nothing is listening on
    const deadCaller = new StreamableToolCaller({
      url: "http://127.0.0.1:9/mcp",
      apiKey: apiKey as string,
    });
    const dead = new SigNozMcpClient({ caller: deadCaller, retry: { maxAttempts: 1 } });

    // #when a call is attempted
    const result = await dead.call({
      tool: "signoz_list_services",
      arguments: { timeRange: "1h" },
      reader: listReader,
      searchContext: CONTEXT,
    });

    // #then it is a typed transport failure
    expect(result.outcome).toBe("TRANSPORT_ERROR");
    expect(result.outcome === "TRANSPORT_ERROR" && result.code).toBe("MCP_UNAVAILABLE");
  });

  it("reports an invalid builder query as an error rather than an empty result", async () => {
    // #given a query the server cannot plan
    const result = await operations.executeBuilderQuery(
      { schemaVersion: "v1", nonsense: true },
      { searchContext: CONTEXT },
    );

    // #then the failure is explicit; treating it as zero rows would silently weaken a contract
    expect(result.outcome).toBe("MCP_ERROR");
  });
});

describe("write, read back, and verify", () => {
  const viewName = `FlightRules / phase-05 / verification / ${process.pid}`;
  let createdId: string | undefined;

  afterAll(async () => {
    if (createdId !== undefined) {
      await operations.deleteView(createdId, { searchContext: CONTEXT }).catch(() => {});
    }
  });

  it("creates a saved view and proves the stored resource matches the specification", async () => {
    // #given a harmless saved view specification. `queryType` and `panelType` are both required:
    // omitting either is rejected with HTTP 400 `failed to validate request body` (SL-042).
    const compositeQuery = {
      queryType: "builder",
      panelType: "list",
      queries: [
        {
          type: "builder_query",
          spec: {
            name: "A",
            signal: "traces",
            disabled: false,
            limit: 100,
            offset: 0,
            order: [{ key: { name: "timestamp" }, direction: "desc" }],
            having: { expression: "" },
            filter: { expression: "service.name = 'flightrules-demo-agent'" },
          },
        },
      ],
    };

    // #when it is created through the verified write flow
    const outcome = await createAndVerify({
      name: viewName,
      materialFields: {
        name: viewName,
        sourcePage: "traces",
        "compositeQuery.queries.0.spec.filter.expression":
          "service.name = 'flightrules-demo-agent'",
      },
      listExisting: () => operations.listViews("traces", { searchContext: CONTEXT }),
      findExisting: (value) => {
        const payload = value as { data: { id?: string; name?: string }[] | null };
        return (payload.data ?? []).find((row) => row.name === viewName)?.id;
      },
      create: () =>
        operations.createView(
          { name: viewName, sourcePage: "traces", compositeQuery },
          { searchContext: CONTEXT },
        ),
      identifierOf: (value) => (typeof value.data === "string" ? value.data : value.data.id),
      fetch: (id) => operations.getView(id, { searchContext: CONTEXT }),
      resourceOf: (value) => value.data,
    });

    if (outcome.status === "VERIFIED" || outcome.status === "MISMATCHED") createdId = outcome.id;

    // #then the read-back confirmed every material field
    expect(outcome.status).toBe("VERIFIED");
    expect(outcome.status === "VERIFIED" && outcome.comparisons.every((c) => c.matches)).toBe(true);
  });

  it("detects a mismatch when the read-back is compared against a different specification", async () => {
    // #given the view created above, compared against a filter it does not have. This proves the
    // verification can fail, which a create-and-read test alone never does.
    expect(createdId).toBeDefined();
    const fetched = await operations.getView(createdId as string, { searchContext: CONTEXT });

    expect(fetched.outcome).toBe("SUCCESS_WITH_ROWS");
    if (fetched.outcome !== "SUCCESS_WITH_ROWS") return;

    // #then a field comparison against the wrong value fails
    expect(deepEquals(fetched.value.data["name"], "a completely different name")).toBe(false);
    expect(deepEquals(fetched.value.data["name"], viewName)).toBe(true);
  });

  it("refuses a second create under the same managed name", async () => {
    // #given the view already exists
    const outcome = await createAndVerify({
      name: viewName,
      materialFields: {},
      listExisting: () => operations.listViews("traces", { searchContext: CONTEXT }),
      findExisting: (value) => {
        const payload = value as { data: { id?: string; name?: string }[] | null };
        return (payload.data ?? []).find((row) => row.name === viewName)?.id;
      },
      create: () => {
        throw new Error("a create must not be attempted when the name is taken");
      },
      identifierOf: () => "",
      fetch: () => {
        throw new Error("unreachable");
      },
      resourceOf: () => ({}),
    });

    // #then no duplicate is created
    expect(outcome.status).toBe("NAME_COLLISION");
  });
});

/** Finds the most recent trace id for a release, using the client under test. */
async function latestTraceIdFor(releaseId: string): Promise<string> {
  const result = await operations.executeBuilderQuery(
    buildTraceQuery({
      filter: `agent.release.id = '${releaseId}' AND name = 'refund.request'`,
      selectFields: [
        { name: "trace_id", context: "span" },
        { name: "span_id", context: "span" },
      ],
      ...window(),
      limit: 1,
      orderDirection: "desc",
    }),
    { searchContext: CONTEXT },
  );

  if (result.outcome !== "SUCCESS_WITH_ROWS") {
    throw new Error(
      `no ${releaseId} run found in the last 6 hours (outcome ${result.outcome}). ` +
        "Run `make demo-v1` and `make demo-v2` before the integration suite.",
    );
  }

  const traceId = rowsOf(result.value)[0]?.data["trace_id"];
  if (typeof traceId !== "string") throw new Error(`no trace_id on the ${releaseId} root span`);
  return traceId;
}
