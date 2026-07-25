import {
  buildTraceQuery,
  rowsOf as mcpRowsOf,
  SigNozMcpClient,
  SigNozOperations,
  StreamableToolCaller,
} from "@flightrules/signoz-mcp";
import { knownGoodTrace, rowsOf, unsafeTrace } from "@flightrules/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTraceGraph, type SpanRowData } from "./build.js";
import { fingerprintGraph } from "./canonical.js";
import { diffGraphs } from "./diff.js";

/**
 * Phase 06 integration tests.
 *
 * The unit tests use captured fixtures; these fetch traces from the live deployment and prove the
 * graph engine produces the same result on freshly emitted telemetry. Without this, a fixture
 * could drift from what the system actually emits and every unit test would still pass.
 *
 * Requires a recent `make demo-v1` and `make demo-v2`.
 */

const mcpUrl = process.env["SIGNOZ_MCP_URL"] ?? "http://localhost:8000/mcp";
const apiKey = process.env["SIGNOZ_API_KEY"];

if (!apiKey || apiKey === "replace-me") {
  throw new Error("SIGNOZ_API_KEY must be set for SigNoz integration tests. Source .env.");
}

const CONTEXT =
  "FlightRules Phase 06 integration test: reconstruct canonical graphs from live SigNoz traces";
const ROOT_SELECTOR = "refund.request";

const SELECT_FIELDS = [
  { name: "trace_id", context: "span" as const },
  { name: "span_id", context: "span" as const },
  { name: "parent_span_id", context: "span" as const },
  { name: "name", context: "span" as const },
  { name: "kind_string", context: "span" as const },
  { name: "duration_nano", context: "span" as const, dataType: "number" as const },
  { name: "timestamp", context: "span" as const },
  { name: "service.name", context: "resource" as const },
  { name: "agent.release.id", context: "tag" as const },
  { name: "agent.run.id", context: "tag" as const },
  { name: "agent.side_effect", context: "tag" as const },
  { name: "agent.data_domain", context: "tag" as const },
  { name: "agent.retry.number", context: "tag" as const, dataType: "number" as const },
  { name: "agent.step.category", context: "tag" as const },
  { name: "gen_ai.tool.name", context: "tag" as const },
  { name: "gen_ai.operation.name", context: "tag" as const },
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
    clientName: "flightrules-phase06-tests",
  });
  client = new SigNozMcpClient({ caller, timeoutMs: 60_000 });
  operations = new SigNozOperations(client);
  await client.discoverCapabilities();
}, 120_000);

afterAll(async () => {
  await client?.close().catch(() => {});
});

async function liveRows(releaseId: string): Promise<readonly SpanRowData[]> {
  const found = await operations.executeBuilderQuery(
    buildTraceQuery({
      filter: `agent.release.id = '${releaseId}' AND name = '${ROOT_SELECTOR}'`,
      selectFields: [{ name: "trace_id", context: "span" }],
      ...window(),
      limit: 1,
      orderDirection: "desc",
    }),
    { searchContext: CONTEXT },
  );
  if (found.outcome !== "SUCCESS_WITH_ROWS") {
    throw new Error(`no ${releaseId} run in the last 6 hours. Run make demo-v1 and make demo-v2.`);
  }
  const traceId = mcpRowsOf(found.value)[0]?.data["trace_id"] as string;

  const spans = await operations.getTraceSpans(
    traceId,
    { selectFields: SELECT_FIELDS, ...window(), limit: 500 },
    { searchContext: CONTEXT },
  );
  if (spans.outcome !== "SUCCESS_WITH_ROWS") {
    throw new Error(`could not fetch ${releaseId} trace ${traceId}: ${spans.outcome}`);
  }
  return mcpRowsOf(spans.value).map((row) => row.data);
}

describe("graphs built from live telemetry", () => {
  it("reconstructs the known-good release with all six services", async () => {
    // #given a trace fetched from the running deployment
    const graph = buildTraceGraph(await liveRows("refund-agent-v1"), {
      rootSelector: ROOT_SELECTOR,
    });

    // #then the approved route is reconstructed from real evidence
    expect(graph.nodes).toHaveLength(12);
    expect(new Set(graph.nodes.map((node) => node.serviceName)).size).toBe(6);
    expect(graph.quality).toBe("complete");
  });

  it("reconstructs the unsafe release with the prerequisites absent", async () => {
    const graph = buildTraceGraph(await liveRows("refund-agent-v2"), {
      rootSelector: ROOT_SELECTOR,
    });
    const services = new Set(graph.nodes.map((node) => node.serviceName));

    expect(graph.nodes).toHaveLength(8);
    expect(services).not.toContain("flightrules-policy-service");
    expect(services).not.toContain("flightrules-fraud-service");
  });

  it("produces the same fingerprint for a live trace as for the captured fixture", async () => {
    // #given the same logical run, once from a checked-in fixture and once from a fresh run with
    // entirely different trace, span and run identifiers
    const live = buildTraceGraph(await liveRows("refund-agent-v1"), {
      rootSelector: ROOT_SELECTOR,
    });
    const fixture = buildTraceGraph(rowsOf(knownGoodTrace()), { rootSelector: ROOT_SELECTOR });

    // #then route identity is stable across separate executions, which is the exit gate for
    // this phase and the precondition for baseline mining in Phase 08
    expect(fingerprintGraph(live).fingerprint).toBe(fingerprintGraph(fixture).fingerprint);
  });

  it("produces the same fingerprint for two independent live runs of the same release", async () => {
    // #given two separate v1 executions
    const first = buildTraceGraph(await liveRows("refund-agent-v1"), {
      rootSelector: ROOT_SELECTOR,
    });
    const second = buildTraceGraph(await liveRows("refund-agent-v1"), {
      rootSelector: ROOT_SELECTOR,
    });

    expect(fingerprintGraph(first).fingerprint).toBe(fingerprintGraph(second).fingerprint);
  });

  it("distinguishes the two releases and explains the difference", async () => {
    // #given both live traces
    const baseline = buildTraceGraph(await liveRows("refund-agent-v1"), {
      rootSelector: ROOT_SELECTOR,
    });
    const candidate = buildTraceGraph(await liveRows("refund-agent-v2"), {
      rootSelector: ROOT_SELECTOR,
    });
    const baselineFingerprint = fingerprintGraph(baseline).fingerprint;
    const candidateFingerprint = fingerprintGraph(candidate).fingerprint;

    // #then the fingerprints differ
    expect(candidateFingerprint).not.toBe(baselineFingerprint);

    // #and the diff names the skipped checks and the duplicated refund
    const diff = diffGraphs(baseline, candidate, {
      baseline: baselineFingerprint,
      candidate: candidateFingerprint,
    });
    const removed = diff.changes.filter((c) => c.kind === "node_removed").map((c) => c.subject);
    expect(removed).toContain("policy.retrieve");
    expect(removed).toContain("fraud.check");

    const duplicated = diff.changes.find((c) => c.kind === "side_effect_duplicated");
    expect(duplicated?.subject).toContain("payment.refund");
    expect(duplicated?.candidateCount).toBe(2);
  });

  it("matches the live unsafe trace against the captured unsafe fixture", async () => {
    const live = buildTraceGraph(await liveRows("refund-agent-v2"), {
      rootSelector: ROOT_SELECTOR,
    });
    const fixture = buildTraceGraph(rowsOf(unsafeTrace()), { rootSelector: ROOT_SELECTOR });
    expect(fingerprintGraph(live).fingerprint).toBe(fingerprintGraph(fixture).fingerprint);
  });
});
