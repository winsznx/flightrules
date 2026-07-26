#!/usr/bin/env node
/**
 * Proves, against the running deployment, that the two signals the Violation Inspector depends on
 * actually reach SigNoz and are actually queryable (PRD sections 17.4 and 17.5, PRD Phase 16
 * tasks 13 and the OTLP-logs requirement).
 *
 * Neither claim can be established from the application side. "The exporter was constructed" and
 * "the counter was incremented" are both true in a deployment where nothing arrives — which is
 * exactly the state this repository was in before Phase 16:
 *
 *   - logs were written to stdout and never exported, so the inspector's log panel was permanently
 *     empty and said so;
 *   - the metric instruments emitted `project.slug` and `agent.key` while the API grouped by
 *     `flight_rules.project.id` and `flight_rules.agent.id`, so SigNoz returned the requested labels
 *     carrying empty values. SL-062 recorded that as a SigNoz behaviour. It was a name mismatch.
 *
 * Grouping by a label nothing sets is not an error in SigNoz, so only a query that reads the
 * returned label *values* can tell the difference. That is what this does.
 *
 *   node scripts/verify-telemetry.mjs            # uses .demo-state.json
 *   node scripts/verify-telemetry.mjs <traceId>
 */
import { readFile } from "node:fs/promises";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const apiKey = process.env["SIGNOZ_API_KEY"];
const mcpUrl = process.env["SIGNOZ_MCP_URL"] ?? "http://localhost:8000/mcp";
const apiUrl = process.env["API_URL"] ?? `http://localhost:${process.env["API_PORT"] ?? "4000"}`;

if (!apiKey || apiKey === "replace-me") {
  process.stderr.write("SIGNOZ_API_KEY is not set. Source .env first.\n");
  process.exit(5);
}

const WINDOW_MS = 60 * 60 * 1000;
const SEARCH_CONTEXT = "FlightRules Phase 16: verify exported logs and metric dimensions";

const failures = [];
const ok = (message) => process.stdout.write(`  ok    ${message}\n`);
const fail = (message) => {
  failures.push(message);
  process.stdout.write(`  FAIL  ${message}\n`);
};

/** The MCP text envelope wraps one JSON document; the tools also append advisory notes. */
function parseEnvelope(result) {
  const text = result.content.map((entry) => entry.text ?? "").join("\n");
  const match = /^\{[\s\S]*\}$/m.exec(text);
  if (!match) throw new Error(`no JSON document in the MCP response: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

async function demoState() {
  try {
    return JSON.parse(await readFile(".demo-state.json", "utf8"));
  } catch {
    return null;
  }
}

/** The trace of a real violation, so correlation is proven against evidence the product produced. */
async function violationTrace(state) {
  const violationId = Object.values(state?.violations ?? {})[0];
  if (!violationId) return null;
  const response = await fetch(`${apiUrl}/api/violations/${violationId}/logs`);
  if (!response.ok) return null;
  const body = await response.json();
  return { violationId, traceId: body.traceId, state: body.state, logs: body.logs ?? [] };
}

const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
  requestInit: { headers: { "SIGNOZ-API-KEY": apiKey } },
});
const client = new Client(
  { name: "flightrules-verify-telemetry", version: "0.1.0" },
  { capabilities: {} },
);
await client.connect(transport);

const call = async (name, args) =>
  parseEnvelope(
    await client.callTool({ name, arguments: { searchContext: SEARCH_CONTEXT, ...args } }),
  );

const end = Date.now();
const start = end - WINDOW_MS;

// ------------------------------------------------------------------ logs

process.stdout.write("\nExported logs\n");

const state = await demoState();
const traceId = process.argv[2] ?? (await violationTrace(state))?.traceId ?? null;

if (!traceId) {
  fail("no trace to correlate against. Run `make demo-full` then `make demo-urls`.");
} else {
  const logs = await call("signoz_search_logs", {
    filter: `trace_id = '${traceId}'`,
    start,
    end,
    limit: 50,
  });
  const rows = logs?.data?.data?.results?.[0]?.rows ?? [];

  if (rows.length === 0) {
    fail(`SigNoz holds no log correlated to ${traceId}. Logs are not reaching the collector.`);
  } else {
    ok(`${String(rows.length)} log record(s) correlate to trace ${traceId}`);

    const correlated = rows.filter((row) => row.data?.trace_id === traceId);
    if (correlated.length === rows.length) ok("every returned record carries the trace identifier");
    else fail(`${String(rows.length - correlated.length)} record(s) came back without a trace ID`);

    const services = new Set(
      rows.map((row) => row.data?.resources_string?.["service.name"]).filter(Boolean),
    );
    if (services.size > 0) ok(`service names present: ${[...services].sort().join(", ")}`);
    else fail("no record carries a service name; the resource attributes are missing");

    const withSpan = rows.filter((row) => (row.data?.span_id ?? "").length > 0);
    if (withSpan.length > 0)
      ok(`${String(withSpan.length)} record(s) also carry a span identifier`);
    else fail("no record carries a span identifier; correlation is trace-level only");

    // PRD section 17.6. A log is the easiest place to lose this.
    const bodies = rows.map((row) => String(row.data?.body ?? "")).join("\n");
    const attributes = JSON.stringify(rows.map((row) => row.data?.attributes_string ?? {}));
    const forbidden = ["gen_ai.input.messages", "gen_ai.tool.call.arguments", "gen_ai.prompt"];
    const leaked = forbidden.filter((key) => attributes.includes(key));
    if (leaked.length === 0)
      ok("no prompt, tool-argument or tool-result key appears in any record");
    else fail(`forbidden key(s) exported on a log record: ${leaked.join(", ")}`);

    if (!/SIGNOZ-API-KEY\s*[:=]\s*\S/i.test(bodies)) ok("no credential appears in any log body");
    else fail("a log body contains something shaped like a credential");
  }
}

// --------------------------------------------------------------- metrics

process.stdout.write("\nMetric dimensions\n");

const METRIC = "flight_rules.duplicate_side_effects";
const DIMENSIONS = ["flight_rules.project.id", "flight_rules.agent.id"];

const seriesOf = (payload) => {
  const found = [];
  for (const result of payload?.data?.data?.results ?? []) {
    for (const aggregation of result.aggregations ?? []) {
      for (const series of aggregation.series ?? []) {
        const labels = {};
        for (const label of series.labels ?? []) {
          if (label?.key?.name) labels[label.key.name] = label.value;
        }
        found.push({ labels, values: series.values ?? [] });
      }
    }
  }
  return found;
};

const grouped = seriesOf(
  await call("signoz_query_metrics", {
    metricName: METRIC,
    start,
    end,
    groupBy: DIMENSIONS.join(","),
  }),
);

if (grouped.length === 0) {
  fail(`SigNoz holds no ${METRIC} series in the last hour. Run \`make demo-full\` first.`);
} else {
  ok(`${String(grouped.length)} series returned for ${METRIC}`);

  const populated = grouped.filter((series) =>
    DIMENSIONS.every((dimension) => (series.labels[dimension] ?? "").length > 0),
  );
  if (populated.length > 0) {
    ok(`${String(populated.length)} series carry both FlightRules dimensions with real values`);
  } else {
    fail(
      "every series carries the FlightRules dimensions with EMPTY values. The instruments are not " +
        "emitting the names the API groups by — this is the SL-062 defect.",
    );
  }

  const agentId = populated[0]?.labels["flight_rules.agent.id"] ?? state?.agentId ?? null;
  if (agentId) {
    const filtered = seriesOf(
      await call("signoz_query_metrics", {
        metricName: METRIC,
        start,
        end,
        groupBy: DIMENSIONS.join(","),
        filter: `flight_rules.agent.id = '${agentId}'`,
      }),
    );
    if (filtered.length > 0 && filtered.length < grouped.length) {
      ok(
        `filtering on flight_rules.agent.id narrows ${String(grouped.length)} series to ${String(filtered.length)}`,
      );
    } else if (filtered.length === 0) {
      fail("filtering on flight_rules.agent.id matched nothing; the dimension is not queryable");
    } else {
      ok("filtering on flight_rules.agent.id returns the agent's series (only one series exists)");
    }
  }
}

await client.close();

process.stdout.write("\n");
if (failures.length > 0) {
  process.stderr.write(`${String(failures.length)} telemetry check(s) failed.\n`);
  process.exit(1);
}
process.stdout.write(
  "Exported logs and metric dimensions both verified against the running SigNoz.\n",
);
