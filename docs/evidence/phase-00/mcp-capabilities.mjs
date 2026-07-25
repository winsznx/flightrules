import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.SIGNOZ_MCP_URL ?? "http://localhost:8000/mcp";
const apiKey = process.env.SIGNOZ_API_KEY;
if (!apiKey) throw new Error("SIGNOZ_API_KEY required");

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { "SIGNOZ-API-KEY": apiKey } },
});

const client = new Client(
  { name: "flightrules-phase00-capability-probe", version: "0.0.0" },
  { capabilities: {} },
);

await client.connect(transport);

const serverVersion = client.getServerVersion();
const serverCapabilities = client.getServerCapabilities();

const tools = await client.listTools();
let resources = { resources: [] };
let resourceTemplates = { resourceTemplates: [] };
let prompts = { prompts: [] };
try { resources = await client.listResources(); } catch (e) { resources = { error: String(e.message ?? e) }; }
try { resourceTemplates = await client.listResourceTemplates(); } catch (e) { resourceTemplates = { error: String(e.message ?? e) }; }
try { prompts = await client.listPrompts(); } catch (e) { prompts = { error: String(e.message ?? e) }; }

const snapshot = {
  capturedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  endpoint: url,
  serverInfo: serverVersion,
  serverCapabilities,
  toolCount: tools.tools.length,
  tools: tools.tools
    .map((t) => ({
      name: t.name,
      title: t.title ?? null,
      description: t.description ?? null,
      inputSchema: t.inputSchema ?? null,
      outputSchema: t.outputSchema ?? null,
      annotations: t.annotations ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name)),
  resources: resources.resources ?? resources,
  resourceTemplates: resourceTemplates.resourceTemplates ?? resourceTemplates,
  prompts: prompts.prompts ?? prompts,
};

writeFileSync(process.argv[2] ?? "mcp-capabilities.json", `${JSON.stringify(snapshot, null, 2)}\n`);
console.log("serverInfo:", JSON.stringify(serverVersion));
console.log("toolCount:", snapshot.toolCount);
console.log("tools:", snapshot.tools.map((t) => t.name).join(", "));
console.log("resources:", JSON.stringify(snapshot.resources).slice(0, 400));
await client.close();
