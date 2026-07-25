import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL("http://localhost:8000/mcp"), {
  requestInit: { headers: { "SIGNOZ-API-KEY": process.env.SIGNOZ_API_KEY } },
});
const client = new Client({ name: "flightrules-phase00-write", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);
const ctx = "FlightRules Phase 00 feasibility proof: create a harmless SigNoz saved view and dashboard through MCP, then read them back and compare fields";
const textOf = (r) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const body = (r) => r.structuredContent ?? JSON.parse(textOf(r));

const viewName = "FlightRules Phase00 Probe View";
const desiredView = {
  name: viewName,
  sourcePage: "traces",
  category: "FlightRules",
  tags: ["flightrules", "phase00"],
  compositeQuery: {
    queryType: "builder",
    panelType: "list",
    queries: [{
      type: "builder_query",
      spec: {
        name: "A",
        signal: "traces",
        source: "",
        stepInterval: 0,
        limit: 100,
        order: [{ key: { name: "timestamp" }, direction: "desc" }],
        filter: { expression: "service.name = 'flightrules-phase00-probe'" },
        having: { expression: "" },
      },
    }],
  },
};

const created = await client.callTool({ name: "signoz_create_view", arguments: { searchContext: ctx, ...desiredView } });
console.log("=== create_view isError:", created.isError === true);
if (created.isError) { console.log(textOf(created).slice(0, 1200)); process.exit(1); }
const createdBody = body(created);
const viewId = createdBody?.data?.id ?? createdBody?.data;
console.log("created view id:", JSON.stringify(viewId).slice(0, 120));

const readBack = await client.callTool({ name: "signoz_get_view", arguments: { searchContext: ctx, id: typeof viewId === "string" ? viewId : viewId?.id } });
console.log("=== get_view isError:", readBack.isError === true);
const rb = body(readBack)?.data;
console.log("readback name:", rb?.name);
console.log("readback sourcePage:", rb?.sourcePage);
console.log("readback filter:", rb?.compositeQuery?.queries?.[0]?.spec?.filter?.expression);
const matches =
  rb?.name === desiredView.name &&
  rb?.sourcePage === desiredView.sourcePage &&
  rb?.compositeQuery?.queries?.[0]?.spec?.filter?.expression === desiredView.compositeQuery.queries[0].spec.filter.expression;
console.log("READ-BACK FIELD MATCH:", matches);

const listed = await client.callTool({ name: "signoz_list_views", arguments: { searchContext: ctx, sourcePage: "traces" } });
const names = (body(listed)?.data ?? []).map((v) => v.name);
console.log("list_views contains created view:", names.includes(viewName), "| total:", names.length);

const deleted = await client.callTool({
  name: "signoz_delete_view",
  arguments: { searchContext: ctx, id: typeof viewId === "string" ? viewId : viewId?.id },
});
console.log("=== delete_view isError:", deleted.isError === true, textOf(deleted).slice(0, 300));

await client.close();
