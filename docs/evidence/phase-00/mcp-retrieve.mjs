import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const traceId = process.argv[2];
if (!traceId) throw new Error("usage: node mcp-retrieve.mjs <traceId>");

const transport = new StreamableHTTPClientTransport(new URL("http://localhost:8000/mcp"), {
  requestInit: { headers: { "SIGNOZ-API-KEY": process.env.SIGNOZ_API_KEY } },
});
const client = new Client({ name: "flightrules-phase00-retrieve", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

function textOf(result) {
  return (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

const search = await client.callTool({
  name: "signoz_search_traces",
  arguments: {
    searchContext: "FlightRules Phase 00 feasibility proof: confirm the emitted probe trace is queryable in SigNoz",
    start: "now-30m",
    end: "now",
    filter: "service.name = 'flightrules-phase00-probe'",
    limit: 20,
  },
});
console.log("=== signoz_search_traces isError:", search.isError === true);
console.log(textOf(search).slice(0, 1500));

const details = await client.callTool({
  name: "signoz_get_trace_details",
  arguments: {
    searchContext: "FlightRules Phase 00 feasibility proof: retrieve the complete span tree for the emitted probe trace",
    traceId,
  },
});
console.log("\n=== signoz_get_trace_details isError:", details.isError === true);
const detailText = textOf(details);
console.log(detailText.slice(0, 3000));
console.log("\n=== structuredContent keys:", details.structuredContent ? Object.keys(details.structuredContent) : "none");
if (details.structuredContent) {
  console.log(JSON.stringify(details.structuredContent).slice(0, 3000));
}
await client.close();
