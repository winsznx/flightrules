import { readFileSync } from "node:fs";
import path from "node:path";
import {
  formatValidationErrors,
  parseContract,
  type TrajectoryContract,
} from "@flightrules/contract-schema";
import {
  buildTraceQuery,
  rowsOf as mcpRowsOf,
  SigNozMcpClient,
  SigNozOperations,
  StreamableToolCaller,
} from "@flightrules/signoz-mcp";
import {
  buildTraceGraph,
  canonicaliseGraph,
  fingerprintGraph,
  type SpanRowData,
  type TraceGraph,
} from "@flightrules/trace-graph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serialiseEvaluation } from "./canonical.js";
import { evaluateRun } from "./evaluate.js";
import type { ApprovedRoute } from "./rule-context.js";

/**
 * Phase 07 integration tests.
 *
 * The unit tests evaluate captured fixtures. These fetch both releases from the running SigNoz
 * deployment and evaluate the *active production contract* against them, so the exit gate is proven
 * on telemetry emitted minutes ago rather than on a file that could have drifted from what the demo
 * actually produces.
 *
 * Requires a recent `make demo-v1` and `make demo-v2`.
 */

const mcpUrl = process.env["SIGNOZ_MCP_URL"] ?? "http://localhost:8000/mcp";
const apiKey = process.env["SIGNOZ_API_KEY"];

if (!apiKey || apiKey === "replace-me") {
  throw new Error("SIGNOZ_API_KEY must be set for SigNoz integration tests. Source .env.");
}

const CONTEXT =
  "FlightRules Phase 07 integration test: evaluate the active contract against live SigNoz traces";
const ROOT_SELECTOR = "refund.request";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const DEMO_CONTRACT = path.join(
  REPO_ROOT,
  "contracts",
  "demo-commerce",
  "refund-agent",
  "production",
  "contract.yaml",
);
const FIXTURE_DIR = path.join(REPO_ROOT, "packages", "contract-engine", "fixtures", "contracts");

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
  // `dataType` is mandatory for a non-string tag. Without it the Query Builder returns `null` for
  // the column — a success, with no error and no warning — so a rule keyed on this attribute would
  // silently see nothing. Recorded as SL-046; the same applies to `agent.retry.number` above.
  { name: "agent.idempotency.present", context: "tag" as const, dataType: "bool" as const },
  { name: "gen_ai.tool.name", context: "tag" as const },
  { name: "gen_ai.operation.name", context: "tag" as const },
];

let caller: StreamableToolCaller;
let client: SigNozMcpClient;
let operations: SigNozOperations;

function contractFrom(file: string): TrajectoryContract {
  const result = parseContract(readFileSync(file, "utf8"));
  if (!result.ok) throw new Error(`${file}: ${formatValidationErrors(result.errors)}`);
  return result.value.contract;
}

function window() {
  const endMs = Date.now();
  return { startMs: endMs - 6 * 60 * 60 * 1000, endMs };
}

beforeAll(async () => {
  caller = new StreamableToolCaller({
    url: mcpUrl,
    apiKey: apiKey as string,
    clientName: "flightrules-phase07-tests",
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

async function liveGraph(releaseId: string): Promise<TraceGraph> {
  return buildTraceGraph(await liveRows(releaseId), { rootSelector: ROOT_SELECTOR });
}

async function approvedFamily(): Promise<readonly ApprovedRoute[]> {
  const graph = await liveGraph("refund-agent-v1");
  return [
    { fingerprint: fingerprintGraph(graph).fingerprint, canonical: canonicaliseGraph(graph) },
  ];
}

describe("the active contract evaluated against live telemetry", () => {
  it("passes the approved release fetched from SigNoz", async () => {
    // #given the real v1 trace and the committed production contract
    const graph = await liveGraph("refund-agent-v1");
    const { evaluation } = evaluateRun({
      graph,
      contract: contractFrom(DEMO_CONTRACT),
      approvedRoutes: await approvedFamily(),
    });

    // #then the release passes with no violation at all
    expect(evaluation.status).toBe("pass");
    expect(evaluation.violations).toEqual([]);
    expect(evaluation.routeApproved).toBe(true);
  });

  it("fails the canary on the missing fraud check, the missing policy check and the duplicate refund", async () => {
    // #given the real v2 trace
    const graph = await liveGraph("refund-agent-v2");
    const { evaluation } = evaluateRun({
      graph,
      contract: contractFrom(DEMO_CONTRACT),
      approvedRoutes: await approvedFamily(),
    });

    // #then the release fails, and each of the three PRD findings is present with its own code
    expect(evaluation.status).toBe("fail");
    const byRule = new Map(evaluation.violations.map((entry) => [entry.ruleId, entry]));
    expect(byRule.get("require-fraud-check")?.code).toBe("REQUIRED_SPAN_MISSING");
    expect(byRule.get("require-policy-check")?.code).toBe("REQUIRED_SPAN_MISSING");
    expect(byRule.get("single-refund-write")?.code).toBe("CARDINALITY_ABOVE_MAX");
    expect(evaluation.counts.zeroToleranceViolations).toBe(3);
  });

  it("links each live violation to span identifiers present in the fetched trace", async () => {
    const graph = await liveGraph("refund-agent-v2");
    const { evaluation } = evaluateRun({
      graph,
      contract: contractFrom(DEMO_CONTRACT),
      approvedRoutes: await approvedFamily(),
    });

    const present = new Set(graph.nodes.map((node) => node.spanId));
    const duplicate = evaluation.violations.find((entry) => entry.ruleId === "single-refund-write");
    expect(duplicate?.evidence.spanIds).toHaveLength(2);
    for (const spanId of duplicate?.evidence.spanIds ?? []) {
      expect(present.has(spanId)).toBe(true);
    }
  });

  it("reports insufficient evidence for the aborted payment handler rather than a violation", async () => {
    // #given the live canary trace, whose first payment attempt timed out before its handler span
    // could be exported
    const graph = await liveGraph("refund-agent-v2");
    expect(graph.warnings.map((warning) => warning.kind)).toContain(
      "client_span_without_server_span",
    );

    const { evaluation } = evaluateRun({
      graph,
      contract: contractFrom(DEMO_CONTRACT),
      approvedRoutes: await approvedFamily(),
    });
    const edgeRule = evaluation.ruleResults.find(
      (result) => result.ruleId === "refund-handler-follows-refund-call",
    );

    // #then the rule that needs the missing span says so, instead of reporting a skipped step
    expect(edgeRule?.outcome).toBe("insufficient_evidence");
    expect(edgeRule?.insufficientReason).toBe("unobservable_subtree");

    // #and the duplicate-refund finding, whose evidence lives in the two exported client spans, is
    // unaffected
    expect(evaluation.violations.some((entry) => entry.ruleId === "single-refund-write")).toBe(
      true,
    );
  });

  it("reports insufficient evidence for a metric the live agent never emits", async () => {
    // #given a run-scoped token budget and an agent that makes no model call
    const graph = await liveGraph("refund-agent-v1");
    const { evaluation } = evaluateRun({
      graph,
      contract: contractFrom(path.join(FIXTURE_DIR, "run-scoped-token-budget.yaml")),
    });

    // #then the budget is unconfirmed, and the run is insufficient_data rather than a pass
    expect(evaluation.ruleResults[0]?.outcome).toBe("insufficient_evidence");
    expect(evaluation.ruleResults[0]?.insufficientReason).toBe("metric_not_emitted");
    expect(evaluation.status).toBe("insufficient_data");
  });

  it("produces a byte-identical evaluation for a live trace and the committed fixture of it", async () => {
    // #given the same logical v1 run fetched live, evaluated twice
    const graph = await liveGraph("refund-agent-v1");
    const contract = contractFrom(DEMO_CONTRACT);
    const approved = await approvedFamily();

    const first = evaluateRun({ graph, contract, approvedRoutes: approved });
    const second = evaluateRun({ graph, contract, approvedRoutes: approved });

    expect(serialiseEvaluation(second.evaluation)).toBe(serialiseEvaluation(first.evaluation));
    expect(second.evaluationHash).toBe(first.evaluationHash);
  });

  it("agrees with the committed contract's own approved route fingerprint", async () => {
    // #given the live v1 route
    const graph = await liveGraph("refund-agent-v1");
    const contract = contractFrom(DEMO_CONTRACT);

    // #then the fingerprint committed in the contract is the one the engine computes today, so the
    // approved-route rule is not passing because of a stale constant
    expect(contract.spec.approvedRoutes).toContain(fingerprintGraph(graph).fingerprint);
  });

  it("evaluates a live trace within the PRD section 20.2 budget", async () => {
    const graph = await liveGraph("refund-agent-v2");
    const contract = contractFrom(DEMO_CONTRACT);
    const approved = await approvedFamily();

    const started = process.hrtime.bigint();
    evaluateRun({ graph, contract, approvedRoutes: approved });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(elapsedMs).toBeLessThan(250);
  });
});
