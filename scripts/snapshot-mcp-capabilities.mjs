#!/usr/bin/env node
/**
 * Captures the live SigNoz MCP tool surface, including every input and output schema, and writes
 * it to docs/research/mcp-capabilities.json.
 *
 * Tool names alone are not a capability check. The argument shapes differ from what the names
 * suggest in ways that matter — `signoz_create_view` takes flat arguments rather than a nested
 * resource object, `signoz_get_trace_details` has no field-selection parameter at all — so the
 * snapshot records schemas, and the required-tool assertion runs against the live server.
 *
 * Usage:
 *   node scripts/snapshot-mcp-capabilities.mjs [outputPath]
 */
import { writeFileSync } from "node:fs";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** The tools PRD section 16.4 requires. Absence is a capability failure, never a silent degrade. */
const REQUIRED_TOOLS = [
  "signoz_aggregate_traces",
  "signoz_create_alert",
  "signoz_create_dashboard",
  "signoz_create_view",
  "signoz_execute_builder_query",
  "signoz_get_alert",
  "signoz_get_alert_history",
  "signoz_get_dashboard",
  "signoz_get_field_keys",
  "signoz_get_field_values",
  "signoz_get_trace_details",
  "signoz_get_view",
  "signoz_list_alert_rules",
  "signoz_list_dashboards",
  "signoz_list_notification_channels",
  "signoz_list_services",
  "signoz_list_views",
  "signoz_search_logs",
  "signoz_search_traces",
  "signoz_update_alert",
  "signoz_update_dashboard",
  "signoz_update_view",
];

const url = process.env.SIGNOZ_MCP_URL ?? "http://localhost:8000/mcp";
const apiKey = process.env.SIGNOZ_API_KEY;
const outputPath = process.argv[2] ?? "docs/research/mcp-capabilities.json";

if (!apiKey || apiKey === "replace-me") {
  process.stderr.write("SIGNOZ_API_KEY is not set. Run scripts/bootstrap-signoz.sh first.\n");
  process.exit(5);
}

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { "SIGNOZ-API-KEY": apiKey } },
});
const client = new Client(
  { name: "flightrules-capability-snapshot", version: "0.1.0" },
  { capabilities: {} },
);

async function safeList(fn, key) {
  try {
    const result = await fn();
    return result[key] ?? [];
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

let exitCode = 0;
try {
  await client.connect(transport);

  const serverInfo = client.getServerVersion();
  const serverCapabilities = client.getServerCapabilities();
  const { tools } = await client.listTools();

  const snapshot = {
    capturedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    endpoint: url,
    serverInfo,
    serverCapabilities,
    toolCount: tools.length,
    tools: tools
      .map((tool) => ({
        name: tool.name,
        title: tool.title ?? null,
        description: tool.description ?? null,
        inputSchema: tool.inputSchema ?? null,
        outputSchema: tool.outputSchema ?? null,
        annotations: tool.annotations ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    resources: await safeList(() => client.listResources(), "resources"),
    resourceTemplates: await safeList(() => client.listResourceTemplates(), "resourceTemplates"),
    prompts: await safeList(() => client.listPrompts(), "prompts"),
  };

  writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);

  const available = new Set(tools.map((tool) => tool.name));
  const missing = REQUIRED_TOOLS.filter((name) => !available.has(name));

  process.stdout.write(
    `${serverInfo?.name ?? "unknown"} ${serverInfo?.version ?? "unknown"} — ` +
      `${tools.length} tools, ${Array.isArray(snapshot.resources) ? snapshot.resources.length : 0} resources\n` +
      `Snapshot written to ${outputPath}\n`,
  );

  if (missing.length > 0) {
    process.stderr.write(
      `\nMCP_TOOL_MISSING — ${missing.length} required tool(s) absent:\n` +
        missing.map((name) => `  ${name}\n`).join(""),
    );
    exitCode = 1;
  } else {
    process.stdout.write(`All ${REQUIRED_TOOLS.length} required tools are present.\n`);
  }
} catch (error) {
  process.stderr.write(
    `MCP capability discovery failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  exitCode = 4;
} finally {
  await client.close().catch(() => {});
}

process.exit(exitCode);
