import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL("http://localhost:8000/mcp"), {
  requestInit: { headers: { "SIGNOZ-API-KEY": process.env.SIGNOZ_API_KEY } },
});
const client = new Client({ name: "flightrules-phase00-qb", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

const list = await client.listResources();
console.log("=== resources ===");
for (const r of list.resources) console.log(" -", r.uri, "|", r.name);

const uri = process.argv[2] ?? "signoz://traces/query-builder-guide";
const res = await client.readResource({ uri });
const text = (res.contents ?? []).map((c) => c.text ?? "").join("\n");
writeFileSync(process.argv[3] ?? "qb-guide.md", text);
console.log(`\n=== ${uri} (${text.length} chars) written ===`);
await client.close();
