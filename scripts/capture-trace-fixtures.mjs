#!/usr/bin/env node
/**
 * Captures the current demo traces from the live SigNoz deployment and writes them as test
 * fixtures.
 *
 * The fixtures are real telemetry, not hand-written JSON: PRD Phase 06 requires that graph tests
 * run against traces produced by the actual instrumented system. Volatile identifiers are kept
 * because the graph engine's job is to normalise them away, and proving that against invented
 * identifiers would prove nothing.
 *
 * Nothing sensitive is captured. The demo emits no prompts, no tool arguments and no customer
 * data; the redaction test in `packages/telemetry` asserts that, and this script additionally
 * refuses to write a fixture containing any forbidden attribute key.
 *
 * Usage: node scripts/capture-trace-fixtures.mjs
 */
import { writeFileSync } from "node:fs";
import { FORBIDDEN_TELEMETRY_KEYS } from "@flightrules/domain";
import {
  buildTraceQuery,
  rowsOf,
  SigNozMcpClient,
  SigNozOperations,
  StreamableToolCaller,
} from "@flightrules/signoz-mcp";

const mcpUrl = process.env["SIGNOZ_MCP_URL"] ?? "http://localhost:8000/mcp";
const apiKey = process.env["SIGNOZ_API_KEY"];
if (!apiKey) throw new Error("SIGNOZ_API_KEY must be set. Source .env first.");

const CONTEXT =
  "FlightRules Phase 06: capture the demo traces from SigNoz as deterministic graph test fixtures";

const SELECT_FIELDS = [
  { name: "trace_id", context: "span" },
  { name: "span_id", context: "span" },
  { name: "parent_span_id", context: "span" },
  { name: "name", context: "span" },
  { name: "kind_string", context: "span" },
  { name: "duration_nano", context: "span", dataType: "number" },
  { name: "has_error", context: "span", dataType: "bool" },
  { name: "status_code_string", context: "span" },
  { name: "timestamp", context: "span" },
  { name: "service.name", context: "resource" },
  { name: "deployment.environment.name", context: "resource" },
  { name: "agent.release.id", context: "tag" },
  { name: "agent.run.id", context: "tag" },
  { name: "agent.side_effect", context: "tag" },
  { name: "agent.data_domain", context: "tag" },
  { name: "agent.retry.number", context: "tag", dataType: "number" },
  { name: "agent.step.category", context: "tag" },
  { name: "agent.scenario", context: "tag" },
  { name: "agent.order.id", context: "tag" },
  { name: "agent.idempotency.present", context: "tag", dataType: "bool" },
  { name: "gen_ai.tool.name", context: "tag" },
  { name: "gen_ai.operation.name", context: "tag" },
];

const caller = new StreamableToolCaller({
  url: mcpUrl,
  apiKey,
  clientName: "flightrules-fixture-capture",
});
const client = new SigNozMcpClient({ caller, timeoutMs: 60_000 });
const operations = new SigNozOperations(client);
await client.discoverCapabilities();

const endMs = Date.now();
const startMs = endMs - 6 * 60 * 60 * 1000;

async function latestTraceId(releaseId) {
  const result = await operations.executeBuilderQuery(
    buildTraceQuery({
      filter: `agent.release.id = '${releaseId}' AND name = 'refund.request'`,
      selectFields: [{ name: "trace_id", context: "span" }],
      startMs,
      endMs,
      limit: 1,
      orderDirection: "desc",
    }),
    { searchContext: CONTEXT },
  );
  if (result.outcome !== "SUCCESS_WITH_ROWS") {
    throw new Error(`no ${releaseId} run found (${result.outcome}). Run make demo-v1 / demo-v2.`);
  }
  return rowsOf(result.value)[0].data.trace_id;
}

for (const [releaseId, file] of [
  ["refund-agent-v1", "packages/test-fixtures/traces/refund-agent-v1.json"],
  ["refund-agent-v2", "packages/test-fixtures/traces/refund-agent-v2.json"],
]) {
  const traceId = await latestTraceId(releaseId);
  const result = await operations.getTraceSpans(
    traceId,
    { selectFields: SELECT_FIELDS, startMs, endMs, limit: 500, orderDirection: "asc" },
    { searchContext: CONTEXT },
  );
  if (result.outcome !== "SUCCESS_WITH_ROWS") {
    throw new Error(`could not fetch ${releaseId} trace ${traceId}: ${result.outcome}`);
  }

  const rows = rowsOf(result.value);
  const serialised = JSON.stringify(rows);
  for (const key of FORBIDDEN_TELEMETRY_KEYS) {
    if (serialised.includes(key)) {
      throw new Error(`refusing to write a fixture containing the forbidden attribute ${key}`);
    }
  }

  // Sorted by span_id so re-capturing an equivalent trace produces a stable diff. The graph
  // engine must not depend on this order, and a property test proves it does not.
  const sorted = [...rows].sort((a, b) => a.data.span_id.localeCompare(b.data.span_id));

  writeFileSync(
    file,
    `${JSON.stringify(
      {
        capturedAtUtc: new Date().toISOString(),
        releaseId,
        traceId,
        source: "signoz_execute_builder_query via @flightrules/signoz-mcp",
        spanCount: sorted.length,
        rows: sorted,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`${releaseId}: ${sorted.length} spans -> ${file}\n`);
}

await client.close();
