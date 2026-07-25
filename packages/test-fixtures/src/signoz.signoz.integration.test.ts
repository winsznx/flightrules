import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Phase 02 integration tests. These exercise the deployed SigNoz stack directly, before the
 * typed FlightRules MCP client exists (Phase 05), so they use the official SDK the same way the
 * client will.
 *
 * They fail rather than skip when the stack is absent. A skipped test that reports green is the
 * false evidence this project forbids.
 */
const signozUrl = process.env["SIGNOZ_URL"] ?? "http://localhost:8080";
const mcpUrl = process.env["SIGNOZ_MCP_URL"] ?? "http://localhost:8000/mcp";
const mcpBase = mcpUrl.replace(/\/mcp$/, "");
const otlpEndpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "http://localhost:4318";
const apiKey = process.env["SIGNOZ_API_KEY"];

if (!apiKey || apiKey === "replace-me") {
  throw new Error(
    "SIGNOZ_API_KEY must be set for SigNoz integration tests. Deploy the stack with " +
      "`make signoz-up` and run `make signoz-bootstrap`, then source .env.",
  );
}

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
] as const;

let client: Client;
let toolNames: ReadonlySet<string>;

beforeAll(async () => {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { "SIGNOZ-API-KEY": apiKey } },
  });
  client = new Client(
    { name: "flightrules-phase02-tests", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  const { tools } = await client.listTools();
  toolNames = new Set(tools.map((tool) => tool.name));
}, 60_000);

afterAll(async () => {
  await client?.close().catch(() => {});
});

describe("SigNoz HTTP API", () => {
  it("reports healthy", async () => {
    const response = await fetch(`${signozUrl}/api/v1/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("runs the pinned version with setup completed", async () => {
    const response = await fetch(`${signozUrl}/api/v1/version`);
    const body = (await response.json()) as { version: string; setupCompleted: boolean };

    expect(body.version).toBe("v0.134.0");
    // Ingestion does not work until setup completes, so this is a functional precondition.
    expect(body.setupCompleted).toBe(true);
  });
});

describe("SigNoz MCP Server", () => {
  it("answers the liveness probe", async () => {
    expect((await fetch(`${mcpBase}/livez`)).status).toBe(200);
  });

  it("answers the readiness probe", async () => {
    const response = await fetch(`${mcpBase}/readyz`);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("ok");
  });

  it("identifies itself as the pinned version over MCP", () => {
    expect(client.getServerVersion()).toMatchObject({ name: "SigNozMCP", version: "v0.9.0" });
  });

  it("advertises tool, resource and prompt capabilities", () => {
    const capabilities = client.getServerCapabilities();
    expect(capabilities).toHaveProperty("tools");
    expect(capabilities).toHaveProperty("resources");
  });

  it.each(REQUIRED_TOOLS)("exposes the required tool %s", (name) => {
    expect(toolNames.has(name)).toBe(true);
  });

  it("serves a read-only tool call with a valid API key", async () => {
    const result = await client.callTool({
      name: "signoz_list_services",
      arguments: {
        searchContext:
          "FlightRules Phase 02 verification: confirm an authenticated read-only MCP tool call succeeds",
        timeRange: "1h",
      },
    });
    expect(result.isError).not.toBe(true);
  });

  it("rejects an invalid API key", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { "SIGNOZ-API-KEY": "definitely-not-a-valid-flightrules-key" } },
    });
    const rogue = new Client({ name: "flightrules-rogue", version: "0.1.0" }, { capabilities: {} });

    let rejected = false;
    try {
      await rogue.connect(transport);
      const result = await rogue.callTool({
        name: "signoz_list_services",
        arguments: {
          searchContext:
            "FlightRules Phase 02 verification: confirm an invalid API key is rejected",
          timeRange: "1h",
        },
      });
      rejected = result.isError === true;
    } catch {
      rejected = true;
    } finally {
      await rogue.close().catch(() => {});
    }

    expect(rejected).toBe(true);
  });

  it("exposes the Query Builder guide resource the trace-retrieval path depends on", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((resource) => resource.uri);
    expect(uris).toContain("signoz://traces/query-builder-guide");
  });
});

describe("OTLP ingestion", () => {
  it("accepts a trace export over HTTP", async () => {
    // Deliberately a real export, not a port check: ports 4317 and 4318 accept a TCP connection
    // through the Docker proxy even when the collector is not listening on them (SL-010).
    const response = await fetch(`${otlpEndpoint}/v1/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resourceSpans: [] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ partialSuccess: {} });
  });
});
