import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const traceId = process.argv[2];
const transport = new StreamableHTTPClientTransport(new URL("http://localhost:8000/mcp"), {
  requestInit: { headers: { "SIGNOZ-API-KEY": process.env.SIGNOZ_API_KEY } },
});
const client = new Client({ name: "flightrules-phase00-attrs", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);
const ctx = "FlightRules Phase 00 feasibility proof: confirm custom span attributes are retrievable through supported MCP tools";
const textOf = (r) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

const keys = await client.callTool({
  name: "signoz_get_field_keys",
  arguments: { searchContext: ctx, signal: "traces", fieldContext: "attribute", searchText: "agent" },
});
console.log("=== field keys (attribute, 'agent') isError:", keys.isError === true);
console.log(textOf(keys).slice(0, 1200));

const end = Date.now();
const start = end - 60 * 60 * 1000;
const query = {
  schemaVersion: "v1",
  start,
  end,
  requestType: "raw",
  compositeQuery: {
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
          filter: { expression: `trace_id = '${traceId}'` },
          selectFields: [
            { name: "trace_id", fieldDataType: "string", signal: "traces", fieldContext: "span" },
            { name: "span_id", fieldDataType: "string", signal: "traces", fieldContext: "span" },
            { name: "parent_span_id", fieldDataType: "string", signal: "traces", fieldContext: "span" },
            { name: "name", fieldDataType: "string", signal: "traces", fieldContext: "span" },
            { name: "duration_nano", fieldDataType: "number", signal: "traces", fieldContext: "span" },
            { name: "kind_string", fieldDataType: "string", signal: "traces", fieldContext: "span" },
            { name: "has_error", fieldDataType: "bool", signal: "traces", fieldContext: "span" },
            { name: "service.name", fieldDataType: "string", signal: "traces", fieldContext: "resource" },
            { name: "agent.side_effect", fieldDataType: "string", signal: "traces", fieldContext: "tag" },
            { name: "agent.release.id", fieldDataType: "string", signal: "traces", fieldContext: "tag" },
          ],
        },
      },
    ],
  },
  formatOptions: { formatTableResultForUI: false, fillGaps: false },
  variables: {},
};

const res = await client.callTool({
  name: "signoz_execute_builder_query",
  arguments: { searchContext: ctx, query },
});
console.log("\n=== execute_builder_query isError:", res.isError === true);
const body = res.structuredContent ?? JSON.parse(textOf(res));
const rows = body?.data?.data?.results?.[0]?.rows ?? [];
console.log("rowCount:", rows.length);
for (const r of rows) {
  const d = r.data ?? {};
  console.log(JSON.stringify({
    name: d.name,
    span_id: d.span_id,
    parent_span_id: d.parent_span_id,
    "agent.side_effect": d["agent.side_effect"],
    "agent.release.id": d["agent.release.id"],
    kind_string: d.kind_string,
    duration_nano: d.duration_nano,
  }));
}
if (rows.length === 0) console.log("RAW:", textOf(res).slice(0, 1500));
await client.close();
