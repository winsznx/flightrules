#!/usr/bin/env node
/**
 * Temporary Phase 17 instrument: prints every span SigNoz holds for the last hour, with its trace,
 * service, name and parent, so a missing producer and a broken parent chain can be told apart.
 * Deleted with the diagnostic workflow that calls it.
 */
import {
  buildTraceQuery,
  rowsOf,
  SigNozMcpClient,
  SigNozOperations,
  StreamableToolCaller,
} from "@flightrules/signoz-mcp";

const caller = new StreamableToolCaller({
  url: process.env["SIGNOZ_MCP_URL"] ?? "http://localhost:8000/mcp",
  apiKey: process.env["SIGNOZ_API_KEY"] ?? "",
  clientName: "flightrules-span-probe",
});
const client = new SigNozMcpClient({ caller, timeoutMs: 60_000 });
const operations = new SigNozOperations(client);
await client.discoverCapabilities();

const endMs = Date.now();
const query = await operations.executeBuilderQuery(
  buildTraceQuery({
    filter: "",
    selectFields: [
      { name: "trace_id", context: "span" },
      { name: "span_id", context: "span" },
      { name: "parent_span_id", context: "span" },
      { name: "name", context: "span" },
      { name: "service.name", context: "resource" },
      { name: "agent.release.id", context: "tag" },
    ],
    startMs: endMs - 60 * 60 * 1000,
    endMs,
    limit: 200,
    orderDirection: "desc",
  }),
  { searchContext: "FlightRules span probe" },
);

process.stdout.write(`outcome ${query.outcome}\n`);
if (query.outcome === "SUCCESS_WITH_ROWS") {
  for (const row of rowsOf(query.value)) {
    process.stdout.write(
      [
        row.data["trace_id"],
        row.data["service.name"],
        row.data["name"],
        `parent=${String(row.data["parent_span_id"] ?? "")}`,
        `release=${String(row.data["agent.release.id"] ?? "(unset)")}`,
      ].join("  ") + "\n",
    );
  }
}

await client.close().catch(() => {});
